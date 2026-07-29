import {randomUUID} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {
  createActorContextIssuer,
  type OpaqueSecretRef,
  type RepositoryObservationPort,
  type TaskTrackerPort,
  type TrackerAdapter,
  type TrackerRepositorySnapshot,
  type TrackerRepositoryReadScopeAuthorizer,
  type TrackerSnapshotProjector
} from '@fai-control-plane/domain';
import {
  createTrackerRepositorySnapshotReconciliationService,
  createTrackerRepositorySnapshotOrchestrationService
} from './index';

const id = (): string => randomUUID();
const credentialRef: OpaqueSecretRef = {
  provider: 'test-secrets', reference: 'tracker/read', scope: ['repository:read']
};
const snapshot: TrackerRepositorySnapshot = {
  repository: {
    externalId: 'provider:repository:1', externalVersion: 'provider:repository:v1',
    owner: 'owner', name: 'repository', defaultBranch: 'main', headSha: 'a'.repeat(40)
  },
  externalVersion: 'provider:snapshot:v1', workItems: [], pullRequests: [], checks: []
};
const workItem = () => ({
  externalId: 'provider:issue:1', externalVersion: 'provider:issue:v1',
  url: 'https://provider.test/issues/1', htmlUrl: 'https://provider.test/issues/1',
  number: 1, title: 'Issue', state: 'open' as const,
  labels: [{externalId: 'provider:label:1', name: 'bug', color: 'd73a4a'}],
  assignees: [{externalId: 'provider:user:1', login: 'maintainer'}], milestone: null,
  projectStatus: null
});
const pullRequest = () => ({
  externalId: 'provider:pr:1', externalVersion: 'provider:pr:v1',
  url: 'https://provider.test/pulls/1', htmlUrl: 'https://provider.test/pulls/1',
  number: 1, title: 'Pull request', state: 'open' as const, draft: false, merged: false,
  headRef: 'feature', headSha: 'a'.repeat(40), baseRef: 'main', labels: [],
  assignees: [{externalId: 'provider:user:1', login: 'maintainer'}], milestone: null,
  linkedWorkItemExternalIds: []
});
const check = () => ({
  externalId: 'provider:check:1', externalVersion: 'provider:check:v1',
  pullRequestExternalId: 'provider:pr:1', name: 'CI', status: 'completed' as const,
  conclusion: 'success' as const, detailsUrl: 'https://provider.test/checks/1'
});
const applied = {
  status: 'applied' as const,
  snapshotExternalVersion: snapshot.externalVersion,
  createdWorkItems: 0,
  updatedWorkItems: 0,
  updatedWorkItemStatuses: 0,
  projectedPullRequests: 0,
  projectedChecks: 0,
  unknownWorkItemExternalIds: [],
  unknownProjectStatusWorkItemExternalIds: [],
  unmappablePullRequestExternalIds: [],
  ambiguousPullRequestExternalIds: [],
  unknownCheckExternalIds: []
};

const actorFor = (capabilities: readonly string[]) => {
  const actorId = id();
  const issuer = createActorContextIssuer({
    users: [{actorId, capabilities: capabilities as never}], agents: [], systems: []
  });
  if (!issuer.ok) throw new Error('Test issuer did not initialize.');
  const actor = issuer.value.issueUser(actorId);
  if (!actor.ok) throw new Error('Test actor did not initialize.');
  return actor.value;
};

const authorizedActor = () => actorFor([
  'read:repository:development', 'write:tracker:development'
]);

const input = (overrides: Record<string, unknown> = {}) => ({
  actor: authorizedActor(),
  workspaceId: id(),
  projectId: id(),
  operationId: id(),
  correlationId: id(),
  expectedProvider: 'test-tracker',
  repository: {owner: 'owner', repository: 'repository'},
  credentialRef,
  mode: 'bootstrap' as const,
  ...overrides
});

const reconciliationInput = (overrides: Record<string, unknown> = {}) => {
  const request = input({
    mode: 'synchronize',
    expectedPreviousExternalVersion: 'provider:snapshot:v0',
    ...overrides
  });
  const {operationId: _operationId, correlationId: _correlationId, mode: _mode, ...result} = request;
  return result;
};

