import type {
  OpaqueSecretRef,
  TrackerAdapter,
  TrackerWorkItemTransitionInput
} from '@fai-control-plane/domain';
import {workItemStatuses} from '@fai-control-plane/domain';
import {and, eq, lte, or, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type WritePayload = Omit<TrackerWorkItemTransitionInput, 'credentialRef'> & Readonly<{version: 1}>;
type ClaimedEvent = Readonly<{
  id: string;
  workspaceId: string;
  projectId: string | null;
  status: 'pending' | 'publishing';
  payload: WritePayload;
  attemptCount: number;
  updatedAt: Date;
}>;

export type GitHubProjectStatusPublisherResult =
  | Readonly<{status: 'idle'}>
  | Readonly<{status: 'published'; eventId: string}>
  | Readonly<{status: 'retryable'; eventId: string}>
  | Readonly<{status: 'failed'; eventId: string; code: string}>;

const maximumAttempts = 4;
const leaseMs = 60_000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const providerIdPattern = /^[A-Za-z0-9_:-]{1,512}$/;

const retryDelayMs = (attemptCount: number): number =>
  Math.min(60_000, 1_000 * (2 ** Math.min(attemptCount, 6)));

const payload = (value: Record<string, unknown>): WritePayload | null => {
  const expected = value.expected;
  const target = value.target;
  if (
    value.version !== 1 || typeof value.bindingId !== 'string' ||
    typeof value.workItemId !== 'string' || !Number.isSafeInteger(value.canonicalVersion) ||
    typeof value.status !== 'string' || typeof value.mutationId !== 'string' ||
    expected === null || typeof expected !== 'object' || Array.isArray(expected) ||
    target === null || typeof target !== 'object' || Array.isArray(target)
  ) return null;
  const expectedValue = expected as Record<string, unknown>;
  const targetValue = target as Record<string, unknown>;
  if (
    !uuidPattern.test(value.bindingId) ||
    !uuidPattern.test(value.workItemId) ||
    !uuidPattern.test(value.mutationId) ||
    typeof value.canonicalVersion !== 'number' ||
    value.canonicalVersion < 1 ||
    !workItemStatuses.includes(value.status as WritePayload['status']) ||
    (expectedValue.bindingExternalVersion !== null && typeof expectedValue.bindingExternalVersion !== 'string') ||
    (expectedValue.providerOptionId !== null && typeof expectedValue.providerOptionId !== 'string') ||
    typeof targetValue.repositoryExternalId !== 'string' ||
    !/^github:repository:[1-9][0-9]{0,19}$/.test(targetValue.repositoryExternalId) ||
    typeof targetValue.projectExternalId !== 'string' ||
    !providerIdPattern.test(targetValue.projectExternalId) ||
    typeof targetValue.projectItemExternalId !== 'string' ||
    !providerIdPattern.test(targetValue.projectItemExternalId) ||
    typeof targetValue.fieldExternalId !== 'string' ||
    !providerIdPattern.test(targetValue.fieldExternalId)
  ) return null;
  return {
    version: 1,
    bindingId: value.bindingId,
    workItemId: value.workItemId,
    canonicalVersion: value.canonicalVersion as number,
    status: value.status as WritePayload['status'],
    expectedBindingVersion: expectedValue.bindingExternalVersion as string | null,
    expectedProviderOptionId: expectedValue.providerOptionId as string | null,
    target: {
      repositoryExternalId: targetValue.repositoryExternalId,
      projectExternalId: targetValue.projectExternalId,
      projectItemExternalId: targetValue.projectItemExternalId,
      fieldExternalId: targetValue.fieldExternalId
    },
    mutationId: value.mutationId
  };
};

const receiptPayload = (outcome: string): Record<string, string> => ({outcome});

export const createPostgresGitHubProjectStatusPublisher = (
  db: Database,
  adapter: Pick<TrackerAdapter, 'transitionWorkItem'>,
  credentialRef: OpaqueSecretRef,
  now: () => Date = () => new Date()
): Readonly<{publishAvailable(): Promise<GitHubProjectStatusPublisherResult>}> => ({
  async publishAvailable(): Promise<GitHubProjectStatusPublisherResult> {
    return db.transaction(async (tx): Promise<GitHubProjectStatusPublisherResult> => {
      const current = now();
      const [candidate] = await tx.select().from(schema.outboxEvents).where(and(
        eq(schema.outboxEvents.destination, 'github'),
        eq(schema.outboxEvents.eventType, 'github.project_status.write.v1'),
        or(
          and(eq(schema.outboxEvents.status, 'pending'), lte(schema.outboxEvents.availableAt, current)),
          and(eq(schema.outboxEvents.status, 'publishing'), lte(schema.outboxEvents.availableAt, current))
        )
      )).orderBy(schema.outboxEvents.availableAt, schema.outboxEvents.createdAt)
        .limit(1).for('update', {skipLocked: true});
      if (candidate === undefined) return {status: 'idle'};
      const parsed = payload(candidate.payload);
      const failInitial = async (
        code: string,
        outcome: string
      ): Promise<GitHubProjectStatusPublisherResult> => {
        await tx.update(schema.outboxEvents).set({
          status: 'failed', failureCode: code, updatedAt: now(),
          payload: {...candidate.payload, providerReceipt: receiptPayload(outcome)}
        }).where(and(
          eq(schema.outboxEvents.id, candidate.id),
          eq(schema.outboxEvents.status, candidate.status)
        ));
        return {status: 'failed', eventId: candidate.id, code};
      };
      if (parsed === null) return failInitial('github_project_status_payload_invalid', 'identity_denied');
      const claimAt = now();
      const [claimedRow] = await tx.update(schema.outboxEvents).set({
        status: 'publishing',
        attemptCount: sql`${schema.outboxEvents.attemptCount} + 1`,
        availableAt: new Date(claimAt.getTime() + leaseMs),
        updatedAt: claimAt
      }).where(and(
        eq(schema.outboxEvents.id, candidate.id),
        eq(schema.outboxEvents.status, candidate.status)
      )).returning({
        id: schema.outboxEvents.id,
        workspaceId: schema.outboxEvents.workspaceId,
        projectId: schema.outboxEvents.projectId,
        attemptCount: schema.outboxEvents.attemptCount,
        updatedAt: schema.outboxEvents.updatedAt
      });
      if (claimedRow === undefined) return {status: 'idle'};
      const claimed: ClaimedEvent = {
        ...claimedRow,
        status: candidate.status as ClaimedEvent['status'],
        payload: parsed
      };
      const fail = async (
        code: string,
        outcome: string
      ): Promise<GitHubProjectStatusPublisherResult> => {
        await tx.update(schema.outboxEvents).set({
          status: 'failed', failureCode: code, updatedAt: now(),
          payload: {...candidate.payload, providerReceipt: receiptPayload(outcome)}
        }).where(and(
          eq(schema.outboxEvents.id, claimed.id),
          eq(schema.outboxEvents.status, 'publishing'),
          eq(schema.outboxEvents.updatedAt, claimed.updatedAt)
        ));
        return {status: 'failed', eventId: claimed.id, code};
      };
      const [bound] = await tx.select({
        binding: schema.trackerBindings,
        workItem: schema.workItems,
        workspaceId: schema.projects.workspaceId
      }).from(schema.trackerBindings)
        .innerJoin(schema.workItems, and(
          eq(schema.workItems.id, schema.trackerBindings.entityId),
          eq(schema.workItems.projectId, schema.trackerBindings.projectId)
        ))
        .innerJoin(schema.projects, eq(schema.projects.id, schema.trackerBindings.projectId))
        .where(and(
          eq(schema.trackerBindings.id, parsed.bindingId),
          eq(schema.trackerBindings.provider, 'github'),
          eq(schema.trackerBindings.surface, 'issue'),
          eq(schema.trackerBindings.entityType, 'work_item'),
          eq(schema.trackerBindings.entityId, parsed.workItemId)
        )).for('update');
      if (
        bound === undefined || claimed.projectId !== bound.binding.projectId ||
        claimed.workspaceId !== bound.workspaceId
      ) return fail('github_project_status_identity_denied', 'identity_denied');
      const metadata = bound.binding.metadata as Record<string, unknown>;
      const projectStatus = metadata.projectStatus;
      const status = projectStatus !== null && typeof projectStatus === 'object' && !Array.isArray(projectStatus)
        ? projectStatus as Record<string, unknown>
        : null;
      if (status === null) return fail('github_project_status_identity_denied', 'identity_denied');
      const targetMatches = status !== null &&
        metadata.repositoryExternalId === parsed.target.repositoryExternalId &&
        status.projectExternalId === parsed.target.projectExternalId &&
        status.projectItemExternalId === parsed.target.projectItemExternalId &&
        status.fieldExternalId === parsed.target.fieldExternalId &&
        status.optionExternalId === parsed.expectedProviderOptionId;
      if (!targetMatches) return fail('github_project_status_identity_denied', 'identity_denied');
      if (
        bound.workItem.version !== parsed.canonicalVersion ||
        bound.workItem.status !== parsed.status ||
        bound.binding.externalVersion !== parsed.expectedBindingVersion ||
        bound.binding.lastOutboundMutationId !== parsed.mutationId
      ) return fail('github_project_status_stale', 'stale');
      const transitionWorkItem = adapter.transitionWorkItem;
      if (transitionWorkItem === undefined) {
        return fail('github_project_status_identity_denied', 'identity_denied');
      }
      let result: Awaited<ReturnType<typeof transitionWorkItem>>;
      try {
        result = await transitionWorkItem({...parsed, credentialRef});
      } catch {
        result = {status: 'retryable'};
      }
      if (result.status === 'retryable') {
        if (claimed.attemptCount >= maximumAttempts) {
          return fail('github_project_status_retry_exhausted', 'retry_exhausted');
        }
        await tx.update(schema.outboxEvents).set({
          status: 'pending', availableAt: new Date(now().getTime() + retryDelayMs(claimed.attemptCount)), updatedAt: now(),
          payload: {...candidate.payload, providerReceipt: receiptPayload('retryable')}
        }).where(and(
          eq(schema.outboxEvents.id, claimed.id),
          eq(schema.outboxEvents.status, 'publishing'),
          eq(schema.outboxEvents.updatedAt, claimed.updatedAt)
        ));
        return {status: 'retryable', eventId: claimed.id};
      }
      if (result.status !== 'confirmed') {
        return fail(
          result.status === 'stale' ? 'github_project_status_stale' : 'github_project_status_identity_denied',
          result.status
        );
      }
      if (
        result.receipt.verification !== 'read_after_write' ||
        result.receipt.projectItemExternalId !== parsed.target.projectItemExternalId ||
        result.receipt.clientMutationId !== parsed.mutationId
      ) return fail('github_project_status_identity_denied', 'identity_denied');
      const [updatedBinding] = await tx.update(schema.trackerBindings).set({
        metadata: {
          ...metadata,
          projectStatus: {
            ...status,
            optionExternalId: result.receipt.optionExternalId,
            status: parsed.status
          }
        },
        updatedAt: now()
      }).where(and(
        eq(schema.trackerBindings.id, bound.binding.id),
        eq(schema.trackerBindings.lastOutboundMutationId, parsed.mutationId)
      )).returning({id: schema.trackerBindings.id});
      if (updatedBinding === undefined) {
        return fail('github_project_status_stale', 'stale');
      }
      const [published] = await tx.update(schema.outboxEvents).set({
        status: 'published', publishedAt: now(), updatedAt: now(),
        payload: {...candidate.payload, providerReceipt: result.receipt}
      }).where(and(
        eq(schema.outboxEvents.id, claimed.id),
        eq(schema.outboxEvents.status, 'publishing'),
        eq(schema.outboxEvents.updatedAt, claimed.updatedAt)
      )).returning({id: schema.outboxEvents.id});
      return published === undefined
        ? {status: 'retryable', eventId: claimed.id}
        : {status: 'published', eventId: claimed.id};
    });
  }
});
