import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {defaultDeliveryProtocolDefinition, hashDeliveryProtocolDefinition} from '@fai-control-plane/domain';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors, auditEvents, commandReceipts, createDatabase, createPostgresDeploymentEvidenceStore,
  createPostgresProjectTaskProjectionReader,
  deliveryJourneyEvidence, deliveryJourneys, deployments, projectMemberships, projectPlanDrafts,
  projectPlanMaterializations, projectPlanVersions, projectScopeBaselineVersions, projects, runbooks,
  workItems, workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) throw new Error('DATABASE_URL is required for deployment evidence integration tests in CI.');
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_deployment_evidence_${randomUUID().replaceAll('-', '')}`;

describePostgres('deployment evidence persistence', () => {
  let adminPool: Pool; let testPool: Pool; let db: ReturnType<typeof createDatabase>['db'];
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
    if (adminPool !== undefined) { try { await dropDatabaseWhenDisconnected(adminPool, databaseName); }
      finally { await adminPool.end(); } }
  }, 30_000);

  it('separates desired, approved, and observed truth with workspace authority, CAS, replay, and rollback evidence', async () => {
    const ids = {workspace: randomUUID(), otherWorkspace: randomUUID(), project: randomUUID(), owner: randomUUID(),
      contributor: randomUUID(), observer: randomUUID(), plan: randomUUID(), planVersion: randomUUID(),
      baseline: randomUUID(), materialization: randomUUID(), workItem: randomUUID(), production: randomUUID(),
      staging: randomUUID(), restored: randomUUID(), protocol: randomUUID()};
    await db.insert(workspaces).values([
      {id: ids.workspace, name: 'Release', slug: `release-${randomUUID()}`},
      {id: ids.otherWorkspace, name: 'Other', slug: `other-${randomUUID()}`}
    ]);
    await db.insert(projects).values({id: ids.project, workspaceId: ids.workspace, name: 'Project', slug: `project-${randomUUID()}`});
    await db.insert(actors).values([
      {id: ids.owner, workspaceId: ids.workspace, type: 'human', role: 'developer', displayName: 'PO', authMode: 'user'},
      {id: ids.contributor, workspaceId: ids.workspace, type: 'human', role: 'developer', displayName: 'Developer', authMode: 'user'},
      {id: ids.observer, workspaceId: ids.workspace, type: 'system', role: 'agent_operator', displayName: 'Deployment observer', authMode: 'system'}
    ]);
    await db.insert(projectMemberships).values([
      {id: randomUUID(), projectId: ids.project, actorId: ids.owner, role: 'project_owner'},
      {id: randomUUID(), projectId: ids.project, actorId: ids.contributor, role: 'contributor'}
    ]);
    const definition = {title: 'Approved', outcomes: [], milestones: [], risks: [], tasks: []};
    await db.insert(projectPlanDrafts).values({id: ids.plan, workspaceId: ids.workspace, projectId: ids.project,
      state: 'approved', definition: definition as never, contentHash: 'a'.repeat(64), revision: 1,
      createdByActorId: ids.owner, approvedByActorId: ids.owner, approvedAt: new Date('2026-08-11T08:00:00.000Z')});
    await db.insert(projectPlanVersions).values({id: ids.planVersion, workspaceId: ids.workspace, projectId: ids.project,
      planId: ids.plan, version: 1, sourceRevision: 1, definition: definition as never, contentHash: 'a'.repeat(64),
      sourceManifest: [], simulation: {} as never, approvedByActorId: ids.owner, approvedAt: new Date('2026-08-11T08:00:00.000Z')});
    await db.insert(projectScopeBaselineVersions).values({id: ids.baseline, projectId: ids.project, version: 1,
      sourcePlanVersionId: ids.planVersion, sourcePlanHash: 'a'.repeat(64), approvedByActorId: ids.owner,
      approvedAt: new Date('2026-08-11T08:00:00.000Z')});
    await db.insert(projectPlanMaterializations).values({id: ids.materialization, workspaceId: ids.workspace,
      projectId: ids.project, planVersionId: ids.planVersion, baselineId: ids.baseline, commandId: randomUUID(),
      planVersion: 1, planHash: 'a'.repeat(64), sourceManifestHash: 'b'.repeat(64), outcomeCount: 1,
      milestoneCount: 1, workItemCount: 1, dependencyCount: 0, journeyCount: 0, publicationIntentCount: 0,
      createdByActorId: ids.owner});
    await db.insert(workItems).values({id: ids.workItem, projectId: ids.project, title: 'Release task',
      sourcePlanVersionId: ids.planVersion, sourceTaskKey: 'release', responsibility: {kind: 'human', actorId: ids.owner},
      acceptanceEvidence: []});
    const store = createPostgresDeploymentEvidenceStore(db, {now: () => new Date('2026-08-11T11:00:00.000Z')});
    const command = (type: string, payload: Record<string, unknown>, key: string, actorId = ids.owner,
      workspaceId = ids.workspace) => ({commandId: randomUUID(), workspaceId, correlationId: randomUUID(),
        idempotencyKey: key, actor: {actorId}, type, payload});
    const execute = (value: ReturnType<typeof command>) => store.execute({command: value as never,
      requestHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'), authorized: true});
    const requestPayload = {deploymentId: ids.production, projectId: ids.project, workItemId: ids.workItem,
      planVersionId: ids.planVersion, materializationId: ids.materialization, environment: 'production',
      reference: {kind: 'commit', reference: 'git-commit:0123456789abcdef'}, expectedProjectVersion: 1};

    const restoredAuthority = command('deployment.request.v1', {...requestPayload, deploymentId: ids.restored,
      environment: 'development'}, 'restored-authority', ids.contributor);
    await expect(execute(restoredAuthority)).resolves.toMatchObject({receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}});
    await db.update(projectMemberships).set({role: 'project_owner'}).where(eq(projectMemberships.actorId, ids.contributor));
    await expect(execute(restoredAuthority)).resolves.toMatchObject({receipt: {result: {ok: true, value: {state: 'approved'}}}});
    await db.update(projectMemberships).set({role: 'contributor'}).where(eq(projectMemberships.actorId, ids.contributor));

    await expect(execute(command('deployment.request.v1', requestPayload, 'cross-workspace', ids.owner, ids.otherWorkspace)))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'NOT_FOUND'}}}});
    await expect(execute(command('deployment.request.v1', requestPayload, 'not-manager', ids.contributor)))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}});
    await expect(execute(command('deployment.request.v1', {...requestPayload, expectedProjectVersion: 2}, 'stale-project')))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
    await expect(execute(command('deployment.request.v1', requestPayload, 'too-early')))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
    const protocol = defaultDeliveryProtocolDefinition();
    await db.insert(runbooks).values({id: ids.protocol, projectId: ids.project, name: 'Release protocol', version: 1,
      definition: protocol as never, active: true, protocolState: 'published', revision: 1,
      contentHash: hashDeliveryProtocolDefinition(protocol)});
    await db.update(workItems).set({status: 'done'}).where(eq(workItems.id, ids.workItem));
    await db.insert(deliveryJourneys).values({workItemId: ids.workItem, protocolId: ids.protocol,
      protocolVersion: 1, stageKey: 'acceptance', version: 1});
    await db.insert(deliveryJourneyEvidence).values({workItemId: ids.workItem, stageKey: 'acceptance',
      requirement: 'Product Owner acceptance', evidenceReference: 'evidence:po-acceptance', commandId: randomUUID()});
    const request = command('deployment.request.v1', requestPayload, 'production-request');
    await expect(execute(request)).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      state: 'requested', nextAction: 'approve_production', version: 1
    }}}});
    await expect(execute(request)).resolves.toMatchObject({status: 'replayed'});
    await expect(execute({...request, commandId: randomUUID(), payload: {...request.payload,
      reference: {kind: 'commit', reference: 'git-commit:different'}}}))
      .resolves.toMatchObject({status: 'key_reused'});

    const prematureObservation = command('deployment.observe_result.v1', {deploymentId: ids.production,
      expectedVersion: 1, observation: {outcome: 'failed', reference: 'evidence:result:premature',
        startedAt: '2026-08-11T10:00:00.000Z', completedAt: '2026-08-11T10:01:00.000Z',
        smokeChecks: [{name: 'health', status: 'failed', reference: 'evidence:smoke:premature'}],
        rollback: {outcome: 'not_required', reference: null}}}, 'premature-observation', ids.observer);
    await expect(execute(prematureObservation)).resolves.toMatchObject({receipt: {result: {error: {code: 'APPROVAL_REQUIRED'}}}});
    const approvals = await Promise.all([
      execute(command('deployment.production_approve.v1', {deploymentId: ids.production, expectedVersion: 1}, 'approve-a')),
      execute(command('deployment.production_approve.v1', {deploymentId: ids.production, expectedVersion: 1}, 'approve-b'))
    ]);
    expect(approvals.filter((entry) => 'receipt' in entry && entry.receipt.result.ok)).toHaveLength(1);
    expect(approvals.filter((entry) => 'receipt' in entry && !entry.receipt.result.ok && entry.receipt.result.error.code === 'VERSION_CONFLICT')).toHaveLength(1);

    const rollbackObservation = command('deployment.observe_result.v1', {deploymentId: ids.production,
      expectedVersion: 2, observation: {outcome: 'rolled_back', reference: 'evidence:deployment:failed',
        startedAt: '2026-08-11T10:00:00.000Z', completedAt: '2026-08-11T10:07:00.000Z',
        smokeChecks: [{name: 'health', status: 'failed', reference: 'evidence:smoke:failed'}],
        rollback: {outcome: 'completed', reference: 'evidence:rollback:completed'}}}, 'rollback-observation', ids.observer);
    await expect(execute(rollbackObservation)).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      state: 'observed', version: 3, nextAction: 'review_observation'
    }}}});
    await expect(execute(rollbackObservation)).resolves.toMatchObject({status: 'replayed'});
    const [persisted] = await db.select().from(deployments).where(eq(deployments.id, ids.production));
    expect(persisted).toMatchObject({workspaceId: ids.workspace, workItemId: ids.workItem,
      planVersionId: ids.planVersion, materializationId: ids.materialization, status: 'observed', version: 3,
      externalRef: null, observedResult: {outcome: 'rolled_back', reference: 'evidence:deployment:failed'},
      rollbackEvidence: {outcome: 'completed', reference: 'evidence:rollback:completed'}});
    const projection = await createPostgresProjectTaskProjectionReader(db).read({workspaceId: ids.workspace,
      projectId: ids.project});
    expect(projection?.project.deployments.find(({id}) => id === ids.production)).toMatchObject({
      status: 'observed', nextAction: 'review_observation',
      externalEvidence: {availability: 'known', value: {outcome: 'rolled_back'}}
    });

    const stagingPayload = {...requestPayload, deploymentId: ids.staging, workItemId: null,
      environment: 'staging', reference: {kind: 'artifact', reference: 'artifact:release-bundle:42'}};
    await expect(execute(command('deployment.request.v1', stagingPayload, 'staging-request')))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {state: 'approved', version: 1}}}});
    const [staging] = await db.select().from(deployments).where(eq(deployments.id, ids.staging));
    expect(staging?.requestedByActorId).toBe(ids.owner); expect(staging?.approvedByActorId).toBe(ids.owner);
    expect(await db.select().from(auditEvents)).toHaveLength(12);
    expect(await db.select().from(commandReceipts)).toHaveLength(12);
  });
});
