import {createHash, randomUUID} from 'node:crypto';
import {
  decideAsconNextAction,
  type TrackerRepositorySnapshot,
  type TrackerSnapshotProjectionInput,
  type TrackerSnapshotProjectionResult,
  type TrackerSnapshotProjector
} from '@fai-control-plane/domain';
import {and, eq, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type TerminalResult = Exclude<TrackerSnapshotProjectionResult, {status: 'replayed'}>;

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
): string => `sha256:${createHash('sha256').update(canonical(input)).digest('hex')}`;

const validateInput = (input: TrackerSnapshotProjectionInput): void => {
  const required = [
    input.operationId,
    input.workspaceId,
    input.projectId,
    input.actorId,
    input.correlationId,
    input.provider,
    input.snapshot.repository.externalId,
    input.snapshot.externalVersion
  ];
  const unique = (values: readonly string[]): boolean =>
    new Set(values).size === values.length;
  if (
    required.some((value) => value.length === 0) ||
    !unique(input.snapshot.projectItems.map(({externalId}) => externalId)) ||
    !unique(input.snapshot.projectItems.map(({issueExternalId}) => issueExternalId)) ||
    !unique(input.snapshot.pullRequests.map(({externalId}) => externalId)) ||
    !unique(input.snapshot.checks.map(({externalId}) => externalId))
  ) throw new Error('tracker_snapshot_input_invalid');
};

const decisionsFor = (snapshot: TrackerRepositorySnapshot) =>
  snapshot.repository.owner === 'VF78' && snapshot.repository.name === 'ascon'
    ? snapshot.projectItems.map(decideAsconNextAction)
    : [];

const repositoryMetadata = (snapshot: TrackerRepositorySnapshot): Record<string, unknown> => ({
  owner: snapshot.repository.owner,
  name: snapshot.repository.name,
  defaultBranch: snapshot.repository.defaultBranch,
  headSha: snapshot.repository.headSha
});

