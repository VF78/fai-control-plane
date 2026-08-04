import {and, eq} from 'drizzle-orm';
import {
  DEFAULT_AGENT_INSTRUCTIONS,
  DEFAULT_AGENT_SETTINGS,
  defaultDeliveryProtocolDefinition,
  effectiveInstructions,
  hashAgentProfileConfiguration,
  hashDeliveryProtocolDefinition,
  type DeliveryProtocolDefinition
} from '@fai-control-plane/domain';
import {
  createDatabase,
  actors,
  agentProfiles,
  projects,
  projectScopeBaselineVersions,
  projectScopeOutcomeObservations,
  projectScopeOutcomes,
  projectTrackerRepositoryScopes,
  runtimeRegistrations,
  runbooks,
  secretRefs,
  workspaceInstructionVersions,
  workItems,
  workspaces
} from './index';
import {
  reconcileLaunchHumanRoster,
  reconcileLaunchProjectMemberships
} from './launch-roster';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for seed');
const credentialReference = process.env.GITHUB_PROJECTS_OAUTH_TOKEN_FILE;
if (!credentialReference) {
  throw new Error('GITHUB_PROJECTS_OAUTH_TOKEN_FILE is required for seed');
}
const bootstrapExternalSubject = process.env.FCP_BOOTSTRAP_HUMAN_SUBJECT;
if (!bootstrapExternalSubject) {
  throw new Error('FCP_BOOTSTRAP_HUMAN_SUBJECT is required for seed');
}
const operatorGitHubUserIds = process.env.FCP_OPERATOR_GITHUB_USER_IDS;
if (!operatorGitHubUserIds) {
  throw new Error('FCP_OPERATOR_GITHUB_USER_IDS is required for seed');
}

const {db, pool} = createDatabase(databaseUrl);
const workspaceSeed = {name: 'fAI Studio', slug: 'fai-studio'};
const repositorySeeds = [
  {name: 'MSA', slug: 'msa', owner: 'VF78', repository: 'MSA', externalId: 'github:repository:1278325372'},
  {name: 'ASCON', slug: 'ascon', owner: 'VF78', repository: 'ascon', externalId: 'github:repository:1279114011'}
] as const;
type ScopeOutcomeSeed = readonly [string, string, number, 'accepted' | 'review' | 'in_progress' | 'not_started' | 'not_configured'];
type ScopeObservationSeed = readonly [number, number, string];
type ScopeSeed = Readonly<{
  checkpointTitle: string;
  checkpointStatus: 'ready' | 'in_dev';
  outcomes: readonly ScopeOutcomeSeed[];
  observations: readonly ScopeObservationSeed[];
}>;

const launchDeliveryProtocol = (
  projectSlug: typeof repositorySeeds[number]['slug'],
  hermesActorId: string,
  hermesProfileId: string
): DeliveryProtocolDefinition => {
  const definition = defaultDeliveryProtocolDefinition();
  if (projectSlug === 'ascon') return definition;
  return {
    ...definition,
    stages: definition.stages.map((stage) => {
      if (stage.key === 'development') {
        return {
          ...stage,
          responsibility: {kind: 'project_role', role: 'contributor'} as const
        };
      }
      if (stage.key === 'qa') {
        return {
          ...stage,
          responsibility: {
            kind: 'actor',
            actorId: hermesActorId,
            actorType: 'agent',
            agentProfileId: hermesProfileId
          } as const,
          executionMode: 'autonomous' as const
        };
      }
      if (stage.key === 'staging') {
        return {
          ...stage,
          responsibility: {
            kind: 'actor',
            actorId: hermesActorId,
            actorType: 'agent',
            agentProfileId: hermesProfileId
          } as const,
          executionMode: 'human_approval' as const
        };
      }
      return stage;
    })
  };
};

