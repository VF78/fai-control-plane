import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {
  createCanonicalCommandService,
  createTrackerRepositorySnapshotOrchestrationService
} from '@fai-control-plane/application';
import {
  createPostgresTrackerRepositoryReadScopeAuthorizer,
  createPostgresTrackerSnapshotProjector,
  createPostgresTrackerStatusObservationProcessor,
  createPostgresUnitOfWork
} from '@fai-control-plane/db/runtime';
import {
  createActorContextIssuer,
  type OpaqueSecretRef,
  type SecretsProvider
} from '@fai-control-plane/domain';
import {createGitHubRepositoryReadAdapter} from '@fai-control-plane/integrations/runtime';

const projectSlugs = ['msa', 'ascon'] as const;
const maximumObservationsPerSnapshot = 10;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const appSecretScope = Object.freeze(['github:app:installation-token:mint']);
const projectSecretScope = Object.freeze(['read:project']);

type ProjectSlug = typeof projectSlugs[number];
type Database = Parameters<typeof createPostgresTrackerRepositoryReadScopeAuthorizer>[0];
type Queryable = Readonly<{
  query(text: string, values?: unknown[]): Promise<Readonly<{rows: unknown[]}>>;
}>;
type ScopeRow = Readonly<{
  projectId: string;
  projectSlug: ProjectSlug;
  owner: string;
  repository: string;
  credentialProvider: string;
  credentialReference: string;
  credentialScope: string[];
  lastInboundVersion: string | null;
}>;

type ReconciliationFailure = Readonly<{
  code: string;
  project: ProjectSlug | 'workspace';
  status: 'failed' | 'denied' | 'conflict' | 'retryable' | 'limit_reached';
}>;

class GitHubReconciliationError extends Error {
  constructor(readonly failure: ReconciliationFailure) {
    super(failure.code);
  }
}

const required = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const requiredUuid = (name: string): string => {
  const value = required(name);
  if (!uuidPattern.test(value)) throw new Error(`${name} must be a UUID`);
  return value;
};

const requiredExactInteger = (name: string, expected: number): number => {
  if (required(name) !== String(expected)) {
    throw new Error(`${name} must be exactly ${expected}`);
  }
  return expected;
};

const createFileSecretsProvider = (
  allowedReference: OpaqueSecretRef,
  allowedPurpose: string
): SecretsProvider => ({
  async resolve(reference, purpose) {
    if (
      purpose !== allowedPurpose ||
      reference.provider !== allowedReference.provider ||
      reference.reference !== allowedReference.reference ||
      reference.scope.length !== allowedReference.scope.length ||
      reference.scope.some((part, index) => part !== allowedReference.scope[index])
    ) {
      throw new Error('Secret reference is not allowed.');
    }
    const value = await readFile(allowedReference.reference, 'utf8');
    if (value.length === 0 || value.length > 65_536 || value.includes('\0')) {
      throw new Error('GitHub secret file is invalid.');
    }
    return {value: value.trimEnd()};
  }
});

const fail = (failure: ReconciliationFailure): never => {
  throw new GitHubReconciliationError(failure);
};

const snapshotSucceeded = (status: string): status is 'applied' | 'replayed' =>
  status === 'applied' || status === 'replayed';

const failureForSnapshot = (
  project: ProjectSlug,
  result: Readonly<{status: string; code?: string}>
): ReconciliationFailure => ({
  code: result.code ?? 'GITHUB_RECONCILIATION_SNAPSHOT_UNAVAILABLE',
  project,
  status: result.status === 'denied' ? 'denied' : result.status === 'conflict' ? 'conflict' : 'failed'
});

export type GitHubReconciliationRuntime = Readonly<{
  reconcile(): Promise<void>;
}>;

