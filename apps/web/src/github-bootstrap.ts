import {randomUUID} from 'node:crypto';
import {createTrackerRepositorySnapshotOrchestrationService} from '@fai-control-plane/application';
import {
  createDatabase,
  createPostgresTrackerRepositoryReadScopeAuthorizer,
  createPostgresTrackerSnapshotProjector,
  actors,
  projectTrackerRepositoryScopes,
  projects,
  secretRefs,
  trackerBindings,
  workspaces
} from '@fai-control-plane/db';
import {createActorContextIssuer} from '@fai-control-plane/domain';
import {createGitHubRepositoryReadAdapter} from '@fai-control-plane/integrations';
import {and, eq, inArray} from 'drizzle-orm';
import {createFileSecretsProvider} from './github-webhook-runtime';

const required = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const requiredExactInteger = (name: string, expected: number): number => {
  const value = required(name);
  if (value !== String(expected)) {
    throw new Error(`${name} must be exactly ${expected}`);
  }
  return expected;
};

const databaseUrl = required('DATABASE_URL');
const projectsTokenFile = required('GITHUB_PROJECTS_OAUTH_TOKEN_FILE');
const appPrivateKeyFile = required('GITHUB_APP_PRIVATE_KEY_FILE');
requiredExactInteger('GITHUB_APP_ID', 4_397_394);
requiredExactInteger('GITHUB_MSA_INSTALLATION_ID', 149_112_973);
requiredExactInteger('GITHUB_ASCON_INSTALLATION_ID', 149_112_973);
const bootstrapSubject = required('FCP_BOOTSTRAP_HUMAN_SUBJECT');
const {db, pool} = createDatabase(databaseUrl);
const projectSlugs = ['msa', 'ascon'] as const;

try {
  console.info('GitHub App and Projects OAuth credentials: configured');
  const [workspace] = await db.select({id: workspaces.id}).from(workspaces)
    .where(eq(workspaces.slug, 'fai-studio'));
  if (workspace === undefined) throw new Error('Seeded fAI Studio workspace is required');

  const [actor] = await db.select({id: actors.id}).from(actors).where(and(
    eq(actors.workspaceId, workspace.id),
    eq(actors.authMode, 'user'),
    eq(actors.externalSubject, bootstrapSubject)
  ));
  if (actor === undefined) throw new Error('Seeded bootstrap actor is required');

  const issuer = createActorContextIssuer({
    users: [{
      actorId: actor.id,
      capabilities: ['read:repository:development', 'write:tracker:development']
    }],
    agents: [],
    systems: []
  });
  if (!issuer.ok) throw new Error('Bootstrap actor grants are invalid');
  const trustedActor = issuer.value.issueUser(actor.id);
  if (!trustedActor.ok) throw new Error('Bootstrap actor cannot be issued');

  const scopes = await db.select({
    projectId: projects.id,
    projectSlug: projects.slug,
    owner: projectTrackerRepositoryScopes.repositoryOwner,
    repository: projectTrackerRepositoryScopes.repositoryName,
    credentialProvider: secretRefs.provider,
    credentialReference: secretRefs.reference,
    credentialScope: secretRefs.scope,
    bindingId: trackerBindings.id,
    lastInboundVersion: trackerBindings.lastInboundVersion
  }).from(projectTrackerRepositoryScopes)
    .innerJoin(projects, eq(projects.id, projectTrackerRepositoryScopes.projectId))
    .innerJoin(secretRefs, eq(secretRefs.id, projectTrackerRepositoryScopes.credentialRefId))
    .leftJoin(trackerBindings, and(
      eq(trackerBindings.projectId, projects.id),
      eq(trackerBindings.provider, 'github'),
      eq(trackerBindings.surface, 'repository'),
      eq(trackerBindings.entityType, 'project'),
      eq(trackerBindings.entityId, projects.id)
    ))
    .where(and(
      eq(projects.workspaceId, workspace.id),
      eq(projectTrackerRepositoryScopes.provider, 'github'),
      inArray(projects.slug, [...projectSlugs])
    ));
  if (scopes.length !== projectSlugs.length ||
    new Set(scopes.map(({projectSlug}) => projectSlug)).size !== projectSlugs.length) {
    throw new Error('Exactly the seeded MSA and ASCON repository scopes are required');
  }

  const service = createTrackerRepositorySnapshotOrchestrationService({
    adapter: createGitHubRepositoryReadAdapter({
      fetch: (input, init) => fetch(input, init),
      appSecretsProvider: createFileSecretsProvider({
        provider: 'file',
        reference: appPrivateKeyFile,
        scope: ['github:app:installation-token:mint']
      }, 'github_app_installation_token_mint'),
      appPrivateKeyRef: {
        provider: 'file',
        reference: appPrivateKeyFile,
        scope: ['github:app:installation-token:mint']
      },
      projectsSecretsProvider: createFileSecretsProvider({
        provider: 'file',
        reference: projectsTokenFile,
        scope: ['project']
      }, 'github_project_snapshot_read_oauth_token')
    }),
    scopeAuthorizer: createPostgresTrackerRepositoryReadScopeAuthorizer(db),
    projector: createPostgresTrackerSnapshotProjector(db)
  });

  let failed = false;
  for (const scope of scopes.sort((left, right) => left.projectSlug.localeCompare(right.projectSlug))) {
    const mode = scope.bindingId === null ? 'bootstrap' : 'synchronize';
    const result = await service.orchestrate({
      actor: trustedActor.value,
      workspaceId: workspace.id,
      projectId: scope.projectId,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      expectedProvider: 'github',
      repository: {owner: scope.owner, repository: scope.repository},
      credentialRef: {
        provider: scope.credentialProvider,
        reference: scope.credentialReference,
        scope: scope.credentialScope
      },
      ...(mode === 'bootstrap'
        ? {mode}
        : {mode, expectedPreviousExternalVersion: scope.lastInboundVersion ?? ''})
    });
    const resultCode = 'code' in result ? ` (${result.code})` : '';
    console.info(`${scope.projectSlug}: ${mode} ${result.status}${resultCode}`);
    if (result.status === 'denied' || result.status === 'failed' || result.status === 'conflict') {
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
} finally {
  await pool.end();
}
