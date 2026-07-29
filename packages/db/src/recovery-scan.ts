import {randomUUID} from 'node:crypto';
import {and, asc, eq, inArray, lte, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {fromDrizzle} from 'pg-boss';
import {INCOMING_EVENT_QUEUE, type PgBossTransactionalSender} from './incoming-event-inbox';
import {reconcileRiskSignal} from './risk-signal';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

export const RECOVERY_SCAN_QUEUE = 'recovery-scan';
export const recoveryScanCron = '*/5 * * * *';

const configuredProjectSlugs = ['msa', 'ascon'] as const;
const recoveryScanName = 'recovery_scan';
const maximumIncomingEventAttempts = 5;
const recoveryExhaustedCode = 'incoming_event_recovery_exhausted';
const runnerLeaseExpiredCode = 'runner_lease_expired';

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

            const expiredRuns = await tx.select({
              id: schema.agentRuns.id,
              workspaceId: schema.projects.workspaceId,
              actorId: schema.actors.id,
              attempt: schema.agentRuns.attempt,
              version: schema.agentRuns.version
            }).from(schema.agentRuns)
              .innerJoin(schema.taskPackets, eq(schema.taskPackets.id, schema.agentRuns.taskPacketId))
              .innerJoin(schema.projects, eq(schema.projects.id, schema.taskPackets.projectId))
              .innerJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.agentRuns.agentProfileId))
              .innerJoin(schema.actors, eq(schema.actors.id, schema.agentProfiles.actorId))
              .where(and(
                eq(schema.taskPackets.projectId, projectId),
                eq(schema.agentRuns.status, 'running'),
                lte(schema.agentRuns.leaseExpiresAt, runAt)
              )).orderBy(asc(schema.agentRuns.id)).for('update', {
                of: schema.agentRuns,
                skipLocked: true
              });

            for (const run of expiredRuns) {
              const [terminalized] = await tx.update(schema.agentRuns).set({
                status: 'failed',
                completedAt: runAt,
                failureCode: runnerLeaseExpiredCode,
                runnerId: null,
                leaseTokenHash: null,
                leaseExpiresAt: null,
                version: sql`${schema.agentRuns.version} + 1`,
                updatedAt: runAt
              }).where(and(
                eq(schema.agentRuns.id, run.id),
                eq(schema.agentRuns.status, 'running'),
                eq(schema.agentRuns.version, run.version),
                lte(schema.agentRuns.leaseExpiresAt, runAt)
              )).returning({version: schema.agentRuns.version});
              if (terminalized === undefined) continue;
              const auditIdentity = `runner.lease_expired:${run.id}:attempt:${run.attempt}`;
              await tx.insert(schema.auditEvents).values({
                id: randomUUID(),
                workspaceId: run.workspaceId,
                projectId,
                actorId: run.actorId,
                commandId: auditIdentity,
                actionCategory: 'write',
                action: 'runner.lease_expired',
                targetType: 'agent_run',
                targetId: run.id,
                outcome: 'failed',
                reasonCode: runnerLeaseExpiredCode,
                expectedVersion: run.version,
                resultVersion: terminalized.version,
                correlationId: auditIdentity,
                occurredAt: runAt,
                metadata: {}
              });
            }

            const exhausted = await tx.select({id: schema.incomingEvents.id})
              .from(schema.incomingEvents).where(and(
                eq(schema.incomingEvents.projectId, projectId),
                eq(schema.incomingEvents.provider, 'github'),
                eq(schema.incomingEvents.status, 'failed'),
                eq(schema.incomingEvents.failureCode, recoveryExhaustedCode)
              )).orderBy(asc(schema.incomingEvents.id));
            await reconcileRiskSignal(tx, {
              projectId,
              deduplicationKey: recoveryExhaustedCode,
              observedAt: runAt,
              condition: exhausted.length === 0 ? null : {
                code: recoveryExhaustedCode,
                ruleId: recoveryExhaustedCode,
                ruleVersion: '1',
                signalClass: 'fact',
                severity: 'red',
                summary: 'Incoming event recovery retries are exhausted.',
                details: {incomingEventIds: exhausted.map((event) => event.id)},
                evidenceReferences: exhausted.map((event) => ({
                  type: 'incoming_event',
                  id: event.id
                })),
                impact: 'Inbound provider events are not reaching canonical processing.',
                nextAction: 'inspect_failed_incoming_events'
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
