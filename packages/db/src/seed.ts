import {and, eq} from 'drizzle-orm';
import {
  createDatabase,
  projects,
  projectTrackerRepositoryScopes,
  secretRefs,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for seed');
const credentialReference = process.env.GITHUB_REPOSITORY_READ_TOKEN_FILE;
if (!credentialReference) {
  throw new Error('GITHUB_REPOSITORY_READ_TOKEN_FILE is required for seed');
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

  const [credential] = await db.insert(secretRefs).values({
    workspaceId: persistedWorkspace.id,
    provider: 'file',
    reference: credentialReference,
    scope: ['github:repository:snapshot:read']
  }).onConflictDoNothing({
    target: [secretRefs.workspaceId, secretRefs.provider, secretRefs.reference]
  }).returning();
  const persistedCredential = credential ?? (await db.select().from(secretRefs)
    .where(and(eq(secretRefs.workspaceId, persistedWorkspace.id), eq(secretRefs.provider, 'file'), eq(secretRefs.reference, credentialReference))))[0];
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
    }).onConflictDoNothing({
      target: [projectTrackerRepositoryScopes.projectId, projectTrackerRepositoryScopes.provider, projectTrackerRepositoryScopes.repositoryOwner, projectTrackerRepositoryScopes.repositoryName]
    });
  }
  console.log(`Seeded fAI Studio workspace: ${persistedWorkspace.id}`);
} finally {
  await pool.end();
}
