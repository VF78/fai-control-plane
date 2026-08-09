import {randomUUID} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {
  createActorContextIssuer,
  type AccessObservationPort,
  type CanonicalCommand
} from '@fai-control-plane/domain';
import {
  createAccessObservationService,
  type CanonicalCommandExecution,
  type CanonicalCommandService
} from './index';

const workspaceId = randomUUID();
const projectId = randomUUID();
const actorId = randomUUID();
const issued = createActorContextIssuer({
  users: [{actorId, capabilities: ['write:control_plane:development']}],
  agents: [], systems: []
});
if (!issued.ok) throw new Error('issuer failed');
const actorResult = issued.value.issueUser(actorId);
if (!actorResult.ok) throw new Error('actor failed');

const binding = () => ({
  workspaceId, projectId, grantId: randomUUID(), grantVersion: 3,
  grantActorId: actorId, identityActorId: actorId,
  resourceType: 'repository' as const, identityProvider: 'github',
  resourceId: 'repository-scope-1',
  externalSubject: 'github:user:75837222', identityActive: true,
  repository: {
    scopeId: 'repository-scope-1', owner: 'VF78', repository: 'MSA',
    externalId: 'github:repository:1278325372'
  }
});
const confirmed: AccessObservationPort = {
  provider: 'github',
  observeAccess: async () => ({
    state: 'confirmed', provider: 'github',
    externalResourceRef: 'github:repository:1278325372', confirmedLevel: 'admin',
    observedAt: '2026-08-09T10:00:00.000Z'
  })
};
const execution = (
  status: 'completed' | 'replayed',
  result: unknown = {ok: true, value: {id: 'grant', version: 4}}
): CanonicalCommandExecution => ({
  status,
  receipt: {result}
} as unknown as CanonicalCommandExecution);

describe('access observation application service', () => {
  it.each(['completed', 'replayed'] as const)(
    'applies a confirmed fact through the canonical command (%s)',
    async (status) => {
      const commands = {execute: vi.fn(async (command: CanonicalCommand) => {
        void command;
        return execution(status);
      })};
      const service = createAccessObservationService({
        observer: confirmed, commands,
        now: () => new Date('2026-08-09T10:00:01.000Z'), nextId: () => randomUUID()
      });
      await expect(service.observe({workspaceId, projectId, actor: actorResult.value, binding: binding()}))
        .resolves.toMatchObject({state: 'confirmed', application: status === 'replayed' ? 'replayed' : 'applied'});
      const command = commands.execute.mock.calls[0]?.[0];
      expect(command).toMatchObject({
        workspaceId, type: 'resource_access_grant.observe',
        payload: {expectedVersion: 3, confirmedLevel: 'admin'}
      });
    }
  );

  it('denies a cross-workspace binding before provider read or canonical write', async () => {
    const observer = {provider: 'github', observeAccess: vi.fn(confirmed.observeAccess)};
    const commands: CanonicalCommandService = {execute: vi.fn()};
    const service = createAccessObservationService({observer, commands});
    await expect(service.observe({
      workspaceId, projectId, actor: actorResult.value,
      binding: {...binding(), workspaceId: randomUUID()}
    })).resolves.toMatchObject({state: 'unobserved'});
    expect(observer.observeAccess).not.toHaveBeenCalled();
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['cross-actor identity', {identityActorId: randomUUID()}],
    ['wrong repository scope', {resourceId: randomUUID()}]
  ])('rejects %s before provider read or canonical write', async (_name, mismatch) => {
    const observer = {provider: 'github', observeAccess: vi.fn(confirmed.observeAccess)};
    const commands: CanonicalCommandService = {execute: vi.fn()};
    const service = createAccessObservationService({observer, commands});
    await expect(service.observe({
      workspaceId, projectId, actor: actorResult.value,
      binding: {...binding(), ...mismatch}
    })).resolves.toMatchObject({state: 'unobserved'});
    expect(observer.observeAccess).not.toHaveBeenCalled();
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it.each(['unobserved', 'unsupported', 'unavailable'] as const)(
    'never writes when provider result is %s',
    async (state) => {
      const observer: AccessObservationPort = {
        provider: 'github', observeAccess: async () => ({state, remediation: 'fix binding'})
      };
      const commands: CanonicalCommandService = {execute: vi.fn()};
      const service = createAccessObservationService({observer, commands});
      await expect(service.observe({workspaceId, projectId, actor: actorResult.value, binding: binding()}))
        .resolves.toEqual({state, remediation: 'fix binding'});
      expect(commands.execute).not.toHaveBeenCalled();
    }
  );

  it('converts an adapter failure to unavailable without a canonical write', async () => {
    const observer: AccessObservationPort = {
      provider: 'github',
      observeAccess: async () => { throw new Error('provider failed'); }
    };
    const commands: CanonicalCommandService = {execute: vi.fn()};
    const service = createAccessObservationService({observer, commands});
    await expect(service.observe({workspaceId, projectId, actor: actorResult.value, binding: binding()}))
      .resolves.toMatchObject({state: 'unavailable'});
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('surfaces an optimistic version conflict without retrying a stale write', async () => {
    const commands = {execute: vi.fn(async () => execution('completed', {
      ok: false, error: {code: 'VERSION_CONFLICT', message: 'conflict'}
    }))};
    const service = createAccessObservationService({observer: confirmed, commands});
    await expect(service.observe({workspaceId, projectId, actor: actorResult.value, binding: binding()}))
      .resolves.toMatchObject({state: 'unavailable', remediation: expect.stringContaining('version')});
    expect(commands.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['provider', {provider: 'other'}],
    ['repository', {externalResourceRef: 'github:repository:999'}]
  ])('rejects a confirmed fact with mismatched %s identity', async (_name, mismatch) => {
    const observer: AccessObservationPort = {
      ...confirmed,
      observeAccess: async () => ({
        state: 'confirmed', provider: 'github',
        externalResourceRef: 'github:repository:1278325372', confirmedLevel: 'read',
        observedAt: '2026-08-09T10:00:00.000Z',
        ...mismatch
      })
    };
    const commands: CanonicalCommandService = {execute: vi.fn()};
    const service = createAccessObservationService({observer, commands});
    await expect(service.observe({workspaceId, projectId, actor: actorResult.value, binding: binding()}))
      .resolves.toMatchObject({state: 'unavailable'});
    expect(commands.execute).not.toHaveBeenCalled();
  });
});
