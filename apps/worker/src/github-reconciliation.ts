import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {
  createTrackerRepositorySnapshotReconciliationService,
  createTrackerRepositorySnapshotOrchestrationService
} from '@fai-control-plane/application';
import {
  createPostgresTrackerRepositoryReadScopeAuthorizer,
  createPostgresTrackerSnapshotProjector
} from '@fai-control-plane/db/runtime';
import {
  createActorContextIssuer,
  type OpaqueSecretRef,
  type SecretsProvider
} from '@fai-control-plane/domain';
import {
  createGitHubRepositoryReadAdapter,
  GitHubRepositoryReadError
} from '@fai-control-plane/integrations/runtime';

const projectSlugs = ['msa', 'ascon'] as const;
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
  repositoryExternalId: string;
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

const failureForReconciliation = (
  project: ProjectSlug,
  result: Readonly<{status: string; code?: string}>
): ReconciliationFailure => ({
  code: result.code ?? 'GITHUB_RECONCILIATION_SNAPSHOT_UNAVAILABLE',
  project,
  status: result.status === 'denied'
    ? 'denied'
    : result.status === 'conflict'
      ? 'conflict'
      : result.status === 'retryable'
        ? 'retryable'
        : 'failed'
});

const recordReconciliationFailure = async (
  pool: Queryable,
  input: Readonly<{
    workspaceId: string;
    projectId: string;
    actorId: string;
    repositoryExternalId: string;
    code: string;
  }>
): Promise<void> => {
  const eventId = randomUUID();
  await pool.query(
    `insert into audit_events (
       id, workspace_id, project_id, actor_id, command_id, action_category,
       action, target_type, target_id, outcome, reason_code, correlation_id, occurred_at
     ) values ($1, $2, $3, $4, $5, 'write', 'tracker_snapshot.reconcile',
       'tracker_repository', $6, 'failed', $7, $8, now())`,
    [
      eventId,
      input.workspaceId,
      input.projectId,
      input.actorId,
      `tracker-reconcile-failure:${eventId}`,
      input.repositoryExternalId,
      input.code.toUpperCase(),
      eventId
    ]
  );
};

export type GitHubReconciliationRuntime = Readonly<{
  /** Shared core for both a provider event and the scheduled repair poll. */
  reconcile(projectId?: string): Promise<void>;
}>;
export type AgentRoleRequestPreparer = Readonly<{
  prepareSnapshotDecisions(input: Readonly<{
    workspaceId: string;
    projectId: string;
    actorId: string;
    snapshot: import('@fai-control-plane/domain').TrackerRepositorySnapshot;
    decisions: readonly import('@fai-control-plane/domain').TrackerNextActionDecision[];
  }>): Promise<void>;
}>;

/** Reconciles only pre-seeded, already-bootstrapped GitHub repository bindings. */
export const createGitHubReconciliationRuntime = (
  db: Database,
  pool: Queryable,
  agentRoleRequests?: AgentRoleRequestPreparer
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
  const github = createGitHubRepositoryReadAdapter({
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
  });
  const service = createTrackerRepositorySnapshotReconciliationService({
    snapshots: createTrackerRepositorySnapshotOrchestrationService({
      taskTracker: github,
      repositoryObservation: github,
      scopeAuthorizer: createPostgresTrackerRepositoryReadScopeAuthorizer(db),
      projector: createPostgresTrackerSnapshotProjector(db),
      onRepositoryReadFailure(error) {
        console.warn('github repository read failed', {
          code: error instanceof GitHubRepositoryReadError
            ? error.code
            : 'github_read_unavailable'
        });
      }
    })
  });

  return {
    async reconcile(requestedProjectId?: string): Promise<void> {
      if (requestedProjectId !== undefined && !uuidPattern.test(requestedProjectId)) {
        return fail({
          code: 'GITHUB_RECONCILIATION_PROJECT_INVALID',
          project: 'workspace',
          status: 'failed'
        });
      }
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
           s.repository_external_id as "repositoryExternalId",
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
           p.id = any($3::uuid[]) and
           ($4::uuid is null or p.id = $4::uuid)`,
        [
          workspace.id,
          [...projectSlugs],
          Object.values(configuredProjectIds),
          requestedProjectId ?? null
        ]
      );
      const scopes = scopeResult.rows as ScopeRow[];
      const expectedScopeCount = requestedProjectId === undefined ? projectSlugs.length : 1;
      if (
        scopes.length !== expectedScopeCount ||
        new Set(scopes.map(({projectSlug}) => projectSlug)).size !== expectedScopeCount ||
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
      for (const scope of scopes.sort((left, right) => left.projectSlug.localeCompare(right.projectSlug))) {
        const project = scope.projectSlug as ProjectSlug;
        const result = await service.reconcile({
          actor: trustedActor.value,
          workspaceId: workspace.id,
          projectId: scope.projectId,
          expectedProvider: 'github',
          repository: {owner: scope.owner, repository: scope.repository},
          credentialRef: {
            provider: scope.credentialProvider,
            reference: scope.credentialReference,
            scope: scope.credentialScope
          },
          expectedPreviousExternalVersion: scope.lastInboundVersion ?? ''
        });
        if (result.status !== 'completed') {
          const failure = failureForReconciliation(project, result);
          try {
            await recordReconciliationFailure(pool, {
              workspaceId: workspace.id,
              projectId: scope.projectId,
              actorId: actor.id,
              repositoryExternalId: scope.repositoryExternalId,
              code: failure.code
            });
          } catch {
            console.warn('github reconciliation failure audit unavailable', {
              code: 'GITHUB_RECONCILIATION_FAILURE_AUDIT_UNAVAILABLE',
              project
            });
          }
          return fail(failure);
        }
        const completed = result.result.status === 'replayed' ? result.result.result : result.result;
        await agentRoleRequests?.prepareSnapshotDecisions({
          workspaceId: workspace.id,
          projectId: scope.projectId,
          actorId: actor.id,
          snapshot: completed.snapshot,
          decisions: completed.decisions
        });
        console.info('github reconciliation', {
          code: 'GITHUB_RECONCILIATION_SNAPSHOT_COMPLETED',
          project,
          status: result.result.status
        });
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
