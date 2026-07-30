import {randomUUID} from 'node:crypto';
import {and, eq, inArray, isNull} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  actors,
  activeWorkItemStaleAfterMs,
  agentProfiles,
  agentRuns,
  approvalRequests,
  buildChecks,
  canonicalEvents,
  createDatabase,
  createPostgresHealthcheckProducer,
  deliveryJourneys,
  milestones,
  outboxEvents,
  pendingApprovalStaleAfterMs,
  prLinks,
  projectTrackerRepositoryScopes,
  riskSignals,
  runbooks,
  scheduledJobs,
  secretRefs,
  taskPackets,
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
  atRiskMilestone: randomUUID(),
  horizonBoundaryMilestone: randomUUID(),
  beyondHorizonMilestone: randomUUID(),
  otherMilestone: randomUUID(),
  otherAtRiskMilestone: randomUUID(),
  protocol: randomUUID(),
  overdueJourneyWork: randomUUID(),
  staleWork: randomUUID(),
  boundaryWork: randomUUID(),
  blockedWork: randomUUID(),
  atRiskWork: randomUUID(),
  atRiskSecondWork: randomUUID(),
  horizonBoundaryWork: randomUUID(),
  beyondHorizonWork: randomUUID(),
  otherRiskWork: randomUUID(),
  otherAtRiskWork: randomUUID(),
  staleApproval: randomUUID(),
  boundaryApproval: randomUUID(),
  otherApproval: randomUUID(),
  profile: randomUUID(),
  event: randomUUID(),
  packet: randomUUID(),
  stuckRun: randomUUID(),
  boundaryRun: randomUUID(),
  prLink: randomUUID(),
  failedBuildCheck: randomUUID(),
  staleBuildCheck: randomUUID(),
  stuckScheduledJob: randomUUID(),
  boundaryScheduledJob: randomUUID(),
  otherScheduledJob: randomUUID()
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
    await db.insert(agentProfiles).values({
      id: ids.profile,
      workspaceId: ids.workspace,
      actorId: ids.actor,
      runtimeId: 'healthcheck-runner',
      runtimeProfile: 'codex-safe'
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
        id: ids.atRiskMilestone,
        projectId: ids.project,
        title: 'At-risk milestone',
        targetAt: new Date(current.getTime() + 24 * 60 * 60 * 1_000)
      },
      {
        id: ids.horizonBoundaryMilestone,
        projectId: ids.project,
        title: 'At-risk horizon boundary milestone',
        targetAt: new Date(current.getTime() + 7 * 24 * 60 * 60 * 1_000)
      },
      {
        id: ids.beyondHorizonMilestone,
        projectId: ids.project,
        title: 'Beyond at-risk horizon milestone',
        targetAt: new Date(current.getTime() + 7 * 24 * 60 * 60 * 1_000 + 1)
      },
      {
        id: ids.otherMilestone,
        projectId: ids.otherProject,
        title: 'Other project overdue milestone',
        targetAt: new Date(current.getTime() - 1)
      },
      {
        id: ids.otherAtRiskMilestone,
        projectId: ids.otherProject,
        title: 'Other project at-risk milestone',
        targetAt: new Date(current.getTime() + 24 * 60 * 60 * 1_000)
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
        id: ids.atRiskWork,
        projectId: ids.project,
        milestoneId: ids.atRiskMilestone,
        title: 'At-risk blocked work',
        status: 'in_dev',
        blocked: true,
        ownerActorId: ids.actor,
        updatedAt: current
      },
      {
        id: ids.atRiskSecondWork,
        projectId: ids.project,
        milestoneId: ids.atRiskMilestone,
        title: 'Second at-risk blocked work',
        status: 'qa',
        blocked: true,
        ownerActorId: ids.actor,
        updatedAt: current
      },
      {
        id: ids.horizonBoundaryWork,
        projectId: ids.project,
        milestoneId: ids.horizonBoundaryMilestone,
        title: 'Horizon-boundary blocked work',
        status: 'ready',
        blocked: true,
        updatedAt: current
      },
      {
        id: ids.beyondHorizonWork,
        projectId: ids.project,
        milestoneId: ids.beyondHorizonMilestone,
        title: 'Beyond-horizon blocked work',
        status: 'ready',
        blocked: true,
        ownerActorId: ids.actor,
        updatedAt: current
      },
      {
        id: ids.otherRiskWork,
        projectId: ids.otherProject,
        title: 'Other project risky work',
        status: 'in_dev',
        blocked: true,
        updatedAt: new Date(current.getTime() - activeWorkItemStaleAfterMs - 1)
      },
      {
        id: ids.otherAtRiskWork,
        projectId: ids.otherProject,
        milestoneId: ids.otherAtRiskMilestone,
        title: 'Other project at-risk blocked work',
        status: 'ready',
        blocked: true,
        ownerActorId: ids.actor,
        updatedAt: current
      }
    ]);
    await db.insert(deliveryJourneys).values({
      workItemId: ids.overdueJourneyWork,
      protocolId: ids.protocol,
      protocolVersion: 1,
      stageKey: 'delivery',
      deadlineAt: new Date(current.getTime() - 1)
    });
    await db.insert(prLinks).values({
      id: ids.prLink,
      workItemId: ids.staleWork,
      provider: 'github',
      repositoryRef: 'VF78/MSA',
      externalId: 'healthcheck-pr-1',
      url: 'https://github.com/VF78/MSA/pull/1',
      headRef: 'risk-check',
      baseRef: 'main',
      state: 'open',
      draft: false
    });
    await db.insert(buildChecks).values([
      {
        id: ids.failedBuildCheck,
        prLinkId: ids.prLink,
        provider: 'github',
        externalId: 'healthcheck-build-failed',
        name: 'required-check',
        status: 'completed',
        conclusion: 'failure',
        evidenceState: 'confirmed',
        completedAt: new Date(current.getTime() - 1)
      },
      {
        id: ids.staleBuildCheck,
        prLinkId: ids.prLink,
        provider: 'github',
        externalId: 'healthcheck-build-stale',
        name: 'stale-check',
        status: 'completed',
        conclusion: 'failure',
        evidenceState: 'stale',
        completedAt: new Date(current.getTime() - 1)
      }
    ]);
    await db.insert(canonicalEvents).values({
      id: ids.event,
      workspaceId: ids.workspace,
      projectId: ids.project,
      eventType: 'test.healthcheck',
      aggregateType: 'work_item',
      aggregateId: ids.staleWork,
      deduplicationKey: `healthcheck-${randomUUID()}`,
      payload: {},
      occurredAt: current
    });
    await db.insert(taskPackets).values({
      id: ids.packet,
      projectId: ids.project,
      workItemId: ids.staleWork,
      workItemVersion: 1,
      goal: 'Verify stuck run risk',
      dataPolicy: {},
      timeboxMinutes: 15,
      expectedOutputSchema: {},
      reviewerActorId: ids.actor,
      approverActorId: ids.actor,
      runtimeProfile: 'codex-safe',
      authMode: 'agent',
      secretRefId: ids.secret,
      createdFromEventId: ids.event,
      contentHash: '1'.repeat(64),
      createdByActorId: ids.actor
    });
    await db.insert(agentRuns).values([
      {
        id: ids.stuckRun,
        taskPacketId: ids.packet,
        agentProfileId: ids.profile,
        confirmedPacketHash: '2'.repeat(64),
        baseCommit: 'a'.repeat(40),
        status: 'running',
        idempotencyKey: `healthcheck-run-${ids.stuckRun}`,
        runnerId: 'runner-stuck',
        leaseTokenHash: '3'.repeat(64),
        leaseExpiresAt: new Date(current.getTime() - 1)
      },
      {
        id: ids.boundaryRun,
        taskPacketId: ids.packet,
        agentProfileId: ids.profile,
        confirmedPacketHash: '2'.repeat(64),
        baseCommit: 'a'.repeat(40),
        status: 'running',
        idempotencyKey: `healthcheck-run-${ids.boundaryRun}`,
        runnerId: 'runner-boundary',
        leaseTokenHash: '4'.repeat(64),
        leaseExpiresAt: current
      }
    ]);
    await db.insert(scheduledJobs).values([
      {
        id: ids.stuckScheduledJob,
        projectId: ids.project,
        name: 'stuck-job',
        cron: '*/5 * * * *',
        queueName: 'stuck-job',
        status: 'active',
        nextRunAt: new Date(current.getTime() - 1)
      },
      {
        id: ids.boundaryScheduledJob,
        projectId: ids.project,
        name: 'boundary-job',
        cron: '*/5 * * * *',
        queueName: 'boundary-job',
        status: 'active',
        nextRunAt: current
      },
      {
        id: ids.otherScheduledJob,
        projectId: ids.otherProject,
        name: 'other-stuck-job',
        cron: '*/5 * * * *',
        queueName: 'other-stuck-job',
        status: 'active',
        nextRunAt: new Date(current.getTime() - 1)
      }
    ]);
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
      'agent_run_stuck',
      'blocked_work_item_unowned',
      'blocked_work_item_unowned',
      'build_check_failed',
      'delivery_deadline_overdue',
      'delivery_deadline_overdue',
      'github_status_writeback_failed',
      'milestone_at_risk',
      'milestone_at_risk',
      'pending_approval_stale',
      'queue_work_failed',
      'scheduled_job_stuck',
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
      signal.deduplicationKey === `milestone_at_risk:milestone:${ids.atRiskMilestone}`
    )).toEqual(expect.objectContaining({
      workItemId: null,
      ruleId: 'milestone_at_risk',
      ruleVersion: '1',
      signalClass: 'inference',
      severity: 'yellow',
      details: {
        milestoneId: ids.atRiskMilestone,
        targetAt: new Date(current.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        blockedWorkItems: [
          {workItemId: ids.atRiskWork, status: 'in_dev', ownerActorId: ids.actor},
          {workItemId: ids.atRiskSecondWork, status: 'qa', ownerActorId: ids.actor}
        ].sort((left, right) => left.workItemId.localeCompare(right.workItemId)),
        riskHorizonDays: 7
      },
      evidenceReferences: [
        {type: 'milestone', id: ids.atRiskMilestone},
        ...[
          {type: 'work_item', id: ids.atRiskWork},
          {type: 'work_item', id: ids.atRiskSecondWork}
        ].sort((left, right) => left.id.localeCompare(right.id))
      ],
      ownerActorId: ids.actor,
      nextAction: 'review_blocked_work_for_at_risk_milestone'
    }));
    expect(active.find((signal) =>
      signal.deduplicationKey === `milestone_at_risk:milestone:${ids.horizonBoundaryMilestone}`
    )).toEqual(expect.objectContaining({ownerActorId: null}));
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
    expect(active.find((signal) =>
      signal.deduplicationKey === `build_check_failed:build_check:${ids.failedBuildCheck}`
    )).toEqual(expect.objectContaining({
      workItemId: ids.staleWork,
      signalClass: 'fact',
      evidenceReferences: [{type: 'build_check', id: ids.failedBuildCheck}],
      nextAction: 'inspect_failed_build_check'
    }));
    expect(active.find((signal) =>
      signal.deduplicationKey === `agent_run_stuck:agent_run:${ids.stuckRun}`
    )).toEqual(expect.objectContaining({
      workItemId: ids.staleWork,
      agentRunId: ids.stuckRun,
      signalClass: 'fact',
      evidenceReferences: [{type: 'agent_run', id: ids.stuckRun}],
      nextAction: 'recover_or_stop_stuck_agent_run'
    }));
    expect(active.find((signal) =>
      signal.deduplicationKey ===
        `scheduled_job_stuck:scheduled_job:${ids.stuckScheduledJob}`
    )).toEqual(expect.objectContaining({
      signalClass: 'fact',
      evidenceReferences: [{type: 'scheduled_job', id: ids.stuckScheduledJob}],
      nextAction: 'inspect_or_recover_scheduled_job'
    }));
    expect(active.some((signal) =>
      signal.deduplicationKey.includes(ids.boundaryMilestone) ||
      signal.deduplicationKey.includes(ids.beyondHorizonMilestone) ||
      signal.deduplicationKey.includes(ids.boundaryWork) ||
      signal.deduplicationKey.includes(ids.boundaryApproval) ||
      signal.deduplicationKey.includes(ids.boundaryRun) ||
      signal.deduplicationKey.includes(ids.boundaryScheduledJob) ||
      signal.deduplicationKey.includes(ids.staleBuildCheck)
    )).toBe(false);
    const otherProjectRules = (await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.otherProject),
      isNull(riskSignals.resolvedAt)
    ))).filter((signal) => [
      'delivery_deadline_overdue',
      'milestone_at_risk',
      'active_work_item_stale',
      'pending_approval_stale',
      'blocked_work_item_unowned',
      'build_check_failed',
      'agent_run_stuck',
      'scheduled_job_stuck'
    ].includes(signal.ruleId));
    expect(otherProjectRules.map((signal) => signal.ruleId).sort()).toEqual([
      'active_work_item_stale',
      'blocked_work_item_unowned',
      'delivery_deadline_overdue',
      'milestone_at_risk',
      'pending_approval_stale',
      'scheduled_job_stuck'
    ]);
    expect(otherProjectRules.every((signal) =>
      signal.deduplicationKey.includes(ids.otherRiskWork) ||
      signal.deduplicationKey.includes(ids.otherMilestone) ||
      signal.deduplicationKey.includes(ids.otherAtRiskMilestone) ||
      signal.deduplicationKey.includes(ids.otherApproval) ||
      signal.deduplicationKey.includes(ids.otherScheduledJob)
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
      .where(inArray(milestones.id, [
        ids.overdueMilestone,
        ids.boundaryMilestone,
        ids.atRiskMilestone,
        ids.horizonBoundaryMilestone,
        ids.beyondHorizonMilestone
      ]));
    await db.update(deliveryJourneys).set({
      deadlineAt: new Date(current.getTime() + 60_000),
      updatedAt: current
    }).where(eq(deliveryJourneys.workItemId, ids.overdueJourneyWork));
    await db.update(workItems).set({updatedAt: current})
      .where(inArray(workItems.id, [ids.staleWork, ids.boundaryWork]));
    await db.update(workItems).set({ownerActorId: ids.actor, updatedAt: current})
      .where(eq(workItems.id, ids.blockedWork));
    await db.update(workItems).set({status: 'done', updatedAt: current})
      .where(eq(workItems.id, ids.horizonBoundaryWork));
    await db.update(approvalRequests).set({
      status: 'approved',
      decidedByActorId: ids.actor,
      decidedAt: current,
      updatedAt: current
    }).where(inArray(approvalRequests.id, [ids.staleApproval, ids.boundaryApproval]));
    await db.update(buildChecks).set({
      conclusion: 'success',
      updatedAt: current
    }).where(eq(buildChecks.id, ids.failedBuildCheck));
    await db.update(agentRuns).set({
      status: 'done',
      completedAt: current,
      runnerId: null,
      leaseTokenHash: null,
      leaseExpiresAt: null,
      updatedAt: current
    }).where(inArray(agentRuns.id, [ids.stuckRun, ids.boundaryRun]));
    await db.update(scheduledJobs).set({
      nextRunAt: new Date(current.getTime() + 60_000),
      updatedAt: current
    }).where(inArray(scheduledJobs.id, [
      ids.stuckScheduledJob,
      ids.boundaryScheduledJob
    ]));
    await producer.run();
    await producer.run();

    expect(await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.project),
      isNull(riskSignals.resolvedAt)
    ))).toHaveLength(0);
    expect(await db.select().from(riskSignals).where(eq(
      riskSignals.projectId, ids.project
    ))).toHaveLength(14);
  });
});
