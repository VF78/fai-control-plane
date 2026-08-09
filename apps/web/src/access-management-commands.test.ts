import {expect, it, vi} from 'vitest';
import {onboardActorCommand, setDesiredAccessCommand, setMembershipCommand} from './access-management-commands';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const targetId = '33333333-3333-4333-8333-333333333333';
const authorization = {
  ok: true as const,
  session: {actorId, csrfToken: 'csrf'},
  runtime: {config: {workspaceId}},
  sessionToken: 'session'
};
const request = (path: string, values: Record<string, string>) => new Request(`https://app.example${path}`, {
  method: 'POST',
  headers: {'content-type': 'application/x-www-form-urlencoded', referer: 'https://app.example/projects/msa/access'},
  body: new URLSearchParams(values)
});

it('submits only a bounded canonical membership intent', async () => {
  const setMembership = vi.fn().mockResolvedValue('updated');
  const response = await setMembershipCommand(request(`/api/access/memberships/${targetId}`, {
    _csrf: 'csrf', expectedVersion: '2', role: 'contributor', active: 'true'
  }), targetId, {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({setMembership})
  });
  expect(response.status).toBe(303);
  expect(setMembership).toHaveBeenCalledWith({
    workspaceId, operatorActorId: actorId, membershipId: targetId,
    expectedVersion: 2, role: 'contributor', active: true
  });
});

it('submits desired access without claiming provider confirmation', async () => {
  const setDesiredAccess = vi.fn().mockResolvedValue('updated');
  const response = await setDesiredAccessCommand(request(`/api/access/grants/${targetId}`, {
    _csrf: 'csrf', expectedVersion: '3', desiredLevel: 'write'
  }), targetId, {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({setDesiredAccess})
  });
  expect(response.status).toBe(303);
  expect(setDesiredAccess).toHaveBeenCalledWith({
    workspaceId, operatorActorId: actorId, grantId: targetId,
    expectedVersion: 3, desiredLevel: 'write'
  });
});

it('fails closed for extra fields, stale versions, and missing CSRF', async () => {
  const requireSession = vi.fn().mockResolvedValue(authorization) as never;
  const malformed = await setMembershipCommand(request('/api/access/memberships/x', {
    _csrf: 'csrf', expectedVersion: '2', role: 'contributor', active: 'true', extra: 'x'
  }), targetId, {requireSession, getRuntime: vi.fn()});
  expect(malformed.status).toBe(400);

  const stale = await setDesiredAccessCommand(request(`/api/access/grants/${targetId}`, {
    _csrf: 'csrf', expectedVersion: '3', desiredLevel: 'read'
  }), targetId, {
    requireSession,
    getRuntime: vi.fn().mockResolvedValue({setDesiredAccess: vi.fn().mockResolvedValue('stale')})
  });
  expect(stale.status).toBe(409);

  const deniedSession = vi.fn().mockResolvedValue({ok: false, response: new Response(null, {status: 403})});
  const denied = await setDesiredAccessCommand(request(`/api/access/grants/${targetId}`, {
    _csrf: '', expectedVersion: '3', desiredLevel: 'read'
  }), targetId, {requireSession: deniedSession as never, getRuntime: vi.fn()});
  expect(denied.status).toBe(403);
  expect(deniedSession).toHaveBeenCalledWith(expect.any(Request), {csrfToken: ''});
});

it('submits bounded human and agent onboarding without provider config or secrets', async () => {
  const onboardActor = vi.fn().mockResolvedValue('updated');
  const deps = {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({onboardActor})
  };
  const human = await onboardActorCommand(request('/api/access/onboarding', {
    _csrf: 'csrf', idempotencyKey: targetId, projectId: targetId, actorType: 'human',
    displayName: 'Мария', actorRole: 'developer', membershipRole: 'contributor'
  }), deps);
  expect(human.status).toBe(303);
  expect(onboardActor).toHaveBeenCalledWith(expect.objectContaining({
    workspaceId, operatorActorId: actorId, actorType: 'human', displayName: 'Мария',
    actorRole: 'developer', membershipRole: 'contributor'
  }));

  const agent = await onboardActorCommand(request('/api/access/onboarding', {
    _csrf: 'csrf', idempotencyKey: actorId, projectId: targetId, actorType: 'agent',
    displayName: 'Codex QA', runtimeId: 'codex', runtimeProfile: 'read_safe', runtimeKey: 'codex-qa'
  }), deps);
  expect(agent.status).toBe(303);
  expect(onboardActor).toHaveBeenLastCalledWith(expect.objectContaining({
    actorType: 'agent', actorRole: 'agent_operator', membershipRole: 'agent', runtimeId: 'codex'
  }));

  const secret = await onboardActorCommand(request('/api/access/onboarding', {
    _csrf: 'csrf', idempotencyKey: actorId, projectId: targetId, actorType: 'agent',
    displayName: 'Codex QA', runtimeId: 'codex', runtimeProfile: 'read_safe', runtimeKey: 'token=ghp_abcdefghijklmnopqrstuvwxyz'
  }), deps);
  expect(secret.status).toBe(400);
  expect(onboardActor).toHaveBeenCalledTimes(2);
});
