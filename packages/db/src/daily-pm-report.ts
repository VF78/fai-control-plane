import {and, asc, desc, eq, inArray, isNull, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Database['transaction']>[0] extends (
  tx: infer Value
) => unknown ? Value : never;

export const DAILY_PM_REPORT_QUEUE = 'daily-pm-report';
// pg-boss evaluates cron expressions in UTC; this runs daily at 09:00 UTC.
export const dailyPmReportCron = '0 9 * * *';
export const dailyPmReportSnapshotStaleAfterMs = 15 * 60 * 1_000;

const configuredProjectSlugs = ['msa', 'ascon'] as const;
const dailyPmReportName = 'daily_pm_report';
const workItemStatuses = ['backlog', 'ready', 'in_dev', 'qa', 'acceptance', 'done'] as const;
const riskSeverities = ['green', 'yellow', 'red'] as const;

const nextDailyPmReportRunAt = (runAt: Date): Date => {
  const next = new Date(Date.UTC(
    runAt.getUTCFullYear(), runAt.getUTCMonth(), runAt.getUTCDate(), 9, 0, 0, 0
  ));
  if (next <= runAt) next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const reportDateFor = (runAt: Date): string => runAt.toISOString().slice(0, 10);

const buildPayload = async (
  tx: Transaction,
  projectId: string,
  runAt: Date
): Promise<schema.DailyPmReportPayload> => {
  const workItemRows = await tx.select({
    status: schema.workItems.status,
    count: sql<number>`count(*)::int`
  }).from(schema.workItems).where(and(
    eq(schema.workItems.projectId, projectId),
    isNull(schema.workItems.deletedAt)
  )).groupBy(schema.workItems.status);
  const riskRows = await tx.select({
    severity: schema.riskSignals.severity,
    count: sql<number>`count(*)::int`
  }).from(schema.riskSignals).where(and(
    eq(schema.riskSignals.projectId, projectId),
    isNull(schema.riskSignals.resolvedAt)
  )).groupBy(schema.riskSignals.severity);
  const [approvals] = await tx.select({count: sql<number>`count(*)::int`})
    .from(schema.approvalRequests).where(and(
      eq(schema.approvalRequests.projectId, projectId),
      eq(schema.approvalRequests.status, 'pending')
    ));
  const [failedWritebacks] = await tx.select({count: sql<number>`count(*)::int`})
    .from(schema.outboxEvents).where(and(
      eq(schema.outboxEvents.projectId, projectId),
      eq(schema.outboxEvents.destination, 'github'),
      eq(schema.outboxEvents.eventType, 'github.project_status.write.v1'),
      eq(schema.outboxEvents.status, 'failed')
    ));
  const [latest] = await tx.select({createdAt: schema.trackerSnapshotOperations.createdAt})
    .from(schema.trackerSnapshotOperations).where(and(
      eq(schema.trackerSnapshotOperations.projectId, projectId),
      eq(schema.trackerSnapshotOperations.provider, 'github'),
      sql`${schema.trackerSnapshotOperations.result}->>'status' = 'applied'`
    )).orderBy(desc(schema.trackerSnapshotOperations.createdAt)).limit(1);
  const [blocked] = await tx.select({count: sql<number>`count(*)::int`})
    .from(schema.workItems).where(and(
      eq(schema.workItems.projectId, projectId),
      eq(schema.workItems.blocked, true),
      isNull(schema.workItems.deletedAt)
    ));
  const statusCounts = Object.fromEntries(workItemStatuses.map((status) => [status, 0])) as
    Record<(typeof workItemStatuses)[number], number>;
  for (const row of workItemRows) statusCounts[row.status] = row.count;
  const unresolvedCountsBySeverity = Object.fromEntries(
    riskSeverities.map((severity) => [severity, 0])
  ) as Record<(typeof riskSeverities)[number], number>;
  for (const row of riskRows) unresolvedCountsBySeverity[row.severity] = row.count;
  const latestAt = latest?.createdAt.toISOString() ?? null;

  return {
    schemaVersion: 1,
    timezone: 'UTC',
    reportDate: reportDateFor(runAt),
    generatedAt: runAt.toISOString(),
    dataAsOf: runAt.toISOString(),
    workItems: {
      statusCounts,
      blockedCount: blocked?.count ?? 0
    },
    riskSignals: {unresolvedCountsBySeverity},
    approvals: {pendingCount: approvals?.count ?? 0},
    github: {
      failedWritebackCount: failedWritebacks?.count ?? 0,
      latestSuccessfulTrackerSnapshot: {
        at: latestAt,
        freshness: latest === undefined
          ? 'missing'
          : latest.createdAt < new Date(runAt.getTime() - dailyPmReportSnapshotStaleAfterMs)
            ? 'stale'
            : 'fresh'
      }
    }
  };
};

export const createPostgresDailyPmReportProducer = (
  db: Database,
  options: Readonly<{now?: () => Date}> = {}
): Readonly<{run(): Promise<void>}> => {
  const now = options.now ?? (() => new Date());

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
      const runAt = now();
      let firstFailure: unknown;

      for (const {id: projectId} of configuredProjects) {
        try {
          await db.transaction(async (tx) => {
            await tx.select({id: schema.projects.id}).from(schema.projects)
              .where(eq(schema.projects.id, projectId)).for('update');
            const [existingReport] = await tx.select({id: schema.dailyPmReports.id})
              .from(schema.dailyPmReports).where(and(
                eq(schema.dailyPmReports.projectId, projectId),
                eq(schema.dailyPmReports.reportDate, reportDateFor(runAt))
              )).limit(1);
            if (existingReport !== undefined) {
              await tx.update(schema.scheduledJobs).set({
                cron: dailyPmReportCron,
                queueName: DAILY_PM_REPORT_QUEUE,
                status: 'active',
                nextRunAt: nextDailyPmReportRunAt(runAt),
                lastRunAt: runAt,
                lastSuccessAt: runAt,
                retryCount: 0,
                heartbeatAt: runAt,
                updatedAt: runAt
              }).where(and(
                eq(schema.scheduledJobs.projectId, projectId),
                eq(schema.scheduledJobs.name, dailyPmReportName)
              ));
              return;
            }
            await tx.insert(schema.scheduledJobs).values({
              projectId,
              name: dailyPmReportName,
              cron: dailyPmReportCron,
              queueName: DAILY_PM_REPORT_QUEUE,
              status: 'active',
              nextRunAt: nextDailyPmReportRunAt(runAt),
              lastRunAt: runAt,
              heartbeatAt: runAt
            }).onConflictDoUpdate({
              target: [schema.scheduledJobs.projectId, schema.scheduledJobs.name],
              set: {
                cron: dailyPmReportCron,
                queueName: DAILY_PM_REPORT_QUEUE,
                status: 'active',
                nextRunAt: nextDailyPmReportRunAt(runAt),
                lastRunAt: runAt,
                heartbeatAt: runAt,
                updatedAt: runAt
              }
            });
            await tx.insert(schema.dailyPmReports).values({
              projectId,
              reportDate: reportDateFor(runAt),
              payload: await buildPayload(tx, projectId, runAt),
              createdAt: runAt
            }).onConflictDoNothing({
              target: [schema.dailyPmReports.projectId, schema.dailyPmReports.reportDate]
            });
            await tx.update(schema.scheduledJobs).set({
              status: 'active',
              lastSuccessAt: runAt,
              retryCount: 0,
              heartbeatAt: runAt,
              updatedAt: runAt
            }).where(and(
              eq(schema.scheduledJobs.projectId, projectId),
              eq(schema.scheduledJobs.name, dailyPmReportName)
            ));
          });
        } catch (error) {
          await db.insert(schema.scheduledJobs).values({
            projectId,
            name: dailyPmReportName,
            cron: dailyPmReportCron,
            queueName: DAILY_PM_REPORT_QUEUE,
            status: 'unhealthy',
            nextRunAt: nextDailyPmReportRunAt(runAt),
            lastRunAt: runAt,
            retryCount: 1,
            heartbeatAt: runAt
          }).onConflictDoUpdate({
            target: [schema.scheduledJobs.projectId, schema.scheduledJobs.name],
            set: {
              status: 'unhealthy',
              retryCount: sql`${schema.scheduledJobs.retryCount} + 1`,
              nextRunAt: nextDailyPmReportRunAt(runAt),
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
