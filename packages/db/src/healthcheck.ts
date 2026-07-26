import {and, asc, desc, eq, inArray, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

export const HEALTHCHECK_QUEUE = 'healthcheck';
export const healthcheckCron = '*/5 * * * *';
export const healthcheckStaleAfterMs = 15 * 60 * 1_000;

const configuredProjectSlugs = ['msa', 'ascon'] as const;
const healthcheckName = 'healthcheck';

type Condition = Readonly<{
  code: 'github_status_writeback_failed' | 'tracker_sync_missing_or_stale';
  severity: 'yellow' | 'red';
  summary: string;
  details: Record<string, unknown>;
}>;

const reconcileSignal = async (
  tx: Parameters<Database['transaction']>[0] extends (tx: infer Transaction) => unknown
    ? Transaction
    : never,
  projectId: string,
  code: Condition['code'],
  condition: Condition | null,
  now: Date
): Promise<void> => {
  const signals = await tx.select().from(schema.riskSignals).where(and(
    eq(schema.riskSignals.projectId, projectId),
    eq(schema.riskSignals.code, code)
  )).orderBy(asc(schema.riskSignals.createdAt), asc(schema.riskSignals.id)).for('update');
  const active = signals.filter((signal) => signal.resolvedAt === null);

  if (condition === null) {
    if (active.length > 0) {
      await tx.update(schema.riskSignals).set({resolvedAt: now, updatedAt: now})
        .where(inArray(schema.riskSignals.id, active.map((signal) => signal.id)));
    }
    return;
  }

  const [primary, ...duplicates] = active;
  if (primary === undefined) {
    await tx.insert(schema.riskSignals).values({
      projectId,
      code: condition.code,
      severity: condition.severity,
      summary: condition.summary,
      details: condition.details,
      createdAt: now,
      updatedAt: now
    });
    return;
  }
  await tx.update(schema.riskSignals).set({
    severity: condition.severity,
    summary: condition.summary,
    details: condition.details,
    resolvedAt: null,
    updatedAt: now
  }).where(eq(schema.riskSignals.id, primary.id));
  if (duplicates.length > 0) {
    await tx.update(schema.riskSignals).set({resolvedAt: now, updatedAt: now})
      .where(inArray(schema.riskSignals.id, duplicates.map((signal) => signal.id)));
  }
};

export const createPostgresHealthcheckProducer = (
  db: Database,
  options: Readonly<{now?: () => Date; staleAfterMs?: number}> = {}
): Readonly<{run(): Promise<void>}> => {
  const now = options.now ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? healthcheckStaleAfterMs;

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
      let firstFailure: unknown;

      for (const {id: projectId} of configuredProjects) {
        const runAt = now();
        try {
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
              tx.select({createdAt: schema.trackerSnapshotOperations.createdAt})
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
                  severity: 'yellow',
                  summary: 'Tracker snapshot is missing or stale.',
                  details: latest === undefined
                    ? {state: 'missing'}
                    : {state: 'stale', latestSnapshotAt: latest.createdAt.toISOString()}
                }
              : null;
            const writebackCondition: Condition | null = failedWritebacks.length === 0 ? null : {
              code: 'github_status_writeback_failed',
              severity: 'red',
              summary: 'GitHub status write-back failed.',
              details: {
                failedOutboxEventIds: failedWritebacks.map((event) => event.id),
                failureCodes: failedWritebacks.map((event) => event.failureCode)
              }
            };
            await reconcileSignal(
              tx, projectId, 'tracker_sync_missing_or_stale', syncCondition, runAt
            );
            await reconcileSignal(
              tx, projectId, 'github_status_writeback_failed', writebackCondition, runAt
            );
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
