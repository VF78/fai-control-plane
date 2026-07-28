import type {
  CanonicalCommand,
  CommandError,
  CommandReceipt,
  TrustedActorContext
} from '@fai-control-plane/domain';
import {and, eq, lte, or} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {randomUUID} from 'node:crypto';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type CanonicalCommandExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: CommandReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;
type CanonicalCommandExecutor = Readonly<{
  execute(command: CanonicalCommand): Promise<CanonicalCommandExecution>;
}>;
type ClaimedObservation = typeof schema.trackerStatusObservationInbox.$inferSelect & Readonly<{
  processingToken: string;
}>;

export type TrackerStatusObservationProcessorResult =
  | Readonly<{status: 'idle'}>
  | Readonly<{status: 'applied'; observationId: string}>
  | Readonly<{status: 'acknowledged'; observationId: string}>
  | Readonly<{status: 'conflict'; observationId: string; code: string}>
  | Readonly<{status: 'retryable'; observationId: string}>;

const leaseMs = 60_000;

const conflictCode = (execution: CanonicalCommandExecution): string => {
  if (!('receipt' in execution)) {
    return execution.error.code.toLowerCase();
  }
  const result = execution.receipt.result;
  if (result.ok) return 'unexpected_success';
  return result.error.code === 'VERSION_CONFLICT'
    ? 'canonical_version_conflict'
    : result.error.code === 'INVALID_TRANSITION'
      ? 'invalid_transition'
      : result.error.code.toLowerCase();
};

export const createPostgresTrackerStatusObservationProcessor = (
  db: Database,
  commandService: CanonicalCommandExecutor,
  actor: TrustedActorContext,
  now: () => Date = () => new Date()
): Readonly<{processAvailable(): Promise<TrackerStatusObservationProcessorResult>}> => ({
  async processAvailable(): Promise<TrackerStatusObservationProcessorResult> {
    const claimed = await db.transaction(async (tx): Promise<ClaimedObservation | null> => {
      const current = now();
      const [candidate] = await tx.select()
        .from(schema.trackerStatusObservationInbox)
        .where(or(
          eq(schema.trackerStatusObservationInbox.state, 'pending'),
          and(
            eq(schema.trackerStatusObservationInbox.state, 'processing'),
            lte(schema.trackerStatusObservationInbox.processingLeaseExpiresAt, current)
          )
        ))
        .orderBy(schema.trackerStatusObservationInbox.createdAt)
        .limit(1)
        .for('update', {skipLocked: true});
      if (candidate === undefined) return null;
      const processingToken = randomUUID();
      const [updated] = await tx.update(schema.trackerStatusObservationInbox)
        .set({
          state: 'processing',
          processingToken,
          processingLeaseExpiresAt: new Date(current.getTime() + leaseMs)
        })
        .where(and(
          eq(schema.trackerStatusObservationInbox.id, candidate.id),
          eq(schema.trackerStatusObservationInbox.state, candidate.state)
        ))
        .returning();
      return updated === undefined ? null : {...updated, processingToken};
    });
    if (claimed === null) return {status: 'idle'};
    if (actor.actorId !== claimed.actorId) {
      const [completed] = await db.update(schema.trackerStatusObservationInbox).set({
        state: 'conflict',
        conflictCode: 'actor_mismatch',
        processingToken: null,
        processingLeaseExpiresAt: null,
        processedAt: now()
      }).where(and(
        eq(schema.trackerStatusObservationInbox.id, claimed.id),
        eq(schema.trackerStatusObservationInbox.state, 'processing'),
        eq(schema.trackerStatusObservationInbox.processingToken, claimed.processingToken)
      )).returning({id: schema.trackerStatusObservationInbox.id});
      return completed === undefined
        ? {status: 'retryable', observationId: claimed.id}
        : {
            status: 'conflict',
            observationId: claimed.id,
            code: 'actor_mismatch'
          };
    }

    let execution: CanonicalCommandExecution;
    try {
      execution = await commandService.execute({
        commandId: claimed.id,
        workspaceId: claimed.workspaceId,
        correlationId: claimed.correlationId,
        idempotencyKey: `tracker-status-observation:${claimed.id}`,
        issuedAt: claimed.createdAt.toISOString(),
        actor,
        type: 'work_item.transition',
        payload: {
          workItemId: claimed.workItemId,
          status: claimed.mappedStatus,
          expectedVersion: claimed.expectedCanonicalVersion
        }
      });
    } catch {
      return {status: 'retryable', observationId: claimed.id};
    }

    const applied = (execution.status === 'completed' || execution.status === 'replayed') &&
      execution.receipt.result.ok;
    const code = applied ? null : conflictCode(execution);
    const terminalState = applied ? 'applied' as const : 'conflict' as const;
    const [completed] = await db.update(schema.trackerStatusObservationInbox).set({
      state: terminalState,
      conflictCode: code,
      processingToken: null,
      processingLeaseExpiresAt: null,
      processedAt: now()
    }).where(and(
      eq(schema.trackerStatusObservationInbox.id, claimed.id),
      eq(schema.trackerStatusObservationInbox.state, 'processing'),
      eq(schema.trackerStatusObservationInbox.processingToken, claimed.processingToken)
    )).returning({id: schema.trackerStatusObservationInbox.id});
    if (completed === undefined) return {status: 'retryable', observationId: claimed.id};
    return applied
      ? {status: 'applied', observationId: claimed.id}
      : {status: 'conflict', observationId: claimed.id, code: code!};
  }
});
