import {and, asc, eq, inArray, lte, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {fromDrizzle} from 'pg-boss';
import {INCOMING_EVENT_QUEUE, type PgBossTransactionalSender} from './incoming-event-inbox';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

export const RECOVERY_SCAN_QUEUE = 'recovery-scan';
export const recoveryScanCron = '*/5 * * * *';

const configuredProjectSlugs = ['msa', 'ascon'] as const;
const recoveryScanName = 'recovery_scan';
const maximumIncomingEventAttempts = 5;
const recoveryExhaustedCode = 'incoming_event_recovery_exhausted';

type Condition = Readonly<{
  severity: 'red';
  summary: string;
  details: Record<string, unknown>;
}>;

const reconcileSignal = async (
  tx: Parameters<Database['transaction']>[0] extends (tx: infer Transaction) => unknown
    ? Transaction
    : never,
  projectId: string,
  condition: Condition | null,
  now: Date
): Promise<void> => {
  const signals = await tx.select().from(schema.riskSignals).where(and(
    eq(schema.riskSignals.projectId, projectId),
    eq(schema.riskSignals.code, recoveryExhaustedCode)
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
      code: recoveryExhaustedCode,
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

export const createPostgresRecoveryScanProducer = (
  db: Database,
  boss: PgBossTransactionalSender,
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
      let firstFailure: unknown;

      for (const {id: projectId} of configuredProjects) {
        const runAt = now();
        try {
          await db.transaction(async (tx) => {
            await tx.select({id: schema.projects.id}).from(schema.projects)
              .where(eq(schema.projects.id, projectId)).for('update');
            await tx.insert(schema.scheduledJobs).values({
              projectId,
              name: recoveryScanName,
              cron: recoveryScanCron,
              queueName: RECOVERY_SCAN_QUEUE,
              status: 'active',
              nextRunAt: new Date(runAt.getTime() + 5 * 60 * 1_000),
              lastRunAt: runAt,
              heartbeatAt: runAt
            }).onConflictDoUpdate({
              target: [schema.scheduledJobs.projectId, schema.scheduledJobs.name],
              set: {
                cron: recoveryScanCron,
                queueName: RECOVERY_SCAN_QUEUE,
                status: 'active',
                nextRunAt: new Date(runAt.getTime() + 5 * 60 * 1_000),
                lastRunAt: runAt,
                heartbeatAt: runAt,
                updatedAt: runAt
              }
            });

            const expired = await tx.select({
              id: schema.incomingEvents.id,
              processingToken: schema.incomingEvents.processingToken,
              attemptCount: schema.incomingEvents.attemptCount
            }).from(schema.incomingEvents).where(and(
              eq(schema.incomingEvents.projectId, projectId),
              eq(schema.incomingEvents.provider, 'github'),
              eq(schema.incomingEvents.status, 'processing'),
              lte(schema.incomingEvents.processingLeaseExpiresAt, runAt)
            )).orderBy(asc(schema.incomingEvents.id)).for('update', {skipLocked: true});

            for (const event of expired) {
              if (event.processingToken === null) continue;
              if (event.attemptCount >= maximumIncomingEventAttempts) {
                await tx.update(schema.incomingEvents).set({
                  status: 'failed',
                  processingToken: null,
                  processingLeaseExpiresAt: null,
                  failureCode: recoveryExhaustedCode
                }).where(and(
                  eq(schema.incomingEvents.id, event.id),
                  eq(schema.incomingEvents.status, 'processing'),
                  eq(schema.incomingEvents.processingToken, event.processingToken),
                  lte(schema.incomingEvents.processingLeaseExpiresAt, runAt)
                ));
                continue;
              }
              const recovered = await tx.update(schema.incomingEvents).set({
                status: 'pending',
                processingToken: null,
                processingLeaseExpiresAt: null,
                failureCode: null
              }).where(and(
                eq(schema.incomingEvents.id, event.id),
                eq(schema.incomingEvents.status, 'processing'),
                eq(schema.incomingEvents.processingToken, event.processingToken),
                lte(schema.incomingEvents.processingLeaseExpiresAt, runAt)
              )).returning({id: schema.incomingEvents.id});
              if (recovered.length !== 1) continue;
              const jobId = await boss.send(
                INCOMING_EVENT_QUEUE,
                {eventId: event.id},
                {db: fromDrizzle(tx, sql)}
              );
              if (jobId === null) throw new Error('Incoming event recovery enqueue failed.');
            }

            const exhausted = await tx.select({id: schema.incomingEvents.id})
              .from(schema.incomingEvents).where(and(
                eq(schema.incomingEvents.projectId, projectId),
                eq(schema.incomingEvents.provider, 'github'),
                eq(schema.incomingEvents.status, 'failed'),
                eq(schema.incomingEvents.failureCode, recoveryExhaustedCode)
              )).orderBy(asc(schema.incomingEvents.id));
            await reconcileSignal(tx, projectId, exhausted.length === 0 ? null : {
              severity: 'red',
              summary: 'Incoming event recovery retries are exhausted.',
              details: {incomingEventIds: exhausted.map((event) => event.id)}
            }, runAt);
            await tx.update(schema.scheduledJobs).set({
              status: 'active',
              lastSuccessAt: runAt,
              retryCount: 0,
              heartbeatAt: runAt,
              updatedAt: runAt
            }).where(and(
              eq(schema.scheduledJobs.projectId, projectId),
              eq(schema.scheduledJobs.name, recoveryScanName)
            ));
          });
        } catch (error) {
          await db.insert(schema.scheduledJobs).values({
            projectId,
            name: recoveryScanName,
            cron: recoveryScanCron,
            queueName: RECOVERY_SCAN_QUEUE,
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
