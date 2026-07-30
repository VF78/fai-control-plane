import {expect, it, vi} from 'vitest';
import {runtimeRegistrationStateCommand} from './runtime-registration-commands';

const registrationId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const actorId = '44444444-4444-4444-8444-444444444444';
const request = (body: unknown) => new Request(
  `https://app.example/api/runtime-registrations/${registrationId}/state`,
  {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body)
  }
);
const authorization = {
  ok: true as const,
  session: {actorId, csrfToken: 'csrf'},
  runtime: {config: {workspaceId: '55555555-5555-4555-8555-555555555555'}},
  sessionToken: 'session'
};
const body = {
  _csrf: 'csrf',
  action: 'disable',
  agentId,
  expectedVersion: 3,
  projectId
};

it('returns the canonical receipt only after a governed registration mutation', async () => {
  const setEnabled = vi.fn().mockResolvedValue({
    status: 'updated',
    commandId: '66666666-6666-4666-8666-666666666666',
    commandType: 'runtime_registration.disable',
    enabled: false,
    version: 4
  });
  const response = await runtimeRegistrationStateCommand(request(body), registrationId, {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({setEnabled})
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    status: 'updated',
    registration: {enabled: false, version: 4},
    receipt: {commandType: 'runtime_registration.disable'}
  });
  expect(setEnabled).toHaveBeenCalledWith(expect.objectContaining({
    operatorActorId: actorId,
    registrationId,
    expectedProjectId: projectId,
    expectedAgentId: agentId,
    expectedVersion: 3,
    enabled: false
  }));
});

it('maps manual recovery to the exact expired run transition and returns its receipt', async () => {
  const agentProfileId = '77777777-7777-4777-8777-777777777777';
  const runId = '88888888-8888-4888-8888-888888888888';
  const recoverExpiredRun = vi.fn().mockResolvedValue({
    status: 'updated',
    commandId: '99999999-9999-4999-8999-999999999999',
    commandType: 'agent_run.transition',
    failureCode: 'operator_recovered_expired_lease',
    version: 4
  });
  const response = await runtimeRegistrationStateCommand(request({
    ...body,
    action: 'recover',
    agentProfileId,
    expectedRunVersion: 3,
    runId
  }), registrationId, {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({recoverExpiredRun})
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    status: 'updated',
    run: {failureCode: 'operator_recovered_expired_lease', version: 4},
    receipt: {commandType: 'agent_run.transition'}
  });
  expect(recoverExpiredRun).toHaveBeenCalledWith(expect.objectContaining({
    operatorActorId: actorId,
    registrationId,
    expectedProjectId: projectId,
    expectedAgentId: agentId,
    expectedRegistrationVersion: 3,
    expectedAgentProfileId: agentProfileId,
    agentRunId: runId,
    expectedRunVersion: 3
  }));
});

it('maps replacement to one exact canonical switch and returns its receipt', async () => {
  const targetRegistrationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const replace = vi.fn().mockResolvedValue({
    status: 'updated',
    commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    commandType: 'runtime_registration.replace',
    source: {enabled: false, version: 4},
    target: {enabled: true, version: 6}
  });
  const response = await runtimeRegistrationStateCommand(request({
    _csrf: 'csrf',
    action: 'replace',
    expectedVersion: 3,
    projectId,
    targetExpectedVersion: 5,
    targetRegistrationId
  }), registrationId, {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({replace})
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    status: 'updated',
    replacement: {
      source: {enabled: false, version: 4},
      target: {enabled: true, version: 6}
    },
    receipt: {commandType: 'runtime_registration.replace'}
  });
  expect(replace).toHaveBeenCalledWith(expect.objectContaining({
    operatorActorId: actorId,
    projectId,
    sourceRegistrationId: registrationId,
    sourceExpectedVersion: 3,
    targetRegistrationId,
    targetExpectedVersion: 5
  }));
});

it('fails closed for malformed, cross-scope, unauthorized, and stale requests', async () => {
  const requireSession = vi.fn().mockResolvedValue(authorization) as never;
  const getRuntime = (status: string) => vi.fn().mockResolvedValue({
    setEnabled: vi.fn().mockResolvedValue({status})
  });

  const malformed = await runtimeRegistrationStateCommand(request({...body, extra: true}), registrationId, {
    requireSession,
    getRuntime: getRuntime('updated')
  });
  expect(malformed.status).toBe(400);

  const crossScope = await runtimeRegistrationStateCommand(request(body), registrationId, {
    requireSession,
    getRuntime: getRuntime('not_found')
  });
  expect(crossScope.status).toBe(404);

  const unauthorized = await runtimeRegistrationStateCommand(request(body), registrationId, {
    requireSession,
    getRuntime: getRuntime('forbidden')
  });
  expect(unauthorized.status).toBe(403);

  const stale = await runtimeRegistrationStateCommand(request(body), registrationId, {
    requireSession,
    getRuntime: getRuntime('stale')
  });
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({
    message: 'Registration changed. Refresh and retry.'
  });
});

it('passes the CSRF token to authenticated session validation', async () => {
  const requireSession = vi.fn().mockResolvedValue({
    ok: false,
    response: new Response(null, {status: 403})
  });
  const response = await runtimeRegistrationStateCommand(request(body), registrationId, {
    requireSession: requireSession as never,
    getRuntime: vi.fn()
  });
  expect(response.status).toBe(403);
  expect(requireSession).toHaveBeenCalledWith(expect.any(Request), {csrfToken: 'csrf'});
});
