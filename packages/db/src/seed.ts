import {and, eq} from 'drizzle-orm';
import {
  DEFAULT_AGENT_INSTRUCTIONS,
  DEFAULT_AGENT_SETTINGS,
  hashAgentProfileConfiguration
} from '@fai-control-plane/domain';
import {
  createDatabase,
  actors,
  agentProfiles,
  projects,
  projectTrackerRepositoryScopes,
  secretRefs,
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