const advisoryLock = async (
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  scope: string
): Promise<void> => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope}, 0))`);
};

export const createPostgresTrackerSnapshotProjector = (
  db: Database
): TrackerSnapshotProjector => {
  const project = async (
    input: TrackerSnapshotProjectionInput
  ): Promise<TrackerSnapshotProjectionResult> => {
    validateInput(input);
    const requestHash = trackerSnapshotProjectionRequestHash(input);

    return db.transaction(async (tx) => {
      await advisoryLock(tx, `tracker-snapshot-operation:${input.workspaceId}:${input.operationId}`);
      const [previousOperation] = await tx.select({
        requestHash: schema.trackerSnapshotOperations.requestHash,
        result: schema.trackerSnapshotOperations.result,
        projectId: schema.trackerSnapshotOperations.projectId,
        repositoryExternalId: schema.trackerSnapshotOperations.repositoryExternalId
      }).from(schema.trackerSnapshotOperations).where(and(
        eq(schema.trackerSnapshotOperations.workspaceId, input.workspaceId),
        eq(schema.trackerSnapshotOperations.id, input.operationId)
      ));
      if (previousOperation !== undefined) {
        if (previousOperation.requestHash === requestHash) {
          return {status: 'replayed', result: previousOperation.result as TerminalResult};
        }
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          projectId: previousOperation.projectId,
          actorId: null,
          commandId: `tracker-snapshot-reuse:${input.operationId}:${requestHash}`,
          actionCategory: 'write',
          action: 'tracker_snapshot.idempotency_reuse',
          targetType: 'tracker_repository',
          targetId: previousOperation.repositoryExternalId,
          outcome: 'rejected',
          reasonCode: 'IDEMPOTENCY_KEY_REUSED',
          correlationId: input.correlationId,
          occurredAt: new Date()
        }).onConflictDoNothing({
          target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]
        });
        return {status: 'conflict', code: 'idempotency_key_reused'};
      }

      const [[projectRow], [actorRow]] = await Promise.all([
        tx.select({id: schema.projects.id}).from(schema.projects).where(and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.workspaceId, input.workspaceId)
        )),
        tx.select({id: schema.actors.id}).from(schema.actors).where(and(
          eq(schema.actors.id, input.actorId),
          eq(schema.actors.workspaceId, input.workspaceId)
        ))
      ]);
      if (projectRow === undefined || actorRow === undefined) {
        throw new Error('tracker_snapshot_scope_invalid');
      }

      await advisoryLock(tx, [
        'tracker-snapshot-repository', input.workspaceId, input.projectId, input.provider
      ].join(':'));
      const [binding] = await tx.select().from(schema.trackerBindings).where(and(
        eq(schema.trackerBindings.projectId, input.projectId),
        eq(schema.trackerBindings.provider, input.provider),
        eq(schema.trackerBindings.surface, 'repository'),
        eq(schema.trackerBindings.entityType, 'project'),
        eq(schema.trackerBindings.entityId, input.projectId)
      )).for('update');

      let result: TerminalResult;
      if (binding !== undefined && binding.externalId !== input.snapshot.repository.externalId) {
        result = {status: 'conflict', code: 'repository_identity_conflict'};
      } else if (input.mode === 'bootstrap' && binding !== undefined) {
        result = {
          status: 'conflict', code: 'bootstrap_already_completed',
          ...(binding.lastInboundVersion === null
            ? {}
            : {currentExternalVersion: binding.lastInboundVersion})
        };
      } else if (input.mode === 'synchronize' && binding === undefined) {
        result = {status: 'conflict', code: 'bootstrap_required'};
      } else if (
        input.mode === 'synchronize' &&
        binding?.lastInboundVersion !== input.expectedPreviousExternalVersion &&
        binding?.lastInboundVersion !== input.snapshot.externalVersion
      ) {
        result = {
          status: 'conflict', code: 'stale_snapshot',
          ...(binding?.lastInboundVersion === null || binding?.lastInboundVersion === undefined
            ? {}
            : {currentExternalVersion: binding.lastInboundVersion})
        };
      } else {
        const decisions = decisionsFor(input.snapshot);
        const unchanged = binding?.lastInboundVersion === input.snapshot.externalVersion;
        result = {
          status: unchanged ? 'unchanged' : 'applied',
          snapshotExternalVersion: input.snapshot.externalVersion,
          snapshot: input.snapshot,
          decisions
        };
        const now = new Date();
        if (binding === undefined) {
          await tx.insert(schema.trackerBindings).values({
            projectId: input.projectId,
            provider: input.provider,
            surface: 'repository',
            externalId: input.snapshot.repository.externalId,
            entityType: 'project',
            entityId: input.projectId,
            externalVersion: input.snapshot.repository.externalVersion,
            observedAt: now,
            confirmedAt: unchanged ? now : null,
            evidenceState: unchanged ? 'confirmed' : 'observed',
            lastInboundVersion: input.snapshot.externalVersion,
            metadata: repositoryMetadata(input.snapshot)
          });
        } else {
          await tx.update(schema.trackerBindings).set({
            externalVersion: input.snapshot.repository.externalVersion,
            observedAt: now,
            confirmedAt: unchanged ? now : null,
            evidenceState: unchanged ? 'confirmed' : 'observed',
            conflictReason: null,
            lastInboundVersion: input.snapshot.externalVersion,
            metadata: repositoryMetadata(input.snapshot),
            updatedAt: now
          }).where(eq(schema.trackerBindings.id, binding.id));
        }
      }

      await tx.insert(schema.trackerSnapshotOperations).values({
        id: input.operationId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        provider: input.provider,
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
        outcome: result.status === 'conflict' ? 'failed' : 'succeeded',
        reasonCode: result.status === 'conflict' ? result.code.toUpperCase() : null,
        correlationId: input.correlationId,
        occurredAt: new Date()
      });
      return result;
    });
  };

  return {
    bootstrap: (input) => project({...input, mode: 'bootstrap'}),
    synchronize: (input) => project({...input, mode: 'synchronize'})
  };
};
