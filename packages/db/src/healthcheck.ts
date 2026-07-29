import {and, asc, desc, eq, inArray, isNull, lt, ne, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {
  reconcileRiskSignal,
  reconcileRiskSignalSet,
  type RiskSignalCondition,
  type RiskSignalSetMember
} from './risk-signal';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

export const HEALTHCHECK_QUEUE = 'healthcheck';
export const healthcheckCron = '*/5 * * * *';
export const healthcheckStaleAfterMs = 15 * 60 * 1_000;
export const activeWorkItemStaleAfterMs = 7 * 24 * 60 * 60 * 1_000;
export const pendingApprovalStaleAfterMs = 24 * 60 * 60 * 1_000;

const configuredProjectSlugs = ['msa', 'ascon'] as const;
const healthcheckName = 'healthcheck';
const activeWorkItemStatuses = new Set(['in_dev', 'qa', 'acceptance']);
const deadlineOverdueRuleId = 'delivery_deadline_overdue';
const staleWorkItemRuleId = 'active_work_item_stale';
const staleApprovalRuleId = 'pending_approval_stale';
const blockedUnownedRuleId = 'blocked_work_item_unowned';

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

            const latestSnapshot = await tx.select({
              id: schema.trackerSnapshotOperations.id,
              createdAt: schema.trackerSnapshotOperations.createdAt
            }).from(schema.trackerSnapshotOperations).where(and(
              eq(schema.trackerSnapshotOperations.projectId, projectId),
              eq(schema.trackerSnapshotOperations.provider, 'github'),
              sql`${schema.trackerSnapshotOperations.result}->>'status' = 'applied'`
            )).orderBy(desc(schema.trackerSnapshotOperations.createdAt)).limit(1);
            const failedWritebacks = await tx.select({
              id: schema.outboxEvents.id,
              failureCode: schema.outboxEvents.failureCode
            }).from(schema.outboxEvents).where(and(
              eq(schema.outboxEvents.projectId, projectId),
              eq(schema.outboxEvents.destination, 'github'),
              eq(schema.outboxEvents.eventType, 'github.project_status.write.v1'),
              eq(schema.outboxEvents.status, 'failed')
            )).orderBy(asc(schema.outboxEvents.id));
            const overdueMilestones = await tx.select({
              id: schema.milestones.id,
              targetAt: schema.milestones.targetAt
            }).from(schema.milestones).where(and(
              eq(schema.milestones.projectId, projectId),
              isNull(schema.milestones.closedAt),
              lt(schema.milestones.targetAt, runAt)
            )).orderBy(asc(schema.milestones.id));
            const overdueDeliveryJourneys = await tx.select({
              workItemId: schema.deliveryJourneys.workItemId,
              deadlineAt: schema.deliveryJourneys.deadlineAt,
              status: schema.workItems.status,
              ownerActorId: schema.workItems.ownerActorId
            }).from(schema.deliveryJourneys)
              .innerJoin(
                schema.workItems,
                eq(schema.workItems.id, schema.deliveryJourneys.workItemId)
              )
              .where(and(
                eq(schema.workItems.projectId, projectId),
                isNull(schema.workItems.deletedAt),
                ne(schema.workItems.status, 'done'),
                lt(schema.deliveryJourneys.deadlineAt, runAt)
              )).orderBy(asc(schema.deliveryJourneys.workItemId));
            const openWorkItems = await tx.select({
              id: schema.workItems.id,
              status: schema.workItems.status,
              blocked: schema.workItems.blocked,
              ownerActorId: schema.workItems.ownerActorId,
              updatedAt: schema.workItems.updatedAt
            }).from(schema.workItems).where(and(
              eq(schema.workItems.projectId, projectId),
              isNull(schema.workItems.deletedAt),
              ne(schema.workItems.status, 'done')
            )).orderBy(asc(schema.workItems.id));
            const staleApprovals = await tx.select({
              id: schema.approvalRequests.id,
              workItemId: schema.approvalRequests.workItemId,
              agentRunId: schema.approvalRequests.agentRunId,
              createdAt: schema.approvalRequests.createdAt
            }).from(schema.approvalRequests).where(and(
              eq(schema.approvalRequests.projectId, projectId),
              eq(schema.approvalRequests.status, 'pending'),
              lt(
                schema.approvalRequests.createdAt,
                new Date(runAt.getTime() - pendingApprovalStaleAfterMs)
              )
            )).orderBy(asc(schema.approvalRequests.id));
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
            const overdueDeadlineMembers: RiskSignalSetMember[] = [
              ...overdueMilestones.map((milestone) => ({
                deduplicationKey: `${deadlineOverdueRuleId}:milestone:${milestone.id}`,
                condition: {
                  code: deadlineOverdueRuleId,
                  ruleId: deadlineOverdueRuleId,
                  ruleVersion: '1',
                  signalClass: 'fact' as const,
                  severity: 'red' as const,
                  summary: 'Milestone deadline is overdue.',
                  details: {
                    entityType: 'milestone',
                    entityId: milestone.id,
                    deadlineAt: milestone.targetAt!.toISOString()
                  },
                  evidenceReferences: [{type: 'milestone', id: milestone.id}],
                  impact: 'The project has passed an open delivery commitment.',
                  nextAction: 'replan_or_close_overdue_deadline'
                }
              })),
              ...overdueDeliveryJourneys.map((journey) => ({
                workItemId: journey.workItemId,
                deduplicationKey:
                  `${deadlineOverdueRuleId}:delivery_journey:${journey.workItemId}`,
                condition: {
                  code: deadlineOverdueRuleId,
                  ruleId: deadlineOverdueRuleId,
                  ruleVersion: '1',
                  signalClass: 'fact' as const,
                  severity: 'red' as const,
                  summary: 'Delivery deadline is overdue.',
                  details: {
                    entityType: 'delivery_journey',
                    entityId: journey.workItemId,
                    deadlineAt: journey.deadlineAt!.toISOString(),
                    workItemStatus: journey.status
                  },
                  evidenceReferences: [{
                    type: 'delivery_journey',
                    id: journey.workItemId
                  }],
                  impact: 'Active delivery work has passed its canonical deadline.',
                  ownerActorId: journey.ownerActorId,
                  nextAction: 'replan_or_close_overdue_deadline'
                }
              }))
            ];
            const staleWorkItemMembers: RiskSignalSetMember[] = openWorkItems
              .filter((item) =>
                activeWorkItemStatuses.has(item.status) &&
                runAt.getTime() - item.updatedAt.getTime() > activeWorkItemStaleAfterMs
              )
              .map((item) => ({
                workItemId: item.id,
                deduplicationKey: `${staleWorkItemRuleId}:work_item:${item.id}`,
                condition: {
                  code: staleWorkItemRuleId,
                  ruleId: staleWorkItemRuleId,
                  ruleVersion: '1',
                  signalClass: 'inference',
                  severity: 'yellow',
                  summary: 'Active work item is stale.',
                  details: {
                    workItemId: item.id,
                    workItemStatus: item.status,
                    lastUpdatedAt: item.updatedAt.toISOString(),
                    staleAfterHours: activeWorkItemStaleAfterMs / 3_600_000
                  },
                  evidenceReferences: [{type: 'work_item', id: item.id}],
                  impact: 'Active delivery work may no longer reflect current progress.',
                  ownerActorId: item.ownerActorId,
                  nextAction: 'review_stale_work_item'
                }
              }));
            const staleApprovalMembers: RiskSignalSetMember[] = staleApprovals.map(
              (approval) => ({
                workItemId: approval.workItemId,
                agentRunId: approval.agentRunId,
                deduplicationKey: `${staleApprovalRuleId}:approval:${approval.id}`,
                condition: {
                  code: staleApprovalRuleId,
                  ruleId: staleApprovalRuleId,
                  ruleVersion: '1',
                  signalClass: 'fact',
                  severity: 'yellow',
                  summary: 'Pending approval is older than 24 hours.',
                  details: {
                    approvalRequestId: approval.id,
                    requestedAt: approval.createdAt.toISOString(),
                    staleAfterHours: pendingApprovalStaleAfterMs / 3_600_000
                  },
                  evidenceReferences: [{
                    type: 'approval_request',
                    id: approval.id
                  }],
                  impact: 'Governed delivery work is waiting on an overdue decision.',
                  nextAction: 'decide_or_cancel_pending_approval'
                }
              })
            );
            const blockedUnownedMembers: RiskSignalSetMember[] = openWorkItems
              .filter((item) => item.blocked && item.ownerActorId === null)
              .map((item) => ({
                workItemId: item.id,
                deduplicationKey: `${blockedUnownedRuleId}:work_item:${item.id}`,
                condition: {
                  code: blockedUnownedRuleId,
                  ruleId: blockedUnownedRuleId,
                  ruleVersion: '1',
                  signalClass: 'fact',
                  severity: 'red',
                  summary: 'Blocked work item has no owner.',
                  details: {
                    workItemId: item.id,
                    workItemStatus: item.status
                  },
                  evidenceReferences: [{type: 'work_item', id: item.id}],
                  impact: 'A delivery blocker has no accountable owner.',
                  nextAction: 'assign_owner_to_blocked_work_item'
                }
              }));
            await reconcileRiskSignalSet(tx, {
              projectId,
              ruleId: deadlineOverdueRuleId,
              observedAt: runAt,
              members: overdueDeadlineMembers
            });
            await reconcileRiskSignalSet(tx, {
              projectId,
              ruleId: staleWorkItemRuleId,
              observedAt: runAt,
              members: staleWorkItemMembers
            });
            await reconcileRiskSignalSet(tx, {
              projectId,
              ruleId: staleApprovalRuleId,
              observedAt: runAt,
              members: staleApprovalMembers
            });
            await reconcileRiskSignalSet(tx, {
              projectId,
              ruleId: blockedUnownedRuleId,
              observedAt: runAt,
              members: blockedUnownedMembers
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