const fakes = () => {
  const calls: string[] = [];
  const reader = vi.fn(async () => {
    calls.push('read');
    return snapshot;
  });
  const authorizeScope = vi.fn<TrackerRepositoryReadScopeAuthorizer['authorize']>(async () => {
    calls.push('scope');
    return {status: 'authorized' as const, repositoryExternalId: snapshot.repository.externalId};
  });
  const bootstrap = vi.fn(async () => {
    calls.push('bootstrap');
    return applied;
  });
  const synchronize = vi.fn(async () => {
    calls.push('synchronize');
    return applied;
  });
  const adapter: TrackerAdapter = {
    provider: 'test-tracker',
    capabilities: {
      readWorkItems: true, writeWorkItems: false, readPullRequests: true, readChecks: true
    },
    readRepositorySnapshot: reader
  };
  const projector: TrackerSnapshotProjector = {bootstrap, synchronize};
  const scopeAuthorizer: TrackerRepositoryReadScopeAuthorizer = {authorize: authorizeScope};
  return {calls, reader, authorizeScope, bootstrap, synchronize, adapter, projector, scopeAuthorizer};
};

describe('tracker repository snapshot orchestration', () => {
  it('reconciles a provider-neutral contract double with a fenced checkpoint', async () => {
    const orchestrate = vi.fn(async () => applied);
    const service = createTrackerRepositorySnapshotReconciliationService({
      snapshots: {orchestrate},
      idGenerator: {
        next: vi.fn().mockReturnValueOnce('operation-1').mockReturnValueOnce('correlation-1')
      }
    });

    await expect(service.reconcile(reconciliationInput())).resolves.toEqual({
      status: 'completed', result: applied
    });
    expect(orchestrate).toHaveBeenCalledWith(expect.objectContaining({
      expectedProvider: 'test-tracker',
      expectedPreviousExternalVersion: 'provider:snapshot:v0',
      operationId: 'operation-1',
      correlationId: 'correlation-1',
      mode: 'synchronize'
    }));
  });

  it('makes provider read outages retryable but preserves explicit conflicts', async () => {
    const snapshots = {orchestrate: vi.fn()};
    const service = createTrackerRepositorySnapshotReconciliationService({
      snapshots,
      idGenerator: {next: id}
    });
    snapshots.orchestrate.mockResolvedValueOnce({
      status: 'failed', code: 'repository_read_failed'
    });
    await expect(service.reconcile(reconciliationInput())).resolves.toEqual({
      status: 'retryable', code: 'repository_read_failed'
    });
    snapshots.orchestrate.mockResolvedValueOnce({
      status: 'conflict', code: 'stale_snapshot', currentExternalVersion: 'provider:snapshot:v1'
    });
    await expect(service.reconcile(reconciliationInput())).resolves.toEqual({
      status: 'conflict', code: 'stale_snapshot', currentExternalVersion: 'provider:snapshot:v1'
    });
    snapshots.orchestrate.mockResolvedValueOnce({
      status: 'replayed',
      result: {
        status: 'conflict', code: 'stale_snapshot', currentExternalVersion: 'provider:snapshot:v1'
      }
    });
    await expect(service.reconcile(reconciliationInput())).resolves.toEqual({
      status: 'conflict', code: 'stale_snapshot', currentExternalVersion: 'provider:snapshot:v1'
    });
  });

  it('denies an unauthorized actor before reading', async () => {
    const fake = fakes();
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);

    await expect(service.orchestrate(input({
      actor: actorFor(['write:tracker:development'])
    }))).resolves.toEqual({status: 'denied', code: 'CAPABILITY_DENIED'});
    expect(fake.calls).toEqual([]);
  });

  it('denies a read-only actor missing tracker write before scope authorization', async () => {
    const fake = fakes();
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);

    await expect(service.orchestrate(input({
      actor: actorFor(['read:repository:development'])
    }))).resolves.toEqual({status: 'denied', code: 'CAPABILITY_DENIED'});
    expect(fake.calls).toEqual([]);
  });

  it('denies a forged actor before scope authorization', async () => {
    const fake = fakes();
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);

    await expect(service.orchestrate(input({
      actor: {
        kind: 'trusted_user', actorId: id(), actorType: 'human',
        capabilities: ['read:repository:development', 'write:tracker:development']
      }
    }))).resolves.toEqual({status: 'denied', code: 'INVALID_ACTOR_CONTEXT'});
    expect(fake.calls).toEqual([]);
  });

  it('rejects invalid mode-specific input before reading', async () => {
    const fake = fakes();
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);

    await expect(service.orchestrate(input({workspaceId: 'not valid'}))).resolves.toEqual({
      status: 'failed', code: 'invalid_input'
    });
    await expect(service.orchestrate(input({
      mode: 'synchronize', expectedPreviousExternalVersion: 'provider:v1', pullRequestBindings: []
    }))).resolves.toEqual({status: 'failed', code: 'invalid_input'});
    expect(fake.calls).toEqual([]);
  });

  it('fails closed for missing reader capabilities before reading', async () => {
    const fake = fakes();
    fake.adapter = {
      ...fake.adapter,
      capabilities: {...fake.adapter.capabilities, readChecks: false}
    };
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);

    await expect(service.orchestrate(input())).resolves.toEqual({
      status: 'failed', code: 'adapter_capability_unavailable'
    });
    expect(fake.calls).toEqual(['scope']);
  });

  it('checks the provider and projects a bootstrap snapshot exactly once', async () => {
    const fake = fakes();
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);
    const request = input();

    await expect(service.orchestrate(request)).resolves.toEqual(applied);
    expect(fake.calls).toEqual(['scope', 'read', 'bootstrap']);
    expect(fake.reader).toHaveBeenCalledTimes(1);
    expect(fake.reader).toHaveBeenCalledWith({
      repository: request.repository, credentialRef: request.credentialRef
    });
    expect(fake.bootstrap).toHaveBeenCalledTimes(1);
    expect(fake.bootstrap).toHaveBeenCalledWith(expect.objectContaining({
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      actorId: request.actor.actorId,
      correlationId: request.correlationId,
      provider: request.expectedProvider,
      snapshot
    }));
    expect(fake.synchronize).not.toHaveBeenCalled();
  });

  it('composes separate task-tracker and repository-observation ports', async () => {
    const fake = fakes();
    const readWorkItems = vi.fn<TaskTrackerPort['readWorkItems']>(async () => ({
      externalVersion: 'jira-like:work-items:v1',
      workItems: snapshot.workItems
    }));
    const readRepositoryObservation = vi.fn<RepositoryObservationPort['readRepositoryObservation']>(
      async () => ({
        repository: snapshot.repository,
        externalVersion: 'git-host:repository:v1',
        pullRequests: snapshot.pullRequests,
        checks: snapshot.checks
      })
    );
    const service = createTrackerRepositorySnapshotOrchestrationService({
      taskTracker: {
        provider: 'jira-like',
        capabilities: {readWorkItems: true, writeWorkItems: false},
        readWorkItems
      },
      repositoryObservation: {
        provider: 'test-tracker',
        capabilities: {readPullRequests: true, readChecks: true},
        readRepositoryObservation
      },
      projector: fake.projector,
      scopeAuthorizer: fake.scopeAuthorizer
    });

    await expect(service.orchestrate(input())).resolves.toEqual(applied);
    expect(readWorkItems).toHaveBeenCalledTimes(1);
    expect(readRepositoryObservation).toHaveBeenCalledTimes(1);
    expect(fake.bootstrap).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'test-tracker',
      snapshot: expect.objectContaining({
        workItems: snapshot.workItems,
        repository: snapshot.repository,
        externalVersion: expect.stringMatching(/^composed:sha256:/)
      })
    }));
  });

  it('projects a synchronization snapshot exactly once with its expected version', async () => {
    const fake = fakes();
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);
    const request = input({
      mode: 'synchronize',
      expectedPreviousExternalVersion: 'provider:snapshot:v0'
    });

    await expect(service.orchestrate(request)).resolves.toEqual(applied);
    expect(fake.calls).toEqual(['scope', 'read', 'synchronize']);
    expect(fake.reader).toHaveBeenCalledTimes(1);
    expect(fake.synchronize).toHaveBeenCalledWith(expect.objectContaining({
      expectedPreviousExternalVersion: 'provider:snapshot:v0',
      provider: 'test-tracker', snapshot
    }));
    expect(fake.bootstrap).not.toHaveBeenCalled();
  });

  it('sanitizes adapter and projector failures without duplicate calls', async () => {
    const readerFailure = fakes();
    readerFailure.reader.mockRejectedValueOnce(new Error('credential=secret-value'));
    const readerService = createTrackerRepositorySnapshotOrchestrationService(readerFailure);
    await expect(readerService.orchestrate(input())).resolves.toEqual({
      status: 'failed', code: 'repository_read_failed'
    });
    expect(readerFailure.reader).toHaveBeenCalledTimes(1);
    expect(readerFailure.bootstrap).not.toHaveBeenCalled();

    const projectorFailure = fakes();
    projectorFailure.bootstrap.mockRejectedValueOnce(new Error('provider body: sensitive'));
    const projectorService = createTrackerRepositorySnapshotOrchestrationService(projectorFailure);
    await expect(projectorService.orchestrate(input())).resolves.toEqual({
      status: 'failed', code: 'snapshot_projection_failed'
    });
    expect(projectorFailure.reader).toHaveBeenCalledTimes(1);
    expect(projectorFailure.bootstrap).toHaveBeenCalledTimes(1);
    expect(projectorFailure.synchronize).not.toHaveBeenCalled();
  });

  it('does not read when the adapter provider differs from the requested provider', async () => {
    const fake = fakes();
    fake.adapter = {...fake.adapter, provider: 'other-tracker'};
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);

    await expect(service.orchestrate(input())).resolves.toEqual({
      status: 'failed', code: 'adapter_provider_mismatch'
    });
    expect(fake.calls).toEqual(['scope']);
  });

  it('denies an unconfigured cross-workspace scope before reading', async () => {
    const fake = fakes();
    fake.authorizeScope.mockResolvedValueOnce({status: 'denied'});
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);
    const request = input({workspaceId: id(), projectId: id()});

    await expect(service.orchestrate(request)).resolves.toEqual({
      status: 'denied', code: 'POLICY_DENIED'
    });
    expect(fake.authorizeScope).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: request.workspaceId, projectId: request.projectId
    }));
    expect(fake.reader).not.toHaveBeenCalled();
  });

  it('sanitizes scope authorization failures before reading', async () => {
    const fake = fakes();
    fake.authorizeScope.mockRejectedValueOnce(new Error('database connection details'));
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);

    await expect(service.orchestrate(input())).resolves.toEqual({
      status: 'failed', code: 'repository_scope_authorization_failed'
    });
    expect(fake.calls).toEqual([]);
    expect(fake.reader).not.toHaveBeenCalled();
  });

  it('rejects a mismatched reader snapshot before projection', async () => {
    const fake = fakes();
    fake.reader.mockResolvedValueOnce({
      ...snapshot,
      repository: {...snapshot.repository, name: 'other-repository'}
    });
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);

    await expect(service.orchestrate(input())).resolves.toEqual({
      status: 'failed', code: 'invalid_repository_snapshot'
    });
    expect(fake.authorizeScope).toHaveBeenCalledTimes(1);
    expect(fake.reader).toHaveBeenCalledTimes(1);
    expect(fake.bootstrap).not.toHaveBeenCalled();
  });

  it.each([
    ['a work item with malformed nested labels', {
      ...snapshot,
      workItems: [{...workItem(), labels: [{
        ...workItem().labels[0], unsupported: true
      }]}]
    }],
    ['a pull request with duplicate assignees', {
      ...snapshot,
      pullRequests: [{...pullRequest(), assignees: [
        pullRequest().assignees[0], pullRequest().assignees[0]
      ]}]
    }],
    ['a pull request with malformed milestone state', {
      ...snapshot,
      pullRequests: [{...pullRequest(), milestone: {
        externalId: 'provider:milestone:1', number: 1, title: 'Milestone', state: 'unknown'
      }}]
    }],
    ['a check with an invalid enum', {
      ...snapshot,
      checks: [{...check(), status: 'unknown'}]
    }]
  ])('rejects %s before projection', async (_name, malformedSnapshot) => {
    const fake = fakes();
    fake.reader.mockResolvedValueOnce(malformedSnapshot as never);
    const service = createTrackerRepositorySnapshotOrchestrationService(fake);

    await expect(service.orchestrate(input())).resolves.toEqual({
      status: 'failed', code: 'invalid_repository_snapshot'
    });
    expect(fake.reader).toHaveBeenCalledTimes(1);
    expect(fake.bootstrap).not.toHaveBeenCalled();
    expect(fake.synchronize).not.toHaveBeenCalled();
  });
});