try {
  const [workspace] = await db.insert(workspaces).values(workspaceSeed)
    .onConflictDoNothing({target: workspaces.slug}).returning();
  const persistedWorkspace = workspace ?? (await db.select().from(workspaces)
    .where(eq(workspaces.slug, workspaceSeed.slug)))[0];
  if (!persistedWorkspace) throw new Error('workspace seed failed');

  const launchHumanRoster = await reconcileLaunchHumanRoster(
    db,
    persistedWorkspace.id,
    bootstrapExternalSubject,
    operatorGitHubUserIds
  );
  const bootstrapActor = {id: launchHumanRoster.bootstrapActorId};
  const hermesActorSeed = {
    workspaceId: persistedWorkspace.id,
    type: 'agent' as const,
    role: 'agent_operator' as const,
    displayName: 'Hermes',
    authMode: 'agent' as const,
    externalSubject: 'agent:hermes:v1',
    capabilities: {'read:control_plane:development': true}
  };
  await db.insert(actors).values(hermesActorSeed).onConflictDoUpdate({
    target: [actors.workspaceId, actors.authMode, actors.externalSubject],
    set: {
      type: hermesActorSeed.type,
      role: hermesActorSeed.role,
      displayName: hermesActorSeed.displayName,
      capabilities: hermesActorSeed.capabilities
    }
  });
  const [hermesActor] = await db.select({id: actors.id}).from(actors).where(and(
    eq(actors.workspaceId, persistedWorkspace.id),
    eq(actors.authMode, 'agent'),
    eq(actors.externalSubject, hermesActorSeed.externalSubject)
  ));
  if (hermesActor === undefined) throw new Error('Hermes actor seed failed');
  const codexActorSeed = {
    workspaceId: persistedWorkspace.id,
    type: 'agent' as const,
    role: 'agent_operator' as const,
    displayName: 'Codex CLI',
    authMode: 'agent' as const,
    externalSubject: 'agent:codex-cli:v1',
    capabilities: {'read:repository:development': true}
  };
  await db.insert(actors).values(codexActorSeed).onConflictDoUpdate({
    target: [actors.workspaceId, actors.authMode, actors.externalSubject],
    set: {
      type: codexActorSeed.type,
      role: codexActorSeed.role,
      displayName: codexActorSeed.displayName,
      capabilities: codexActorSeed.capabilities
    }
  });
  const [codexActor] = await db.select({id: actors.id}).from(actors).where(and(
    eq(actors.workspaceId, persistedWorkspace.id),
    eq(actors.authMode, 'agent'),
    eq(actors.externalSubject, codexActorSeed.externalSubject)
  ));
  if (codexActor === undefined) throw new Error('Codex actor seed failed');
  const hermesConfig = {
    runtimeId: 'hermes',
    runtimeProfile: 'read_safe',
    allowedTools: ['task_packet_read', 'artifact_write'] as string[],
    forbiddenSurfaces: ['external_message', 'github_write', 'production', 'deploy', 'merge'] as string[],
    instructions: DEFAULT_AGENT_INSTRUCTIONS,
    settings: DEFAULT_AGENT_SETTINGS,
    enabled: true,
    version: 1
  } as const;
  await db.insert(agentProfiles).values({
    workspaceId: persistedWorkspace.id,
    actorId: hermesActor.id,
    ...hermesConfig,
    configHash: hashAgentProfileConfiguration(hermesConfig)
  }).onConflictDoNothing({
    target: [agentProfiles.actorId, agentProfiles.runtimeId, agentProfiles.runtimeProfile]
  });
  const [hermesProfile] = await db.select({id: agentProfiles.id}).from(agentProfiles).where(and(
    eq(agentProfiles.workspaceId, persistedWorkspace.id),
    eq(agentProfiles.actorId, hermesActor.id),
    eq(agentProfiles.runtimeId, hermesConfig.runtimeId),
    eq(agentProfiles.runtimeProfile, hermesConfig.runtimeProfile)
  ));
  if (hermesProfile === undefined) throw new Error('Hermes profile seed failed');
  const baselineInstructions = effectiveInstructions({
    instructions: DEFAULT_AGENT_INSTRUCTIONS,
    settings: DEFAULT_AGENT_SETTINGS
  });
  await db.insert(workspaceInstructionVersions).values({
    workspaceId: persistedWorkspace.id,
    version: 1,
    instructions: baselineInstructions.instructions,
    settings: baselineInstructions.settings as Record<string, unknown>,
    contentHash: baselineInstructions.hash,
    authoredByActorId: bootstrapActor.id,
    approvedByActorId: bootstrapActor.id
  }).onConflictDoNothing({
    target: [workspaceInstructionVersions.workspaceId, workspaceInstructionVersions.version]
  });
  await db.insert(agentProfiles).values({
    workspaceId: persistedWorkspace.id,
    actorId: bootstrapActor.id,
    runtimeId: 'pm-qa-bot',
    runtimeProfile: 'read_safe',
    allowedTools: [],
    forbiddenSurfaces: ['external_message', 'github_write', 'runner', 'production'],
    enabled: true
  }).onConflictDoUpdate({
    target: [agentProfiles.actorId, agentProfiles.runtimeId, agentProfiles.runtimeProfile],
    set: {
      allowedTools: [],
      forbiddenSurfaces: ['external_message', 'github_write', 'runner', 'production']
    }
  });
  await db.update(agentProfiles).set({enabled: false}).where(and(
    eq(agentProfiles.workspaceId, persistedWorkspace.id),
    eq(agentProfiles.actorId, bootstrapActor.id),
    eq(agentProfiles.runtimeId, 'codex-cli'),
    eq(agentProfiles.runtimeProfile, 'write_scoped')
  ));
  await db.insert(agentProfiles).values({
    workspaceId: persistedWorkspace.id,
    actorId: codexActor.id,
    runtimeId: 'codex-cli',
    runtimeProfile: 'write_scoped',
    allowedTools: ['git', 'read', 'test', 'build', 'issue_read'],
    forbiddenSurfaces: ['production', 'deploy', 'merge', 'protected_secrets'],
    enabled: true
  }).onConflictDoUpdate({
    target: [agentProfiles.actorId, agentProfiles.runtimeId, agentProfiles.runtimeProfile],
    set: {
      allowedTools: ['git', 'read', 'test', 'build', 'issue_read'],
      forbiddenSurfaces: ['production', 'deploy', 'merge', 'protected_secrets'],
      enabled: true
    }
  });

  const [persistedCredential] = await db.insert(secretRefs).values({
    workspaceId: persistedWorkspace.id,
    provider: 'file',
    reference: credentialReference,
    scope: ['read:project']
  }).onConflictDoUpdate({
    target: [secretRefs.workspaceId, secretRefs.provider, secretRefs.reference],
    set: {scope: ['read:project']}
  }).returning();
  if (!persistedCredential) throw new Error('credential reference seed failed');

  for (const repository of repositorySeeds) {
    const [project] = await db.insert(projects).values({
      workspaceId: persistedWorkspace.id, name: repository.name, slug: repository.slug
    }).onConflictDoNothing({target: [projects.workspaceId, projects.slug]}).returning();
    const persistedProject = project ?? (await db.select().from(projects)
      .where(and(eq(projects.workspaceId, persistedWorkspace.id), eq(projects.slug, repository.slug))))[0];
    if (!persistedProject) throw new Error(`project seed failed: ${repository.slug}`);
    await reconcileLaunchProjectMemberships(
      db,
      persistedProject.id,
      repository.slug,
      launchHumanRoster.members,
      hermesActor.id
    );
    const deliveryProtocol = launchDeliveryProtocol(
      repository.slug,
      hermesActor.id,
      hermesProfile.id
    );
    const deliveryProtocolHash = hashDeliveryProtocolDefinition(deliveryProtocol);
    const [activeProtocol] = await db.select({
      id: runbooks.id,
      contentHash: runbooks.contentHash
    }).from(runbooks).where(and(
      eq(runbooks.projectId, persistedProject.id),
      eq(runbooks.protocolState, 'published'),
      eq(runbooks.active, true)
    ));
    if (
      activeProtocol !== undefined &&
      activeProtocol.contentHash !== deliveryProtocolHash
    ) {
      throw new Error(
        `active delivery protocol differs from launch protocol: ${repository.slug}`
      );
    }
    if (activeProtocol === undefined) {
      await db.insert(runbooks).values({
        projectId: persistedProject.id,
        name: 'Delivery',
        version: 1,
        definition: deliveryProtocol as unknown as Record<string, unknown>,
        active: true,
        protocolState: 'published',
        revision: 1,
        contentHash: deliveryProtocolHash
      });
    }
    const scopeSeed: ScopeSeed = repository.slug === 'msa'
      ? {
          checkpointTitle: 'Совместный E2E-сценарий и бизнес-приёмка',
          checkpointStatus: 'in_dev' as const,
          outcomes: [
            ['catalog_mapping', 'Сопоставление номенклатуры', 25, 'accepted' as const],
            ['document_intake', 'Приём и разбор документов', 20, 'accepted' as const],
            ['stock_price_reconciliation', 'Сверка цен и остатков', 15, 'review' as const],
            ['joint_e2e', 'Совместный E2E-сценарий', 25, 'in_progress' as const],
            ['business_acceptance', 'Бизнес-приёмка', 15, 'not_started' as const]
          ],
          observations: [[10, 80, '2026-08-01T09:00:00.000Z'], [45, 100, '2026-08-04T15:02:00.000Z']]
        }
      : {
          checkpointTitle: 'Подтвердить старт работ',
          checkpointStatus: 'ready' as const,
          outcomes: [
            ['source_inventory', 'Инвентаризация исходных данных', 20, 'not_started' as const],
            ['integration_outline', 'Контур интеграции', 20, 'not_started' as const],
            ['business_scenario', 'Бизнес-сценарий', 20, 'not_started' as const],
            ['pilot_acceptance', 'Приёмка пилота', 20, 'not_started' as const],
            ['launch_decision', 'Решение о запуске', 20, 'not_started' as const]
          ],
          observations: [[0, 100, '2026-08-04T15:02:00.000Z'], [0, 100, '2026-08-05T09:00:00.000Z']]
        };
    await db.insert(projectScopeBaselineVersions).values({
      projectId: persistedProject.id, version: 1, active: true,
      approvedByActorId: bootstrapActor.id, approvedAt: new Date('2026-08-04T15:02:00.000Z'),
      checkpointTitle: scopeSeed.checkpointTitle, checkpointStatus: scopeSeed.checkpointStatus,
      checkpointOwnerActorId: bootstrapActor.id, checkpointTargetAt: null
    }).onConflictDoUpdate({
      target: [projectScopeBaselineVersions.projectId, projectScopeBaselineVersions.version],
      set: {active: true, approvedByActorId: bootstrapActor.id, approvedAt: new Date('2026-08-04T15:02:00.000Z'), checkpointTitle: scopeSeed.checkpointTitle, checkpointStatus: scopeSeed.checkpointStatus, checkpointOwnerActorId: bootstrapActor.id, checkpointTargetAt: null}
    });
    const [scopeBaseline] = await db.select({id: projectScopeBaselineVersions.id}).from(projectScopeBaselineVersions).where(and(
      eq(projectScopeBaselineVersions.projectId, persistedProject.id), eq(projectScopeBaselineVersions.version, 1)
    ));
    if (scopeBaseline === undefined) throw new Error(`scope baseline seed failed: ${repository.slug}`);
    for (const [key, title, weight, state] of scopeSeed.outcomes) {
      const accepted = state === 'accepted';
      await db.insert(projectScopeOutcomes).values({
        baselineId: scopeBaseline.id, key, title, weight, state,
        acceptedByActorId: accepted ? bootstrapActor.id : null,
        acceptedAt: accepted ? new Date('2026-08-04T15:02:00.000Z') : null,
        evidenceReference: 'Решение Product Owner · #91'
      }).onConflictDoUpdate({
        target: [projectScopeOutcomes.baselineId, projectScopeOutcomes.key],
        set: {title, weight, state, acceptedByActorId: accepted ? bootstrapActor.id : null, acceptedAt: accepted ? new Date('2026-08-04T15:02:00.000Z') : null, evidenceReference: 'Решение Product Owner · #91'}
      });
    }
    for (const [acceptedWeight, totalWeight, observedAt] of scopeSeed.observations) {
      await db.insert(projectScopeOutcomeObservations).values({
        projectId: persistedProject.id, baselineId: scopeBaseline.id, acceptedWeight, totalWeight,
        observedAt: new Date(observedAt), evidenceReference: 'Решение Product Owner · #91'
      }).onConflictDoUpdate({
        target: [projectScopeOutcomeObservations.projectId, projectScopeOutcomeObservations.observedAt],
        set: {baselineId: scopeBaseline.id, acceptedWeight, totalWeight, evidenceReference: 'Решение Product Owner · #91'}
      });
    }
    if (repository.slug === 'msa') {
      await db.insert(runtimeRegistrations).values({
        projectId: persistedProject.id,
        actorId: hermesActor.id,
        agentProfileId: hermesProfile.id,
        provider: 'provider_neutral',
        runtimeKey: 'hermes',
        enabled: true,
        serviceMaxAgeSeconds: 300,
        schedulerMaxAgeSeconds: 900,
        deliveryMaxAgeSeconds: 93_600
      }).onConflictDoUpdate({
        target: [
          runtimeRegistrations.projectId,
          runtimeRegistrations.actorId,
          runtimeRegistrations.agentProfileId,
          runtimeRegistrations.provider,
          runtimeRegistrations.runtimeKey
        ],
        set: {
          enabled: true,
          serviceMaxAgeSeconds: 300,
          schedulerMaxAgeSeconds: 900,
          deliveryMaxAgeSeconds: 93_600
        }
      });
      const existingItems = await db.select({id: workItems.id}).from(workItems).where(eq(workItems.projectId, persistedProject.id));
      if (existingItems.length === 0) {
        await db.insert(workItems).values([
          ...Array.from({length: 42}, (_, index) => ({
            projectId: persistedProject.id,
            title: `Бэклог · уточнение ${index + 1}`,
            summary: 'Подтверждённая очередь для локального просмотра доски.',
            status: 'backlog' as const,
            ownerActorId: index % 3 === 0 ? bootstrapActor.id : null
          })),
          {projectId: persistedProject.id, title: 'Совместный E2E-сценарий', summary: 'Проверка основного бизнес-сценария.', status: 'in_dev' as const, ownerActorId: bootstrapActor.id},
          {projectId: persistedProject.id, title: 'Сверка цен и остатков', summary: 'Подтверждение расхождений перед приёмкой.', status: 'qa' as const, ownerActorId: hermesActor.id},
          {projectId: persistedProject.id, title: 'Бизнес-приёмка', summary: 'Подготовить решение владельца продукта.', status: 'acceptance' as const, ownerActorId: bootstrapActor.id}
        ]);
      }
    }
    await db.insert(projectTrackerRepositoryScopes).values({
      projectId: persistedProject.id,
      provider: 'github',
      repositoryOwner: repository.owner,
      repositoryName: repository.repository,
      repositoryExternalId: repository.externalId,
      credentialRefId: persistedCredential.id
    }).onConflictDoUpdate({
      target: [projectTrackerRepositoryScopes.projectId, projectTrackerRepositoryScopes.provider, projectTrackerRepositoryScopes.repositoryOwner, projectTrackerRepositoryScopes.repositoryName],
      set: {credentialRefId: persistedCredential.id}
    });
  }
  console.log(`Seeded fAI Studio workspace: ${persistedWorkspace.id}`);
} finally {
  await pool.end();
}
