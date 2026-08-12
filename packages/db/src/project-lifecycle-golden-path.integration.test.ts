import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  createActorContextIssuer,
  canonicalJson,
  hashAgentProfileConfiguration,
  hashDeliveryProtocolDefinition,
  hashProjectPlanSourceManifest,
  sourceArtifactDigest,
  type HermesCodexWorkOrder,
  type ProjectPlanDefinition,
  type TrustedActorContext
} from '@fai-control-plane/domain';
import {
  createAgentRunAcceptanceService,
  createDeploymentEvidenceService,
  createDeploymentExecutorService,
  createDeliveryJourneyService,
  createGovernedQaService,
  createProjectAcceptanceService,
  createProjectExecutionService,
  createProjectOutcomeAcceptanceService,
  createProjectPlanService,
  createRunnerClaimService,
  mapRunnerCompletionToDeliveryEvidence,
  type RunnerClaimEnvelope,
  type RunnerCompletionPayload,
  type SemanticProjectPlanRequest
} from '../../application/src/index.ts';
import {asc, eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  reconcileLaunchHumanRoster,
  reconcileLaunchProjectMemberships
} from './launch-roster';
import {
  actors,
  agentProfiles,
  agentRuns,
  auditEvents,
  commandReceipts,
  createDatabase,
  createPostgresAgentRunAcceptanceStore,
  createPostgresDeliveryJourneyStore,
  createPostgresDeploymentEvidenceStore,
  createPostgresDeploymentExecutorStore,
  createPostgresGovernedQaStore,
  createPostgresProjectAcceptanceStore,
  createPostgresProjectExecutionDispatcher,
  createPostgresProjectExecutionStore,
  createPostgresProjectOutcomeAcceptanceStore,
  createPostgresProjectPlanStore,
  createPostgresRunnerClaimStore,
  deliveryJourneyEvidence,
  deliveryJourneys,
  deploymentExecutorJobs,
  deploymentExecutorRegistrations,
  deployments,
  loadProjectAcceptanceProjection,
  projectExecutions,
  projectMemberships,
  projectPlanMaterializations,
  projectPlanVersions,
  projectScopeOutcomes,
  projectSetups,
  projectSourceArtifacts,
  projectTrackerRepositoryScopes,
  projectUatProtocols,
  projectUatResults,
  projectUatSignoffs,
  projects,
  qaReviewReceipts,
  qaTaskPackets,
  runtimeAvailabilityObservations,
  runtimeRegistrations,
  runbooks,
  secretRefs,
  taskPackets,
  trackerBindings,
  workItems,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for the project lifecycle golden-path integration test in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_project_golden_path_${randomUUID().replaceAll('-', '')}`;
const nowIso = '2026-08-12T08:00:00.000Z';

const envelope = <T extends string, P>(
  workspaceId: string,
  actor: TrustedActorContext,
  type: T,
  payload: P,
  idempotencyKey: string
) => ({
  commandId: randomUUID(),
  workspaceId,
  correlationId: randomUUID(),
  idempotencyKey,
  issuedAt: nowIso,
  actor,
  type,
  payload
});

const hermesProvenance = (claim: RunnerClaimEnvelope) => {
  const workOrder = claim.workOrder as HermesCodexWorkOrder;
  const directive = {
    schemaVersion: 1 as const,
    orchestrator: 'hermes' as const,
    executor: 'codex-cli' as const,
    taskPacketId: workOrder.taskPacket.id,
    taskPacketHash: workOrder.taskPacket.sha256,
    workOrderHash: claim.workOrderHash!,
    strategy: 'risk_first' as const,
    orderedStepIds: [...workOrder.orchestration.stepIds],
    selectedCheckIds: workOrder.orchestration.checkCandidates.map(({id}) => id),
    selectedRiskControlIds: [...workOrder.orchestration.riskControlIds]
  };
  return {
    orchestrator: 'hermes' as const,
    executor: 'codex-cli' as const,
    workOrderHash: claim.workOrderHash!,
    directiveHash: createHash('sha256').update(canonicalJson(directive)).digest('hex'),
    strategy: 'risk_first' as const,
    hermesVersion: '0.18.2' as const,
    hermesConfigHash: workOrder.runtime.hermesConfigSha256,
    directive
  };
};

describePostgres('project lifecycle golden path', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];

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
    await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))});
  }, 30_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try {
        await dropDatabaseWhenDisconnected(adminPool, databaseName);
      } finally {
        await adminPool.end();
      }
    }
  }, 30_000);

  it('completes one immutable MSA lifecycle only through its canonical PostgreSQL gates', async () => {
    const ids = {
      workspace: randomUUID(), msa: randomUUID(), ascon: randomUUID(), hermes: randomUUID(), profile: randomUUID(),
      registration: randomUUID(), client: randomUUID(), deployer: randomUUID(), deploymentRegistration: randomUUID(),
      repositoryCredential: randomUUID(), repositoryScope: randomUUID(), protocol: randomUUID(), plan: randomUUID(),
      deployment: randomUUID(), uatProtocol: randomUUID(), uatResult: randomUUID()
    };
    await db.insert(workspaces).values({id: ids.workspace, name: 'fAI Studio', slug: `fai-${randomUUID()}`});
    await db.insert(projects).values([
      {id: ids.msa, workspaceId: ids.workspace, name: 'MSA', slug: 'msa'},
      {id: ids.ascon, workspaceId: ids.workspace, name: 'ASCON', slug: 'ascon'}
    ]);
    const roster = await reconcileLaunchHumanRoster(db, ids.workspace, 'github:user:222', '111,222');
    await db.insert(actors).values({
      id: ids.hermes,
      workspaceId: ids.workspace,
      type: 'agent',
      role: 'agent_operator',
      displayName: 'Hermes',
      authMode: 'agent',
      externalSubject: 'agent:hermes:v1'
    });
    await reconcileLaunchProjectMemberships(db, ids.msa, 'msa', roster.members, ids.hermes);
    await reconcileLaunchProjectMemberships(db, ids.ascon, 'ascon', roster.members, ids.hermes);

    const [owner] = await db.select({id: actors.id}).from(actors).where(eq(actors.displayName, 'Vladimir'));
    const [developer] = await db.select({id: actors.id}).from(actors).where(eq(actors.displayName, 'Vitaliy'));
    if (owner === undefined || developer === undefined) throw new Error('launch roster fixture missing');
    const launchMemberships = await db.select({
      project: projects.slug,
      actor: actors.displayName,
      roles: projectMemberships.roles,
      active: projectMemberships.active
    }).from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .innerJoin(actors, eq(actors.id, projectMemberships.actorId))
      .orderBy(asc(projects.slug), asc(actors.displayName));
    expect(launchMemberships).toEqual([
      {project: 'ascon', actor: 'Hermes', roles: ['agent'], active: false},
      {project: 'ascon', actor: 'Vitaliy', roles: ['contributor'], active: false},
      {project: 'ascon', actor: 'Vladimir', roles: ['project_owner', 'contributor'], active: true},
      {project: 'msa', actor: 'Hermes', roles: ['agent'], active: true},
      {project: 'msa', actor: 'Vitaliy', roles: ['contributor'], active: true},
      {project: 'msa', actor: 'Vladimir', roles: ['project_owner'], active: true}
    ]);
    expect(launchMemberships.some(({roles, active}) => active && roles.includes('client_viewer'))).toBe(false);

    await db.insert(actors).values([
      {id: ids.client, workspaceId: ids.workspace, type: 'human', role: 'developer', displayName: 'MSA client',
        authMode: 'user', capabilities: {'write:control_plane:development': true}},
      {id: ids.deployer, workspaceId: ids.workspace, type: 'system', role: 'agent_operator',
        displayName: 'Trusted deployment executor', authMode: 'system', externalSubject: 'system:deployment-executor:v1',
        capabilities: {'deploy:runner:production': true}}
    ]);
    await db.insert(projectMemberships).values({
      id: randomUUID(), projectId: ids.msa, actorId: ids.client, roles: ['client_viewer']
    });
    const profile = {
      runtimeId: 'hermes', runtimeProfile: 'write_scoped',
      allowedTools: ['task_packet_read', 'artifact_write'],
      forbiddenSurfaces: ['external_message', 'github_write', 'production', 'deploy', 'merge'],
      instructions: 'Execute only the immutable project work order and return structured evidence.',
      settings: {resultFormat: 'structured_v1' as const, includeEvidence: true},
      enabled: true, version: 1
    };
    await db.insert(agentProfiles).values({id: ids.profile, workspaceId: ids.workspace, actorId: ids.hermes,
      ...profile, configHash: hashAgentProfileConfiguration(profile)});
    await db.insert(runtimeRegistrations).values({
      id: ids.registration, projectId: ids.msa, actorId: ids.hermes, agentProfileId: ids.profile,
      provider: 'provider_neutral', runtimeKey: 'hermes-codex-v1', enabled: true,
      serviceMaxAgeSeconds: 300, schedulerMaxAgeSeconds: 900, deliveryMaxAgeSeconds: 93_600
    });
    await db.insert(projectSetups).values({
      id: randomUUID(), projectId: ids.msa, state: 'pending', configuration: {
        repositoryBinding: 'link_existing', trackerBinding: 'link_existing', internalChat: 'none', clientChat: 'none',
        executionMode: 'managed_agent', agentProfileId: ids.profile
      }
    });
    await db.insert(secretRefs).values({id: ids.repositoryCredential, workspaceId: ids.workspace,
      provider: 'fixture', reference: 'fixture://repository-read', scope: ['repository:read']});
    await db.insert(projectTrackerRepositoryScopes).values({
      id: ids.repositoryScope, projectId: ids.msa, provider: 'fixture', repositoryOwner: 'VF78',
      repositoryName: 'MSA', repositoryExternalId: 'fixture:msa', credentialRefId: ids.repositoryCredential
    });
    await db.insert(trackerBindings).values({
      projectId: ids.msa, provider: 'fixture', surface: 'repository', externalId: 'fixture:msa',
      entityType: 'project', entityId: ids.msa, metadata: {defaultBranch: 'main', headSha: 'a'.repeat(40)}
    });
    await db.insert(deploymentExecutorRegistrations).values({
      id: ids.deploymentRegistration, workspaceId: ids.workspace, projectId: ids.msa,
      systemActorId: ids.deployer, environment: 'production', executorKey: 'msa-production-v1', enabled: true
    });

    const protocolDefinition = {
      schemaVersion: 1 as const,
      stages: [
        {key: 'development', name: 'Development', enabled: true, taskStatus: 'in_dev' as const,
          responsibility: {kind: 'actor' as const, actorId: ids.hermes, actorType: 'agent' as const,
            agentProfileId: ids.profile}, executionMode: 'autonomous' as const,
          entryCriteria: ['Approved plan is materialized'], requiredEvidence: ['Implementation change', 'Relevant checks'],
          allowedNextStageKey: 'qa'},
        {key: 'qa', name: 'QA', enabled: true, taskStatus: 'qa' as const,
          responsibility: {kind: 'actor' as const, actorId: ids.hermes, actorType: 'agent' as const,
            agentProfileId: ids.profile}, executionMode: 'autonomous' as const,
          entryCriteria: ['Implementation receipt is accepted'], requiredEvidence: ['QA result'],
          allowedNextStageKey: 'acceptance'},
        {key: 'acceptance', name: 'Acceptance', enabled: true, taskStatus: 'acceptance' as const,
          responsibility: {kind: 'project_role' as const, role: 'project_owner' as const},
          executionMode: 'human_approval' as const, entryCriteria: ['QA receipt is accepted'],
          requiredEvidence: ['Product Owner acceptance'], allowedNextStageKey: 'accepted'},
        {key: 'accepted', name: 'Accepted', enabled: true, taskStatus: 'done' as const,
          responsibility: {kind: 'project_role' as const, role: 'project_owner' as const},
          executionMode: 'human_approval' as const, entryCriteria: ['Product Owner accepted the result'],
          requiredEvidence: ['Accepted release baseline'], allowedNextStageKey: null}
      ]
    };
    await db.insert(runbooks).values({
      id: ids.protocol, projectId: ids.msa, name: 'MSA delivery', version: 1,
      definition: protocolDefinition, active: true, protocolState: 'published', revision: 1,
      contentHash: hashDeliveryProtocolDefinition(protocolDefinition)
    });

    const issuer = createActorContextIssuer({
      users: [
        {actorId: owner.id, capabilities: ['read:control_plane:development', 'write:control_plane:development']},
        {actorId: ids.client, capabilities: ['write:control_plane:development']}
      ],
      agents: [],
      systems: [{actorId: ids.deployer, capabilities: ['deploy:runner:production']}]
    });
    if (!issuer.ok) throw new Error('actor issuer fixture missing');
    const ownerContext = issuer.value.issueUser(owner.id);
    const clientContext = issuer.value.issueUser(ids.client);
    const deployerContext = issuer.value.issueSystem(ids.deployer);
    if (!ownerContext.ok || !clientContext.ok || !deployerContext.ok) throw new Error('trusted actor fixture missing');

    const sourceInputs = [
      {kind: 'project_passport' as const, name: 'Project passport', content: 'Outcome: deliver the bounded MSA release.\nOwner: Vladimir.'},
      {kind: 'solution_architecture' as const, name: 'Solution architecture', content: 'Architecture: modular service with PostgreSQL authority.'},
      {kind: 'client_requirements' as const, name: 'Client requirements', content: 'Client requires a verified release and documented UAT.'},
      {kind: 'acceptance_method' as const, name: 'Acceptance notes', content: 'Acceptance uses health smoke and immutable signoffs.'}
    ].map((source) => ({...source, id: randomUUID(), sha256: sourceArtifactDigest(source.content)}));
    let plannerRequest: SemanticProjectPlanRequest | null = null;
    const planDefinition = (): ProjectPlanDefinition => ({
      title: 'Hermes MSA delivery plan',
      outcomes: [
        {key: 'release', title: 'Verified release', weight: 20,
          evidence: {kind: 'citation', artifactId: sourceInputs[0]!.id,
            locator: {kind: 'line_range', startLine: 1, endLine: 1}}},
        {key: 'architecture', title: 'Architecture preserved', weight: 20,
          evidence: {kind: 'citation', artifactId: sourceInputs[1]!.id,
            locator: {kind: 'whole_artifact'}}},
        {key: 'requirements', title: 'Client requirements verified', weight: 20,
          evidence: {kind: 'citation', artifactId: sourceInputs[2]!.id,
            locator: {kind: 'whole_artifact'}}},
        {key: 'uat', title: 'Client UAT completed', weight: 20,
          evidence: {kind: 'citation', artifactId: sourceInputs[2]!.id,
            locator: {kind: 'whole_artifact'}}},
        {key: 'acceptance', title: 'Acceptance evidence retained', weight: 20,
          evidence: {kind: 'citation', artifactId: sourceInputs[3]!.id,
            locator: {kind: 'whole_artifact'}}}
      ],
      milestones: [{key: 'uat', title: 'Client UAT', checkpoint: 'Client signs the immutable UAT result',
        targetAt: '2026-09-15', evidence: {kind: 'citation', artifactId: sourceInputs[2]!.id,
          locator: {kind: 'whole_artifact'}}}],
      risks: [{key: 'acceptance_drift', statement: 'Acceptance evidence may drift',
        mitigation: 'Bind the exact immutable release and UAT receipts',
        evidence: {kind: 'citation', artifactId: sourceInputs[3]!.id, locator: {kind: 'whole_artifact'}}}],
      tasks: [{key: 'deliver', title: 'Implement, verify, and release MSA',
        responsibility: {kind: 'agent_profile', agentProfileId: ids.profile},
        outcomeKeys: ['release', 'architecture', 'requirements', 'uat', 'acceptance'],
        milestoneKey: 'uat', dependsOn: [],
        acceptanceEvidence: [{description: 'Client requirements are verified',
          evidence: {kind: 'citation', artifactId: sourceInputs[2]!.id, locator: {kind: 'whole_artifact'}}}]}]
    });
    const planService = createProjectPlanService(createPostgresProjectPlanStore(db), {
      generate: async (request) => {
        plannerRequest = request;
        return {ok: true, value: planDefinition()};
      }
    });
    for (const source of sourceInputs) {
      const command = envelope(ids.workspace, ownerContext.value, 'project_plan.source.record', {
        artifactId: source.id, projectId: ids.msa, name: source.name, sourceKind: source.kind,
        mediaType: 'text/markdown' as const, content: source.content, sizeBytes: Buffer.byteLength(source.content),
        sha256: source.sha256, sourceFile: null,
        provenance: {kind: 'manager_note' as const, label: 'Vladimir', capturedAt: nowIso}
      }, `golden-source:${source.kind}`);
      await expect(planService.execute(command)).resolves.toMatchObject({receipt: {result: {ok: true}}});
    }
    const sourceManifest = sourceInputs.map(({id: artifactId, sha256}) => ({artifactId, version: 1, sha256}));
    const canonicalSourceManifest = [...sourceManifest]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    await expect(planService.execute(envelope(ids.workspace, ownerContext.value, 'project_plan.draft.generate', {
      planId: ids.plan, projectId: ids.msa, expectedRevision: null, sourceManifest
    }, 'golden-plan-generate'))).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      plan: {state: 'draft', revision: 1},
      semanticPlanningContextHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    }}}});
    expect(plannerRequest).toMatchObject({
      sourceManifestHash: hashProjectPlanSourceManifest(canonicalSourceManifest),
      artifacts: expect.arrayContaining(sourceInputs.map(({id, kind}) => expect.objectContaining({id, sourceKind: kind}))),
      planningContext: {
        schemaVersion: 1,
        projectId: ids.msa,
        deliveryProtocol: {id: ids.protocol, contentHash: hashDeliveryProtocolDefinition(protocolDefinition)},
        responsibilityCandidates: expect.arrayContaining([
          expect.objectContaining({kind: 'human', actorId: developer.id, roles: ['contributor']}),
          expect.objectContaining({kind: 'agent_profile', agentProfileId: ids.profile})
        ])
      },
      planningContextHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    const simulation = await planService.simulate({workspaceId: ids.workspace, projectId: ids.msa,
      actor: ownerContext.value, definition: planDefinition()});
    expect(simulation).toMatchObject({readyForApproval: true,
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/), simulationHash: expect.stringMatching(/^[0-9a-f]{64}$/)});
    if (simulation === null) throw new Error('plan simulation fixture missing');
    await expect(planService.execute(envelope(ids.workspace, ownerContext.value, 'project_plan.approve', {
      planId: ids.plan, expectedRevision: 1, expectedPlanHash: simulation.planHash,
      expectedSimulationHash: simulation.simulationHash
    }, 'golden-plan-approve'))).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      plan: {state: 'approved', approvedVersion: 1}
    }}}});
    const [approvedVersion] = await db.select().from(projectPlanVersions).where(eq(projectPlanVersions.planId, ids.plan));
    if (approvedVersion === undefined) throw new Error('approved plan version fixture missing');
    expect([...approvedVersion.sourceManifest].sort((left, right) => left.artifactId.localeCompare(right.artifactId)))
      .toEqual([...sourceManifest].sort((left, right) => left.artifactId.localeCompare(right.artifactId)));
    expect(approvedVersion.definition).toEqual(planDefinition());
    await expect(planService.execute(envelope(ids.workspace, ownerContext.value, 'project_plan.materialize', {
      projectId: ids.msa, planId: ids.plan, expectedPlanVersion: 1,
      expectedPlanHash: approvedVersion.contentHash,
      expectedSourceManifestHash: hashProjectPlanSourceManifest(approvedVersion.sourceManifest)
    }, 'golden-plan-materialize'))).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      materialization: {workItemCount: 1, journeyCount: 1, outcomeCount: 5}
    }}}});
    const [materialization] = await db.select().from(projectPlanMaterializations)
      .where(eq(projectPlanMaterializations.planVersionId, approvedVersion.id));
    const [workItem] = await db.select().from(workItems).where(eq(workItems.projectId, ids.msa));
    const [journey] = await db.select().from(deliveryJourneys).where(eq(deliveryJourneys.workItemId, workItem!.id));
    if (materialization === undefined || workItem === undefined || journey === undefined) {
      throw new Error('materialized lifecycle fixture missing');
    }
    expect(workItem).toMatchObject({status: 'in_dev', responsibility: {kind: 'agent_profile', agentProfileId: ids.profile}});
    expect(journey).toMatchObject({stageKey: 'development', version: 1});

    const runtimeEnvironment = {
      HERMES_ORCHESTRATOR_VERSION: '0.18.2', HERMES_ORCHESTRATOR_CONFIG_SHA256: 'b'.repeat(64),
      RUNNER_ENABLED: 'true', LOCAL_RUNNER_TRANSPORT_ENABLED: 'true',
      LOCAL_RUNNER_WORKSPACE_ID: ids.workspace, LOCAL_RUNNER_ID: 'golden-hermes-runner',
      LOCAL_RUNNER_ALLOWED_PROJECT_IDS: ids.msa, LOCAL_RUNNER_ALLOWED_REPOSITORIES: 'VF78/MSA',
      LOCAL_RUNNER_ALLOWED_RUNTIME_IDS: 'hermes',
      LOCAL_RUNNER_ALLOWED_RUNTIME_REGISTRATION_KEYS: 'hermes-codex-v1',
      LOCAL_RUNNER_TOKEN_FILE: '/run/secrets/local-runner-token',
      RUNTIME_OBSERVATION_TRANSPORT_ENABLED: 'true',
      RUNTIME_OBSERVATION_ALLOWED_REGISTRATION_IDS: ids.registration,
      RUNTIME_OBSERVATION_TOKEN_FILE: '/run/secrets/runtime-observation-token'
    } as const;
    const runnerAuthorization = {workspaceId: ids.workspace, runnerId: 'golden-hermes-runner',
      projectIds: [ids.msa], repositories: [{owner: 'VF78', name: 'MSA'}], runtimeIds: ['hermes']};
    const transport = {status: 'available' as const, identity: {
      kind: 'hermes_authenticated_claim_v1' as const, runnerId: runnerAuthorization.runnerId,
      workspaceId: ids.workspace, projectIds: [ids.msa], repositories: runnerAuthorization.repositories,
      runtimeIds: ['hermes'], runtimeRegistrationKeys: ['hermes-codex-v1']
    }};
    let clock = new Date('2026-08-12T08:10:00.000Z');
    const observeHermes = async () => db.insert(runtimeAvailabilityObservations).values(
      (['service', 'scheduler', 'delivery'] as const).map((component) => ({
        runtimeRegistrationId: ids.registration, component, state: 'available' as const,
        observedAt: clock, ttlSeconds: component === 'service' ? 300 : component === 'scheduler' ? 900 : 93_600,
        evidenceReference: `fixture://hermes/${component}/${clock.toISOString()}`
      }))
    );
    await observeHermes();
    const executionService = createProjectExecutionService(createPostgresProjectExecutionStore(db));
    await expect(executionService.execute(envelope(ids.workspace, ownerContext.value, 'project_execution.start', {
      projectId: ids.msa, expectedVersion: 0
    }, 'golden-execution-start'))).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      status: 'running', version: 1, selection: {responsibleActor: {id: ids.hermes, agentProfileId: ids.profile}}
    }}}});
    const dispatcher = createPostgresProjectExecutionDispatcher(db, {runnerQueueEnabled: true,
      runtimeEnvironment, autonomousQaClaimTransport: transport, now: () => clock});
    await expect(dispatcher.run({workspaceId: ids.workspace, projectId: ids.msa,
      expectedVersion: 1, requestedByActorId: owner.id})).resolves.toEqual({
      dispatched: 1, blocked: 0, replayed: 0, denied: 0
    });

    const runner = createRunnerClaimService({
      store: createPostgresRunnerClaimStore(db, {activationEnvironment: runtimeEnvironment}),
      clock: {now: () => clock}, tokenGenerator: () => 'g'.repeat(43)
    });
    const implementationClaim = await runner.claim(runnerAuthorization);
    expect(implementationClaim).toMatchObject({runtimeId: 'hermes', runtimeProvenance: {
      orchestrator: 'hermes', executor: 'codex-cli'
    }, workOrder: {dossierManifest: expect.arrayContaining([
      expect.objectContaining({sourceKind: 'project_passport'}),
      expect.objectContaining({sourceKind: 'solution_architecture'}),
      expect.objectContaining({sourceKind: 'client_requirements'})
    ])}});
    if (implementationClaim === null) throw new Error('implementation claim missing');
    expect(implementationClaim.workOrder!.dossierManifest).toHaveLength(4);
    expect(implementationClaim.workOrder!.dossierManifest).toEqual(expect.arrayContaining(sourceInputs.map(
      ({id: artifactId, sha256, kind: sourceKind}) => expect.objectContaining({artifactId, sha256, sourceKind})
    )));
    const completionFor = (claim: RunnerClaimEnvelope, qa: boolean): RunnerCompletionPayload => {
      const receiptSha256 = createHash('sha256').update(`${claim.runId}:${qa ? 'qa' : 'implementation'}`).digest('hex');
      const reference = `runs/${claim.runId}`;
      return {
        runId: claim.runId, attempt: claim.attempt, terminal: 'done', receiptSha256, receiptSizeBytes: 512,
        finalStatus: 'succeeded', runtimeId: 'hermes', runtimeProfile: 'write_scoped', durationMs: 60_000,
        cost: {state: 'unknown', reason: 'runtime_usage_not_available'},
        usage: {state: 'unknown', reason: 'runtime_usage_not_available'},
        runtimeProvenance: hermesProvenance(claim),
        summaryArtifact: {name: 'structured-summary.json', reference: `${reference}/structured-summary.json`,
          sha256: createHash('sha256').update(`${claim.runId}:summary`).digest('hex'), sizeBytes: 128},
        artifactStore: {provider: 'fixture', reference, correlationId: `artifact-run-${claim.runId}`},
        receiptArtifact: {name: 'agent-run-receipt.json', reference: `${reference}/agent-run-receipt.json`,
          sha256: receiptSha256, sizeBytes: 512},
        pathManifest: {name: 'observed-path-manifest.json', reference: `${reference}/observed-path-manifest.json`,
          sha256: createHash('sha256').update(`${claim.runId}:manifest`).digest('hex'), sizeBytes: 128},
        changedFiles: qa ? [] : ['src/msa-delivery.ts'],
        checks: [{name: qa ? 'golden QA' : 'focused implementation checks', status: 'passed'}],
        ...(qa ? {qaResult: {outcome: 'passed' as const,
          checks: [{name: 'golden QA', status: 'passed' as const,
            reference: {kind: 'receipt' as const, sha256: receiptSha256}}],
          artifacts: [{kind: 'report', reference: {kind: 'receipt' as const, sha256: receiptSha256}}],
          failures: [], risks: [], evidenceReferences: [{requirement: 'QA result',
            reference: {kind: 'receipt' as const, sha256: receiptSha256}}]}} : {}),
        riskCount: 0, nextAction: 'review_receipt'
      };
    };
    const implementationCompletion = completionFor(implementationClaim, false);
    clock = new Date('2026-08-12T08:11:00.000Z');
    await expect(runner.complete({authorization: runnerAuthorization,
      payload: implementationCompletion, leaseToken: implementationClaim.leaseToken}))
      .resolves.toMatchObject({terminal: 'done'});
    const acceptanceService = createAgentRunAcceptanceService(createPostgresAgentRunAcceptanceStore(db, {
      parseCompletion: (value) => value as RunnerCompletionPayload,
      evidenceFor: mapRunnerCompletionToDeliveryEvidence,
      now: () => clock
    }));
    await expect(acceptanceService.execute(envelope(ids.workspace, ownerContext.value, 'agent_run.accept_result.v1', {
      runId: implementationClaim.runId, receiptSha256: implementationCompletion.receiptSha256,
      expectedWorkItemVersion: 1
    }, `agent-run-accept:v1:${implementationClaim.runId}:${implementationCompletion.receiptSha256}:${owner.id}`)))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {
        workItemStatus: 'qa', workItemVersion: 2, journeyStageKey: 'qa', journeyVersion: 2,
        executionStatus: 'paused', executionVersion: 2
      }}}});

    await expect(executionService.execute(envelope(ids.workspace, ownerContext.value, 'project_execution.resume', {
      projectId: ids.msa, expectedVersion: 2
    }, 'golden-execution-resume-qa'))).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      status: 'running', version: 3, selection: {stageKey: 'qa', responsibleActor: {id: ids.hermes}}
    }}}});
    clock = new Date('2026-08-12T08:12:00.000Z');
    await observeHermes();
    await expect(dispatcher.run({workspaceId: ids.workspace, projectId: ids.msa,
      expectedVersion: 3, requestedByActorId: owner.id})).resolves.toEqual({
      dispatched: 1, blocked: 0, replayed: 0, denied: 0
    });
    const qaClaim = await runner.claim(runnerAuthorization);
    expect(qaClaim).toMatchObject({runtimeId: 'hermes', workOrder: {protocol: {stageKey: 'qa'}}});
    if (qaClaim === null) throw new Error('QA claim missing');
    const qaCompletion = completionFor(qaClaim, true);
    clock = new Date('2026-08-12T08:13:00.000Z');
    await expect(runner.complete({authorization: runnerAuthorization, payload: qaCompletion,
      leaseToken: qaClaim.leaseToken})).resolves.toMatchObject({terminal: 'done'});
    const [qaPacket] = await db.select().from(qaTaskPackets).where(eq(qaTaskPackets.taskPacketId, qaClaim.packetId));
    expect(qaPacket).toMatchObject({workItemVersion: 2, journeyVersion: 2, stageKey: 'qa'});
    const qaService = createGovernedQaService(createPostgresGovernedQaStore(db));
    const qaReview = await qaService.execute(envelope(ids.workspace, ownerContext.value, 'qa_review.record.v1', {
      workItemId: workItem.id, expectedWorkItemVersion: 2, expectedJourneyVersion: 2,
      taskPacketId: qaClaim.packetId
    }, `golden-qa-accept:${qaClaim.runId}`));
    if ('receipt' in qaReview && !qaReview.receipt.result.ok) {
      throw new Error(`${qaReview.receipt.result.error.code}: ${qaReview.receipt.result.error.message}`);
    }
    expect(qaReview).toMatchObject({receipt: {result: {ok: true, value: {
      workItemStatus: 'acceptance', workItemVersion: 3, journeyStageKey: 'acceptance', journeyVersion: 3,
      executionStatus: 'paused'
    }}}});
    expect((await db.select().from(qaReviewReceipts).where(eq(qaReviewReceipts.taskPacketId, qaClaim.packetId)))[0])
      .toMatchObject({outcome: 'passed', agentRunId: qaClaim.runId});

    const journeyService = createDeliveryJourneyService(createPostgresDeliveryJourneyStore(db));
    await expect(journeyService.execute(envelope(ids.workspace, ownerContext.value, 'delivery_journey.advance', {
      workItemId: workItem.id, expectedWorkItemVersion: 3, expectedJourneyVersion: 3,
      evidenceReferences: [{requirement: 'Product Owner acceptance', reference: 'evidence:po:msa-release-accepted'}]
    }, 'golden-terminal-po-acceptance'))).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      task: {status: 'done', version: 4}, journeyVersion: 4,
      nextAllowedAction: {kind: 'record_terminal_evidence'}
    }}}});
    await expect(journeyService.execute(envelope(ids.workspace, ownerContext.value, 'delivery_journey.advance', {
      workItemId: workItem.id, expectedWorkItemVersion: 4, expectedJourneyVersion: 4,
      evidenceReferences: [{requirement: 'Accepted release baseline', reference: 'evidence:po:msa-baseline-accepted'}]
    }, 'golden-terminal-baseline-evidence'))).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      task: {status: 'done', version: 4}, journeyVersion: 5,
      nextAllowedAction: {kind: 'blocked', reason: 'journey_complete'}
    }}}});

    const deploymentService = createDeploymentEvidenceService(createPostgresDeploymentEvidenceStore(db, {
      now: () => clock
    }));
    const releasePackage = {schemaVersion: 1 as const, sourceCommit: 'c'.repeat(40),
      artifactReference: 'artifact:release-package:msa-v1', artifactSha256: 'd'.repeat(64)};
    await expect(deploymentService.execute(envelope(ids.workspace, ownerContext.value, 'deployment.request.v1', {
      deploymentId: ids.deployment, projectId: ids.msa, workItemId: workItem.id,
      planVersionId: approvedVersion.id, materializationId: materialization.id, environment: 'production' as const,
      reference: {kind: 'commit' as const, reference: `git-commit:${releasePackage.sourceCommit}`},
      releasePackage, expectedProjectVersion: 1
    }, `deployment-request:v1:${ids.deployment}:1:${owner.id}`))).resolves.toMatchObject({receipt: {result: {
      ok: true, value: {state: 'requested', version: 1, nextAction: 'approve_production'}
    }}});
    await expect(deploymentService.execute(envelope(ids.workspace, ownerContext.value,
      'deployment.production_approve.v1', {deploymentId: ids.deployment, expectedVersion: 1},
      `deployment-production-approve:v1:${ids.deployment}:1:${owner.id}`)))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {state: 'approved', version: 2}}}});
    const deploymentExecutor = createDeploymentExecutorService({
      store: createPostgresDeploymentExecutorStore(db), now: () => clock,
      tokenGenerator: () => 'e'.repeat(43)
    });
    const deploymentAuthorization = {workspaceId: ids.workspace, executorId: 'msa-production-v1',
      registrationId: ids.deploymentRegistration, projectIds: [ids.msa], environments: ['production' as const],
      actor: deployerContext.value};
    const deploymentClaim = await deploymentExecutor.claim(deploymentAuthorization);
    expect(deploymentClaim).toMatchObject({deploymentId: ids.deployment, deploymentVersion: 2,
      releasePackage, approvedByActorId: owner.id});
    if (deploymentClaim === null) throw new Error('deployment claim missing');
    clock = new Date('2026-08-12T08:14:00.000Z');
    await expect(deploymentExecutor.heartbeat({authorization: deploymentAuthorization,
      leaseToken: deploymentClaim.leaseToken,
      payload: {jobId: deploymentClaim.jobId, attempt: deploymentClaim.attempt}}))
      .resolves.toMatchObject({leaseExpiresAt: '2026-08-12T08:16:00.000Z'});
    clock = new Date('2026-08-12T08:15:00.000Z');
    await expect(deploymentExecutor.complete({authorization: deploymentAuthorization,
      leaseToken: deploymentClaim.leaseToken, payload: {jobId: deploymentClaim.jobId,
        deploymentId: ids.deployment, deploymentVersion: 2, attempt: 1,
        result: {outcome: 'succeeded', startedAt: '2026-08-12T08:13:30.000Z',
          completedAt: '2026-08-12T08:14:30.000Z',
          smokeChecks: [{name: 'health', status: 'passed', reference: 'evidence:msa:health'}],
          rollback: {outcome: 'not_required', reference: null}}}})).resolves.toMatchObject({outcome: 'succeeded'});
    expect((await db.select().from(deployments).where(eq(deployments.id, ids.deployment)))[0])
      .toMatchObject({status: 'observed', version: 3, observedResult: {outcome: 'succeeded'}, releasePackage});
    expect((await db.select().from(deploymentExecutorJobs).where(eq(
      deploymentExecutorJobs.deploymentId, ids.deployment)))[0]).toMatchObject({status: 'succeeded', attempt: 1});

    const outcomeService = createProjectOutcomeAcceptanceService(createPostgresProjectOutcomeAcceptanceStore(db, {
      now: () => clock
    }));
    const outcomes = await db.select().from(projectScopeOutcomes)
      .where(eq(projectScopeOutcomes.baselineId, materialization.baselineId)).orderBy(asc(projectScopeOutcomes.key));
    expect(outcomes.map(({weight}) => weight).reduce((sum, weight) => sum + weight, 0)).toBe(100);
    for (const [index, outcome] of outcomes.entries()) {
      await expect(outcomeService.execute(envelope(ids.workspace, ownerContext.value,
        'project_scope_outcome.accept.v1', {projectId: ids.msa, baselineId: materialization.baselineId,
          outcomeId: outcome.id, expectedExecutionVersion: 4},
        `project-outcome-accept:v1:${outcome.id}:4:${owner.id}`))).resolves.toMatchObject({receipt: {result: {
          ok: true, value: index === outcomes.length - 1
            ? {acceptedWeight: 100, totalWeight: 100, executionStatus: 'blocked', executionVersion: 5}
            : {executionStatus: 'paused', executionVersion: 4}
        }}});
    }

    const projectAcceptance = createProjectAcceptanceService(createPostgresProjectAcceptanceStore(db, {
      now: () => clock
    }));
    const prepare = await projectAcceptance.execute(envelope(ids.workspace, ownerContext.value,
      'project_uat.prepare.v1', {projectId: ids.msa, protocolId: ids.uatProtocol, expectedExecutionVersion: 5,
        requiredSmokeChecks: ['health'], requiredDeploymentEnvironment: 'production' as const},
      `project-uat-prepare:v1:${ids.msa}:5:${owner.id}`));
    expect(prepare).toMatchObject({receipt: {result: {ok: true, value: {version: 1,
      release: {state: 'deployment_observed', deploymentId: ids.deployment},
      blockers: expect.arrayContaining(['uat_passed_required', 'product_owner_signoff_required',
        'client_representative_signoff_required'])
    }}}});
    if (!('receipt' in prepare) || !prepare.receipt.result.ok) throw new Error('UAT protocol missing');
    const uat = prepare.receipt.result.value.protocol;
    const premature = envelope(ids.workspace, ownerContext.value, 'project_execution.complete.v1', {
      projectId: ids.msa, protocolId: ids.uatProtocol, expectedVersion: 1, expectedExecutionVersion: 5
    }, `project-execution-complete:v1:${ids.msa}:5:1:${owner.id}`);
    await expect(projectAcceptance.execute(premature)).resolves.toMatchObject({receipt: {result: {
      ok: false, error: {code: 'INVALID_TRANSITION'}
    }}});
    const checks = uat.checklist.map((item) => ({key: item.key, outcome: 'passed' as const,
      evidenceReferences: item.requiredEvidence.map((requirement) => `evidence:uat:${item.key}:${requirement}`),
      artifactReferences: [`artifact:uat:${item.key}`]}));
    await expect(projectAcceptance.execute(envelope(ids.workspace, ownerContext.value,
      'project_uat.record_result.v1', {projectId: ids.msa, protocolId: ids.uatProtocol,
        resultId: ids.uatResult, expectedVersion: 1, outcome: 'passed' as const, checks},
      `project-uat-result:v1:${ids.uatProtocol}:1:${owner.id}`)))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {version: 2}}}});
    await expect(projectAcceptance.execute(envelope(ids.workspace, ownerContext.value, 'project_uat.signoff.v1', {
      projectId: ids.msa, protocolId: ids.uatProtocol, resultId: ids.uatResult, expectedVersion: 2,
      kind: 'product_owner' as const, evidenceReference: 'signoff:po:msa'
    }, `project-uat-signoff:v1:product_owner:${ids.uatResult}:2:${owner.id}`)))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {version: 3, completionReady: false}}}});
    await expect(projectAcceptance.execute(envelope(ids.workspace, ownerContext.value,
      'project_execution.complete.v1', {projectId: ids.msa, protocolId: ids.uatProtocol,
        expectedVersion: 3, expectedExecutionVersion: 5},
      `project-execution-complete:v1:${ids.msa}:5:3:${owner.id}`)))
      .resolves.toMatchObject({receipt: {result: {ok: false, error: {code: 'INVALID_TRANSITION',
        message: expect.stringContaining('client_representative_signoff_required')}}}});
    await expect(projectAcceptance.execute(envelope(ids.workspace, clientContext.value, 'project_uat.signoff.v1', {
      projectId: ids.msa, protocolId: ids.uatProtocol, resultId: ids.uatResult, expectedVersion: 3,
      kind: 'client_representative' as const, evidenceReference: 'signoff:client:msa'
    }, `project-uat-signoff:v1:client_representative:${ids.uatResult}:3:${ids.client}`)))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {version: 4, completionReady: true}}}});
    await expect(projectAcceptance.execute(envelope(ids.workspace, ownerContext.value,
      'project_execution.complete.v1', {projectId: ids.msa, protocolId: ids.uatProtocol,
        expectedVersion: 4, expectedExecutionVersion: 5},
      `project-execution-complete:v1:${ids.msa}:5:4:${owner.id}`)))
      .resolves.toMatchObject({receipt: {result: {ok: true, value: {version: 5, completionReady: true}}}});

    expect((await db.select().from(projectExecutions).where(eq(projectExecutions.projectId, ids.msa)))[0])
      .toMatchObject({status: 'completed', version: 6, blockReason: null, completedAt: clock});
    expect(await loadProjectAcceptanceProjection(db, ids.workspace, ids.msa)).toMatchObject({
      completionReady: true, release: {state: 'deployment_observed', deploymentId: ids.deployment},
      signoffs: {productOwner: {actorId: owner.id}, clientRepresentative: {actorId: ids.client}}
    });
    expect(await db.select().from(projectUatProtocols).where(eq(projectUatProtocols.id, ids.uatProtocol))).toHaveLength(1);
    expect(await db.select().from(projectUatResults).where(eq(projectUatResults.id, ids.uatResult))).toHaveLength(1);
    expect(await db.select().from(projectUatSignoffs).where(eq(projectUatSignoffs.resultId, ids.uatResult))).toHaveLength(2);
    await expect(db.update(projectUatProtocols).set({contentHash: '9'.repeat(64)}).where(eq(
      projectUatProtocols.id, ids.uatProtocol))).rejects.toThrow();
    await expect(db.update(projectUatResults).set({outcome: 'failed'}).where(eq(
      projectUatResults.id, ids.uatResult))).rejects.toThrow();
    expect((await db.select().from(auditEvents).where(eq(auditEvents.projectId, ids.msa))).length)
      .toBeGreaterThan(15);
    expect((await db.select().from(commandReceipts).where(eq(commandReceipts.workspaceId, ids.workspace))).length)
      .toBeGreaterThan(15);
    expect(await db.select().from(projectSourceArtifacts).where(eq(projectSourceArtifacts.projectId, ids.msa)))
      .toHaveLength(4);
    expect(await db.select().from(taskPackets).where(eq(taskPackets.projectId, ids.msa))).toHaveLength(2);
    expect(await db.select().from(agentRuns).where(eq(agentRuns.workItemId, workItem.id))).toHaveLength(2);
    expect(await db.select().from(deliveryJourneyEvidence).where(eq(deliveryJourneyEvidence.workItemId, workItem.id)))
      .toHaveLength(5);
  });
});
