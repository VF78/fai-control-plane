import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {defaultDeliveryProtocolDefinition, MVP_AGENT_RUN_RETRY_POLICY} from '@fai-control-plane/domain';
import {
  hashAgentProfileConfiguration,
  hashDeliveryProtocolDefinition,
  validateDeliveryEvidenceReferences
} from '@fai-control-plane/domain';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {and, eq, inArray} from 'drizzle-orm';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors, agentProfiles, agentRunReceipts, agentRuns, approvalRequests, artifacts, auditEvents,
  canonicalEvents, commandReceipts,
  createDatabase, createPostgresAgentRunRetryContinuationStore,
  createPostgresProjectExecutionDispatcher, createPostgresProjectExecutionStore,
  createPostgresAgentRunAcceptanceStore, createPostgresProjectOutcomeAcceptanceStore, createPostgresRunnerClaimStore,
  deliveryJourneyEvidence, deliveryJourneys,
  outboxEvents, projectExecutionDispatches, projectExecutions,
  loadProjectExecutionProjection,
  projectMemberships, projectPlanDrafts, projectPlanMaterializations, projectPlanVersions,
  projectPublicationIntents, projectScopeBaselineVersions, projectTrackerRepositoryScopes,
  projectScopeOutcomeObservations, projectScopeOutcomes,
  projects, runbooks, runtimeRegistrations, secretRefs, taskPackets, trackerBindings,
  riskSignals, statusTransitions, workItemDependencies, workItemScopeOutcomes, workItems, workspaces
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

  const seedAutonomousProject = async (humanOwned: boolean, sameStatusNext = false) => {
    const ids = {workspace: randomUUID(), project: randomUUID(), owner: randomUUID(), agent: randomUUID(),
      profile: randomUUID(), plan: randomUUID(), planVersion: randomUUID(), baseline: randomUUID(),
      protocol: randomUUID(), task: randomUUID(), secret: randomUUID(), repository: randomUUID()};
    await db.insert(workspaces).values({id: ids.workspace, name: 'Autonomous', slug: `autonomous-${randomUUID()}`});
    await db.insert(projects).values({id: ids.project, workspaceId: ids.workspace, name: 'Project', slug: `project-${randomUUID()}`});
    await db.insert(actors).values([
      {id: ids.owner, workspaceId: ids.workspace, type: 'human', role: 'workspace_admin', displayName: 'Owner', authMode: 'user',
        capabilities: {'write:control_plane:development': true}},
      {id: ids.agent, workspaceId: ids.workspace, type: 'agent', role: 'agent_operator', displayName: 'Agent', authMode: 'agent'}
    ]);
    await db.insert(projectMemberships).values([
      {id: randomUUID(), projectId: ids.project, actorId: ids.owner, role: 'project_owner'},
      {id: randomUUID(), projectId: ids.project, actorId: ids.agent, role: 'agent'}
    ]);
    const profile = {runtimeId: 'codex-cli', runtimeProfile: 'read_safe', allowedTools: ['repository_read'],
      forbiddenSurfaces: ['production'], instructions: 'Complete only the immutable task packet.',
      settings: {resultFormat: 'structured_v1' as const, includeEvidence: true}, enabled: true, version: 1};
    await db.insert(agentProfiles).values({id: ids.profile, workspaceId: ids.workspace, actorId: ids.agent,
      ...profile, configHash: hashAgentProfileConfiguration(profile)});
    await db.insert(runtimeRegistrations).values({projectId: ids.project, actorId: ids.agent,
      agentProfileId: ids.profile, provider: 'fixture', runtimeKey: `runtime-${randomUUID()}`});
    const planDefinition = {title: 'Autonomous plan', outcomes: [{key: 'outcome_1', title: 'Result', weight: 100,
      evidence: {kind: 'assumption' as const, statement: 'Approved by the project owner.'}}],
      milestones: [{key: 'milestone_1', title: 'Done', checkpoint: 'Owner review', targetAt: null,
        evidence: {kind: 'assumption' as const, statement: 'Owner checkpoint.'}}], risks: [],
      tasks: [{key: 'task_1', title: 'Autonomous task', responsibility: {kind: 'project_role' as const, role: 'project_owner' as const}, outcomeKeys: ['outcome_1'], milestoneKey: 'milestone_1',
        dependsOn: [], acceptanceEvidence: [{description: 'Focused checks pass',
          evidence: {kind: 'assumption' as const, statement: 'Verification is required.'}}]}]};
    await db.insert(projectPlanDrafts).values({id: ids.plan, workspaceId: ids.workspace, projectId: ids.project,
      state: 'approved', definition: planDefinition, contentHash: 'a'.repeat(64), revision: 1,
      createdByActorId: ids.owner, approvedByActorId: ids.owner, approvedAt: new Date()});
    await db.insert(projectPlanVersions).values({id: ids.planVersion, workspaceId: ids.workspace,
      projectId: ids.project, planId: ids.plan, version: 1, sourceRevision: 1, definition: planDefinition,
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
    const definition = {schemaVersion: 1 as const, stages: [
      {key: 'development', name: 'Development', enabled: true,
        taskStatus: 'in_dev' as const, responsibility, executionMode: 'autonomous' as const,
        entryCriteria: ['Ready'], requiredEvidence: ['Implementation change', 'Relevant checks'],
        allowedNextStageKey: 'qa'},
      {key: 'qa', name: sameStatusNext ? 'Peer review' : 'QA', enabled: true,
        taskStatus: sameStatusNext ? 'in_dev' as const : 'qa' as const,
        responsibility: {kind: 'project_role' as const, role: 'project_owner' as const},
        executionMode: 'human_approval' as const, entryCriteria: ['Evidence accepted'],
        requiredEvidence: ['QA result'], allowedNextStageKey: null}
    ]};
    await db.insert(runbooks).values({id: ids.protocol, projectId: ids.project, name: 'Autonomous', version: 1,
      definition, active: true, protocolState: 'published', revision: 1, contentHash: hashDeliveryProtocolDefinition(definition)});
    await db.insert(workItems).values({id: ids.task, projectId: ids.project, title: 'Autonomous task', status: 'in_dev',
      sourcePlanVersionId: ids.planVersion, sourceTaskKey: 'task_1',
      acceptanceEvidence: planDefinition.tasks[0]!.acceptanceEvidence});
    await db.insert(deliveryJourneys).values({workItemId: ids.task, protocolId: ids.protocol,
      protocolVersion: 1, stageKey: 'development'});
    await db.insert(secretRefs).values({id: ids.secret, workspaceId: ids.workspace,
      provider: 'fixture', reference: `dispatch/${ids.project}`});
    await db.insert(projectTrackerRepositoryScopes).values({id: ids.repository, projectId: ids.project,
      provider: 'fixture', repositoryOwner: 'owner', repositoryName: 'repository',
      repositoryExternalId: `repository-${ids.project}`, credentialRefId: ids.secret});
    await db.insert(trackerBindings).values({projectId: ids.project, provider: 'fixture', surface: 'repository',
      externalId: `repository-${ids.project}`, entityType: 'project', entityId: ids.project,
      metadata: {defaultBranch: 'main', headSha: 'a'.repeat(40)}});
    const store = createPostgresProjectExecutionStore(db);
    const command = (type: 'project_execution.start' | 'project_execution.pause', expectedVersion: number, key: string) => ({
      commandId: randomUUID(), workspaceId: ids.workspace, correlationId: randomUUID(), idempotencyKey: key,
      issuedAt: '2026-08-09T10:00:00.000Z', actor: {actorId: ids.owner}, type,
      payload: {projectId: ids.project, expectedVersion}
    });
    return {ids, store, command};
  };

  const seedCompletedAcceptance = async (sameStatusNext = false) => {
    const fixture = await seedAutonomousProject(false, sameStatusNext);
    await fixture.store.execute({
      command: fixture.command('project_execution.start', 0, `accept-start-${randomUUID()}`) as never,
      requestHash: '1'.repeat(64), authorized: true
    });
    await createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true}).run({
      workspaceId: fixture.ids.workspace, projectId: fixture.ids.project,
      expectedVersion: 1, requestedByActorId: fixture.ids.owner
    });
    const [run] = await db.select().from(agentRuns)
      .where(eq(agentRuns.workItemId, fixture.ids.task));
    if (run === undefined) throw new Error('acceptance run fixture missing');
    const completedAt = new Date('2026-08-09T11:00:00.000Z');
    const receiptSha256 = 'a'.repeat(64);
    const summarySha256 = 'b'.repeat(64);
    const manifestSha256 = 'c'.repeat(64);
    const reference = `runs/${run.id}`;
    const metadata = {
      runId: run.id, attempt: 1, terminal: 'done' as const,
      receiptSha256, receiptSizeBytes: 512, finalStatus: 'succeeded' as const,
      runtimeId: 'codex-cli', runtimeProfile: 'read_safe' as const, durationMs: 2_000,
      cost: {state: 'unknown' as const, reason: 'runtime_usage_not_available' as const},
      usage: {state: 'unknown' as const, reason: 'runtime_usage_not_available' as const},
      summaryArtifact: {name: 'structured-summary.json',
        reference: `${reference}/structured-summary.json`, sha256: summarySha256, sizeBytes: 200},
      artifactStore: {provider: 'fixture', reference, correlationId: `artifact-run-${run.id}`},
      receiptArtifact: {name: 'agent-run-receipt.json',
        reference: `${reference}/agent-run-receipt.json`, sha256: receiptSha256, sizeBytes: 512},
      pathManifest: {name: 'observed-path-manifest.json',
        reference: `${reference}/observed-path-manifest.json`, sha256: manifestSha256, sizeBytes: 100},
      changedFiles: ['src/result.ts'],
      checks: [{name: 'pnpm vitest run result.test.ts', status: 'passed' as const}],
      riskCount: 0, nextAction: 'review_receipt' as const
    };
    await db.update(agentRuns).set({status: 'done', attempt: 1, failureCode: null,
      completedAt, version: run.version + 1, updatedAt: completedAt})
      .where(eq(agentRuns.id, run.id));
    await db.insert(agentRunReceipts).values({agentRunId: run.id, runnerId: 'isolated-runner',
      attempt: 1, terminal: 'done', receiptSha256, receiptSizeBytes: 512,
      completionReplayHash: 'd'.repeat(64), metadata, completedAt});
    await db.insert(artifacts).values([
      {id: randomUUID(), agentRunId: run.id, kind: 'receipt', storageProvider: 'fixture',
        storageKey: metadata.receiptArtifact.reference, contentType: 'application/json',
        sha256: receiptSha256, sizeBytes: 512},
      {id: randomUUID(), agentRunId: run.id, kind: 'summary', storageProvider: 'fixture',
        storageKey: metadata.summaryArtifact.reference, contentType: 'application/json',
        sha256: summarySha256, sizeBytes: 200},
      {id: randomUUID(), agentRunId: run.id, kind: 'path_manifest', storageProvider: 'fixture',
        storageKey: metadata.pathManifest.reference, contentType: 'application/json',
        sha256: manifestSha256, sizeBytes: 100}
    ]);
    const store = createPostgresAgentRunAcceptanceStore(db, {
      parseCompletion: (value) => value as never,
      evidenceFor: (stage, payload, retained) => {
        if (payload.summaryArtifact === undefined || !retained.some((artifact) =>
          artifact.kind === 'summary' && !artifact.redacted &&
          artifact.storageKey === payload.summaryArtifact!.reference &&
          artifact.sha256 === payload.summaryArtifact!.sha256)) return {
            ok: false, error: {code: 'INVALID_COMMAND', message: 'summary not retained'}
          };
        return validateDeliveryEvidenceReferences(stage, stage.requiredEvidence.map((requirement) => ({
          requirement, reference: `agent-run-receipt:${payload.runId}:${payload.receiptSha256}`
        })));
      },
      now: () => new Date('2026-08-09T11:01:00.000Z')
    });
    const idempotencyKey = `agent-run-accept:v1:${run.id}:${receiptSha256}:${fixture.ids.owner}`;
    const command = (
      actorId = fixture.ids.owner,
      expectedReceiptSha256 = receiptSha256,
      expectedWorkItemVersion = 1
    ) => ({
      commandId: randomUUID(), workspaceId: fixture.ids.workspace, correlationId: randomUUID(),
      idempotencyKey: `agent-run-accept:v1:${run.id}:${expectedReceiptSha256}:${actorId}`,
      actor: {actorId}, type: 'agent_run.accept_result.v1' as const,
      payload: {runId: run.id, receiptSha256: expectedReceiptSha256, expectedWorkItemVersion}
    });
    return {...fixture, run, receiptSha256, store, command, idempotencyKey};
  };

  const seedOutcomeAcceptance = async () => {
    const fixture = await seedAutonomousProject(false);
    const finalDefinition = defaultDeliveryProtocolDefinition();
    const finalStage = finalDefinition.stages.at(-1)!;
    const first = randomUUID(); const second = randomUUID();
    await db.update(runbooks).set({definition: finalDefinition as never,
      contentHash: hashDeliveryProtocolDefinition(finalDefinition)})
      .where(eq(runbooks.id, fixture.ids.protocol));
    await db.update(workItems).set({status: 'done', version: 2})
      .where(eq(workItems.id, fixture.ids.task));
    await db.update(deliveryJourneys).set({stageKey: finalStage.key, version: 3})
      .where(eq(deliveryJourneys.workItemId, fixture.ids.task));
    await db.insert(deliveryJourneyEvidence).values(finalStage.requiredEvidence.map((requirement) => ({
      workItemId: fixture.ids.task, stageKey: finalStage.key, requirement,
      evidenceReference: `artifact://final/${requirement}`, commandId: randomUUID()
    })));
    await db.insert(projectScopeOutcomes).values([
      {id: first, baselineId: fixture.ids.baseline, sourcePlanVersionId: fixture.ids.planVersion,
        key: 'outcome_1', title: 'First', weight: 40, state: 'review'},
      {id: second, baselineId: fixture.ids.baseline, sourcePlanVersionId: fixture.ids.planVersion,
        key: 'outcome_2', title: 'Second', weight: 60, state: 'review'}
    ]);
    await db.insert(workItemScopeOutcomes).values([
      {workItemId: fixture.ids.task, outcomeId: first, sourcePlanVersionId: fixture.ids.planVersion},
      {workItemId: fixture.ids.task, outcomeId: second, sourcePlanVersionId: fixture.ids.planVersion}
    ]);
    await db.insert(projectExecutions).values({projectId: fixture.ids.project, status: 'blocked',
      blockReason: 'scope_outcomes_pending', version: 3,
      startedAt: new Date('2026-08-09T11:30:00.000Z')});
    const store = createPostgresProjectOutcomeAcceptanceStore(db, {
      now: () => new Date('2026-08-09T12:00:00.000Z')
    });
    const command = (outcomeId: string, expectedExecutionVersion = 3, actorId = fixture.ids.owner, commandId = randomUUID()) => ({
      commandId, workspaceId: fixture.ids.workspace, correlationId: randomUUID(),
      idempotencyKey: `project-outcome-accept:v1:${outcomeId}:${expectedExecutionVersion}:${actorId}`,
      actor: {actorId}, type: 'project_scope_outcome.accept.v1' as const,
      payload: {projectId: fixture.ids.project, baselineId: fixture.ids.baseline, outcomeId, expectedExecutionVersion}
    });
    return {...fixture, first, second, store, command};
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

  it('atomically freezes one exact autonomous selection and queues one runner-compatible AgentRun', async () => {
    const {ids, store, command} = await seedAutonomousProject(false);
    await store.execute({command: command('project_execution.start', 0, 'dispatch-start') as never,
      requestHash: 'd'.repeat(64), authorized: true});
    const dispatcher = createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true,
      now: () => new Date('2026-08-09T10:01:00.000Z')});
    const outcomes = await Promise.all([dispatcher.run({workspaceId: ids.workspace, projectId: ids.project, expectedVersion: 1,
      requestedByActorId: ids.owner}), dispatcher.run({projectId: ids.project, expectedVersion: 1,
      workspaceId: ids.workspace, requestedByActorId: ids.owner})]);
    expect(outcomes.reduce((sum, outcome) => sum + outcome.dispatched, 0)).toBe(1);
    expect(outcomes.reduce((sum, outcome) => sum + outcome.replayed, 0)).toBe(1);
    const [packet] = await db.select().from(taskPackets).where(eq(taskPackets.workItemId, ids.task));
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, ids.task));
    const [link] = await db.select().from(projectExecutionDispatches)
      .where(eq(projectExecutionDispatches.projectId, ids.project));
    expect(packet).toMatchObject({workItemVersion: 1, agentProfileSnapshotId: ids.profile,
      createdByActorId: ids.owner,
      acceptanceCriteria: ['Focused checks pass', 'Implementation change', 'Relevant checks']});
    expect(packet?.dataPolicy).toMatchObject({planVersionId: ids.planVersion, protocolId: ids.protocol,
      protocolRequiredEvidence: ['Implementation change', 'Relevant checks']});
    expect(run).toMatchObject({status: 'queued', taskPacketId: packet?.id, agentProfileId: ids.profile,
      repositoryScopeId: ids.repository, confirmedPacketHash: packet?.contentHash, baseCommit: 'a'.repeat(40)});
    expect(link).toMatchObject({executionVersion: 1, taskPacketId: packet?.id, agentRunId: run?.id,
      requestedByActorId: ids.owner, runtimeRegistrationVersion: 1,
      selectionHash: expect.stringMatching(/^[0-9a-f]{64}$/)});
    await expect(loadProjectExecutionProjection(db, ids.workspace, ids.project)).resolves.toMatchObject({
      status: 'running', dispatch: {taskPacketId: packet?.id, agentRunId: run?.id,
        agentRunStatus: 'queued', nextAction: expect.stringContaining('isolated runner')}});
    expect((await db.select().from(commandReceipts).where(eq(commandReceipts.aggregateId, run!.id)))[0])
      .toMatchObject({commandType: 'project_execution.dispatch.v1', expectedVersion: 1, resultVersion: 1,
        idempotencyKey: `project-execution-dispatch:v1:${ids.project}:1`});
    expect((await db.select().from(auditEvents).where(eq(auditEvents.targetId, run!.id)))[0])
      .toMatchObject({actorId: ids.owner, action: 'project_execution.dispatch.v1', expectedVersion: 1,
        resultVersion: 1, policyDecision: 'allow', outcome: 'succeeded'});
    expect((await db.select().from(canonicalEvents).where(and(
      eq(canonicalEvents.projectId, ids.project),
      eq(canonicalEvents.eventType, 'project_execution.dispatch_requested.v1'))))[0])
      .toMatchObject({payload: {executionVersion: 1, requestedByActorId: ids.owner}});
    expect(await db.select().from(outboxEvents).where(eq(outboxEvents.projectId, ids.project))).toHaveLength(0);
    await expect(store.execute({command: command('project_execution.pause', 1, 'dispatch-pause') as never,
      requestHash: '2'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {value: {
        status: 'paused', version: 2, dispatch: null
      }}}});
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)))[0])
      .toMatchObject({status: 'failed', failureCode: 'operator_cancelled_before_claim'});
  });

  it('accepts one exact AgentRun result atomically and replays concurrent Product Owner commands', async () => {
    const fixture = await seedCompletedAcceptance();
    const commands = [fixture.command(), fixture.command()];
    const results = await Promise.all(commands.map((command) => fixture.store.execute({
      command, requestHash: 'e'.repeat(64), authorized: true
    })));
    expect(results.map(({status}) => status).sort()).toEqual(['completed', 'replayed']);
    expect(await db.select().from(deliveryJourneyEvidence).where(eq(
      deliveryJourneyEvidence.workItemId, fixture.ids.task))).toEqual(expect.arrayContaining([
      expect.objectContaining({stageKey: 'development', requirement: 'Implementation change'}),
      expect.objectContaining({stageKey: 'development', requirement: 'Relevant checks'})
    ]));
    expect((await db.select().from(workItems).where(eq(workItems.id, fixture.ids.task)))[0])
      .toMatchObject({status: 'qa', version: 2});
    expect((await db.select().from(deliveryJourneys).where(eq(
      deliveryJourneys.workItemId, fixture.ids.task)))[0])
      .toMatchObject({stageKey: 'qa', version: 2});
    expect((await db.select().from(projectExecutions).where(eq(
      projectExecutions.projectId, fixture.ids.project)))[0]).toMatchObject({
      status: 'paused', version: 2, selectedWorkItemId: null,
      selectedJourneyVersion: null, selectedStageKey: null,
      blockReason: null, pausedAt: new Date('2026-08-09T11:01:00.000Z')
    });
    expect(await db.select().from(commandReceipts).where(eq(
      commandReceipts.idempotencyKey, fixture.idempotencyKey))).toHaveLength(1);
    expect(await db.select().from(auditEvents).where(eq(
      auditEvents.action, 'agent_run.accept_result.v1'))).toHaveLength(1);
  });

  it('records weighted Product Owner decisions atomically and completes only the final accepted outcome', async () => {
    const fixture = await seedOutcomeAcceptance();
    await db.update(runbooks).set({active: false, protocolState: 'retired'})
      .where(eq(runbooks.id, fixture.ids.protocol));
    await expect(fixture.store.execute({command: fixture.command(fixture.first) as never,
      requestHash: 'o'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: true,
      value: {outcomeId: fixture.first, acceptedWeight: 40, totalWeight: 100,
        executionStatus: 'blocked', executionVersion: 3}}}});
    expect((await db.select().from(projectExecutions).where(eq(
      projectExecutions.projectId, fixture.ids.project)))[0]).toMatchObject({status: 'blocked', version: 3});
    expect(await db.select().from(projectScopeOutcomeObservations).where(eq(
      projectScopeOutcomeObservations.projectId, fixture.ids.project))).toEqual(expect.arrayContaining([
      expect.objectContaining({acceptedWeight: 40, totalWeight: 100})
    ]));
    await expect(fixture.store.execute({command: fixture.command(fixture.second) as never,
      requestHash: 'p'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: true,
      value: {acceptedWeight: 100, totalWeight: 100, executionStatus: 'completed', executionVersion: 4}}}});
    expect((await db.select().from(projectExecutions).where(eq(
      projectExecutions.projectId, fixture.ids.project)))[0]).toMatchObject({status: 'completed', version: 4});
    expect(await db.select().from(projectScopeOutcomes).where(eq(
      projectScopeOutcomes.baselineId, fixture.ids.baseline))).toEqual(expect.arrayContaining([
      expect.objectContaining({id: fixture.first, state: 'accepted', acceptedByActorId: fixture.ids.owner}),
      expect.objectContaining({id: fixture.second, state: 'accepted', acceptedByActorId: fixture.ids.owner})
    ]));
  });

  it('does not count a schema-valid partial accepted row toward final completion', async () => {
    const fixture = await seedOutcomeAcceptance();
    await db.update(projectScopeOutcomes).set({state: 'accepted'}).where(eq(
      projectScopeOutcomes.id, fixture.first));
    await expect(fixture.store.execute({command: fixture.command(fixture.second) as never,
      requestHash: 'z'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: true,
      value: {acceptedWeight: 60, totalWeight: 100, executionStatus: 'blocked', executionVersion: 3}}}});
    expect((await db.select().from(projectExecutions).where(eq(
      projectExecutions.projectId, fixture.ids.project)))[0]).toMatchObject({status: 'blocked', version: 3});
  });

  it('keeps denials from poisoning corrected acceptance and rejects non-owner, stale, and cross-project commands', async () => {
    const fixture = await seedOutcomeAcceptance(); const exact = fixture.command(fixture.first);
    await expect(fixture.store.execute({command: exact as never, requestHash: 'q'.repeat(64), authorized: false,
      policyError: {code: 'POLICY_DENIED', message: 'fixture policy'}})).resolves.toMatchObject({receipt: {result: {ok: false,
      error: {code: 'POLICY_DENIED'}}}});
    await expect(fixture.store.execute({command: exact as never, requestHash: 'q'.repeat(64), authorized: true}))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {acceptedWeight: 40}}}});
    const correctedAudits = await db.select().from(auditEvents).where(and(
      eq(auditEvents.workspaceId, fixture.ids.workspace),
      eq(auditEvents.action, 'project_scope_outcome.accept.v1'),
      eq(auditEvents.targetId, fixture.first)
    ));
    expect(correctedAudits).toHaveLength(2);
    expect(correctedAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({policyDecision: 'deny', outcome: 'rejected', reasonCode: 'POLICY_DENIED'}),
      expect.objectContaining({commandId: exact.commandId, policyDecision: 'allow', outcome: 'succeeded'})
    ]));
    expect(new Set(correctedAudits.map(({commandId}) => commandId)).size).toBe(2);
    const outsider = randomUUID();
    await db.insert(actors).values({id: outsider, workspaceId: fixture.ids.workspace, type: 'human',
      role: 'developer', displayName: 'Outsider', authMode: 'user'});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId: fixture.ids.project,
      actorId: outsider, role: 'contributor'});
    await expect(fixture.store.execute({command: fixture.command(fixture.second, 3, outsider) as never,
      requestHash: 'r'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: false,
      error: {code: 'CAPABILITY_DENIED'}}}});
    await expect(fixture.store.execute({command: fixture.command(fixture.second, 2) as never,
      requestHash: 's'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: false,
      error: {code: 'VERSION_CONFLICT'}}}});
    const foreign = await seedOutcomeAcceptance(); const cross = fixture.command(fixture.second);
    await expect(fixture.store.execute({command: {...cross, payload: {...cross.payload,
      baselineId: foreign.ids.baseline, outcomeId: foreign.first}} as never,
      requestHash: 't'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: false,
      error: {code: 'NOT_FOUND'}}}});
  });

  it('serializes same and different concurrent outcome commands without premature completion', async () => {
    const same = await seedOutcomeAcceptance(); const repeated = same.command(same.first, 3, same.ids.owner, randomUUID());
    const sameResults = await Promise.all([1, 2].map(() => same.store.execute({command: repeated as never,
      requestHash: 'u'.repeat(64), authorized: true})));
    expect(sameResults.map(({status}) => status).sort()).toEqual(['completed', 'replayed']);
    expect((await db.select().from(projectExecutions).where(eq(
      projectExecutions.projectId, same.ids.project)))[0]).toMatchObject({status: 'blocked', version: 3});
    const different = await seedOutcomeAcceptance();
    const results = await Promise.all([different.store.execute({command: different.command(different.first) as never,
      requestHash: 'v'.repeat(64), authorized: true}), different.store.execute({command: different.command(different.second) as never,
      requestHash: 'w'.repeat(64), authorized: true})]);
    expect(results.every((result) => 'receipt' in result && result.receipt.result.ok)).toBe(true);
    expect((await db.select().from(projectExecutions).where(eq(
      projectExecutions.projectId, different.ids.project)))[0]).toMatchObject({status: 'completed', version: 4});
  });

  it('completes and audits policy denial, Product Owner denial, and a stale selection', async () => {
    const policy = await seedCompletedAcceptance();
    const policyCommand = policy.command();
    await expect(policy.store.execute({command: policyCommand, requestHash: '0'.repeat(64),
      authorized: false, policyError: {code: 'POLICY_DENIED', message: 'fixture policy denial'}}))
      .resolves.toMatchObject({status: 'completed', receipt: {result: {ok: false,
        error: {code: 'POLICY_DENIED'}}}});
    expect((await db.select().from(commandReceipts).where(eq(
      commandReceipts.commandId, policyCommand.commandId)))[0]).toMatchObject({state: 'completed',
      result: {ok: false, error: {code: 'POLICY_DENIED'}}});
    expect((await db.select().from(auditEvents).where(eq(
      auditEvents.commandId, policyCommand.commandId)))[0]).toMatchObject({
      policyDecision: 'deny', outcome: 'rejected', reasonCode: 'POLICY_DENIED'
    });

    const authority = await seedCompletedAcceptance();
    const outsider = randomUUID();
    await db.insert(actors).values({id: outsider, workspaceId: authority.ids.workspace,
      type: 'human', role: 'developer', displayName: 'Other member', authMode: 'user'});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId: authority.ids.project,
      actorId: outsider, role: 'project_owner'});
    const authorityCommand = authority.command(outsider);
    await expect(authority.store.execute({command: authorityCommand,
      requestHash: 'f'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {result: {ok: false,
        error: {code: 'CAPABILITY_DENIED'}}}});
    expect((await db.select().from(auditEvents).where(eq(
      auditEvents.commandId, authorityCommand.commandId)))[0]).toMatchObject({
      projectId: authority.ids.project, actorId: outsider, policyDecision: 'deny',
      outcome: 'rejected', reasonCode: 'CAPABILITY_DENIED'
    });

    const stale = await seedCompletedAcceptance();
    const staleCommand = stale.command(stale.ids.owner, stale.receiptSha256, 2);
    await expect(stale.store.execute({command: staleCommand,
      requestHash: '1'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {result: {ok: false,
        error: {code: 'VERSION_CONFLICT'}}}});
    expect((await db.select().from(auditEvents).where(eq(
      auditEvents.commandId, staleCommand.commandId)))[0]).toMatchObject({
      projectId: stale.ids.project, policyDecision: 'allow', outcome: 'failed',
      reasonCode: 'VERSION_CONFLICT', expectedVersion: 2, resultVersion: null
    });
  });

  it('completes exact workspace, receipt, and retained-evidence guard failures without mutation', async () => {
    const foreign = await seedCompletedAcceptance();
    const foreignWorkspace = randomUUID();
    await db.insert(workspaces).values({id: foreignWorkspace, name: 'Foreign',
      slug: `foreign-${randomUUID()}`});
    const foreignCommand = {...foreign.command(), workspaceId: foreignWorkspace};
    await expect(foreign.store.execute({command: foreignCommand,
      requestHash: '0'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {result: {ok: false,
        error: {code: 'NOT_FOUND'}}}});

    const receiptFixture = await seedCompletedAcceptance();
    const wrongReceipt = receiptFixture.command(receiptFixture.ids.owner, '9'.repeat(64));
    await expect(receiptFixture.store.execute({command: wrongReceipt,
      requestHash: '9'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {result: {ok: false,
        error: {code: 'INVALID_COMMAND'}}}});

    const evidenceFixture = await seedCompletedAcceptance();
    await db.delete(artifacts).where(and(eq(artifacts.agentRunId, evidenceFixture.run.id),
      eq(artifacts.kind, 'summary')));
    await expect(evidenceFixture.store.execute({command: evidenceFixture.command(),
      requestHash: '8'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {result: {ok: false,
        error: {code: 'INVALID_COMMAND'}}}});
    expect(await db.select().from(deliveryJourneyEvidence).where(eq(
      deliveryJourneyEvidence.workItemId, evidenceFixture.ids.task))).toHaveLength(0);
    expect((await db.select().from(workItems).where(eq(workItems.id, evidenceFixture.ids.task)))[0])
      .toMatchObject({status: 'in_dev', version: 1});
    expect((await db.select().from(auditEvents).where(eq(
      auditEvents.commandId, wrongReceipt.commandId)))[0]).toMatchObject({
      policyDecision: 'allow', outcome: 'failed', reasonCode: 'INVALID_COMMAND'
    });
  });

  it('lets the exact Product Owner succeed after a hostile contributor attempt', async () => {
    const fixture = await seedCompletedAcceptance();
    const contributor = randomUUID();
    await db.insert(actors).values({id: contributor, workspaceId: fixture.ids.workspace,
      type: 'human', role: 'developer', displayName: 'Contributor', authMode: 'user'});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId: fixture.ids.project,
      actorId: contributor, role: 'contributor'});
    const hostile = fixture.command(contributor);
    await expect(fixture.store.execute({command: hostile,
      requestHash: '3'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {idempotencyKey:
        expect.stringMatching(/^agent-run-accept-attempt:v1:/), result: {ok: false,
          error: {code: 'CAPABILITY_DENIED'}}}});
    const accepted = fixture.command();
    await expect(fixture.store.execute({command: accepted,
      requestHash: '4'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {
        idempotencyKey: fixture.idempotencyKey, result: {ok: true}}});
    expect((await db.select().from(commandReceipts).where(eq(
      commandReceipts.commandId, hostile.commandId)))[0]?.idempotencyKey)
      .toMatch(/^agent-run-accept-attempt:v1:/);
    expect((await db.select().from(commandReceipts).where(eq(
      commandReceipts.idempotencyKey, fixture.idempotencyKey)))[0])
      .toMatchObject({commandId: accepted.commandId, result: {ok: true}});
  });

  it('lets the same Product Owner succeed after stale and policy-denied attempts', async () => {
    const stale = await seedCompletedAcceptance();
    const staleCommand = stale.command(stale.ids.owner, stale.receiptSha256, 2);
    await expect(stale.store.execute({command: staleCommand,
      requestHash: '5'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {idempotencyKey:
        expect.stringMatching(/^agent-run-accept-attempt:v1:/), result: {ok: false,
          error: {code: 'VERSION_CONFLICT'}}}});
    const corrected = stale.command();
    await expect(stale.store.execute({command: corrected,
      requestHash: '6'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {
        idempotencyKey: stale.idempotencyKey, result: {ok: true}}});

    const policy = await seedCompletedAcceptance();
    const denied = policy.command();
    await expect(policy.store.execute({command: denied,
      requestHash: '7'.repeat(64), authorized: false,
      policyError: {code: 'POLICY_DENIED', message: 'capability missing'}}))
      .resolves.toMatchObject({status: 'completed', receipt: {idempotencyKey:
        expect.stringMatching(/^agent-run-accept-attempt:v1:/), result: {ok: false,
          error: {code: 'POLICY_DENIED'}}}});
    const restored = policy.command();
    await expect(policy.store.execute({command: restored,
      requestHash: '7'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {
        idempotencyKey: policy.idempotencyKey, result: {ok: true}}});
    expect(await db.select().from(auditEvents).where(and(
      eq(auditEvents.workspaceId, policy.ids.workspace),
      eq(auditEvents.action, 'agent_run.accept_result.v1')))).toHaveLength(2);
  });

  it('revalidates current Product Owner authority before a completed replay', async () => {
    const fixture = await seedCompletedAcceptance();
    const accepted = fixture.command();
    await expect(fixture.store.execute({command: accepted,
      requestHash: 'e'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {result: {ok: true}}});
    await db.update(actors).set({disabledAt: new Date('2026-08-09T11:02:00.000Z')})
      .where(eq(actors.id, fixture.ids.owner));
    const replay = fixture.command();
    await expect(fixture.store.execute({command: replay,
      requestHash: 'e'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {idempotencyKey:
        expect.stringMatching(/^agent-run-accept-attempt:v1:/), result: {ok: false,
          error: {code: 'CAPABILITY_DENIED'}}}});
    expect(await db.select().from(commandReceipts).where(eq(
      commandReceipts.idempotencyKey, fixture.idempotencyKey))).toEqual([
      expect.objectContaining({commandId: accepted.commandId,
        result: expect.objectContaining({ok: true})})
    ]);
    expect((await db.select().from(auditEvents).where(eq(
      auditEvents.commandId, replay.commandId)))[0]).toMatchObject({
      projectId: fixture.ids.project, actorId: fixture.ids.owner,
      policyDecision: 'deny', outcome: 'rejected', reasonCode: 'CAPABILITY_DENIED'
    });
  });

  it('accepts consecutive same-status stages without a WorkItem transition', async () => {
    const fixture = await seedCompletedAcceptance(true);
    const command = fixture.command();
    await expect(fixture.store.execute({command,
      requestHash: '2'.repeat(64), authorized: true}))
      .resolves.toMatchObject({status: 'completed', receipt: {result: {ok: true, value: {
        workItemStatus: 'in_dev', workItemVersion: 1, journeyStageKey: 'qa',
        journeyVersion: 2, executionStatus: 'paused', executionVersion: 2
      }}}});
    expect((await db.select().from(workItems).where(eq(workItems.id, fixture.ids.task)))[0])
      .toMatchObject({status: 'in_dev', version: 1});
    expect((await db.select().from(deliveryJourneys).where(eq(
      deliveryJourneys.workItemId, fixture.ids.task)))[0]).toMatchObject({stageKey: 'qa', version: 2});
    expect(await db.select().from(statusTransitions).where(eq(
      statusTransitions.idempotencyKey, fixture.idempotencyKey))).toHaveLength(0);
    expect(await db.select().from(deliveryJourneyEvidence).where(eq(
      deliveryJourneyEvidence.workItemId, fixture.ids.task))).toHaveLength(2);
    expect((await db.select().from(commandReceipts).where(eq(
      commandReceipts.commandId, command.commandId)))[0]).toMatchObject({
      resultVersion: 1, result: {ok: true}
    });
  });

  it('rolls back evidence, task, journey, execution, receipt, and audit on a late write failure', async () => {
    const fixture = await seedCompletedAcceptance();
    await db.insert(statusTransitions).values({workItemId: fixture.ids.task,
      fromStatus: 'in_dev', toStatus: 'qa', actorId: fixture.ids.owner,
      reason: 'collision fixture', idempotencyKey: fixture.idempotencyKey});
    await expect(fixture.store.execute({command: fixture.command(),
      requestHash: '7'.repeat(64), authorized: true})).rejects.toBeDefined();
    expect(await db.select().from(deliveryJourneyEvidence).where(eq(
      deliveryJourneyEvidence.workItemId, fixture.ids.task))).toHaveLength(0);
    expect((await db.select().from(workItems).where(eq(workItems.id, fixture.ids.task)))[0])
      .toMatchObject({status: 'in_dev', version: 1});
    expect((await db.select().from(deliveryJourneys).where(eq(
      deliveryJourneys.workItemId, fixture.ids.task)))[0])
      .toMatchObject({stageKey: 'development', version: 1});
    expect((await db.select().from(projectExecutions).where(eq(
      projectExecutions.projectId, fixture.ids.project)))[0])
      .toMatchObject({status: 'running', version: 1, selectedWorkItemId: fixture.ids.task});
    expect(await db.select().from(commandReceipts).where(eq(
      commandReceipts.idempotencyKey, fixture.idempotencyKey))).toHaveLength(0);
    expect(await db.select().from(auditEvents).where(and(
      eq(auditEvents.projectId, fixture.ids.project),
      eq(auditEvents.action, 'agent_run.accept_result.v1')))).toHaveLength(0);
  });

  it('denies and audits a hostile requester before checking an existing dispatch', async () => {
    const {ids, store, command} = await seedAutonomousProject(false);
    await store.execute({command: command('project_execution.start', 0, 'authority-start') as never,
      requestHash: 'c'.repeat(64), authorized: true});
    const dispatcher = createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true});
    await dispatcher.run({workspaceId: ids.workspace, projectId: ids.project, expectedVersion: 1,
      requestedByActorId: ids.owner});
    const hostileActorId = randomUUID();
    await db.insert(actors).values({id: hostileActorId, workspaceId: ids.workspace, type: 'human',
      role: 'developer', displayName: 'Hostile project member', authMode: 'user',
      capabilities: {'write:control_plane:development': true}});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId: ids.project,
      actorId: hostileActorId, role: 'contributor'});
    await expect(dispatcher.run({workspaceId: ids.workspace, projectId: ids.project,
      expectedVersion: 1, requestedByActorId: hostileActorId}))
      .resolves.toEqual({dispatched: 0, blocked: 0, replayed: 0, denied: 1});
    expect(await db.select().from(projectExecutionDispatches)
      .where(eq(projectExecutionDispatches.projectId, ids.project))).toHaveLength(1);
    expect((await db.select().from(auditEvents).where(and(
      eq(auditEvents.projectId, ids.project), eq(auditEvents.actorId, hostileActorId),
      eq(auditEvents.action, 'project_execution.dispatch.v1'))))[0])
      .toMatchObject({policyDecision: 'deny', outcome: 'rejected', reasonCode: 'CAPABILITY_DENIED',
        expectedVersion: 1, resultVersion: null});
    expect((await db.select().from(commandReceipts).where(and(
      eq(commandReceipts.workspaceId, ids.workspace),
      eq(commandReceipts.aggregateId, ids.project),
      eq(commandReceipts.commandType, 'project_execution.dispatch.v1'))))[0])
      .toMatchObject({commandType: 'project_execution.dispatch.v1', result: {ok: false,
        error: {code: 'CAPABILITY_DENIED'}}});
  });

  it('does not dispatch a paused selection and records an unavailable queue as a canonical decision', async () => {
    const paused = await seedAutonomousProject(false);
    await paused.store.execute({command: paused.command('project_execution.start', 0, 'pause-start') as never,
      requestHash: 'e'.repeat(64), authorized: true});
    await paused.store.execute({command: paused.command('project_execution.pause', 1, 'pause-before-dispatch') as never,
      requestHash: 'f'.repeat(64), authorized: true});
    const dispatcher = createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true});
    await expect(dispatcher.run({workspaceId: paused.ids.workspace, projectId: paused.ids.project, expectedVersion: 1,
      requestedByActorId: paused.ids.owner}))
      .resolves.toEqual({dispatched: 0, blocked: 0, replayed: 1, denied: 0});
    expect(await db.select().from(agentRuns).where(eq(agentRuns.workItemId, paused.ids.task))).toHaveLength(0);

    const unavailable = await seedAutonomousProject(false);
    await unavailable.store.execute({command: unavailable.command('project_execution.start', 0, 'unavailable-start') as never,
      requestHash: '1'.repeat(64), authorized: true});
    await expect(createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: false})
      .run({workspaceId: unavailable.ids.workspace, projectId: unavailable.ids.project, expectedVersion: 1,
        requestedByActorId: unavailable.ids.owner}))
      .resolves.toEqual({dispatched: 0, blocked: 1, replayed: 0, denied: 0});
    await expect(loadProjectExecutionProjection(db, unavailable.ids.workspace, unavailable.ids.project))
      .resolves.toMatchObject({status: 'blocked', blockReason: 'runner_queue_unavailable',
        decisions: expect.arrayContaining([expect.objectContaining({id: expect.stringContaining('runner_queue_unavailable')})])});
    expect((await db.select().from(auditEvents).where(and(
      eq(auditEvents.projectId, unavailable.ids.project),
      eq(auditEvents.action, 'project_execution.dispatch.v1'))))[0])
      .toMatchObject({policyDecision: 'deny', outcome: 'rejected', reasonCode: 'runner_queue_unavailable'});

    const denied = await seedAutonomousProject(false);
    await denied.store.execute({command: denied.command('project_execution.start', 0, 'denied-start') as never,
      requestHash: '6'.repeat(64), authorized: true});
    await db.update(actors).set({capabilities: {}}).where(eq(actors.id, denied.ids.owner));
    await expect(createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true})
      .run({workspaceId: denied.ids.workspace, projectId: denied.ids.project, expectedVersion: 1,
        requestedByActorId: denied.ids.owner}))
      .resolves.toEqual({dispatched: 0, blocked: 1, replayed: 0, denied: 0});
    await expect(loadProjectExecutionProjection(db, denied.ids.workspace, denied.ids.project))
      .resolves.toMatchObject({status: 'blocked', blockReason: 'dispatch_policy_denied'});

    const mismatchedRepository = await seedAutonomousProject(false);
    await mismatchedRepository.store.execute({command: mismatchedRepository.command(
      'project_execution.start', 0, 'repository-mismatch-start') as never,
    requestHash: '8'.repeat(64), authorized: true});
    await db.update(trackerBindings).set({externalId: `other-${randomUUID()}`})
      .where(eq(trackerBindings.projectId, mismatchedRepository.ids.project));
    await expect(createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true}).run({
      workspaceId: mismatchedRepository.ids.workspace, projectId: mismatchedRepository.ids.project, expectedVersion: 1,
      requestedByActorId: mismatchedRepository.ids.owner
    })).resolves.toEqual({dispatched: 0, blocked: 1, replayed: 0, denied: 0});
    expect(await db.select().from(agentRuns).where(eq(
      agentRuns.workItemId, mismatchedRepository.ids.task))).toHaveLength(0);
    await expect(loadProjectExecutionProjection(db, mismatchedRepository.ids.workspace,
      mismatchedRepository.ids.project)).resolves.toMatchObject({
      status: 'blocked', blockReason: 'repository_base_commit_unavailable'
    });

    const stale = await seedAutonomousProject(false);
    await stale.store.execute({command: stale.command('project_execution.start', 0, 'stale-start') as never,
      requestHash: '7'.repeat(64), authorized: true});
    await db.update(workItems).set({version: 2}).where(eq(workItems.id, stale.ids.task));
    await expect(createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true})
      .run({workspaceId: stale.ids.workspace, projectId: stale.ids.project, expectedVersion: 1,
        requestedByActorId: stale.ids.owner}))
      .resolves.toEqual({dispatched: 0, blocked: 1, replayed: 0, denied: 0});
    expect(await db.select().from(agentRuns).where(eq(agentRuns.workItemId, stale.ids.task))).toHaveLength(0);
    await expect(loadProjectExecutionProjection(db, stale.ids.workspace, stale.ids.project))
      .resolves.toMatchObject({status: 'blocked', blockReason: 'selection_preconditions_stale'});
    expect((await db.select().from(auditEvents).where(and(
      eq(auditEvents.projectId, stale.ids.project),
      eq(auditEvents.action, 'project_execution.dispatch.v1'))))[0])
      .toMatchObject({policyDecision: 'allow', outcome: 'failed', reasonCode: 'selection_preconditions_stale'});
  });

  it('queues the existing isolated-runner claim contract without exposing provider credentials', async () => {
    const {ids, store, command} = await seedAutonomousProject(false);
    await store.execute({command: command('project_execution.start', 0, 'claim-start') as never,
      requestHash: '3'.repeat(64), authorized: true});
    await createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true})
      .run({workspaceId: ids.workspace, projectId: ids.project, expectedVersion: 1,
        requestedByActorId: ids.owner});
    const claimedAt = new Date('2026-08-09T10:02:00.000Z');
    const claimInput = {workspaceId: ids.workspace,
      runnerId: 'isolated-runner', projectIds: [ids.project],
      repositories: [{owner: 'owner', name: 'repository'}], runtimeIds: ['codex-cli'],
      leaseTokenHash: 'f'.repeat(64), claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + 60_000)};
    await expect(createPostgresRunnerClaimStore(db, {activationEnvironment: {
      RUNNER_ENABLED: 'false', LOCAL_RUNNER_TRANSPORT_ENABLED: 'true'
    }}).claim(claimInput, (record) => record)).resolves.toBeNull();
    expect((await db.select().from(agentRuns).where(eq(agentRuns.workItemId, ids.task)))[0])
      .toMatchObject({status: 'queued', attempt: 0});
    const claim = await createPostgresRunnerClaimStore(db, {activationEnvironment: {
      RUNNER_ENABLED: 'true', LOCAL_RUNNER_TRANSPORT_ENABLED: 'true'
    }}).claim(claimInput, (record) => record);
    expect(claim).toMatchObject({attempt: 1, runtimeId: 'codex-cli', runtimeProfile: 'read_safe',
      repository: {owner: 'owner', name: 'repository'}, baseCommit: 'a'.repeat(40),
      promptFields: {acceptanceCriteria: ['Focused checks pass', 'Implementation change', 'Relevant checks']}});
    expect(JSON.stringify(claim)).not.toContain(ids.secret);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, claim!.runId)))[0])
      .toMatchObject({status: 'running', runnerId: 'isolated-runner', attempt: 1});
  });

  it('rolls back a late persistence failure and retries without duplicate packet or run', async () => {
    const {ids, store, command} = await seedAutonomousProject(false);
    await store.execute({command: command('project_execution.start', 0, 'retry-start') as never,
      requestHash: '4'.repeat(64), authorized: true});
    const idempotencyKey = `project-execution-dispatch:v1:${ids.project}:1`;
    await db.insert(commandReceipts).values({workspaceId: ids.workspace, idempotencyKey,
      requestHash: '5'.repeat(64), commandId: randomUUID(), correlationId: randomUUID(),
      state: 'completed', commandType: 'test.collision', result: {ok: false}, completedAt: new Date()});
    const dispatcher = createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true});
    await expect(dispatcher.run({workspaceId: ids.workspace, projectId: ids.project, expectedVersion: 1,
      requestedByActorId: ids.owner})).rejects.toBeDefined();
    expect(await db.select().from(taskPackets).where(eq(taskPackets.workItemId, ids.task))).toHaveLength(0);
    expect(await db.select().from(agentRuns).where(eq(agentRuns.workItemId, ids.task))).toHaveLength(0);
    await db.delete(commandReceipts).where(eq(commandReceipts.idempotencyKey, idempotencyKey));
    await expect(dispatcher.run({workspaceId: ids.workspace, projectId: ids.project, expectedVersion: 1,
      requestedByActorId: ids.owner}))
      .resolves.toEqual({dispatched: 1, blocked: 0, replayed: 0, denied: 0});
    expect(await db.select().from(taskPackets).where(eq(taskPackets.workItemId, ids.task))).toHaveLength(1);
    expect(await db.select().from(agentRuns).where(eq(agentRuns.workItemId, ids.task))).toHaveLength(1);
  });

  it('rejects a dispatch link assembled from another project packet, run, or runtime', async () => {
    const target = await seedAutonomousProject(false);
    const foreign = await seedAutonomousProject(false);
    await target.store.execute({command: target.command('project_execution.start', 0, 'cross-target') as never,
      requestHash: '9'.repeat(64), authorized: true});
    await foreign.store.execute({command: foreign.command('project_execution.start', 0, 'cross-foreign') as never,
      requestHash: 'a'.repeat(64), authorized: true});
    await createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true}).run({
      workspaceId: foreign.ids.workspace, projectId: foreign.ids.project, expectedVersion: 1,
      requestedByActorId: foreign.ids.owner
    });
    const [foreignLink] = await db.select().from(projectExecutionDispatches)
      .where(eq(projectExecutionDispatches.projectId, foreign.ids.project));
    if (foreignLink === undefined) throw new Error('foreign dispatch fixture missing');
    await db.delete(projectExecutionDispatches).where(eq(projectExecutionDispatches.id, foreignLink.id));
    await expect(db.insert(projectExecutionDispatches).values({workspaceId: target.ids.workspace,
      projectId: target.ids.project, executionVersion: 1, selectionHash: 'b'.repeat(64),
      taskPacketId: foreignLink.taskPacketId, agentRunId: foreignLink.agentRunId,
      runtimeRegistrationId: foreignLink.runtimeRegistrationId,
      runtimeRegistrationVersion: foreignLink.runtimeRegistrationVersion,
      requestedByActorId: target.ids.owner})).rejects.toBeDefined();
    expect(await db.select().from(projectExecutionDispatches)
      .where(eq(projectExecutionDispatches.projectId, target.ids.project))).toHaveLength(0);
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

  it('does not select work behind an unfinished dependency or complete from done tasks without scope acceptance', async () => {
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
      status: 'blocked', blockReason: 'scope_acceptance_required', version: 3, selection: null
    }}}});
  });

  it('atomically and idempotently replaces one failed dispatch within explicit attempt, time, and cost limits', async () => {
    const fixture = await seedAutonomousProject(false);
    await fixture.store.execute({command: fixture.command('project_execution.start', 0, `retry-start-${randomUUID()}`) as never,
      requestHash: '1'.repeat(64), authorized: true});
    await createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true}).run({
      workspaceId: fixture.ids.workspace, projectId: fixture.ids.project,
      expectedVersion: 1, requestedByActorId: fixture.ids.owner
    });
    const [failed] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, fixture.ids.task));
    if (failed === undefined) throw new Error('failed retry fixture missing');
    const completedAt = new Date(failed.createdAt.getTime() + 60_000);
    await db.update(agentRuns).set({status: 'failed', attempt: 1, failureCode: 'process_failed',
      completedAt, version: failed.version + 1, updatedAt: completedAt}).where(eq(agentRuns.id, failed.id));
    await db.insert(commandReceipts).values({workspaceId: fixture.ids.workspace,
      idempotencyKey: `cost-${randomUUID()}`, requestHash: 'c'.repeat(64), commandId: randomUUID(),
      correlationId: randomUUID(), state: 'completed', commandType: 'agent_run.cost.record.v1',
      aggregateType: 'agent_run', aggregateId: failed.id, result: {ok: true, value: {
        kind: 'cost', agentRunId: failed.id, cost: {state: 'calculated', amountMinor: 9_999, currency: 'RUB'}
      }}, completedAt});
    const retryRunId = randomUUID();
    const command = {commandId: randomUUID(), workspaceId: fixture.ids.workspace,
      correlationId: randomUUID(),
      idempotencyKey: `agent-run-retry-continuation:v1:${failed.id}:${retryRunId}:${fixture.ids.owner}`,
      actor: {actorId: fixture.ids.owner}, type: 'agent_run.retry_continuation.v1' as const,
      payload: {projectId: fixture.ids.project, failedRunId: failed.id, retryRunId,
        expectedExecutionVersion: 1}};
    const store = createPostgresAgentRunRetryContinuationStore(db, {
      now: () => new Date(failed.createdAt.getTime() + 119 * 60_000), runnerQueueEnabled: true
    });
    await expect(store.execute({command: command as never,
      requestHash: 'r'.repeat(64), policy: MVP_AGENT_RUN_RETRY_POLICY, authorized: false,
      policyError: {code: 'CAPABILITY_DENIED', message: 'denied before retry'}}))
      .resolves.toMatchObject({status: 'rejected', error: {code: 'CAPABILITY_DENIED'}});
    expect(await db.select().from(commandReceipts).where(and(
      eq(commandReceipts.workspaceId, fixture.ids.workspace),
      eq(commandReceipts.idempotencyKey, command.idempotencyKey)))).toHaveLength(0);
    const alternateRetryRunId = randomUUID();
    const alternate = {...command, commandId: randomUUID(), correlationId: randomUUID(),
      idempotencyKey: `agent-run-retry-continuation:v1:${failed.id}:${alternateRetryRunId}:${fixture.ids.owner}`,
      payload: {...command.payload, retryRunId: alternateRetryRunId}};
    const results = await Promise.all([
      store.execute({command: command as never, requestHash: 'r'.repeat(64),
        policy: MVP_AGENT_RUN_RETRY_POLICY, authorized: true}),
      store.execute({command: alternate as never, requestHash: 's'.repeat(64),
        policy: MVP_AGENT_RUN_RETRY_POLICY, authorized: true})
    ]);
    const queued = results.find((result) => 'receipt' in result && result.receipt.result.ok &&
      result.receipt.result.value.disposition === 'queued');
    const conflicted = results.find((result) => 'receipt' in result && !result.receipt.result.ok);
    expect(queued).toMatchObject({status: 'completed', receipt: {result: {ok: true, value: {
      disposition: 'queued', attemptsUsed: 1, observedCostMinor: 9_999,
      executionVersion: 2, stopReason: null
    }}}});
    expect(conflicted).toMatchObject({status: 'completed', receipt: {result: {ok: false,
      error: {code: 'VERSION_CONFLICT'}}}});
    if (queued === undefined || !('receipt' in queued) || !queued.receipt.result.ok ||
      queued.receipt.result.value.retryRunId === null) throw new Error('queued retry result missing');
    const winningRetryRunId = queued.receipt.result.value.retryRunId;
    const winningCommand = winningRetryRunId === retryRunId ? command : alternate;
    const winningHash = winningRetryRunId === retryRunId ? 'r'.repeat(64) : 's'.repeat(64);
    await expect(store.execute({command: winningCommand as never, requestHash: winningHash,
      policy: MVP_AGENT_RUN_RETRY_POLICY, authorized: true})).resolves.toMatchObject({status: 'replayed'});
    expect(await db.select().from(agentRuns).where(eq(agentRuns.taskPacketId, failed.taskPacketId)))
      .toHaveLength(2);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, winningRetryRunId)))[0])
      .toMatchObject({status: 'queued', retryOfAgentRunId: failed.id, attempt: 0});
    expect((await db.select().from(projectExecutions).where(eq(projectExecutions.projectId, fixture.ids.project)))[0])
      .toMatchObject({status: 'running', version: 2});
    expect((await db.select().from(projectExecutionDispatches).where(and(
      eq(projectExecutionDispatches.projectId, fixture.ids.project),
      eq(projectExecutionDispatches.executionVersion, 2))))[0])
      .toMatchObject({agentRunId: winningRetryRunId, taskPacketId: failed.taskPacketId});
  });

  it('stops on unknown cost with one owner-backed attention and never auto-crosses the accepted human boundary', async () => {
    const fixture = await seedAutonomousProject(false);
    await fixture.store.execute({command: fixture.command('project_execution.start', 0, `stop-start-${randomUUID()}`) as never,
      requestHash: '2'.repeat(64), authorized: true});
    await createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true}).run({
      workspaceId: fixture.ids.workspace, projectId: fixture.ids.project,
      expectedVersion: 1, requestedByActorId: fixture.ids.owner
    });
    const [failed] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, fixture.ids.task));
    if (failed === undefined) throw new Error('stop retry fixture missing');
    const firstCostAt = new Date(failed.createdAt.getTime() + 60_000);
    await db.update(agentRuns).set({status: 'failed', attempt: 1, failureCode: 'process_failed',
      completedAt: firstCostAt, version: failed.version + 1}).where(eq(agentRuns.id, failed.id));
    await db.insert(commandReceipts).values([
      {workspaceId: fixture.ids.workspace, idempotencyKey: `cost-known-${randomUUID()}`,
        requestHash: 'k'.repeat(64), commandId: randomUUID(), correlationId: randomUUID(),
        state: 'completed', commandType: 'agent_run.cost.record.v1', aggregateType: 'agent_run',
        aggregateId: failed.id, result: {ok: true, value: {kind: 'cost', agentRunId: failed.id,
          cost: {state: 'calculated', amountMinor: 500, currency: 'RUB'}}}, completedAt: firstCostAt},
      {workspaceId: fixture.ids.workspace, idempotencyKey: `cost-correction-${randomUUID()}`,
        requestHash: 'l'.repeat(64), commandId: randomUUID(), correlationId: randomUUID(),
        state: 'completed', commandType: 'agent_run.cost.record.v1', aggregateType: 'agent_run',
        aggregateId: failed.id, result: {ok: true, value: {kind: 'cost', agentRunId: failed.id,
          cost: {state: 'pending', reason: 'correction_pending'}}},
        completedAt: new Date(firstCostAt.getTime() + 60_000)}
    ]);
    const retryRunId = randomUUID();
    const command = {commandId: randomUUID(), workspaceId: fixture.ids.workspace,
      correlationId: randomUUID(),
      idempotencyKey: `agent-run-retry-continuation:v1:${failed.id}:${retryRunId}:${fixture.ids.owner}`,
      actor: {actorId: fixture.ids.owner}, type: 'agent_run.retry_continuation.v1' as const,
      payload: {projectId: fixture.ids.project, failedRunId: failed.id, retryRunId,
        expectedExecutionVersion: 1}};
    const store = createPostgresAgentRunRetryContinuationStore(db, {runnerQueueEnabled: true});
    await expect(store.execute({command: command as never, requestHash: 'u'.repeat(64),
      policy: MVP_AGENT_RUN_RETRY_POLICY, authorized: true}))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {
        disposition: 'ask', stopReason: 'cost_unknown', retryRunId: null,
        attentionId: expect.any(String), executionVersion: 2
      }}}});
    await expect(store.execute({command: command as never, requestHash: 'u'.repeat(64),
      policy: MVP_AGENT_RUN_RETRY_POLICY, authorized: true}))
      .resolves.toMatchObject({status: 'replayed'});
    expect(await db.select().from(agentRuns).where(eq(agentRuns.taskPacketId, failed.taskPacketId))).toHaveLength(1);
    expect(await db.select().from(riskSignals).where(and(eq(riskSignals.projectId, fixture.ids.project),
      eq(riskSignals.deduplicationKey, `agent_run_retry_stop:v1:${failed.id}`))))
      .toEqual([expect.objectContaining({ownerActorId: fixture.ids.owner,
        nextAction: expect.stringContaining('Review the failed receipt')})]);
    expect((await db.select().from(projectExecutions).where(eq(projectExecutions.projectId, fixture.ids.project)))[0])
      .toMatchObject({status: 'blocked', version: 2, blockReason: 'retry_cost_unknown'});

    const accepted = await seedCompletedAcceptance();
    await accepted.store.execute({command: accepted.command(), requestHash: 'a'.repeat(64), authorized: true});
    const resume = {commandId: randomUUID(), workspaceId: accepted.ids.workspace,
      correlationId: randomUUID(), idempotencyKey: `accepted-resume-${randomUUID()}`,
      issuedAt: '2026-08-09T12:00:00.000Z', actor: {actorId: accepted.ids.owner},
      type: 'project_execution.resume' as const,
      payload: {projectId: accepted.ids.project, expectedVersion: 2}};
    await expect(createPostgresProjectExecutionStore(db).execute({command: resume as never,
      requestHash: 'e'.repeat(64), authorized: true}))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {
        status: 'blocked', version: 3, blockReason: 'human_confirmation_required',
        selection: {boundary: 'human_confirmation_required', stageKey: 'qa'}, dispatch: null
      }}}});
    const rejectedRetryRunId = randomUUID();
    const boundaryCommand = {commandId: randomUUID(), workspaceId: accepted.ids.workspace,
      correlationId: randomUUID(),
      idempotencyKey: `agent-run-retry-continuation:v1:${accepted.run.id}:${rejectedRetryRunId}:${accepted.ids.owner}`,
      actor: {actorId: accepted.ids.owner}, type: 'agent_run.retry_continuation.v1' as const,
      payload: {projectId: accepted.ids.project, failedRunId: accepted.run.id,
        retryRunId: rejectedRetryRunId, expectedExecutionVersion: 3}};
    await expect(createPostgresAgentRunRetryContinuationStore(db, {runnerQueueEnabled: true}).execute({
      command: boundaryCommand as never, requestHash: 'b'.repeat(64),
      policy: MVP_AGENT_RUN_RETRY_POLICY, authorized: true
    })).resolves.toMatchObject({receipt: {result: {ok: false, error: {code: 'INVALID_TRANSITION'}}}});
    expect(await db.select().from(agentRuns).where(eq(agentRuns.id, rejectedRetryRunId))).toHaveLength(0);
    expect((await db.select().from(projectExecutions).where(eq(projectExecutions.projectId, accepted.ids.project)))[0])
      .toMatchObject({status: 'blocked', version: 3, blockReason: 'human_confirmation_required'});
  });

  it('refuses retry admission when server activation or the exact runtime registration is unavailable', async () => {
    const fixture = await seedAutonomousProject(false);
    await fixture.store.execute({command: fixture.command('project_execution.start', 0,
      `activation-start-${randomUUID()}`) as never, requestHash: 'm'.repeat(64), authorized: true});
    await createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true}).run({
      workspaceId: fixture.ids.workspace, projectId: fixture.ids.project,
      expectedVersion: 1, requestedByActorId: fixture.ids.owner
    });
    const [failed] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, fixture.ids.task));
    if (failed === undefined) throw new Error('activation retry fixture missing');
    await db.update(agentRuns).set({status: 'failed', attempt: 1, failureCode: 'process_failed',
      completedAt: new Date(), version: failed.version + 1}).where(eq(agentRuns.id, failed.id));
    const commandFor = (retryRunId: string) => ({commandId: randomUUID(), workspaceId: fixture.ids.workspace,
      correlationId: randomUUID(),
      idempotencyKey: `agent-run-retry-continuation:v1:${failed.id}:${retryRunId}:${fixture.ids.owner}`,
      actor: {actorId: fixture.ids.owner}, type: 'agent_run.retry_continuation.v1' as const,
      payload: {projectId: fixture.ids.project, failedRunId: failed.id, retryRunId,
        expectedExecutionVersion: 1}});
    const disabledQueueRunId = randomUUID();
    await expect(createPostgresAgentRunRetryContinuationStore(db, {runnerQueueEnabled: false}).execute({
      command: commandFor(disabledQueueRunId) as never, requestHash: 'n'.repeat(64),
      policy: MVP_AGENT_RUN_RETRY_POLICY, authorized: true
    })).resolves.toMatchObject({receipt: {result: {ok: false, error: {code: 'POLICY_DENIED'}}}});
    expect(await db.select().from(agentRuns).where(eq(agentRuns.id, disabledQueueRunId))).toHaveLength(0);
    await db.update(runtimeRegistrations).set({enabled: false, version: 2}).where(and(
      eq(runtimeRegistrations.projectId, fixture.ids.project),
      eq(runtimeRegistrations.agentProfileId, fixture.ids.profile)));
    const disabledRegistrationRunId = randomUUID();
    await expect(createPostgresAgentRunRetryContinuationStore(db, {runnerQueueEnabled: true}).execute({
      command: commandFor(disabledRegistrationRunId) as never, requestHash: 'o'.repeat(64),
      policy: MVP_AGENT_RUN_RETRY_POLICY, authorized: true
    })).resolves.toMatchObject({receipt: {result: {ok: false, error: {code: 'INVALID_TRANSITION'}}}});
    expect(await db.select().from(agentRuns).where(inArray(agentRuns.id,
      [disabledQueueRunId, disabledRegistrationRunId]))).toHaveLength(0);
    expect((await db.select().from(projectExecutions).where(eq(projectExecutions.projectId,
      fixture.ids.project)))[0]).toMatchObject({status: 'running', version: 1});
  });
});