/** Reconciles only pre-seeded, already-bootstrapped GitHub repository bindings. */
export const createGitHubReconciliationRuntime = (
  db: Database,
  pool: Queryable
): GitHubReconciliationRuntime => {
  const workspaceId = requiredUuid('FCP_WORKSPACE_ID');
  const configuredProjectIds: Readonly<Record<ProjectSlug, string>> = {
    msa: requiredUuid('GITHUB_MSA_PROJECT_ID'),
    ascon: requiredUuid('GITHUB_ASCON_PROJECT_ID')
  };
  const projectsTokenFile = required('GITHUB_PROJECTS_OAUTH_TOKEN_FILE');
  const appPrivateKeyFile = required('GITHUB_APP_PRIVATE_KEY_FILE');
  if (!isAbsolute(projectsTokenFile) || !isAbsolute(appPrivateKeyFile)) {
    throw new Error('GitHub credential files must be absolute paths.');
  }
  requiredExactInteger('GITHUB_APP_ID', 4_397_394);
  requiredExactInteger('GITHUB_MSA_INSTALLATION_ID', 149_112_973);
  requiredExactInteger('GITHUB_ASCON_INSTALLATION_ID', 149_112_973);
  const bootstrapSubject = required('FCP_BOOTSTRAP_HUMAN_SUBJECT');
  const appPrivateKeyRef: OpaqueSecretRef = {
    provider: 'file', reference: appPrivateKeyFile, scope: appSecretScope
  };
  const projectsTokenRef: OpaqueSecretRef = {
    provider: 'file', reference: projectsTokenFile, scope: projectSecretScope
  };
  const service = createTrackerRepositorySnapshotOrchestrationService({
    adapter: createGitHubRepositoryReadAdapter({
      fetch: (input, init) => fetch(input, init),
      appSecretsProvider: createFileSecretsProvider(
        appPrivateKeyRef,
        'github_app_installation_token_mint'
      ),
      appPrivateKeyRef,
      projectsSecretsProvider: createFileSecretsProvider(
        projectsTokenRef,
        'github_project_snapshot_read_oauth_token'
      )
    }),
    scopeAuthorizer: createPostgresTrackerRepositoryReadScopeAuthorizer(db),
    projector: createPostgresTrackerSnapshotProjector(db)
  });

  return {
    async reconcile(): Promise<void> {
      const workspaceResult = await pool.query(
        `select id from workspaces where id = $1 and slug = 'fai-studio'`,
        [workspaceId]
      );
      const [workspace] = workspaceResult.rows as ReadonlyArray<Readonly<{id: string}>>;
      if (workspace === undefined) {
        return fail({
          code: 'GITHUB_RECONCILIATION_WORKSPACE_UNAVAILABLE',
          project: 'workspace',
          status: 'failed'
        });
      }
      const actorResult = await pool.query(
        `select id from actors
          where workspace_id = $1 and auth_mode = 'user' and external_subject = $2`,
        [workspace.id, bootstrapSubject]
      );
      const [actor] = actorResult.rows as ReadonlyArray<Readonly<{id: string}>>;
      if (actor === undefined) {
        return fail({
          code: 'GITHUB_RECONCILIATION_ACTOR_UNAVAILABLE',
          project: 'workspace',
          status: 'failed'
        });
      }
      const issuer = createActorContextIssuer({
        users: [{
          actorId: actor.id,
          capabilities: [
            'read:repository:development',
            'write:tracker:development',
            'write:control_plane:development'
          ]
        }],
        agents: [],
        systems: []
      });
      const trustedActor = issuer.ok ? issuer.value.issueUser(actor.id) : issuer;
      if (!trustedActor.ok) {
        return fail({
          code: 'GITHUB_RECONCILIATION_ACTOR_INVALID',
          project: 'workspace',
          status: 'failed'
        });
      }
      const scopeResult = await pool.query(
        `select
           p.id as "projectId",
           p.slug as "projectSlug",
           s.repository_owner as "owner",
           s.repository_name as "repository",
           sr.provider as "credentialProvider",
           sr.reference as "credentialReference",
           sr.scope as "credentialScope",
           tb.last_inbound_version as "lastInboundVersion"
         from project_tracker_repository_scopes s
         inner join projects p on p.id = s.project_id
         inner join secret_refs sr on sr.id = s.credential_ref_id
         inner join tracker_bindings tb on
           tb.project_id = p.id and
           tb.provider = 'github' and
           tb.surface = 'repository' and
           tb.entity_type = 'project' and
           tb.entity_id = p.id
         where p.workspace_id = $1 and
           s.provider = 'github' and
           p.slug = any($2::text[]) and
           p.id = any($3::uuid[])`,
        [workspace.id, [...projectSlugs], Object.values(configuredProjectIds)]
      );
      const scopes = scopeResult.rows as ScopeRow[];
      if (
        scopes.length !== projectSlugs.length ||
        new Set(scopes.map(({projectSlug}) => projectSlug)).size !== projectSlugs.length ||
        scopes.some((scope) =>
          (scope.projectSlug !== 'msa' && scope.projectSlug !== 'ascon') ||
          scope.projectId !== configuredProjectIds[scope.projectSlug]
        )
      ) {
        return fail({
          code: 'GITHUB_RECONCILIATION_BINDINGS_UNAVAILABLE',
          project: 'workspace',
          status: 'failed'
        });
      }
      const observationProcessor = createPostgresTrackerStatusObservationProcessor(
        db,
        createCanonicalCommandService({unitOfWork: createPostgresUnitOfWork(db)}),
        trustedActor.value
      );
      const reconcileStatusObservations = async (project: ProjectSlug): Promise<void> => {
        for (let attempted = 0; attempted < maximumObservationsPerSnapshot; attempted += 1) {
          const result = await observationProcessor.processAvailable();
          if (result.status === 'idle') return;
          if (result.status === 'conflict' || result.status === 'retryable') {
            return fail({
              code: result.status === 'conflict'
                ? 'GITHUB_RECONCILIATION_STATUS_CONFLICT'
                : 'GITHUB_RECONCILIATION_STATUS_RETRYABLE',
              project,
              status: result.status
            });
          }
        }
        return fail({
          code: 'GITHUB_RECONCILIATION_STATUS_LIMIT_REACHED',
          project,
          status: 'limit_reached'
        });
      };

      for (const scope of scopes.sort((left, right) => left.projectSlug.localeCompare(right.projectSlug))) {
        const project = scope.projectSlug as ProjectSlug;
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
          mode: 'synchronize',
          expectedPreviousExternalVersion: scope.lastInboundVersion ?? ''
        });
        if (!snapshotSucceeded(result.status)) return fail(failureForSnapshot(project, result));
        console.info('github reconciliation', {
          code: 'GITHUB_RECONCILIATION_SNAPSHOT_COMPLETED',
          project,
          status: result.status
        });
        await reconcileStatusObservations(project);
      }
    }
  };
};

export const githubReconciliationFailure = (error: unknown): ReconciliationFailure =>
  error instanceof GitHubReconciliationError
    ? error.failure
    : {
        code: 'GITHUB_RECONCILIATION_UNAVAILABLE',
        project: 'workspace',
        status: 'failed'
      };
