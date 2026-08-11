import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {defaultDeliveryProtocolDefinition, hashDeliveryProtocolDefinition} from '@fai-control-plane/domain';
import {and, eq, isNull} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors,
  agentRuns,
  auditEvents,
  commandReceipts,
  createDatabase,
  createPostgresDeliveryJourneyStore,
  createPostgresGovernedQaStore,
  deliveryJourneyEvidence,
  deliveryJourneys,
  projectExecutions,
  projectMemberships,
  projectPlanDrafts,
  projectPlanVersions,
  projects,
  qaReviewReceipts,
  qaTaskPackets,
  riskSignals,
  runbooks,
  taskPackets,
  workItems,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) throw new Error('DATABASE_URL is required for governed QA integration tests in CI.');
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_governed_qa_${randomUUID().replaceAll('-', '')}`;

describePostgres('governed QA persistence', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!); adminUrl.pathname = '/postgres';
    adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(databaseUrl!); testUrl.pathname = `/${databaseName}`;
    const created = createDatabase(testUrl.toString()); db = created.db; testPool = created.pool;
    await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))});
  }, 30_000);
  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try { await dropDatabaseWhenDisconnected(adminPool, databaseName); }
      finally { await adminPool.end(); }
    }
  }, 30_000);

  it('prepares immutable packets and atomically records pass/fail against a retired bound protocol', async () => {
    const ids = {
      workspace: randomUUID(), project: randomUUID(), owner: randomUUID(), contributor: randomUUID(),
      plan: randomUUID(), planVersion: randomUUID(), retiredProtocol: randomUUID(), activeProtocol: randomUUID(),
      noRouteProtocol: randomUUID(), passedTask: randomUUID(), failedTask: randomUUID(), blockedTask: randomUUID()
    };
    await db.insert(workspaces).values({id: ids.workspace, name: 'QA', slug: `qa-${randomUUID()}`});
    await db.insert(projects).values({id: ids.project, workspaceId: ids.workspace, name: 'Project', slug: `project-${randomUUID()}`});
    await db.insert(actors).values([
      {id: ids.owner, workspaceId: ids.workspace, type: 'human', role: 'workspace_admin', displayName: 'Owner', authMode: 'user'},
      {id: ids.contributor, workspaceId: ids.workspace, type: 'human', role: 'developer', displayName: 'Contributor', authMode: 'user'}
    ]);
    await db.insert(projectMemberships).values([
      {id: randomUUID(), projectId: ids.project, actorId: ids.owner, role: 'project_owner'},
      {id: randomUUID(), projectId: ids.project, actorId: ids.contributor, role: 'contributor'}
    ]);
    const planDefinition = {title: 'Plan', outcomes: [], milestones: [], risks: [], tasks: []};
    const approvedAt = new Date('2026-08-11T00:00:00.000Z');
    await db.insert(projectPlanDrafts).values({id: ids.plan, workspaceId: ids.workspace, projectId: ids.project,
      state: 'approved', definition: planDefinition as never, contentHash: 'a'.repeat(64), revision: 1,
      createdByActorId: ids.owner, approvedByActorId: ids.owner, approvedAt});
    await db.insert(projectPlanVersions).values({id: ids.planVersion, workspaceId: ids.workspace, projectId: ids.project,
      planId: ids.plan, version: 1, sourceRevision: 1, definition: planDefinition as never, contentHash: 'a'.repeat(64),
      sourceManifest: [], simulation: {} as never, approvedByActorId: ids.owner, approvedAt});

    const base = defaultDeliveryProtocolDefinition();
    const renamed = base.stages.map((stage) => ({...stage,
      key: stage.key === 'qa' ? 'verification_lane' : stage.key,
      allowedNextStageKey: stage.allowedNextStageKey === 'qa' ? 'verification_lane' : stage.allowedNextStageKey
    }));
    const developmentIndex = renamed.findIndex((stage) => stage.key === 'development');
    const disabled = {...renamed[developmentIndex]!, key: 'disabled_security_hold', name: 'Disabled hold', enabled: false,
      allowedNextStageKey: 'verification_lane'};
    const definition = {...base, stages: [...renamed.slice(0, developmentIndex + 1), disabled, ...renamed.slice(developmentIndex + 1)]};
    const noRouteDefinition = {...definition, stages: definition.stages.map((stage) =>
      stage.taskStatus === 'ready' || stage.taskStatus === 'in_dev' ? {...stage, enabled: false} : stage
    )};
    await db.insert(runbooks).values([
      {id: ids.retiredProtocol, projectId: ids.project, name: 'Delivery v1', version: 1, definition: definition as never,
        active: false, protocolState: 'retired', revision: 1, contentHash: hashDeliveryProtocolDefinition(definition)},
      {id: ids.activeProtocol, projectId: ids.project, name: 'Delivery v2', version: 2,
        definition: base as never, active: true, protocolState: 'published', revision: 1,
        contentHash: hashDeliveryProtocolDefinition(base)},
      {id: ids.noRouteProtocol, projectId: ids.project, name: 'QA without return', version: 1,
        definition: noRouteDefinition as never, active: false, protocolState: 'retired', revision: 1,
        contentHash: hashDeliveryProtocolDefinition(noRouteDefinition)}
    ]);
    const work = (id: string, key: string): typeof workItems.$inferInsert => ({id, projectId: ids.project, title: key, status: 'qa',
      ownerActorId: ids.owner, sourcePlanVersionId: ids.planVersion, sourceTaskKey: key,
      responsibility: {kind: 'human', actorId: ids.owner}, acceptanceEvidence: [], version: 1});
    await db.insert(workItems).values([
      work(ids.passedTask, 'passed'), work(ids.failedTask, 'failed'), work(ids.blockedTask, 'blocked')
    ]);
    await db.insert(deliveryJourneys).values([
      {workItemId: ids.passedTask, protocolId: ids.retiredProtocol, protocolVersion: 1, stageKey: 'verification_lane', version: 1},
      {workItemId: ids.failedTask, protocolId: ids.retiredProtocol, protocolVersion: 1, stageKey: 'verification_lane', version: 1}
      ,{workItemId: ids.blockedTask, protocolId: ids.noRouteProtocol, protocolVersion: 1, stageKey: 'verification_lane', version: 1}
    ]);
    await db.insert(projectExecutions).values({projectId: ids.project, status: 'blocked', blockReason: 'awaiting_qa',
      version: 1, startedAt: approvedAt});

    const qa = createPostgresGovernedQaStore(db);
    const command = (type: 'qa_task_packet.prepare.v1' | 'qa_review.record.v1', payload: Record<string, unknown>, key: string,
      actorId = ids.owner) => ({commandId: randomUUID(), workspaceId: ids.workspace, correlationId: randomUUID(),
        idempotencyKey: key, actor: {actorId}, type, payload});
    const execute = (value: ReturnType<typeof command>) => qa.execute({command: value as never,
      requestHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'), authorized: true});

    const denied = command('qa_task_packet.prepare.v1', {workItemId: ids.passedTask,
      expectedWorkItemVersion: 1, expectedJourneyVersion: 1}, 'qa-denied', ids.contributor);
    await expect(execute(denied)).resolves.toMatchObject({receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}});
    expect(await db.select().from(qaTaskPackets)).toHaveLength(0);

    const genericAdvance = createPostgresDeliveryJourneyStore(db);
    await expect(genericAdvance.execute({command: {commandId: randomUUID(), workspaceId: ids.workspace,
      correlationId: randomUUID(), idempotencyKey: 'generic-custom-qa', actor: {actorId: ids.owner},
      type: 'delivery_journey.advance', payload: {workItemId: ids.passedTask, expectedWorkItemVersion: 1,
        expectedJourneyVersion: 1, evidenceReferences: [{requirement: 'QA result', reference: 'qa://bypass'}]}} as never,
      requestHash: 'b'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});

    const preparePass = command('qa_task_packet.prepare.v1', {workItemId: ids.passedTask,
      expectedWorkItemVersion: 1, expectedJourneyVersion: 1}, 'qa-prepare-pass');
    const preparedPass = await execute(preparePass);
    expect(preparedPass).toMatchObject({status: 'completed', receipt: {result: {ok: true, value: {journeyStageKey: 'verification_lane'}}}});
    await expect(execute(preparePass)).resolves.toMatchObject({status: 'replayed'});
    const passPacketId = 'receipt' in preparedPass && preparedPass.receipt.result.ok
      ? preparedPass.receipt.result.value.taskPacketId : '';
    expect(passPacketId).not.toBe('');
    expect(await db.select().from(agentRuns)).toHaveLength(0);
    expect(await db.select().from(taskPackets)).toHaveLength(1);

    const staleReview = command('qa_review.record.v1', {workItemId: ids.passedTask, expectedWorkItemVersion: 2,
      expectedJourneyVersion: 1, taskPacketId: passPacketId, evidence: {outcome: 'passed',
        checks: [{name: 'smoke', status: 'passed', reference: 'qa://check/stale'}],
        artifacts: [{kind: 'report', reference: 'qa://report/stale'}], failures: [], risks: [],
        evidenceReferences: [{requirement: 'QA result', reference: 'qa://report/stale'}]}}, 'qa-review-stale');
    await expect(execute(staleReview)).resolves.toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
    expect(await db.select().from(qaReviewReceipts)).toHaveLength(0);

    const passReview = command('qa_review.record.v1', {workItemId: ids.passedTask, expectedWorkItemVersion: 1,
      expectedJourneyVersion: 1, taskPacketId: passPacketId, evidence: {outcome: 'passed',
        checks: [{name: 'smoke', status: 'passed', reference: 'qa://check/smoke'}],
        artifacts: [{kind: 'report', reference: 'qa://report/pass'}], failures: [], risks: [],
        evidenceReferences: [{requirement: 'QA result', reference: 'qa://report/pass'}]}}, 'qa-review-pass');
    await expect(execute(passReview)).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      workItemStatus: 'acceptance', journeyStageKey: 'staging', executionStatus: 'paused'
    }}}});
    expect((await db.select().from(workItems).where(eq(workItems.id, ids.passedTask)))[0]).toMatchObject({status: 'acceptance', version: 2});
    expect((await db.select().from(deliveryJourneys).where(eq(deliveryJourneys.workItemId, ids.passedTask)))[0])
      .toMatchObject({stageKey: 'staging', version: 2});
    expect((await db.select().from(projectExecutions).where(eq(projectExecutions.projectId, ids.project)))[0])
      .toMatchObject({status: 'paused', pausedAt: expect.any(Date), blockReason: null, version: 2});
    expect(await db.select().from(deliveryJourneyEvidence).where(eq(deliveryJourneyEvidence.workItemId, ids.passedTask))).toHaveLength(1);

    const prepareFailure = command('qa_task_packet.prepare.v1', {workItemId: ids.failedTask,
      expectedWorkItemVersion: 1, expectedJourneyVersion: 1}, 'qa-prepare-failure');
    const preparedFailure = await execute(prepareFailure);
    const failedPacketId = 'receipt' in preparedFailure && preparedFailure.receipt.result.ok
      ? preparedFailure.receipt.result.value.taskPacketId : '';
    const failedReview = command('qa_review.record.v1', {workItemId: ids.failedTask, expectedWorkItemVersion: 1,
      expectedJourneyVersion: 1, taskPacketId: failedPacketId, evidence: {outcome: 'failed',
        checks: [{name: 'smoke', status: 'failed', reference: 'qa://check/failed'}], artifacts: [],
        failures: [{summary: 'Regression', reference: 'qa://failure/1'}], risks: [], evidenceReferences: []}}, 'qa-review-failed');
    const concurrent = await Promise.all([execute(failedReview), execute(failedReview)]);
    expect(concurrent.map((result) => result.status).sort()).toEqual(['completed', 'replayed']);
    expect((await db.select().from(workItems).where(eq(workItems.id, ids.failedTask)))[0]).toMatchObject({status: 'in_dev', version: 2});
    expect((await db.select().from(deliveryJourneys).where(eq(deliveryJourneys.workItemId, ids.failedTask)))[0])
      .toMatchObject({stageKey: 'development', version: 2});
    expect((await db.select().from(projectExecutions).where(eq(projectExecutions.projectId, ids.project)))[0])
      .toMatchObject({status: 'blocked', pausedAt: null, blockReason: 'qa_review_failed', version: 3});
    expect(await db.select().from(qaReviewReceipts)).toHaveLength(2);
    expect(await db.select().from(riskSignals).where(and(
      eq(riskSignals.workItemId, ids.failedTask), isNull(riskSignals.resolvedAt)
    ))).toHaveLength(1);

    const prepareBlocked = command('qa_task_packet.prepare.v1', {workItemId: ids.blockedTask,
      expectedWorkItemVersion: 1, expectedJourneyVersion: 1}, 'qa-prepare-blocked');
    const preparedBlocked = await execute(prepareBlocked);
    const blockedPacketId = 'receipt' in preparedBlocked && preparedBlocked.receipt.result.ok
      ? preparedBlocked.receipt.result.value.taskPacketId : '';
    const blockedReview = command('qa_review.record.v1', {workItemId: ids.blockedTask, expectedWorkItemVersion: 1,
      expectedJourneyVersion: 1, taskPacketId: blockedPacketId, evidence: {outcome: 'failed',
        checks: [{name: 'smoke', status: 'failed', reference: 'qa://check/no-route'}], artifacts: [],
        failures: [{summary: 'No return route', reference: 'qa://failure/no-route'}], risks: [],
        evidenceReferences: []}}, 'qa-review-blocked');
    await expect(execute(blockedReview)).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      workItemStatus: 'qa', journeyStageKey: 'verification_lane', executionStatus: 'blocked',
      remediation: expect.stringContaining('no protocol-allowed return route')
    }}}});
    expect((await db.select().from(workItems).where(eq(workItems.id, ids.blockedTask)))[0])
      .toMatchObject({status: 'qa', blocked: true, version: 2});
    expect((await db.select().from(deliveryJourneys).where(eq(deliveryJourneys.workItemId, ids.blockedTask)))[0])
      .toMatchObject({stageKey: 'verification_lane', version: 1});
    expect(await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, ids.workspace))).not.toHaveLength(0);
    expect(await db.select().from(commandReceipts).where(eq(commandReceipts.workspaceId, ids.workspace))).not.toHaveLength(0);
  });
});
