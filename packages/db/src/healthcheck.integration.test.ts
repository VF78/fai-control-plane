import {randomUUID} from 'node:crypto';
import {and, eq, inArray, isNull} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  actors,
  activeWorkItemStaleAfterMs,
  approvalRequests,
  createDatabase,
  createPostgresHealthcheckProducer,
  deliveryJourneys,
  milestones,
  outboxEvents,
  pendingApprovalStaleAfterMs,
  projectTrackerRepositoryScopes,
  riskSignals,
  runbooks,
  scheduledJobs,
  secretRefs,
  trackerSnapshotOperations,
  workItems
} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_healthcheck_test_${randomUUID().replaceAll('-', '')}`;
const ids = {
  workspace: randomUUID(),
  project: randomUUID(),
  otherProject: randomUUID(),
  actor: randomUUID(),
  secret: randomUUID(),
  failedOutbox: randomUUID(),
  overdueMilestone: randomUUID(),
  boundaryMilestone: randomUUID(),
  otherMilestone: randomUUID(),
  protocol: randomUUID(),
  overdueJourneyWork: randomUUID(),
  staleWork: randomUUID(),
  boundaryWork: randomUUID(),
  blockedWork: randomUUID(),
  otherRiskWork: randomUUID(),
  staleApproval: randomUUID(),
  boundaryApproval: randomUUID(),
  otherApproval: randomUUID()
};

describePostgres('PostgreSQL healthcheck producer', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  let current = new Date('2026-07-26T12:00:00.000Z');
  let failedQueueCount = 2;

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!);
    adminUrl.pathname = '/postgres';
    adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(databaseUrl!);
    testUrl.pathname = `/${databaseName}`;
    const created = createDatabase(testUrl.toString());
    db = created.db;
    testPool = created.pool;
    await migrate(db, {migrationsFolder: new URL('../drizzle', import.meta.url).pathname});
    await testPool.query(
      `INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Workspace', $2)`,
      [ids.workspace, `workspace-${randomUUID()}`]
    );
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug) VALUES
       ($1, $2, 'MSA', 'msa'), ($3, $2, 'Ascon', 'ascon')`,
      [ids.project, ids.workspace, ids.otherProject]
    );
    await db.insert(secretRefs).values({
      id: ids.secret,
      workspaceId: ids.workspace,
      provider: 'test',
      reference: 'healthcheck',
      scope: []
    });
    await db.insert(actors).values({
      id: ids.actor,
      workspaceId: ids.workspace,
      type: 'human',
      role: 'workspace_admin',
      displayName: 'Healthcheck owner',
      authMode: 'user'
    });
    await db.insert(projectTrackerRepositoryScopes).values([
      {
        projectId: ids.project,
        provider: 'github',
        repositoryOwner: 'VF78',
        repositoryName: 'MSA',
        repositoryExternalId: 'github:repository:1278325372',
        credentialRefId: ids.secret
      },
      {
        projectId: ids.otherProject,
        provider: 'github',
        repositoryOwner: 'VF78',
        repositoryName: 'ascon',
        repositoryExternalId: 'github:repository:ascon',
        credentialRefId: ids.secret
      }
    ]);
    await db.insert(outboxEvents).values({
      id: ids.failedOutbox,
      workspaceId: ids.workspace,
      projectId: ids.project,
      destination: 'github',
      eventType: 'github.project_status.write.v1',
      idempotencyKey: `healthcheck-${randomUUID()}`,
      payload: {},
      status: 'failed',
      failureCode: 'github_project_status_retry_exhausted'
    });
    await db.insert(milestones).values([
      {
        id: ids.overdueMilestone,
        projectId: ids.project,
        title: 'Overdue milestone',
        targetAt: new Date(current.getTime() - 1)
      },
      {
        id: ids.boundaryMilestone,
        projectId: ids.project,
        title: 'Boundary milestone',
        targetAt: current
      },
      {
        id: ids.otherMilestone,
        projectId: ids.otherProject,
        title: 'Other project overdue milestone',
        targetAt: new Date(current.getTime() - 1)
      }
    ]);
    await db.insert(runbooks).values({
      id: ids.protocol,
      projectId: ids.project,
      name: 'Healthcheck delivery protocol',
      version: 1,
      definition: {}
    });
    await db.insert(workItems).values([
      {
        id: ids.overdueJourneyWork,
        projectId: ids.project,
        title: 'Overdue delivery journey',
        status: 'in_dev',
        ownerActorId: ids.actor,
        updatedAt: current
      },
      {
        id: ids.staleWork,
        projectId: ids.project,
        title: 'Stale active work',
        status: 'in_dev',
        ownerActorId: ids.actor,
        updatedAt: new Date(current.getTime() - activeWorkItemStaleAfterMs - 1)
      },
      {
        id: ids.boundaryWork,
        projectId: ids.project,
        title: 'Boundary active work',
        status: 'acceptance',
        updatedAt: new Date(current.getTime() - activeWorkItemStaleAfterMs)
      },
      {
        id: ids.blockedWork,
        projectId: ids.project,
        title: 'Blocked unowned work',
        status: 'ready',
        blocked: true,
        updatedAt: current
      },
      {
        id: ids.otherRiskWork,
        projectId: ids.otherProject,
        title: 'Other project risky work',
        status: 'in_dev',
        blocked: true,
        updatedAt: new Date(current.getTime() - activeWorkItemStaleAfterMs - 1)
      }
    ]);
    await db.insert(deliveryJourneys).values({
      workItemId: ids.overdueJourneyWork,
      protocolId: ids.protocol,
      protocolVersion: 1,
      stageKey: 'delivery',
      deadlineAt: new Date(current.getTime() - 1)
    });
    await db.insert(approvalRequests).values([
      {
        id: ids.staleApproval,
        projectId: ids.project,
        workItemId: ids.staleWork,
        actionCategory: 'write',
        surface: 'delivery',
        environment: 'internal',
        subjectHash: 'a'.repeat(64),
        policyVersion: 1,
        executionIdentity: ids.staleWork,
        actionHash: 'b'.repeat(64),
        requestedByActorId: ids.actor,
        expiresAt: new Date(current.getTime() - 1),
        createdAt: new Date(current.getTime() - pendingApprovalStaleAfterMs - 1),
        updatedAt: new Date(current.getTime() - pendingApprovalStaleAfterMs - 1)
      },
      {
        id: ids.boundaryApproval,
        projectId: ids.project,
        workItemId: ids.boundaryWork,
        actionCategory: 'write',
        surface: 'delivery',
        environment: 'internal',
        subjectHash: 'c'.repeat(64),
        policyVersion: 1,
        executionIdentity: ids.boundaryWork,
        actionHash: 'd'.repeat(64),
        requestedByActorId: ids.actor,
        expiresAt: current,
        createdAt: new Date(current.getTime() - pendingApprovalStaleAfterMs),
        updatedAt: new Date(current.getTime() - pendingApprovalStaleAfterMs)
      },
      {
        id: ids.otherApproval,
        projectId: ids.otherProject,
        workItemId: ids.otherRiskWork,
        actionCategory: 'write',
        surface: 'delivery',
        environment: 'internal',
        subjectHash: 'e'.repeat(64),
        policyVersion: 1,
        executionIdentity: ids.otherRiskWork,
        actionHash: 'f'.repeat(64),
        requestedByActorId: ids.actor,
        expiresAt: new Date(current.getTime() - 1),
        createdAt: new Date(current.getTime() - pendingApprovalStaleAfterMs - 1),
        updatedAt: new Date(current.getTime() - pendingApprovalStaleAfterMs - 1)
      }
    ]);
  });

  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try {
        await dropDatabaseWhenDisconnected(adminPool, databaseName);
      } finally {
        await adminPool.end();
      }
    }
  });

  it('creates once, refreshes idempotently, and resolves when confirmed facts clear', async () => {
    const producer = createPostgresHealthcheckProducer(db, {
      now: () => current,
      queueFailures: async () => [{queueName: 'qa-intake', failedCount: failedQueueCount}]
    });
    await producer.run();
    await producer.run();

    const active = await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.project),
      isNull(riskSignals.resolvedAt)
    ));
    expect(active.map((signal) => signal.code).sort()).toEqual([
      'active_work_item_stale',
      'blocked_work_item_unowned',
      'delivery_deadline_overdue',
      'delivery_deadline_overdue',
      'github_status_writeback_failed',
      'pending_approval_stale',
      'queue_work_failed',
      'tracker_sync_missing_or_stale'
    ]);
    expect(active.find((signal) => signal.code === 'github_status_writeback_failed'))
      .toEqual(expect.objectContaining({
        ruleId: 'github_status_writeback_failed',
        ruleVersion: '1',
        signalClass: 'fact',
        evidenceReferences: [{type: 'outbox_event', id: ids.failedOutbox}],
        impact: 'Canonical delivery status was not published to the tracker.',
        ownerActorId: null,
        nextAction: 'inspect_failed_status_writeback',
        observedAt: current,
        deduplicationKey: 'github_status_writeback_failed'
      }));
    expect(active.find((signal) =>
      signal.deduplicationKey ===
        `delivery_deadline_overdue:milestone:${ids.overdueMilestone}`
    )).toEqual(expect.objectContaining({
      workItemId: null,
      agentRunId: null,
      ruleId: 'delivery_deadline_overdue',
      ruleVersion: '1',
      signalClass: 'fact',
      evidenceReferences: [{type: 'milestone', id: ids.overdueMilestone}],
      ownerActorId: null,
      nextAction: 'replan_or_close_overdue_deadline',
      observedAt: current
    }));
    expect(active.find((signal) =>
      signal.deduplicationKey ===
        `delivery_deadline_overdue:delivery_journey:${ids.overdueJourneyWork}`
    )).toEqual(expect.objectContaining({
      workItemId: ids.overdueJourneyWork,
      signalClass: 'fact',
      evidenceReferences: [{
        type: 'delivery_journey',
        id: ids.overdueJourneyWork
      }],
      ownerActorId: ids.actor
    }));
    expect(active.find((signal) =>
      signal.deduplicationKey === `active_work_item_stale:work_item:${ids.staleWork}`
    )).toEqual(expect.objectContaining({
      workItemId: ids.staleWork,
      ruleVersion: '1',
      signalClass: 'inference',
      evidenceReferences: [{type: 'work_item', id: ids.staleWork}],
      ownerActorId: ids.actor,
      nextAction: 'review_stale_work_item'
    }));
    expect(active.find((signal) =>
      signal.deduplicationKey === `pending_approval_stale:approval:${ids.staleApproval}`
    )).toEqual(expect.objectContaining({
      workItemId: ids.staleWork,
      signalClass: 'fact',
      evidenceReferences: [{type: 'approval_request', id: ids.staleApproval}],
      nextAction: 'decide_or_cancel_pending_approval'
    }));
    expect(active.find((signal) =>
      signal.deduplicationKey === `blocked_work_item_unowned:work_item:${ids.blockedWork}`
    )).toEqual(expect.objectContaining({
      workItemId: ids.blockedWork,
      signalClass: 'fact',
      evidenceReferences: [{type: 'work_item', id: ids.blockedWork}],
      ownerActorId: null,
      nextAction: 'assign_owner_to_blocked_work_item'
    }));
    expect(active.some((signal) =>
      signal.deduplicationKey.includes(ids.boundaryMilestone) ||
      signal.deduplicationKey.includes(ids.boundaryWork) ||
      signal.deduplicationKey.includes(ids.boundaryApproval)
    )).toBe(false);
    const otherProjectRules = (await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.otherProject),
      isNull(riskSignals.resolvedAt)
    ))).filter((signal) => [
      'delivery_deadline_overdue',
      'active_work_item_stale',
      'pending_approval_stale',
      'blocked_work_item_unowned'
    ].includes(signal.ruleId));
    expect(otherProjectRules.map((signal) => signal.ruleId).sort()).toEqual([
      'active_work_item_stale',
      'blocked_work_item_unowned',
      'delivery_deadline_overdue',
      'pending_approval_stale'
    ]);
    expect(otherProjectRules.every((signal) =>
      signal.deduplicationKey.includes(ids.otherRiskWork) ||
      signal.deduplicationKey.includes(ids.otherMilestone) ||
      signal.deduplicationKey.includes(ids.otherApproval)
    )).toBe(true);
    expect(await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.projectId, ids.project),
      eq(scheduledJobs.name, 'healthcheck')
    ))).toHaveLength(1);

    current = new Date('2026-07-26T12:05:00.000Z');
    failedQueueCount = 0;
    await db.update(outboxEvents).set({status: 'published', updatedAt: current})
      .where(eq(outboxEvents.id, ids.failedOutbox));
    await db.insert(trackerSnapshotOperations).values({
      id: randomUUID(),
      workspaceId: ids.workspace,
      projectId: ids.project,
      provider: 'github',
      repositoryExternalId: 'github:repository:1278325372',
      mode: 'synchronize',
      requestHash: `healthcheck-${randomUUID()}`,
      snapshotExternalVersion: 'github:sha256:current',
      result: {status: 'applied'},
      createdAt: current
    });
    await db.update(milestones).set({closedAt: current, updatedAt: current})
      .where(inArray(milestones.id, [ids.overdueMilestone, ids.boundaryMilestone]));
    await db.update(deliveryJourneys).set({
      deadlineAt: new Date(current.getTime() + 60_000),
      updatedAt: current
    }).where(eq(deliveryJourneys.workItemId, ids.overdueJourneyWork));
    await db.update(workItems).set({updatedAt: current})
      .where(inArray(workItems.id, [ids.staleWork, ids.boundaryWork]));
    await db.update(workItems).set({ownerActorId: ids.actor, updatedAt: current})
      .where(eq(workItems.id, ids.blockedWork));
    await db.update(approvalRequests).set({
      status: 'approved',
      decidedByActorId: ids.actor,
      decidedAt: current,
      updatedAt: current
    }).where(inArray(approvalRequests.id, [ids.staleApproval, ids.boundaryApproval]));
    await producer.run();
    await producer.run();

    expect(await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.project),
      isNull(riskSignals.resolvedAt)
    ))).toHaveLength(0);
    expect(await db.select().from(riskSignals).where(eq(
      riskSignals.projectId, ids.project
    ))).toHaveLength(8);
  });
});
