import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createDeploymentExecutorService} from '../../application/src/index.ts';
import {createActorContextIssuer, defaultDeliveryProtocolDefinition, hashDeliveryProtocolDefinition} from '@fai-control-plane/domain';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors, auditEvents, commandReceipts, createDatabase, createPostgresDeploymentEvidenceStore,
  createPostgresDeploymentExecutorStore, createPostgresProjectTaskProjectionReader,
  deploymentExecutorJobs, deploymentExecutorRegistrations,
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
      staging: randomUUID(), restored: randomUUID(), protocol: randomUUID(),
      productionRegistration: randomUUID(), stagingRegistration: randomUUID(), developmentRegistration: randomUUID()};
    await db.insert(workspaces).values([
      {id: ids.workspace, name: 'Release', slug: `release-${randomUUID()}`},
      {id: ids.otherWorkspace, name: 'Other', slug: `other-${randomUUID()}`}
    ]);
    await db.insert(projects).values({id: ids.project, workspaceId: ids.workspace, name: 'Project', slug: `project-${randomUUID()}`});
    await db.insert(actors).values([
      {id: ids.owner, workspaceId: ids.workspace, type: 'human', role: 'developer', displayName: 'PO', authMode: 'user'},
      {id: ids.contributor, workspaceId: ids.workspace, type: 'human', role: 'developer', displayName: 'Developer', authMode: 'user'},
      {id: ids.observer, workspaceId: ids.workspace, type: 'system', role: 'agent_operator',
        displayName: 'Deployment executor', authMode: 'system',
        capabilities: {'deploy:runner:development': true, 'deploy:runner:staging': true,
          'deploy:runner:production': true}}
    ]);
    await db.insert(projectMemberships).values([
      {id: randomUUID(), projectId: ids.project, actorId: ids.owner, roles: ['project_owner']},
      {id: randomUUID(), projectId: ids.project, actorId: ids.contributor, roles: ['contributor']}
    ]);
    await db.insert(deploymentExecutorRegistrations).values([
      {id: ids.productionRegistration, workspaceId: ids.workspace, projectId: ids.project,
        systemActorId: ids.observer, environment: 'production', executorKey: 'executor-production', enabled: true},
      {id: ids.stagingRegistration, workspaceId: ids.workspace, projectId: ids.project,
        systemActorId: ids.observer, environment: 'staging', executorKey: 'executor-staging', enabled: true},
      {id: ids.developmentRegistration, workspaceId: ids.workspace, projectId: ids.project,
        systemActorId: ids.observer, environment: 'development', executorKey: 'executor-development', enabled: true}
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
      reference: {kind: 'commit', reference: `git-commit:${'a'.repeat(40)}`},
      releasePackage: {schemaVersion: 1, sourceCommit: 'a'.repeat(40),
        artifactReference: 'artifact:release-package:production', artifactSha256: 'b'.repeat(64)},
      expectedProjectVersion: 1};

    await db.update(actors).set({capabilities: {}}).where(eq(actors.id, ids.observer));
    await expect(execute(command('deployment.request.v1', {...requestPayload, deploymentId: randomUUID(),
      environment: 'development'}, 'executor-capability-missing'))).resolves.toMatchObject({receipt: {result: {
        error: {code: 'INVALID_TRANSITION'}
      }}});
    await db.update(actors).set({capabilities: {'deploy:runner:development': true,
      'deploy:runner:staging': true, 'deploy:runner:production': true}})
      .where(eq(actors.id, ids.observer));

    const restoredAuthority = command('deployment.request.v1', {...requestPayload, deploymentId: ids.restored,
      environment: 'development'}, 'restored-authority', ids.contributor);
    await expect(execute(restoredAuthority)).resolves.toMatchObject({receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}});
    await db.update(projectMemberships).set({roles: ['project_owner']}).where(eq(projectMemberships.actorId, ids.contributor));
    await expect(execute(restoredAuthority)).resolves.toMatchObject({receipt: {result: {ok: true, value: {state: 'approved'}}}});
    await db.update(projectMemberships).set({roles: ['contributor']}).where(eq(projectMemberships.actorId, ids.contributor));

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
    for (let index = 0; index < 8; index += 1) {
      const staleDeploymentId = randomUUID();
      await expect(execute(command('deployment.request.v1', {...requestPayload,
        deploymentId: staleDeploymentId}, `stale-registration-request-${index}`)))
        .resolves.toMatchObject({receipt: {result: {ok: true}}});
      await expect(execute(command('deployment.production_approve.v1', {
        deploymentId: staleDeploymentId, expectedVersion: 1
      }, `stale-registration-approve-${index}`))).resolves.toMatchObject({receipt: {result: {ok: true}}});
    }
    await db.update(deploymentExecutorJobs).set({createdAt: new Date('2026-08-11T10:59:00.000Z')})
      .where(eq(deploymentExecutorJobs.registrationId, ids.productionRegistration));
    await db.update(deploymentExecutorRegistrations).set({version: 2})
      .where(eq(deploymentExecutorRegistrations.id, ids.productionRegistration));
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
    await expect(execute(prematureObservation)).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
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
    await expect(execute(rollbackObservation)).resolves.toMatchObject({receipt: {result: {error: {
      code: 'INVALID_TRANSITION'
    }}}});
    const issuer = createActorContextIssuer({users: [], agents: [], systems: [{actorId: ids.observer,
      capabilities: ['deploy:runner:development', 'deploy:runner:staging', 'deploy:runner:production']}]});
    if (!issuer.ok) throw new Error('issuer');
    const executorActor = issuer.value.issueSystem(ids.observer);
    if (!executorActor.ok) throw new Error('executor actor');
    let executorNow = new Date('2026-08-11T11:01:00.000Z');
    let tokenNumber = 0;
    const executor = createDeploymentExecutorService({store: createPostgresDeploymentExecutorStore(db),
      now: () => executorNow, tokenGenerator: () => (tokenNumber++ === 0 ? 'l' : 'm').repeat(43)});
    const authorization = {workspaceId: ids.workspace, executorId: 'executor-production',
      registrationId: ids.productionRegistration, projectIds: [ids.project],
      environments: ['production' as const], actor: executorActor.value};
    const claim = await executor.claim(authorization);
    expect(claim).toMatchObject({deploymentId: ids.production, deploymentVersion: 2, attempt: 1,
      releasePackage: {sourceCommit: 'a'.repeat(40)}, approvedByActorId: ids.owner});
    if (claim === null) throw new Error('claim');
    await expect(executor.claim(authorization)).resolves.toBeNull();
    executorNow = new Date('2026-08-11T11:02:00.000Z');
    await expect(executor.heartbeat({authorization, payload: {jobId: claim.jobId, attempt: 1},
      leaseToken: claim.leaseToken})).resolves.toMatchObject({leaseExpiresAt: '2026-08-11T11:04:00.000Z'});
    executorNow = new Date('2026-08-11T11:04:01.000Z');
    const recoveredClaim = await executor.claim(authorization);
    expect(recoveredClaim).toMatchObject({jobId: claim.jobId, attempt: 2, leaseToken: 'm'.repeat(43)});
    if (recoveredClaim === null) throw new Error('recovered claim');
    executorNow = new Date('2026-08-11T11:04:30.000Z');
    const completionPayload = {jobId: claim.jobId, deploymentId: ids.production, deploymentVersion: 2, attempt: 2,
      result: {outcome: 'rolled_back' as const, startedAt: '2026-08-11T11:04:01.000Z',
        completedAt: '2026-08-11T11:04:20.000Z',
        smokeChecks: [{name: 'health', status: 'failed' as const, reference: 'evidence:smoke:failed'}],
        rollback: {outcome: 'completed' as const, reference: 'evidence:rollback:completed'}}};
    await expect(executor.complete({authorization, payload: {...completionPayload, attempt: 1},
      leaseToken: claim.leaseToken})).resolves.toBeNull();
    await expect(executor.complete({authorization, payload: {...completionPayload, jobId: randomUUID()},
      leaseToken: recoveredClaim.leaseToken})).resolves.toBeNull();
    await expect(executor.complete({authorization, payload: completionPayload, leaseToken: recoveredClaim.leaseToken}))
      .resolves.toMatchObject({outcome: 'rolled_back', completedAt: '2026-08-11T11:04:20.000Z'});
    await expect(executor.complete({authorization, payload: completionPayload, leaseToken: recoveredClaim.leaseToken}))
      .resolves.toMatchObject({outcome: 'rolled_back'});
    await expect(executor.complete({authorization, payload: {...completionPayload, attempt: 1},
      leaseToken: recoveredClaim.leaseToken})).resolves.toBeNull();
    const [persisted] = await db.select().from(deployments).where(eq(deployments.id, ids.production));
    expect(persisted).toMatchObject({workspaceId: ids.workspace, workItemId: ids.workItem,
      planVersionId: ids.planVersion, materializationId: ids.materialization, status: 'observed', version: 3,
      externalRef: null, observedResult: {outcome: 'rolled_back'},
      rollbackEvidence: {outcome: 'completed', reference: 'evidence:rollback:completed'}});
    expect(persisted?.observedResult?.reference).toMatch(new RegExp(`^deployment-job:${claim.jobId}:attempt:2:result:[0-9a-f]{64}$`));
    await expect(db.update(deployments).set({releasePackage: {...requestPayload.releasePackage,
      unexpected: 'field'} as never}).where(eq(deployments.id, ids.production))).rejects.toThrow();
    await expect(db.update(deployments).set({releasePackage: {...requestPayload.releasePackage,
      schemaVersion: '1'} as never}).where(eq(deployments.id, ids.production))).rejects.toThrow();
    await expect(db.update(deployments).set({releasePackage: null})
      .where(eq(deployments.id, ids.production))).rejects.toThrow();
    const [completedJob] = await db.select().from(deploymentExecutorJobs).where(eq(
      deploymentExecutorJobs.deploymentId, ids.production));
    expect(completedJob).toMatchObject({status: 'rolled_back', attempt: 2, executorId: null,
      observationReference: persisted?.observedResult?.reference});
    await expect(db.update(deploymentExecutorJobs).set({resultHash: null})
      .where(eq(deploymentExecutorJobs.deploymentId, ids.production))).rejects.toThrow();
    const projection = await createPostgresProjectTaskProjectionReader(db).read({workspaceId: ids.workspace,
      projectId: ids.project});
    expect(projection?.project.deployments.find(({id}) => id === ids.production)).toMatchObject({
      status: 'observed', nextAction: 'review_observation',
      externalEvidence: {availability: 'known', value: {outcome: 'rolled_back'}}
    });

    const stagingPayload = {...requestPayload, deploymentId: ids.staging, workItemId: null,
      environment: 'staging'};
    await expect(execute(command('deployment.request.v1', stagingPayload, 'staging-request')))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {state: 'approved', version: 1}}}});
    const [staging] = await db.select().from(deployments).where(eq(deployments.id, ids.staging));
    expect(staging?.requestedByActorId).toBe(ids.owner); expect(staging?.approvedByActorId).toBe(ids.owner);
    let stagingNow = new Date('2026-08-11T12:00:00.000Z');
    const stagingExecutor = createDeploymentExecutorService({store: createPostgresDeploymentExecutorStore(db),
      now: () => stagingNow, tokenGenerator: () => 's'.repeat(43)});
    const stagingAuthorization = {...authorization, executorId: 'executor-staging',
      registrationId: ids.stagingRegistration, environments: ['staging' as const]};
    const stagingClaim = await stagingExecutor.claim(stagingAuthorization);
    expect(stagingClaim).toMatchObject({deploymentId: ids.staging, environment: 'staging', deploymentVersion: 1});
    if (stagingClaim === null) throw new Error('staging claim');
    stagingNow = new Date('2026-08-11T12:01:00.000Z');
    await expect(stagingExecutor.complete({authorization: stagingAuthorization, leaseToken: stagingClaim.leaseToken,
      payload: {jobId: stagingClaim.jobId, deploymentId: ids.staging, deploymentVersion: 1, attempt: 1,
        result: {outcome: 'succeeded', startedAt: '2026-08-11T12:00:00.000Z',
          completedAt: '2026-08-11T12:00:50.000Z',
          smokeChecks: [{name: 'health', status: 'passed', reference: 'evidence:staging:health'}],
          rollback: {outcome: 'not_required', reference: null}}}})).resolves.toMatchObject({outcome: 'succeeded'});
    const [completedStaging] = await db.select().from(deployments).where(eq(deployments.id, ids.staging));
    expect(completedStaging).toMatchObject({status: 'observed', version: 2,
      observedResult: {outcome: 'succeeded'}, rollbackEvidence: {outcome: 'not_required', reference: null}});
    expect((await db.select().from(auditEvents)).length).toBeGreaterThanOrEqual(14);
    expect((await db.select().from(commandReceipts)).length).toBeGreaterThanOrEqual(13);
  });
});
