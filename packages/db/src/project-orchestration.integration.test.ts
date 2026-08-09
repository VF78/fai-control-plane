import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {hashDeliveryProtocolDefinition} from '@fai-control-plane/domain';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {eq} from 'drizzle-orm';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors, agentProfiles, agentRuns, approvalRequests, canonicalEvents, commandReceipts,
  createDatabase, createPostgresProjectExecutionStore, deliveryJourneys, projectExecutions,
  loadProjectExecutionProjection,
  projectMemberships, projectPlanDrafts, projectPlanMaterializations, projectPlanVersions,
  projectPublicationIntents, projectScopeBaselineVersions, projectTrackerRepositoryScopes,
  projects, runbooks, runtimeRegistrations, secretRefs, taskPackets, workItemDependencies, workItems, workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) throw new Error('DATABASE_URL is required for project orchestration integration tests in CI.');
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_project_execution_${randomUUID().replaceAll('-', '')}`;

describePostgres('governed project orchestration persistence', () => {
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
    if (adminPool !== undefined) { try { await dropDatabaseWhenDisconnected(adminPool, databaseName); } finally { await adminPool.end(); } }
  }, 30_000);

  const seedAutonomousProject = async (humanOwned: boolean) => {
    const ids = {workspace: randomUUID(), project: randomUUID(), owner: randomUUID(), agent: randomUUID(),
      profile: randomUUID(), plan: randomUUID(), planVersion: randomUUID(), baseline: randomUUID(),
      protocol: randomUUID(), task: randomUUID()};
    await db.insert(workspaces).values({id: ids.workspace, name: 'Autonomous', slug: `autonomous-${randomUUID()}`});
    await db.insert(projects).values({id: ids.project, workspaceId: ids.workspace, name: 'Project', slug: `project-${randomUUID()}`});
    await db.insert(actors).values([
      {id: ids.owner, workspaceId: ids.workspace, type: 'human', role: 'workspace_admin', displayName: 'Owner', authMode: 'user'},
      {id: ids.agent, workspaceId: ids.workspace, type: 'agent', role: 'agent_operator', displayName: 'Agent', authMode: 'agent'}
    ]);
    await db.insert(projectMemberships).values([
      {id: randomUUID(), projectId: ids.project, actorId: ids.owner, role: 'project_owner'},
      {id: randomUUID(), projectId: ids.project, actorId: ids.agent, role: 'agent'}
    ]);
    await db.insert(agentProfiles).values({id: ids.profile, workspaceId: ids.workspace, actorId: ids.agent,
      runtimeId: 'fixture', runtimeProfile: 'read_safe'});
    await db.insert(runtimeRegistrations).values({projectId: ids.project, actorId: ids.agent,
      agentProfileId: ids.profile, provider: 'fixture', runtimeKey: `runtime-${randomUUID()}`});
    await db.insert(projectPlanDrafts).values({id: ids.plan, workspaceId: ids.workspace, projectId: ids.project,
      state: 'approved', definition: {} as never, contentHash: 'a'.repeat(64), revision: 1,
      createdByActorId: ids.owner, approvedByActorId: ids.owner, approvedAt: new Date()});
    await db.insert(projectPlanVersions).values({id: ids.planVersion, workspaceId: ids.workspace,
      projectId: ids.project, planId: ids.plan, version: 1, sourceRevision: 1, definition: {} as never,
      contentHash: 'a'.repeat(64), sourceManifest: [], simulation: {} as never,
      approvedByActorId: ids.owner, approvedAt: new Date()});
    await db.insert(projectScopeBaselineVersions).values({id: ids.baseline, projectId: ids.project,
      version: 1, active: true, sourcePlanVersionId: ids.planVersion, sourcePlanHash: 'a'.repeat(64)});
    await db.insert(projectPlanMaterializations).values({workspaceId: ids.workspace, projectId: ids.project,
      planVersionId: ids.planVersion, baselineId: ids.baseline, commandId: randomUUID(), planVersion: 1,
      planHash: 'a'.repeat(64), sourceManifestHash: 'b'.repeat(64), outcomeCount: 1, milestoneCount: 1,
      workItemCount: 1, dependencyCount: 0, journeyCount: 1, publicationIntentCount: 0, createdByActorId: ids.owner});
    const responsibility = humanOwned
      ? {kind: 'project_role' as const, role: 'project_owner' as const}
      : {kind: 'actor' as const, actorId: ids.agent, actorType: 'agent' as const, agentProfileId: ids.profile};
    const definition = {schemaVersion: 1 as const, stages: [{key: 'execute', name: 'Execute', enabled: true,
      taskStatus: 'ready' as const, responsibility, executionMode: 'autonomous' as const,
      entryCriteria: ['Ready'], requiredEvidence: ['Receipt'], allowedNextStageKey: null}]};
    await db.insert(runbooks).values({id: ids.protocol, projectId: ids.project, name: 'Autonomous', version: 1,
      definition, active: true, protocolState: 'published', revision: 1, contentHash: hashDeliveryProtocolDefinition(definition)});
    await db.insert(workItems).values({id: ids.task, projectId: ids.project, title: 'Autonomous task', status: 'ready',
      sourcePlanVersionId: ids.planVersion, sourceTaskKey: 'task_1', acceptanceEvidence: []});
    await db.insert(deliveryJourneys).values({workItemId: ids.task, protocolId: ids.protocol,
      protocolVersion: 1, stageKey: 'execute'});
    const store = createPostgresProjectExecutionStore(db);
    const command = (type: 'project_execution.start' | 'project_execution.pause', expectedVersion: number, key: string) => ({
      commandId: randomUUID(), workspaceId: ids.workspace, correlationId: randomUUID(), idempotencyKey: key,
      issuedAt: '2026-08-09T10:00:00.000Z', actor: {actorId: ids.owner}, type,
      payload: {projectId: ids.project, expectedVersion}
    });
    return {ids, store, command};
  };

  it('blocks a human-owned autonomous stage with an explicit manager decision', async () => {
    const {ids, store, command} = await seedAutonomousProject(true);
    await expect(store.execute({command: command('project_execution.start', 0, 'human-autonomous') as never,
      requestHash: 'h'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {value: {
      status: 'blocked', blockReason: 'autonomous_agent_required', selection: null,
      decisions: expect.arrayContaining([expect.objectContaining({
        id: `protocol:${ids.project}:agent_required`, kind: 'failure', source: 'delivery_protocol'
      })])
    }}}});
    expect((await db.select().from(projectExecutions).where(eq(projectExecutions.projectId, ids.project)))[0])
      .toMatchObject({status: 'blocked', selectedWorkItemId: null, selectedAgentProfileId: null});
  });

  it.each(['journey_advanced', 'protocol_inactive', 'actor_disabled', 'old_plan'] as const)(
    'projects stale autonomous selection as blocked and reconciles it on the next CAS command: %s',
    async (mutation) => {
      const {ids, store, command} = await seedAutonomousProject(false);
      await expect(store.execute({command: command('project_execution.start', 0, `start-${mutation}`) as never,
        requestHash: mutation.padEnd(64, '0'), authorized: true})).resolves.toMatchObject({receipt: {result: {value: {
        status: 'running', version: 1, selection: {workItemId: ids.task, planVersionId: ids.planVersion,
          responsibleActor: {id: ids.agent, type: 'agent', agentProfileId: ids.profile}}
      }}}});
      if (mutation === 'journey_advanced') {
        await db.update(deliveryJourneys).set({version: 2}).where(eq(deliveryJourneys.workItemId, ids.task));
      } else if (mutation === 'protocol_inactive') {
        await db.update(runbooks).set({active: false}).where(eq(runbooks.id, ids.protocol));
      } else if (mutation === 'actor_disabled') {
        await db.update(actors).set({disabledAt: new Date()}).where(eq(actors.id, ids.agent));
      } else {
        const newPlan = randomUUID(); const newPlanVersion = randomUUID(); const newBaseline = randomUUID();
        await db.update(projectScopeBaselineVersions).set({active: false})
          .where(eq(projectScopeBaselineVersions.id, ids.baseline));
        await db.insert(projectPlanDrafts).values({id: newPlan, workspaceId: ids.workspace, projectId: ids.project,
          state: 'approved', definition: {} as never, contentHash: 'c'.repeat(64), revision: 1,
          createdByActorId: ids.owner, approvedByActorId: ids.owner, approvedAt: new Date()});
        await db.insert(projectPlanVersions).values({id: newPlanVersion, workspaceId: ids.workspace,
          projectId: ids.project, planId: newPlan, version: 2, sourceRevision: 1, definition: {} as never,
          contentHash: 'c'.repeat(64), sourceManifest: [], simulation: {} as never,
          approvedByActorId: ids.owner, approvedAt: new Date()});
        await db.insert(projectScopeBaselineVersions).values({id: newBaseline, projectId: ids.project,
          version: 2, active: true, sourcePlanVersionId: newPlanVersion, sourcePlanHash: 'c'.repeat(64)});
        await db.insert(projectPlanMaterializations).values({workspaceId: ids.workspace, projectId: ids.project,
          planVersionId: newPlanVersion, baselineId: newBaseline, commandId: randomUUID(), planVersion: 2,
          planHash: 'c'.repeat(64), sourceManifestHash: 'd'.repeat(64), outcomeCount: 1, milestoneCount: 1,
          workItemCount: 1, dependencyCount: 0, journeyCount: 0, publicationIntentCount: 0,
          createdByActorId: ids.owner, createdAt: new Date(Date.now() + 1_000)});
      }
      await expect(loadProjectExecutionProjection(db, ids.workspace, ids.project)).resolves.toMatchObject({
        status: 'blocked', version: 1, blockReason: 'selection_preconditions_stale', selection: null,
        decisions: expect.arrayContaining([expect.objectContaining({id: `selection:${ids.task}:stale`, kind: 'failure'})])
      });
      await expect(store.execute({command: command('project_execution.pause', 1, `reconcile-${mutation}`) as never,
        requestHash: `r-${mutation}`.padEnd(64, '0'), authorized: true})).resolves.toMatchObject({receipt: {result: {
        error: {code: 'VERSION_CONFLICT'}
      }}});
      expect((await db.select().from(projectExecutions).where(eq(projectExecutions.projectId, ids.project)))[0])
        .toMatchObject({status: 'blocked', version: 2, blockReason: 'selection_preconditions_stale', selectedWorkItemId: null});
    }
  );

  it('serializes Start, preserves the journey, projects real decisions, and pauses/resumes with CAS', async () => {
    const ids = {workspace: randomUUID(), project: randomUUID(), owner: randomUUID(), secondOwner: randomUUID(), agent: randomUUID(),
      profile: randomUUID(), plan: randomUUID(), planVersion: randomUUID(), baseline: randomUUID(),
      materialization: randomUUID(), protocol: randomUUID(), task: randomUUID(), event: randomUUID(),
      secret: randomUUID(), repository: randomUUID(), packet: randomUUID(), failedRun: randomUUID(),
      approval: randomUUID(), publication: randomUUID(), foreignProject: randomUUID(), foreignTask: randomUUID(),
      foreignApproval: randomUUID(), foreignWorkspace: randomUUID()};
    await db.insert(workspaces).values({id: ids.workspace, name: 'Orchestration', slug: `orchestration-${randomUUID()}`});
    await db.insert(workspaces).values({id: ids.foreignWorkspace, name: 'Foreign', slug: `foreign-${randomUUID()}`});
    await db.insert(projects).values([
      {id: ids.project, workspaceId: ids.workspace, name: 'Project', slug: `project-${randomUUID()}`},
      {id: ids.foreignProject, workspaceId: ids.foreignWorkspace, name: 'Foreign project', slug: `foreign-project-${randomUUID()}`}
    ]);
    await db.insert(actors).values([
      {id: ids.owner, workspaceId: ids.workspace, type: 'human', role: 'delivery_lead', displayName: 'Owner', authMode: 'user'},
      {id: ids.agent, workspaceId: ids.workspace, type: 'agent', role: 'agent_operator', displayName: 'Agent', authMode: 'agent'}
    ]);
    await db.insert(projectMemberships).values([
      {id: randomUUID(), projectId: ids.project, actorId: ids.owner, role: 'project_owner'},
      {id: randomUUID(), projectId: ids.project, actorId: ids.agent, role: 'agent'}
    ]);
    await db.insert(agentProfiles).values({id: ids.profile, workspaceId: ids.workspace, actorId: ids.agent,
      runtimeId: 'fixture', runtimeProfile: 'read_safe'});
    await db.insert(projectPlanDrafts).values({id: ids.plan, workspaceId: ids.workspace, projectId: ids.project,
      state: 'approved', definition: {} as never, contentHash: 'a'.repeat(64), revision: 2,
      createdByActorId: ids.owner, approvedByActorId: ids.owner, approvedAt: new Date()});
    await db.insert(projectPlanVersions).values({id: ids.planVersion, workspaceId: ids.workspace,
      projectId: ids.project, planId: ids.plan, version: 1, sourceRevision: 1, definition: {} as never,
      contentHash: 'a'.repeat(64), sourceManifest: [], simulation: {} as never, approvedByActorId: ids.owner,
      approvedAt: new Date()});
    await db.insert(projectScopeBaselineVersions).values({id: ids.baseline, projectId: ids.project,
      version: 1, active: true, sourcePlanVersionId: ids.planVersion, sourcePlanHash: 'a'.repeat(64)});
    await db.insert(projectPlanMaterializations).values({id: ids.materialization, workspaceId: ids.workspace,
      projectId: ids.project, planVersionId: ids.planVersion, baselineId: ids.baseline,
      commandId: randomUUID(), planVersion: 1, planHash: 'a'.repeat(64), sourceManifestHash: 'b'.repeat(64),
      outcomeCount: 1, milestoneCount: 1, workItemCount: 1, dependencyCount: 0, journeyCount: 1,
      publicationIntentCount: 1, createdByActorId: ids.owner});
    const definition = {schemaVersion: 1 as const, stages: [{key: 'intake', name: 'Intake', enabled: true,
      taskStatus: 'ready' as const, responsibility: {kind: 'project_role' as const, role: 'project_owner' as const},
      executionMode: 'manual' as const, entryCriteria: ['Brief ready'], requiredEvidence: ['Accepted brief'],
      allowedNextStageKey: null}]};
    await db.insert(runbooks).values({id: ids.protocol, projectId: ids.project, name: 'Delivery', version: 1,
      definition, active: true, protocolState: 'published', revision: 1, contentHash: hashDeliveryProtocolDefinition(definition)});
    await db.insert(workItems).values({id: ids.task, projectId: ids.project, title: 'Materialized task', status: 'ready',
      sourcePlanVersionId: ids.planVersion, sourceTaskKey: 'task_1', acceptanceEvidence: []});
    await db.insert(workItems).values({id: ids.foreignTask, projectId: ids.foreignProject, title: 'Foreign task', status: 'ready'});
    await db.insert(deliveryJourneys).values({workItemId: ids.task, protocolId: ids.protocol,
      protocolVersion: 1, stageKey: 'intake'});
    await db.insert(projectPublicationIntents).values({id: ids.publication, workspaceId: ids.workspace,
      projectId: ids.project, planVersionId: ids.planVersion, surface: 'tracker', mode: 'link_existing',
      resourceKind: 'work_item', canonicalId: ids.task, idempotencyKey: randomUUID()});
    await db.insert(approvalRequests).values({id: ids.approval, projectId: ids.project, workItemId: ids.task,
      actionCategory: 'write', surface: 'control_plane', environment: 'development', subjectHash: 'c'.repeat(64),
      policyVersion: 1, executionIdentity: ids.owner, actionHash: 'd'.repeat(64), status: 'pending',
      requestedByActorId: ids.owner, expiresAt: new Date(Date.now() + 60_000)});
    await db.insert(approvalRequests).values({id: ids.foreignApproval, projectId: ids.project, workItemId: ids.foreignTask,
      actionCategory: 'write', surface: 'control_plane', environment: 'development', subjectHash: '1'.repeat(64),
      policyVersion: 1, executionIdentity: ids.owner, actionHash: '2'.repeat(64), status: 'pending',
      requestedByActorId: ids.owner, expiresAt: new Date(Date.now() + 60_000)});
    await db.insert(secretRefs).values({id: ids.secret, workspaceId: ids.workspace, provider: 'fixture', reference: `fixture/${ids.project}`});
    await db.insert(projectTrackerRepositoryScopes).values({id: ids.repository, projectId: ids.project,
      provider: 'fixture', repositoryOwner: 'owner', repositoryName: 'repo', repositoryExternalId: ids.project,
      credentialRefId: ids.secret});
    await db.insert(canonicalEvents).values({id: ids.event, workspaceId: ids.workspace, projectId: ids.project,
      eventType: 'task.ready', aggregateType: 'work_item', aggregateId: ids.task,
      deduplicationKey: randomUUID(), payload: {}, occurredAt: new Date()});
    await db.insert(taskPackets).values({id: ids.packet, projectId: ids.project, workItemId: ids.task,
      workItemVersion: 1, goal: 'Fixture', acceptanceCriteria: ['Done'], dataPolicy: {}, timeboxMinutes: 10,
      expectedOutputSchema: {}, reviewerActorId: ids.owner, approverActorId: ids.owner,
      runtimeProfile: 'read_safe', authMode: 'agent', createdFromEventId: ids.event,
      contentHash: 'e'.repeat(64), createdByActorId: ids.owner});
    await db.insert(agentRuns).values({id: ids.failedRun, taskPacketId: ids.packet, agentProfileId: ids.profile,
      workItemId: ids.task, repositoryScopeId: ids.repository, confirmedPacketHash: 'e'.repeat(64),
      baseCommit: 'f'.repeat(40), status: 'failed', idempotencyKey: randomUUID(), failureCode: 'fixture_failure'});
    const store = createPostgresProjectExecutionStore(db);
    const command = (key: string, type: 'project_execution.start' | 'project_execution.pause' | 'project_execution.resume', expectedVersion: number) => ({
      commandId: randomUUID(), workspaceId: ids.workspace, correlationId: randomUUID(), idempotencyKey: key,
      issuedAt: '2026-08-09T10:00:00.000Z', actor: {actorId: ids.owner}, type,
      payload: {projectId: ids.project, expectedVersion}
    });
    const starts = await Promise.all(['start-a', 'start-b'].map((key) => store.execute({
      command: command(key, 'project_execution.start', 0) as never,
      requestHash: key.padEnd(64, key.at(-1)!), authorized: true
    })));
    expect(starts.filter((entry) => 'receipt' in entry && entry.receipt.result.ok)).toHaveLength(1);
    expect(starts.filter((entry) => 'receipt' in entry && !entry.receipt.result.ok && entry.receipt.result.error.code === 'VERSION_CONFLICT')).toHaveLength(1);
    const successful = starts.find((entry) => 'receipt' in entry && entry.receipt.result.ok)!;
    expect(successful).toMatchObject({receipt: {result: {value: {status: 'blocked', version: 1,
      blockReason: 'provider_handoff_required', selection: {workItemId: ids.task, boundary: 'provider_handoff_required'},
      decisions: expect.arrayContaining([
        expect.objectContaining({kind: 'approval', source: 'approval'}),
        expect.objectContaining({kind: 'failure', source: 'agent_run'}),
        expect.objectContaining({kind: 'provider_handoff', source: 'delivery_protocol'}),
        expect.objectContaining({kind: 'provider_handoff', source: 'publication'})
      ])}}}});
    if (!('receipt' in successful) || !successful.receipt.result.ok) throw new Error('expected successful start');
    expect(successful.receipt.result.value.decisions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({id: `approval:${ids.foreignApproval}`})
    ]));
    await expect(loadProjectExecutionProjection(db, ids.foreignWorkspace, ids.project)).resolves.toMatchObject({
      status: 'stopped', version: 0, decisions: []
    });
    expect(await db.select().from(deliveryJourneys).where(eq(deliveryJourneys.workItemId, ids.task))).toHaveLength(1);
    expect(await db.select().from(agentRuns).where(eq(agentRuns.workItemId, ids.task))).toHaveLength(1);
    const pause = command('pause', 'project_execution.pause', 1);
    await expect(store.execute({command: pause as never, requestHash: 'p'.repeat(64), authorized: true}))
      .resolves.toMatchObject({receipt: {result: {value: {status: 'paused', version: 2}}}});
    await expect(store.execute({command: pause as never, requestHash: 'p'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'replayed', receipt: {result: {value: {status: 'paused', version: 2}}}});
    await expect(store.execute({command: command('resume-stale', 'project_execution.resume', 1) as never,
      requestHash: 's'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
    await expect(store.execute({command: command('resume', 'project_execution.resume', 2) as never,
      requestHash: 'r'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {value: {status: 'blocked', version: 3}}}});
    expect((await db.select().from(projectExecutions).where(eq(projectExecutions.projectId, ids.project)))[0]).toMatchObject({status: 'blocked', version: 3});
    await store.execute({command: command('pause-ambiguity', 'project_execution.pause', 3) as never,
      requestHash: 'u'.repeat(64), authorized: true});
    await db.insert(actors).values({id: ids.secondOwner, workspaceId: ids.workspace, type: 'human',
      role: 'developer', displayName: 'Second owner', authMode: 'user'});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId: ids.project,
      actorId: ids.secondOwner, role: 'project_owner'});
    await expect(store.execute({command: command('resume-ambiguity', 'project_execution.resume', 4) as never,
      requestHash: 'v'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {value: {
      status: 'blocked', version: 5, blockReason: 'delivery_protocol_not_ready', selection: null
    }}}});
    expect(await db.select().from(commandReceipts).where(eq(commandReceipts.workspaceId, ids.workspace))).toHaveLength(7);
  });

  it('does not select ready work behind an unfinished dependency and completes only from persisted done facts', async () => {
    const ids = {workspace: randomUUID(), project: randomUUID(), owner: randomUUID(), plan: randomUUID(),
      planVersion: randomUUID(), baseline: randomUUID(), first: randomUUID(), second: randomUUID()};
    await db.insert(workspaces).values({id: ids.workspace, name: 'Dependencies', slug: `dependencies-${randomUUID()}`});
    await db.insert(projects).values({id: ids.project, workspaceId: ids.workspace, name: 'Project', slug: `project-${randomUUID()}`});
    await db.insert(actors).values({id: ids.owner, workspaceId: ids.workspace, type: 'human', role: 'workspace_admin', displayName: 'Owner', authMode: 'user'});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId: ids.project, actorId: ids.owner, role: 'project_owner'});
    await db.insert(projectPlanDrafts).values({id: ids.plan, workspaceId: ids.workspace, projectId: ids.project,
      state: 'approved', definition: {} as never, contentHash: 'a'.repeat(64), revision: 2, createdByActorId: ids.owner,
      approvedByActorId: ids.owner, approvedAt: new Date()});
    await db.insert(projectPlanVersions).values({id: ids.planVersion, workspaceId: ids.workspace, projectId: ids.project,
      planId: ids.plan, version: 1, sourceRevision: 1, definition: {} as never, contentHash: 'a'.repeat(64), sourceManifest: [],
      simulation: {} as never, approvedByActorId: ids.owner, approvedAt: new Date()});
    await db.insert(projectScopeBaselineVersions).values({id: ids.baseline, projectId: ids.project, version: 1,
      active: true, sourcePlanVersionId: ids.planVersion, sourcePlanHash: 'a'.repeat(64)});
    await db.insert(projectPlanMaterializations).values({workspaceId: ids.workspace, projectId: ids.project,
      planVersionId: ids.planVersion, baselineId: ids.baseline, commandId: randomUUID(), planVersion: 1,
      planHash: 'a'.repeat(64), sourceManifestHash: 'b'.repeat(64), outcomeCount: 1, milestoneCount: 1,
      workItemCount: 2, dependencyCount: 1, journeyCount: 0, publicationIntentCount: 0, createdByActorId: ids.owner});
    await db.insert(workItems).values([
      {id: ids.first, projectId: ids.project, title: 'Dependency', status: 'backlog', sourcePlanVersionId: ids.planVersion, sourceTaskKey: 'a', acceptanceEvidence: []},
      {id: ids.second, projectId: ids.project, title: 'Blocked by dependency', status: 'ready', sourcePlanVersionId: ids.planVersion, sourceTaskKey: 'b', acceptanceEvidence: []}
    ]);
    await db.insert(workItemDependencies).values({workItemId: ids.second, dependsOnWorkItemId: ids.first, sourcePlanVersionId: ids.planVersion});
    const store = createPostgresProjectExecutionStore(db);
    const command = (type: 'project_execution.start' | 'project_execution.pause' | 'project_execution.resume', expectedVersion: number, key: string) => ({
      commandId: randomUUID(), workspaceId: ids.workspace, correlationId: randomUUID(), idempotencyKey: key,
      issuedAt: '2026-08-09T10:00:00.000Z', actor: {actorId: ids.owner}, type, payload: {projectId: ids.project, expectedVersion}
    });
    await expect(store.execute({command: command('project_execution.start', 0, 'start') as never,
      requestHash: 'a'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {value: {
      status: 'blocked', blockReason: 'no_ready_unblocked_work_item', selection: null
    }}}});
    await store.execute({command: command('project_execution.pause', 1, 'pause') as never, requestHash: 'b'.repeat(64), authorized: true});
    await db.update(workItems).set({status: 'done'}).where(eq(workItems.projectId, ids.project));
    await expect(store.execute({command: command('project_execution.resume', 2, 'resume') as never,
      requestHash: 'c'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {value: {
      status: 'completed', version: 3, selection: null
    }}}});
  });
});
