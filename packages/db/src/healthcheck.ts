import {and, asc, desc, eq, inArray, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {reconcileRiskSignal, type RiskSignalCondition} from './risk-signal';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

export const HEALTHCHECK_QUEUE = 'healthcheck';
export const healthcheckCron = '*/5 * * * *';
export const healthcheckStaleAfterMs = 15 * 60 * 1_000;

const configuredProjectSlugs = ['msa', 'ascon'] as const;
const healthcheckName = 'healthcheck';

type Condition = RiskSignalCondition & Readonly<{
  code: 'github_status_writeback_failed' | 'queue_work_failed' | 'tracker_sync_missing_or_stale';
}>;

export const createPostgresHealthcheckProducer = (
  db: Database,
  options: Readonly<{
    now?: () => Date;
    staleAfterMs?: number;
    queueFailures?: () => Promise<readonly Readonly<{queueName: string; failedCount: number}>[]>;
  }> = {}
): Readonly<{run(): Promise<void>}> => {
  const now = options.now ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? healthcheckStaleAfterMs;
  const queueFailures = options.queueFailures ?? (async () => []);

  return {
    async run(): Promise<void> {
      const configuredProjects = await db.select({id: schema.projects.id}).from(schema.projects)
        .innerJoin(schema.projectTrackerRepositoryScopes, and(
          eq(schema.projectTrackerRepositoryScopes.projectId, schema.projects.id),
          eq(schema.projectTrackerRepositoryScopes.provider, 'github')
        ))
        .where(inArray(schema.projects.slug, configuredProjectSlugs))
        .groupBy(schema.projects.id)
        .orderBy(asc(schema.projects.id));
      let failedQueuesPromise: Promise<
        readonly Readonly<{queueName: string; failedCount: number}>[]
      > | undefined;
      let firstFailure: unknown;

      for (const {id: projectId} of configuredProjects) {
        const runAt = now();
        try {
          const failedQueues = await (failedQueuesPromise ??= queueFailures().then((queues) =>
            queues.filter((queue) => queue.failedCount > 0)
              .sort((left, right) => left.queueName.localeCompare(right.queueName))
          ));
          await db.transaction(async (tx) => {
            await tx.select({id: schema.projects.id}).from(schema.projects)
              .where(eq(schema.projects.id, projectId)).for('update');
            await tx.insert(schema.scheduledJobs).values({
              projectId,
              name: healthcheckName,
              cron: healthcheckCron,
              queueName: HEALTHCHECK_QUEUE,
              status: 'active',
              nextRunAt: new Date(runAt.getTime() + 5 * 60 * 1_000),
              lastRunAt: runAt,
              heartbeatAt: runAt
            }).onConflictDoUpdate({
              target: [schema.scheduledJobs.projectId, schema.scheduledJobs.name],
              set: {
                cron: healthcheckCron,
                queueName: HEALTHCHECK_QUEUE,
                status: 'active',
                nextRunAt: new Date(runAt.getTime() + 5 * 60 * 1_000),
                lastRunAt: runAt,
                heartbeatAt: runAt,
                updatedAt: runAt
              }
            });

            const [latestSnapshot, failedWritebacks] = await Promise.all([
              tx.select({
                id: schema.trackerSnapshotOperations.id,
                createdAt: schema.trackerSnapshotOperations.createdAt
              })
                .from(schema.trackerSnapshotOperations).where(and(
                  eq(schema.trackerSnapshotOperations.projectId, projectId),
                  eq(schema.trackerSnapshotOperations.provider, 'github'),
                  sql`${schema.trackerSnapshotOperations.result}->>'status' = 'applied'`
                )).orderBy(desc(schema.trackerSnapshotOperations.createdAt)).limit(1),
              tx.select({
                id: schema.outboxEvents.id,
                failureCode: schema.outboxEvents.failureCode
              }).from(schema.outboxEvents).where(and(
                eq(schema.outboxEvents.projectId, projectId),
                eq(schema.outboxEvents.destination, 'github'),
                eq(schema.outboxEvents.eventType, 'github.project_status.write.v1'),
                eq(schema.outboxEvents.status, 'failed')
              )).orderBy(asc(schema.outboxEvents.id))
            ]);
            const staleBefore = new Date(runAt.getTime() - staleAfterMs);
            const latest = latestSnapshot[0];
            const syncCondition: Condition | null = latest === undefined || latest.createdAt < staleBefore
              ? {
                  code: 'tracker_sync_missing_or_stale',
                  ruleId: 'tracker_sync_missing_or_stale',
                  ruleVersion: '1',
                  signalClass: 'inference',
                  severity: 'yellow',
                  summary: 'Tracker snapshot is missing or stale.',
                  details: latest === undefined
                    ? {state: 'missing'}
                    : {state: 'stale', latestSnapshotAt: latest.createdAt.toISOString()},
                  evidenceReferences: latest === undefined
                    ? []
                    : [{type: 'tracker_snapshot_operation', id: latest.id}],
                  impact: 'Delivery state may be based on stale tracker data.',
                  nextAction: 'refresh_tracker_snapshot'
                }
              : null;
            const writebackCondition: Condition | null = failedWritebacks.length === 0 ? null : {
              code: 'github_status_writeback_failed',
              ruleId: 'github_status_writeback_failed',
              ruleVersion: '1',
              signalClass: 'fact',
              severity: 'red',
              summary: 'GitHub status write-back failed.',
              details: {
                failedOutboxEventIds: failedWritebacks.map((event) => event.id),
                failureCodes: failedWritebacks.map((event) => event.failureCode)
              },
              evidenceReferences: failedWritebacks.map((event) => ({
                type: 'outbox_event',
                id: event.id
              })),
              impact: 'Canonical delivery status was not published to the tracker.',
              nextAction: 'inspect_failed_status_writeback'
            };
            const queueCondition: Condition | null = failedQueues.length === 0 ? null : {
              code: 'queue_work_failed',
              ruleId: 'queue_work_failed',
              ruleVersion: '1',
              signalClass: 'fact',
              severity: 'red',
              summary: 'Worker queue has permanently failed work.',
              details: {
                queues: failedQueues,
              },
              evidenceReferences: failedQueues.map((queue) => ({
                type: 'worker_queue',
                id: queue.queueName
              })),
              impact: 'Required asynchronous control-plane work is not completing.',
              nextAction: 'inspect_failed_queue_jobs'
            };
            await reconcileRiskSignal(tx, {
              projectId,
              deduplicationKey: 'tracker_sync_missing_or_stale',
              observedAt: runAt,
              condition: syncCondition
            });
            await reconcileRiskSignal(tx, {
              projectId,
              deduplicationKey: 'github_status_writeback_failed',
              observedAt: runAt,
              condition: writebackCondition
            });
            await reconcileRiskSignal(tx, {
              projectId,
              deduplicationKey: 'queue_work_failed',
              observedAt: runAt,
              condition: queueCondition
            });
            await tx.update(schema.scheduledJobs).set({
              status: 'active',
              lastSuccessAt: runAt,
              retryCount: 0,
              heartbeatAt: runAt,
              updatedAt: runAt
            }).where(and(
              eq(schema.scheduledJobs.projectId, projectId),
              eq(schema.scheduledJobs.name, healthcheckName)
            ));
          });
        } catch (error) {
          await db.insert(schema.scheduledJobs).values({
            projectId,
            name: healthcheckName,
            cron: healthcheckCron,
            queueName: HEALTHCHECK_QUEUE,
            status: 'unhealthy',
            nextRunAt: new Date(runAt.getTime() + 5 * 60 * 1_000),
            lastRunAt: runAt,
            retryCount: 1,
            heartbeatAt: runAt
          }).onConflictDoUpdate({
            target: [schema.scheduledJobs.projectId, schema.scheduledJobs.name],
            set: {
              status: 'unhealthy',
              retryCount: sql`${schema.scheduledJobs.retryCount} + 1`,
              nextRunAt: new Date(runAt.getTime() + 5 * 60 * 1_000),
              lastRunAt: runAt,
              heartbeatAt: runAt,
              updatedAt: runAt
            }
          });
          firstFailure ??= error;
        }
      }
      if (firstFailure !== undefined) throw firstFailure;
    }
  };
};
