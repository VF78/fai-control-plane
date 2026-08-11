import {expect, it, vi} from 'vitest';
import {environmentAccessCommand} from './environment-access-commands';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const environmentId = '44444444-4444-4444-8444-444444444444';
const credentialId = '55555555-5555-4555-8555-555555555555';
const reconcilerActorId = '88888888-8888-4888-8888-888888888888';
const authorization = {ok: true as const, session: {actorId, csrfToken: 'csrf'},
  runtime: {config: {workspaceId}}, sessionToken: 'session'};
const request = (values: Record<string, string>) => new Request('https://app.example/api/access/environments', {
  method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded',
    referer: 'https://app.example/projects/msa/access'}, body: new URLSearchParams(values)
});
const deps = (runtime: Record<string, unknown>) => ({
  requireSession: vi.fn().mockResolvedValue(authorization) as never,
  getRuntime: vi.fn().mockResolvedValue(runtime) as never
});

it('submits bounded environment configuration without credential material', async () => {
  const setProjectEnvironment = vi.fn().mockResolvedValue('updated');
  const result = await environmentAccessCommand(request({_csrf: 'csrf', action: 'configure',
    environmentId, projectId, kind: 'development', provider: 'ssh', endpoint: 'dev.internal',
    port: '22', purpose: 'Разработка', adapterKey: 'ssh', adapterCredentialRefId: credentialId,
    reconcilerActorId,
    enabled: 'true', expectedVersion: '2'}), deps({setProjectEnvironment}));
  expect(result.status).toBe(303);
  expect(setProjectEnvironment).toHaveBeenCalledWith({workspaceId, operatorActorId: actorId,
    environmentId, projectId, kind: 'development', provider: 'ssh', endpoint: 'dev.internal',
    port: 22, purpose: 'Разработка', adapterKey: 'ssh', adapterCredentialRefId: credentialId,
    reconcilerActorId,
    enabled: true, expectedVersion: 2});
});

it('routes production request and exact grant as separate commands', async () => {
  const requestEnvironmentAccess = vi.fn().mockResolvedValue('updated');
  const requested = await environmentAccessCommand(request({_csrf: 'csrf', action: 'request', projectId,
    subjectActorId: actorId, environmentId, credentialRefId: credentialId,
    expiresAt: '2026-08-20T12:00'}), deps({requestEnvironmentAccess}));
  expect(requested.status).toBe(303);
  expect(requestEnvironmentAccess).toHaveBeenCalledWith(expect.objectContaining({
    workspaceId, operatorActorId: actorId, projectId, subjectActorId: actorId,
    environmentId, credentialRefId: credentialId, expiresAt: expect.stringMatching(/Z$/)
  }));

  const setEnvironmentAccess = vi.fn().mockResolvedValue('updated');
  const grantId = '66666666-6666-4666-8666-666666666666';
  const approvalId = '77777777-7777-4777-8777-777777777777';
  const granted = await environmentAccessCommand(request({_csrf: 'csrf', action: 'grant', grantId,
    projectId, subjectActorId: actorId, environmentId, credentialRefId: credentialId,
    approvalRequestId: approvalId, expiresAt: '2026-08-20T12:00', desiredLevel: 'write', expectedVersion: ''}),
  deps({setEnvironmentAccess}));
  expect(granted.status).toBe(303);
  expect(setEnvironmentAccess).toHaveBeenCalledWith(expect.objectContaining({grantId,
    approvalRequestId: approvalId, desiredLevel: 'write', expectedVersion: null}));
});

it('fails closed for extra fields and missing session/CSRF', async () => {
  const invalid = await environmentAccessCommand(request({_csrf: 'csrf', action: 'request', projectId,
    subjectActorId: actorId, environmentId, credentialRefId: credentialId,
    expiresAt: '2026-08-20T12:00', extra: 'x'}), deps({requestEnvironmentAccess: vi.fn()}));
  expect(invalid.status).toBe(400);
  const deniedSession = vi.fn().mockResolvedValue({ok: false, response: new Response(null, {status: 403})});
  const denied = await environmentAccessCommand(request({_csrf: '', action: 'request'}), {
    requireSession: deniedSession as never, getRuntime: vi.fn() as never
  });
  expect(denied.status).toBe(403);
});
