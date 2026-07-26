import {and, eq} from 'drizzle-orm';
import {
  createDatabase,
  actors,
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

  await db.insert(actors).values({
    workspaceId: persistedWorkspace.id,
    type: 'human',
    role: 'workspace_admin',
    displayName: 'Bootstrap operator',
    authMode: 'user',
    externalSubject: bootstrapExternalSubject,
    capabilities: {
      'read:repository:development': true,
      'write:tracker:development': true
    }
  }).onConflictDoNothing({
    target: [actors.workspaceId, actors.authMode, actors.externalSubject]
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
