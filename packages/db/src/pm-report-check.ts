import {and, asc, eq, inArray, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {reconcileRiskSignal} from './risk-signal';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

export const PM_REPORT_CHECK_QUEUE = 'pm-report-check';
// pg-boss evaluates cron expressions in UTC; this runs daily at 09:10 UTC.
export const pmReportCheckCron = '10 9 * * *';

const configuredProjectSlugs = ['msa', 'ascon'] as const;
const pmReportCheckName = 'pm_report_check';
const missingReportCode = 'daily_pm_report_missing';

const nextPmReportCheckRunAt = (runAt: Date): Date => {
  const next = new Date(Date.UTC(
    runAt.getUTCFullYear(), runAt.getUTCMonth(), runAt.getUTCDate(), 9, 10, 0, 0
  ));
  if (next <= runAt) next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const reportDateFor = (runAt: Date): string => runAt.toISOString().slice(0, 10);

export const createPostgresPmReportCheckProducer = (
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
            await tx.insert(schema.scheduledJobs).values({
              projectId,
              name: pmReportCheckName,
              cron: pmReportCheckCron,
              queueName: PM_REPORT_CHECK_QUEUE,
              status: 'active',
              nextRunAt: nextPmReportCheckRunAt(runAt),
              lastRunAt: runAt,
              heartbeatAt: runAt
            }).onConflictDoUpdate({
              target: [schema.scheduledJobs.projectId, schema.scheduledJobs.name],
              set: {
                cron: pmReportCheckCron,
                queueName: PM_REPORT_CHECK_QUEUE,
                status: 'active',
                nextRunAt: nextPmReportCheckRunAt(runAt),
                lastRunAt: runAt,
                heartbeatAt: runAt,
                updatedAt: runAt
              }
            });
            const [report] = await tx.select({id: schema.dailyPmReports.id})
              .from(schema.dailyPmReports).where(and(
                eq(schema.dailyPmReports.projectId, projectId),
                eq(schema.dailyPmReports.reportDate, reportDateFor(runAt))
              )).limit(1);
            await reconcileRiskSignal(tx, {
              projectId,
              deduplicationKey: missingReportCode,
              observedAt: runAt,
              condition: report !== undefined ? null : {
                code: missingReportCode,
                ruleId: missingReportCode,
                ruleVersion: '1',
                signalClass: 'inference',
                severity: 'yellow',
                summary: 'Daily PM report is missing.',
                details: {
                  reportDate: reportDateFor(runAt),
                  reportExists: false,
                  observedAt: runAt.toISOString()
                },
                evidenceReferences: [],
                impact: 'Operators lack the expected daily delivery summary.',
                nextAction: 'generate_daily_pm_report'
              }
            });
            await tx.update(schema.scheduledJobs).set({
              status: 'active',
              lastSuccessAt: runAt,
              retryCount: 0,
              heartbeatAt: runAt,
              updatedAt: runAt
            }).where(and(
              eq(schema.scheduledJobs.projectId, projectId),
              eq(schema.scheduledJobs.name, pmReportCheckName)
            ));
          });
        } catch (error) {
          await db.insert(schema.scheduledJobs).values({
            projectId,
            name: pmReportCheckName,
            cron: pmReportCheckCron,
            queueName: PM_REPORT_CHECK_QUEUE,
            status: 'unhealthy',
            nextRunAt: nextPmReportCheckRunAt(runAt),
            lastRunAt: runAt,
            retryCount: 1,
            heartbeatAt: runAt
          }).onConflictDoUpdate({
            target: [schema.scheduledJobs.projectId, schema.scheduledJobs.name],
            set: {
              status: 'unhealthy',
              retryCount: sql`${schema.scheduledJobs.retryCount} + 1`,
              nextRunAt: nextPmReportCheckRunAt(runAt),
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
