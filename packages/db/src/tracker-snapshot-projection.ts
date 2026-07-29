import {createHash, randomUUID} from 'node:crypto';
import type {
  TrackerCheckSnapshot,
  TrackerPullRequestSnapshot,
  TrackerRepositorySnapshot,
  TrackerSnapshotBootstrapInput,
  TrackerSnapshotProjector,
  TrackerSnapshotProjectionInput,
  TrackerSnapshotProjectionResult,
  TrackerSnapshotSynchronizationInput,
  TrackerWorkItemSnapshot
} from '@fai-control-plane/domain';
import {and, eq, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type AppliedResult = Extract<TrackerSnapshotProjectionResult, {status: 'applied'}>;
type ConflictResult = Extract<TrackerSnapshotProjectionResult, {status: 'conflict'}>;
type EvidenceState = typeof schema.trackerBindings.$inferInsert.evidenceState;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(record[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const trackerSnapshotProjectionRequestHash = (
  input: TrackerSnapshotProjectionInput
): string =>
  `sha256:${createHash('sha256').update(canonical(input)).digest('hex')}`;

const issueMetadata = (
  snapshot: TrackerRepositorySnapshot,
  item: TrackerWorkItemSnapshot
): Record<string, unknown> => ({
  repositoryExternalId: snapshot.repository.externalId,
  number: item.number,
  url: item.url,
  htmlUrl: item.htmlUrl,
  ...(item.requirements === undefined ? {} : {requirements: item.requirements}),
  state: item.state,
  labels: item.labels,
  assignees: item.assignees,
  milestone: item.milestone,
  projectStatus: item.projectStatus
});

const pullRequestMetadata = (
  snapshot: TrackerRepositorySnapshot,
  pullRequest: TrackerPullRequestSnapshot
): Record<string, unknown> => ({
  repositoryExternalId: snapshot.repository.externalId,
  number: pullRequest.number,
  htmlUrl: pullRequest.htmlUrl,
  title: pullRequest.title,
  merged: pullRequest.merged,
  headSha: pullRequest.headSha,
  labels: pullRequest.labels,
  assignees: pullRequest.assignees,
  milestone: pullRequest.milestone
});

const checkMetadata = (
  snapshot: TrackerRepositorySnapshot,
  check: TrackerCheckSnapshot
): Record<string, unknown> => ({
  repositoryExternalId: snapshot.repository.externalId,
  pullRequestExternalId: check.pullRequestExternalId
});

const repositoryMetadata = (
  snapshot: TrackerRepositorySnapshot
): Record<string, unknown> => ({
  owner: snapshot.repository.owner,
  name: snapshot.repository.name,
  defaultBranch: snapshot.repository.defaultBranch,
  headSha: snapshot.repository.headSha
});

const observedEvidence = (
  previousExternalVersion: string | null | undefined,
  externalVersion: string,
  observedAt: Date,
  override?: Readonly<{state: EvidenceState; conflictReason?: string}>
) => ({
  observedAt,
  confirmedAt: override?.state === 'confirmed' ||
    (override === undefined && previousExternalVersion === externalVersion)
    ? observedAt
    : null,
  evidenceState: override?.state ??
    (previousExternalVersion === externalVersion ? 'confirmed' : 'observed'),
  conflictReason: override?.state === 'conflict'
    ? override.conflictReason ?? 'provider_fact_conflict'
    : null
});

const projectStatusIdentityMatches = (
  binding: typeof schema.trackerBindings.$inferSelect,
  snapshot: TrackerRepositorySnapshot,
  observed: TrackerWorkItemSnapshot['projectStatus']
): boolean => {
  if (observed === null) return true;
  const metadata = binding.metadata as Record<string, unknown>;
  const status = metadata.projectStatus;
  if (metadata.repositoryExternalId !== snapshot.repository.externalId) return false;
  // Bindings created before Projects access may be enriched once from the
  // same validated repository issue. Existing Project identity stays immutable.
  if (status === null) return true;
  return typeof status === 'object' && !Array.isArray(status) &&
    (status as Record<string, unknown>).projectExternalId === observed.projectExternalId &&
    (status as Record<string, unknown>).projectItemExternalId === observed.projectItemExternalId &&
    (status as Record<string, unknown>).fieldExternalId === observed.fieldExternalId;
};

const validateInput = (input: TrackerSnapshotProjectionInput): void => {
  const required = [
    input.operationId,
    input.workspaceId,
    input.projectId,
    input.actorId,
    input.correlationId,
    input.provider,
    input.providers?.taskTracker ?? input.provider,
    input.providers?.repositoryObservation ?? input.provider,
    input.snapshot.repository.externalId,
    input.snapshot.externalVersion
  ];
  if (required.some((value) => value.length === 0)) {
    throw new Error('tracker_snapshot_input_invalid');
  }
  const unique = (values: readonly string[]): boolean =>
    new Set(values).size === values.length;
  if (!unique(input.snapshot.workItems.map(({externalId}) => externalId)) ||
      !unique(input.snapshot.pullRequests.map(({externalId}) => externalId)) ||
      !unique(input.snapshot.checks.map(({externalId}) => externalId))) {
    throw new Error('tracker_snapshot_identity_duplicate');
  }
};

const storedResult = (value: unknown): AppliedResult | ConflictResult =>
  value as AppliedResult | ConflictResult;

const advisoryLock = async (
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  scope: string
): Promise<void> => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${scope}, 0))`
  );
};

export const createPostgresTrackerSnapshotProjector = (
  db: Database
): TrackerSnapshotProjector => {
  const project = async (
    input: TrackerSnapshotProjectionInput
  ): Promise<TrackerSnapshotProjectionResult> => {
    validateInput(input);
    const requestHash = trackerSnapshotProjectionRequestHash(input);
    const taskTrackerProvider = input.providers?.taskTracker ?? input.provider;
    const repositoryProvider = input.providers?.repositoryObservation ?? input.provider;

    try {
      return await db.transaction(async (tx) => {
      await advisoryLock(
        tx,
        `tracker-snapshot-operation:${input.workspaceId}:${input.operationId}`
      );
      const [previousOperation] = await tx
        .select({
          requestHash: schema.trackerSnapshotOperations.requestHash,
          result: schema.trackerSnapshotOperations.result,
          projectId: schema.trackerSnapshotOperations.projectId,
          repositoryExternalId:
            schema.trackerSnapshotOperations.repositoryExternalId
        })
        .from(schema.trackerSnapshotOperations)
        .where(and(
          eq(schema.trackerSnapshotOperations.workspaceId, input.workspaceId),
          eq(schema.trackerSnapshotOperations.id, input.operationId)
        ));
      if (previousOperation !== undefined) {
        if (previousOperation.requestHash === requestHash) {
          return {
            status: 'replayed',
            result: storedResult(previousOperation.result)
          };
        }
        const reuseCommandId =
          `tracker-snapshot-reuse:${input.operationId}:${requestHash}`;
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          projectId: previousOperation.projectId,
          actorId: null,
          commandId: reuseCommandId,
          actionCategory: 'write',
          action: 'tracker_snapshot.idempotency_reuse',
          targetType: 'tracker_repository',
          targetId: previousOperation.repositoryExternalId,
          outcome: 'rejected',
          reasonCode: 'IDEMPOTENCY_KEY_REUSED',
          correlationId: input.correlationId,
          occurredAt: new Date()
        }).onConflictDoNothing({
          target: [
            schema.auditEvents.workspaceId,
            schema.auditEvents.commandId
          ]
        });
        return {status: 'conflict', code: 'idempotency_key_reused'};
      }

      const [projectRow] = await tx.select({id: schema.projects.id})
        .from(schema.projects)
        .where(and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.workspaceId, input.workspaceId)
        ));
      const [actorRow] = await tx.select({id: schema.actors.id})
        .from(schema.actors)
        .where(and(
          eq(schema.actors.id, input.actorId),
          eq(schema.actors.workspaceId, input.workspaceId)
        ));
      if (projectRow === undefined || actorRow === undefined) {
        throw new Error('tracker_snapshot_scope_invalid');
      }

      await advisoryLock(
        tx,
        [
          'tracker-snapshot-repository',
          input.workspaceId,
          input.projectId,
          repositoryProvider
        ].join(':')
      );

      const [repositoryBinding] = await tx
        .select()
        .from(schema.trackerBindings)
        .where(and(
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, repositoryProvider),
          eq(schema.trackerBindings.surface, 'repository'),
          eq(schema.trackerBindings.entityType, 'project'),
          eq(schema.trackerBindings.entityId, input.projectId)
        ))
        .for('update');

      const repositoryIdentityMatches = repositoryBinding === undefined ||
        repositoryBinding.externalId === input.snapshot.repository.externalId;

      let conflict: ConflictResult | undefined;
      if (!repositoryIdentityMatches) {
        conflict = {status: 'conflict', code: 'repository_identity_conflict'};
      } else if (input.mode === 'bootstrap' && repositoryBinding !== undefined) {
        conflict = {
          status: 'conflict',
          code: 'bootstrap_already_completed',
          ...(repositoryBinding.lastInboundVersion === null
            ? {}
            : {currentExternalVersion: repositoryBinding.lastInboundVersion})
        };
      } else if (input.mode === 'synchronize' && repositoryBinding === undefined) {
        conflict = {status: 'conflict', code: 'bootstrap_required'};
      } else if (
        input.mode === 'synchronize' &&
        repositoryBinding?.lastInboundVersion !==
          input.expectedPreviousExternalVersion
      ) {
        conflict = {
          status: 'conflict',
          code: 'stale_snapshot',
          ...(repositoryBinding?.lastInboundVersion === null ||
              repositoryBinding?.lastInboundVersion === undefined
            ? {}
            : {currentExternalVersion: repositoryBinding.lastInboundVersion})
        };
      }

      let providerStatusMismatch = false;
      const record = async (
        result: AppliedResult | ConflictResult
      ): Promise<void> => {
        await tx.insert(schema.trackerSnapshotOperations).values({
          id: input.operationId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          provider: repositoryProvider,
          repositoryExternalId: input.snapshot.repository.externalId,
          mode: input.mode,
          requestHash,
          previousExternalVersion: input.mode === 'synchronize'
            ? input.expectedPreviousExternalVersion
            : null,
          snapshotExternalVersion: input.snapshot.externalVersion,
          result: result as unknown as Record<string, unknown>
        });
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          actorId: input.actorId,
          commandId: input.operationId,
          actionCategory: 'write',
          action: input.mode === 'bootstrap'
            ? 'tracker_snapshot.bootstrap'
            : 'tracker_snapshot.synchronize',
          targetType: 'tracker_repository',
          targetId: input.snapshot.repository.externalId,
          outcome: result.status === 'applied' ? 'succeeded' : 'failed',
          reasonCode: result.status === 'conflict'
            ? result.code.toUpperCase()
            : (
                providerStatusMismatch
              )
              ? 'GITHUB_PROJECT_STATUS_MISMATCH'
              : (
                result.unknownWorkItemExternalIds.length > 0 ||
                result.unknownProjectStatusWorkItemExternalIds.length > 0 ||
                result.unmappablePullRequestExternalIds.length > 0 ||
                result.ambiguousPullRequestExternalIds.length > 0 ||
                result.unknownCheckExternalIds.length > 0
              )
              ? 'TRACKER_ITEMS_REQUIRE_ACTION'
              : null,
          correlationId: input.correlationId,
          occurredAt: new Date()
        });
      };

      if (conflict !== undefined) {
        await record(conflict);
        return conflict;
      }

      const issueBindings = await tx
        .select()
        .from(schema.trackerBindings)
        .where(and(
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, taskTrackerProvider),
          eq(schema.trackerBindings.surface, 'issue'),
          eq(schema.trackerBindings.entityType, 'work_item')
        ));
      const canonicalIssueBindings = await tx
        .select({
          binding: schema.trackerBindings,
          workItem: schema.workItems
        })
        .from(schema.trackerBindings)
        .innerJoin(
          schema.workItems,
          and(
            eq(schema.workItems.id, schema.trackerBindings.entityId),
            eq(schema.workItems.projectId, input.projectId)
          )
        )
        .where(and(
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, taskTrackerProvider),
          eq(schema.trackerBindings.surface, 'issue'),
          eq(schema.trackerBindings.entityType, 'work_item')
        ))
        .for('update');
      const rawWorkItemExternalIds = new Set(
        issueBindings.map(({externalId}) => externalId)
      );
      const workItemIds = new Map(
        canonicalIssueBindings.map(
          ({binding}) => [binding.externalId, binding.entityId]
        )
      );
      const workItemsByExternalId = new Map(
        canonicalIssueBindings.map(
          ({binding, workItem}) => [binding.externalId, {binding, workItem}]
        )
      );
      let createdWorkItems = 0;
      let updatedWorkItems = 0;
      let updatedWorkItemStatuses = 0;
      const unknownWorkItemExternalIds: string[] = [];
      const unknownProjectStatusWorkItemExternalIds: string[] = [];
      const observedWorkItemExternalIds = new Set(
        input.snapshot.workItems.map(({externalId}) => externalId)
      );

      for (const item of input.snapshot.workItems) {
        let workItemId = workItemIds.get(item.externalId);
        if (
          workItemId === undefined &&
          input.mode === 'bootstrap' &&
          !rawWorkItemExternalIds.has(item.externalId)
        ) {
          workItemId = randomUUID();
          await tx.insert(schema.workItems).values({
            id: workItemId,
            projectId: input.projectId,
            title: item.title,
            ...(item.projectStatus?.status === null || item.projectStatus === null
              ? {}
              : {status: item.projectStatus.status})
          });
          await tx.insert(schema.trackerBindings).values({
            projectId: input.projectId,
            provider: taskTrackerProvider,
            surface: 'issue',
            externalId: item.externalId,
            entityType: 'work_item',
            entityId: workItemId,
            externalVersion: item.externalVersion,
            ...observedEvidence(null, item.externalVersion, new Date()),
            lastInboundVersion: item.externalVersion,
            metadata: issueMetadata(input.snapshot, item)
          });
          workItemIds.set(item.externalId, workItemId);
          if (item.projectStatus !== null && item.projectStatus.status === null) {
            unknownProjectStatusWorkItemExternalIds.push(item.externalId);
          }
          createdWorkItems += 1;
          continue;
        }
        if (workItemId === undefined) {
          unknownWorkItemExternalIds.push(item.externalId);
          continue;
        }
        const bound = workItemsByExternalId.get(item.externalId);
        if (bound === undefined || bound.workItem.id !== workItemId) {
          unknownWorkItemExternalIds.push(item.externalId);
          continue;
        }
        const {binding, workItem} = bound;
        const observedProjectStatus = item.projectStatus;
        const bindingMetadata = binding.metadata as Record<string, unknown>;
        const adoptsInitialProjectStatus =
          bindingMetadata.projectStatus === null &&
          observedProjectStatus !== null &&
          observedProjectStatus.status !== null;
        if (!projectStatusIdentityMatches(binding, input.snapshot, observedProjectStatus)) {
          unknownProjectStatusWorkItemExternalIds.push(item.externalId);
          continue;
        }
        const mappedProjectStatus = observedProjectStatus?.status ?? null;
        const confirmsOutboundMutation =
          binding.lastOutboundMutationId !== null &&
          mappedProjectStatus === workItem.status;
        const outboundRace =
          binding.lastOutboundMutationId !== null &&
          mappedProjectStatus !== null &&
          mappedProjectStatus !== workItem.status;
        providerStatusMismatch ||= outboundRace;
        const evidence = observedEvidence(
          binding.externalVersion,
          item.externalVersion,
          new Date(),
          outboundRace
            ? {state: 'conflict', conflictReason: 'outbound_race'}
            : confirmsOutboundMutation
              ? {state: 'confirmed'}
              : binding.lastOutboundMutationId !== null
                ? {state: 'pending_confirmation'}
                : undefined
        );
        const [updatedBinding] = await tx.update(schema.trackerBindings).set({
          externalVersion: item.externalVersion,
          ...evidence,
          lastInboundVersion: item.externalVersion,
          ...(confirmsOutboundMutation ? {lastOutboundMutationId: null} : {}),
          metadata: issueMetadata(input.snapshot, item),
          updatedAt: new Date()
        }).where(and(
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, taskTrackerProvider),
          eq(schema.trackerBindings.surface, 'issue'),
          eq(schema.trackerBindings.externalId, item.externalId),
          eq(schema.trackerBindings.entityId, workItemId)
        )).returning({id: schema.trackerBindings.id});
        if (updatedBinding === undefined) {
          unknownWorkItemExternalIds.push(item.externalId);
          continue;
        }
        if (workItem.title !== item.title) {
          const [updatedWorkItem] = await tx.update(schema.workItems)
            .set({title: item.title, updatedAt: new Date()})
            .where(and(
              eq(schema.workItems.id, workItemId),
              eq(schema.workItems.projectId, input.projectId)
            ))
            .returning({id: schema.workItems.id});
          if (updatedWorkItem === undefined) {
            throw new Error('tracker_snapshot_work_item_disappeared');
          }
          updatedWorkItems += 1;
        }
        if (item.projectStatus !== null && item.projectStatus.status === null) {
          unknownProjectStatusWorkItemExternalIds.push(item.externalId);
          continue;
        }
        if (adoptsInitialProjectStatus && mappedProjectStatus !== null) {
          if (mappedProjectStatus !== workItem.status) {
            const [updatedWorkItem] = await tx.update(schema.workItems).set({
              status: mappedProjectStatus,
              version: sql`${schema.workItems.version} + 1`,
              updatedAt: new Date()
            }).where(and(
              eq(schema.workItems.id, workItemId),
              eq(schema.workItems.projectId, input.projectId),
              eq(schema.workItems.version, workItem.version)
            )).returning({id: schema.workItems.id});
            if (updatedWorkItem === undefined) {
              throw new Error('tracker_snapshot_work_item_version_conflict');
            }
            updatedWorkItemStatuses += 1;
          }
          continue;
        }
        if (mappedProjectStatus !== null) {
          await tx.insert(schema.trackerStatusObservationInbox).values({
            id: randomUUID(),
            snapshotOperationId: input.operationId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            bindingId: binding.id,
            workItemId,
            actorId: input.actorId,
            correlationId: input.correlationId,
            provider: taskTrackerProvider,
            mappedStatus: mappedProjectStatus,
            expectedCanonicalVersion: workItem.version,
            bindingInboundVersion: item.externalVersion,
            ...(binding.lastOutboundMutationId === null
              ? {}
              : {outboundMutationId: binding.lastOutboundMutationId}),
            ...(confirmsOutboundMutation || mappedProjectStatus === workItem.status
              ? {state: 'acknowledged' as const}
              : outboundRace
                ? {state: 'conflict' as const, conflictCode: 'outbound_race'}
                : {})
          });
        }
      }

      for (const binding of canonicalIssueBindings.map(({binding}) => binding)) {
        const metadata = binding.metadata as Record<string, unknown>;
        if (
          observedWorkItemExternalIds.has(binding.externalId) ||
          metadata.repositoryExternalId !== input.snapshot.repository.externalId
        ) continue;
        await tx.update(schema.trackerBindings).set({
          evidenceState: 'missing',
          conflictReason: null,
          confirmedAt: null,
          updatedAt: new Date()
        }).where(and(
          eq(schema.trackerBindings.id, binding.id),
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, taskTrackerProvider)
        ));
      }

      const pullRequestBindings = await tx
        .select()
        .from(schema.trackerBindings)
        .where(and(
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, repositoryProvider),
          eq(schema.trackerBindings.surface, 'pull_request'),
          eq(schema.trackerBindings.entityType, 'pr_link')
        ));
      const canonicalPullRequestBindings = await tx
        .select({
          binding: schema.trackerBindings
        })
        .from(schema.trackerBindings)
        .innerJoin(
          schema.prLinks,
          eq(schema.prLinks.id, schema.trackerBindings.entityId)
        )
        .innerJoin(
          schema.workItems,
          and(
            eq(schema.workItems.id, schema.prLinks.workItemId),
            eq(schema.workItems.projectId, input.projectId)
          )
        )
        .where(and(
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, repositoryProvider),
          eq(schema.trackerBindings.surface, 'pull_request'),
          eq(schema.trackerBindings.entityType, 'pr_link')
        ))
        .for('update');
      const rawPullRequestExternalIds = new Set(
        pullRequestBindings.map(({externalId}) => externalId)
      );
      const canonicalPullRequestIds = new Map(
        canonicalPullRequestBindings.map(
          ({binding}) => [binding.externalId, binding.entityId]
        )
      );
      const mappedPullRequestIds = new Map<string, string>();
      const unmappablePullRequestExternalIds: string[] = [];
      const ambiguousPullRequestExternalIds: string[] = [];
      let projectedPullRequests = 0;
      const observedPullRequestExternalIds = new Set(
        input.snapshot.pullRequests.map(({externalId}) => externalId)
      );

      for (const pullRequest of input.snapshot.pullRequests) {
        if (pullRequest.linkedWorkItemExternalIds.length > 1) {
          ambiguousPullRequestExternalIds.push(pullRequest.externalId);
          continue;
        }
        const mappedWorkItemId = workItemIds.get(
          pullRequest.linkedWorkItemExternalIds[0] ?? ''
        );
        if (mappedWorkItemId === undefined) {
          unmappablePullRequestExternalIds.push(pullRequest.externalId);
          continue;
        }
        let prLinkId = canonicalPullRequestIds.get(pullRequest.externalId);
        if (
          prLinkId === undefined &&
          !rawPullRequestExternalIds.has(pullRequest.externalId)
        ) {
          prLinkId = randomUUID();
          await tx.insert(schema.prLinks).values({
            id: prLinkId,
            workItemId: mappedWorkItemId,
            provider: repositoryProvider,
            repositoryRef:
              `${input.snapshot.repository.owner}/${input.snapshot.repository.name}`,
            externalId: pullRequest.externalId,
            externalVersion: pullRequest.externalVersion,
            url: pullRequest.url,
            headRef: pullRequest.headRef,
            baseRef: pullRequest.baseRef,
            state: pullRequest.state,
            draft: pullRequest.draft,
            ...observedEvidence(null, pullRequest.externalVersion, new Date())
          });
          await tx.insert(schema.trackerBindings).values({
            projectId: input.projectId,
            provider: repositoryProvider,
            surface: 'pull_request',
            externalId: pullRequest.externalId,
            entityType: 'pr_link',
            entityId: prLinkId,
            externalVersion: pullRequest.externalVersion,
            ...observedEvidence(null, pullRequest.externalVersion, new Date()),
            lastInboundVersion: pullRequest.externalVersion,
            metadata: pullRequestMetadata(input.snapshot, pullRequest)
          });
          canonicalPullRequestIds.set(pullRequest.externalId, prLinkId);
        }
        if (prLinkId === undefined) {
          unmappablePullRequestExternalIds.push(pullRequest.externalId);
          continue;
        }
        const previousBinding = pullRequestBindings.find(
          ({externalId, entityId}) =>
            externalId === pullRequest.externalId && entityId === prLinkId
        );
        const evidence = observedEvidence(
          previousBinding?.externalVersion,
          pullRequest.externalVersion,
          new Date()
        );
        const [updatedPullRequest] = await tx.update(schema.prLinks).set({
          workItemId: mappedWorkItemId,
          repositoryRef:
            `${input.snapshot.repository.owner}/${input.snapshot.repository.name}`,
          externalVersion: pullRequest.externalVersion,
          url: pullRequest.url,
          headRef: pullRequest.headRef,
          baseRef: pullRequest.baseRef,
          state: pullRequest.state,
          draft: pullRequest.draft,
          ...evidence,
          updatedAt: new Date()
        }).where(eq(schema.prLinks.id, prLinkId))
          .returning({id: schema.prLinks.id});
        if (updatedPullRequest === undefined) {
          unmappablePullRequestExternalIds.push(pullRequest.externalId);
          canonicalPullRequestIds.delete(pullRequest.externalId);
          continue;
        }
        const [updatedBinding] = await tx.update(schema.trackerBindings).set({
          externalVersion: pullRequest.externalVersion,
          ...evidence,
          lastInboundVersion: pullRequest.externalVersion,
          metadata: pullRequestMetadata(input.snapshot, pullRequest),
          updatedAt: new Date()
        }).where(and(
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, repositoryProvider),
          eq(schema.trackerBindings.surface, 'pull_request'),
          eq(schema.trackerBindings.externalId, pullRequest.externalId),
          eq(schema.trackerBindings.entityId, prLinkId)
        )).returning({id: schema.trackerBindings.id});
        if (updatedBinding === undefined) {
          unmappablePullRequestExternalIds.push(pullRequest.externalId);
          canonicalPullRequestIds.delete(pullRequest.externalId);
          continue;
        }
        mappedPullRequestIds.set(pullRequest.externalId, prLinkId);
        projectedPullRequests += 1;
      }

      for (const {binding} of canonicalPullRequestBindings) {
        const metadata = binding.metadata as Record<string, unknown>;
        if (
          observedPullRequestExternalIds.has(binding.externalId) ||
          metadata.repositoryExternalId !== input.snapshot.repository.externalId
        ) continue;
        const missing = {
          evidenceState: 'missing' as const,
          conflictReason: null,
          confirmedAt: null,
          updatedAt: new Date()
        };
        await tx.update(schema.trackerBindings).set(missing).where(and(
          eq(schema.trackerBindings.id, binding.id),
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, repositoryProvider)
        ));
        await tx.update(schema.prLinks).set(missing).where(and(
          eq(schema.prLinks.id, binding.entityId),
          eq(schema.prLinks.provider, repositoryProvider),
          eq(schema.prLinks.externalId, binding.externalId)
        ));
      }

      const checkBindings = await tx
        .select()
        .from(schema.trackerBindings)
        .where(and(
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, repositoryProvider),
          eq(schema.trackerBindings.surface, 'check'),
          eq(schema.trackerBindings.entityType, 'build_check')
        ));
      const canonicalCheckBindings = await tx
        .select({
          binding: schema.trackerBindings
        })
        .from(schema.trackerBindings)
        .innerJoin(
          schema.buildChecks,
          eq(schema.buildChecks.id, schema.trackerBindings.entityId)
        )
        .innerJoin(
          schema.prLinks,
          eq(schema.prLinks.id, schema.buildChecks.prLinkId)
        )
        .innerJoin(
          schema.workItems,
          and(
            eq(schema.workItems.id, schema.prLinks.workItemId),
            eq(schema.workItems.projectId, input.projectId)
          )
        )
        .where(and(
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, repositoryProvider),
          eq(schema.trackerBindings.surface, 'check'),
          eq(schema.trackerBindings.entityType, 'build_check')
        ))
        .for('update');
      const rawCheckExternalIds = new Set(
        checkBindings.map(({externalId}) => externalId)
      );
      const checkIds = new Map(
        canonicalCheckBindings.map(
          ({binding}) => [binding.externalId, binding.entityId]
        )
      );
      const unknownCheckExternalIds: string[] = [];
      let projectedChecks = 0;
      const observedCheckExternalIds = new Set(
        input.snapshot.checks.map(({externalId}) => externalId)
      );

      for (const check of input.snapshot.checks) {
        const prLinkId = mappedPullRequestIds.get(check.pullRequestExternalId);
        if (prLinkId === undefined) {
          unknownCheckExternalIds.push(check.externalId);
          continue;
        }
        let checkId = checkIds.get(check.externalId);
        if (checkId === undefined && rawCheckExternalIds.has(check.externalId)) {
          unknownCheckExternalIds.push(check.externalId);
          continue;
        }
        if (checkId === undefined) {
          checkId = randomUUID();
          await tx.insert(schema.buildChecks).values({
            id: checkId,
            prLinkId,
            provider: repositoryProvider,
            externalId: check.externalId,
            externalVersion: check.externalVersion,
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
            detailsUrl: check.detailsUrl,
            ...observedEvidence(null, check.externalVersion, new Date())
          });
          await tx.insert(schema.trackerBindings).values({
            projectId: input.projectId,
            provider: repositoryProvider,
            surface: 'check',
            externalId: check.externalId,
            entityType: 'build_check',
            entityId: checkId,
            externalVersion: check.externalVersion,
            ...observedEvidence(null, check.externalVersion, new Date()),
            lastInboundVersion: check.externalVersion,
            metadata: checkMetadata(input.snapshot, check)
          });
          checkIds.set(check.externalId, checkId);
        } else {
          const previousBinding = checkBindings.find(
            ({externalId, entityId}) =>
              externalId === check.externalId && entityId === checkId
          );
          const evidence = observedEvidence(
            previousBinding?.externalVersion,
            check.externalVersion,
            new Date()
          );
          const [updatedCheck] = await tx.update(schema.buildChecks).set({
            prLinkId,
            externalVersion: check.externalVersion,
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
            detailsUrl: check.detailsUrl,
            ...evidence,
            updatedAt: new Date()
          }).where(eq(schema.buildChecks.id, checkId))
            .returning({id: schema.buildChecks.id});
          if (updatedCheck === undefined) {
            unknownCheckExternalIds.push(check.externalId);
            continue;
          }
          const [updatedBinding] = await tx.update(schema.trackerBindings).set({
            externalVersion: check.externalVersion,
            ...evidence,
            lastInboundVersion: check.externalVersion,
            metadata: checkMetadata(input.snapshot, check),
            updatedAt: new Date()
          }).where(and(
            eq(schema.trackerBindings.projectId, input.projectId),
            eq(schema.trackerBindings.provider, repositoryProvider),
            eq(schema.trackerBindings.surface, 'check'),
            eq(schema.trackerBindings.externalId, check.externalId),
            eq(schema.trackerBindings.entityId, checkId)
          )).returning({id: schema.trackerBindings.id});
          if (updatedBinding === undefined) {
            unknownCheckExternalIds.push(check.externalId);
            continue;
          }
        }
        projectedChecks += 1;
      }

      for (const {binding} of canonicalCheckBindings) {
        const metadata = binding.metadata as Record<string, unknown>;
        if (
          observedCheckExternalIds.has(binding.externalId) ||
          metadata.repositoryExternalId !== input.snapshot.repository.externalId
        ) continue;
        const stale = {
          evidenceState: 'stale' as const,
          conflictReason: null,
          confirmedAt: null,
          updatedAt: new Date()
        };
        await tx.update(schema.trackerBindings).set(stale).where(and(
          eq(schema.trackerBindings.id, binding.id),
          eq(schema.trackerBindings.projectId, input.projectId),
          eq(schema.trackerBindings.provider, repositoryProvider)
        ));
        await tx.update(schema.buildChecks).set(stale).where(and(
          eq(schema.buildChecks.id, binding.entityId),
          eq(schema.buildChecks.provider, repositoryProvider),
          eq(schema.buildChecks.externalId, binding.externalId)
        ));
      }

      if (repositoryBinding === undefined) {
        await tx.insert(schema.trackerBindings).values({
          projectId: input.projectId,
          provider: repositoryProvider,
          surface: 'repository',
          externalId: input.snapshot.repository.externalId,
          entityType: 'project',
          entityId: input.projectId,
          externalVersion: input.snapshot.repository.externalVersion,
          ...observedEvidence(
            null,
            input.snapshot.repository.externalVersion,
            new Date()
          ),
          lastInboundVersion: input.snapshot.externalVersion,
          metadata: repositoryMetadata(input.snapshot)
        });
      } else {
        await tx.update(schema.trackerBindings).set({
          externalVersion: input.snapshot.repository.externalVersion,
          ...observedEvidence(
            repositoryBinding.externalVersion,
            input.snapshot.repository.externalVersion,
            new Date()
          ),
          lastInboundVersion: input.snapshot.externalVersion,
          metadata: repositoryMetadata(input.snapshot),
          updatedAt: new Date()
        }).where(eq(schema.trackerBindings.id, repositoryBinding.id));
      }

      const result: AppliedResult = {
        status: 'applied',
        snapshotExternalVersion: input.snapshot.externalVersion,
        createdWorkItems,
        updatedWorkItems,
        updatedWorkItemStatuses,
        projectedPullRequests,
        projectedChecks,
        unknownWorkItemExternalIds,
        unknownProjectStatusWorkItemExternalIds,
        unmappablePullRequestExternalIds,
        ambiguousPullRequestExternalIds,
        unknownCheckExternalIds
      };
      await record(result);
        return result;
      });
    } catch {
      throw new Error('tracker_snapshot_projection_failed');
    }
  };

  return {
    bootstrap: (input: Omit<TrackerSnapshotBootstrapInput, 'mode'>) =>
      project({...input, mode: 'bootstrap'}),
    synchronize: (input: Omit<TrackerSnapshotSynchronizationInput, 'mode'>) =>
      project({...input, mode: 'synchronize'})
  };
};
