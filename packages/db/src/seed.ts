import {and, eq} from 'drizzle-orm';
import {
  DEFAULT_HERMES_INSTRUCTIONS,
  DEFAULT_HERMES_SETTINGS,
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

const parseOperatorGitHubUserIds = (value: string): readonly string[] => {
  const ids = value.split(',');
  if (ids.length !== 2) {
    throw new Error('FCP_OPERATOR_GITHUB_USER_IDS must contain exactly two numeric IDs');
  }
  if (ids.some((id) => !/^[1-9][0-9]{0,15}$/.test(id))) {
    throw new Error('FCP_OPERATOR_GITHUB_USER_IDS must use canonical positive decimal IDs');
  }
  if (ids.some((id) => !Number.isSafeInteger(Number(id)))) {
    throw new Error('FCP_OPERATOR_GITHUB_USER_IDS contains an unsafe numeric ID');
  }
  if (new Set(ids).size !== 2) {
    throw new Error('FCP_OPERATOR_GITHUB_USER_IDS must not contain duplicates');
  }
  return ids;
};

const configuredOperatorIds = parseOperatorGitHubUserIds(operatorGitHubUserIds);
const bootstrapOperatorId = bootstrapExternalSubject.match(/^github:user:([1-9][0-9]{0,15})$/)?.[1];
if (bootstrapOperatorId === undefined || !configuredOperatorIds.includes(bootstrapOperatorId)) {
  throw new Error('FCP_BOOTSTRAP_HUMAN_SUBJECT must equal github:user:<id> for FCP_OPERATOR_GITHUB_USER_IDS');
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

  for (const githubUserId of configuredOperatorIds) {
    const isBootstrapOperator = githubUserId === bootstrapOperatorId;
    const actorSeed = {
      workspaceId: persistedWorkspace.id,
      type: 'human' as const,
      role: isBootstrapOperator ? 'workspace_admin' as const : 'developer' as const,
      displayName: isBootstrapOperator ? 'Bootstrap operator' : 'Operator developer',
      authMode: 'user' as const,
      externalSubject: `github:user:${githubUserId}`,
      capabilities: isBootstrapOperator
        ? {
          'read:repository:development': true,
          'write:tracker:development': true,
          'write:control_plane:development': true
        }
        : {
          'read:control_plane:development': true,
          'write:control_plane:development': true
        }
    };
    await db.insert(actors).values(actorSeed).onConflictDoUpdate({
      target: [actors.workspaceId, actors.authMode, actors.externalSubject],
      set: {
        type: actorSeed.type,
        role: actorSeed.role,
        displayName: actorSeed.displayName,
        capabilities: actorSeed.capabilities
      }
    });
  }
  const [bootstrapActor] = await db.select({id: actors.id}).from(actors).where(and(
    eq(actors.workspaceId, persistedWorkspace.id),
    eq(actors.authMode, 'user'),
    eq(actors.externalSubject, bootstrapExternalSubject)
  ));
  if (bootstrapActor === undefined) throw new Error('bootstrap operator seed failed');
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
  const hermesConfig = {
    runtimeId: 'hermes',
    runtimeProfile: 'read_safe',
    allowedTools: ['task_packet_read', 'artifact_write'] as string[],
    forbiddenSurfaces: ['external_message', 'github_write', 'production', 'deploy', 'merge'] as string[],
    instructions: DEFAULT_HERMES_INSTRUCTIONS,
    settings: DEFAULT_HERMES_SETTINGS,
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
  await db.insert(agentProfiles).values({
    workspaceId: persistedWorkspace.id,
    actorId: bootstrapActor.id,
    runtimeId: 'codex-cli',
    runtimeProfile: 'write_scoped',
    allowedTools: ['git', 'read', 'test', 'build', 'issue_read'],
    forbiddenSurfaces: ['production', 'deploy', 'merge', 'protected_secrets'],
    enabled: true
  }).onConflictDoUpdate({
    target: [agentProfiles.actorId, agentProfiles.runtimeId, agentProfiles.runtimeProfile],
    set: {
      allowedTools: ['git', 'read', 'test', 'build', 'issue_read'],
      forbiddenSurfaces: ['production', 'deploy', 'merge', 'protected_secrets']
    }
  });

  const [persistedCredential] = await db.insert(secretRefs).values({
    workspaceId: persistedWorkspace.id,
    provider: 'file',
    reference: credentialReference,
    scope: ['project']
  }).onConflictDoUpdate({
    target: [secretRefs.workspaceId, secretRefs.provider, secretRefs.reference],
    set: {scope: ['project']}
  }).returning();
  if (!persistedCredential) throw new Error('credential reference seed failed');

  for (const repository of repositorySeeds) {
    const [project] = await db.insert(projects).values({
      workspaceId: persistedWorkspace.id, name: repository.name, slug: repository.slug
    }).onConflictDoNothing({target: [projects.workspaceId, projects.slug]}).returning();
    const persistedProject = project ?? (await db.select().from(projects)
      .where(and(eq(projects.workspaceId, persistedWorkspace.id), eq(projects.slug, repository.slug))))[0];
    if (!persistedProject) throw new Error(`project seed failed: ${repository.slug}`);
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
