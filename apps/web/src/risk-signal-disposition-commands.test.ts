import {expect, it} from 'vitest';
import type {EnabledAuthConfig} from './operator-auth';
import {
  riskSignalDispositionCommand,
  type RiskSignalDispositionCommandDependencies
} from './risk-signal-disposition-commands';

it('requires authenticated CSRF, validates bounded disposition input, and maps safe command results', async () => {
  const now = new Date('2026-07-30T12:00:00.000Z');
  const ids = {
    workspace: '00000000-0000-4000-8000-000000000001',
    project: '00000000-0000-4000-8000-000000000002',
    signal: '00000000-0000-4000-8000-000000000003',
    actor: '00000000-0000-4000-8000-000000000004',
    command: '00000000-0000-4000-8000-000000000005'
  };
  const csrfToken = 'csrf-token-0123456789';
  const config: EnabledAuthConfig = {
    enabled: true,
    workspaceId: ids.workspace,
    clientId: 'githubclient123',
    clientSecret: 'not-used',
    sessionSecret: Buffer.alloc(32, 1),
    publicBaseUrl: new URL('https://control.example'),
    callbackUrl: 'https://control.example/oauth/github/complete',
    allowedUserIds: new Set([123]),
    secureCookies: true
  };
  const executed: unknown[] = [];
  let result: unknown = {
    status: 'applied',
    disposition: {
      riskSignalId: ids.signal,
      kind: 'acknowledged',
      reason: 'investigating',
      expiresAt: new Date('2026-07-31T12:00:00.000Z'),
      reentryCondition: 'risk_unresolved_at_expiry',
      version: 1,
      actorId: ids.actor,
      occurredAt: now
    }
  };
  const dependencies: RiskSignalDispositionCommandDependencies = {
    now: () => now,
    nextId: () => '00000000-0000-4000-8000-000000000006',
    requireSession: async (request, options) => {
      if (request.headers.get('x-test-auth') !== 'operator') {
        return {ok: false, response: new Response(null, {status: 401})};
      }
      if (options?.csrfToken !== csrfToken) {
        return {ok: false, response: new Response(null, {status: 403})};
      }
      return {
        ok: true,
        session: {
          actorId: ids.actor,
          displayName: 'Operator',
          githubUserId: 123,
          expiresAt: new Date('2026-07-31T18:00:00.000Z'),
          csrfToken
        },
        runtime: {config, service: {} as never},
        sessionToken: 'session'
      };
    },
    getRuntime: async () => ({
      execute: async (input: unknown) => {
        executed.push(input);
        return result;
      }
    }) as never
  };
  const request = (
    authenticated: boolean,
    overrides: Record<string, unknown> = {}
  ) => new Request('https://control.example/api/risk-signals/x/disposition', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? {'x-test-auth': 'operator'} : {})
    },
    body: JSON.stringify({
      _csrf: csrfToken,
      action: 'acknowledged',
      commandId: ids.command,
      expectedVersion: 0,
      expiresAt: '2026-07-31T12:00:00.000Z',
      projectId: ids.project,
      reason: 'investigating',
      ...overrides
    })
  });

  expect((await riskSignalDispositionCommand(
    request(false),
    ids.signal,
    dependencies
  )).status).toBe(401);
  expect((await riskSignalDispositionCommand(
    request(true, {_csrf: 'wrong'}),
    ids.signal,
    dependencies
  )).status).toBe(403);
  expect((await riskSignalDispositionCommand(
    request(true, {reason: 'free-form secret'}),
    ids.signal,
    dependencies
  )).status).toBe(400);
  expect((await riskSignalDispositionCommand(
    request(true, {expiresAt: '2026-09-01T12:00:00.000Z'}),
    ids.signal,
    dependencies
  )).status).toBe(400);

  const applied = await riskSignalDispositionCommand(
    request(true),
    ids.signal,
    dependencies
  );
  expect(applied.status).toBe(200);
  await expect(applied.json()).resolves.toEqual({
    status: 'applied',
    disposition: {
      kind: 'acknowledged',
      expiresAt: '2026-07-31T12:00:00.000Z',
      reentryCondition: 'risk_unresolved_at_expiry',
      version: 1
    }
  });
  expect(executed).toEqual([expect.objectContaining({
    workspaceId: ids.workspace,
    projectId: ids.project,
    riskSignalId: ids.signal,
    actorId: ids.actor,
    commandId: ids.command,
    reason: 'investigating',
    expectedVersion: 0
  })]);
  expect(JSON.stringify(executed)).not.toContain('clientSecret');

  result = {status: 'conflict'};
  expect((await riskSignalDispositionCommand(
    request(true),
    ids.signal,
    dependencies
  )).status).toBe(409);
  result = {status: 'not_found'};
  expect((await riskSignalDispositionCommand(
    request(true),
    ids.signal,
    dependencies
  )).status).toBe(404);
  result = {status: 'forbidden'};
  expect((await riskSignalDispositionCommand(
    request(true),
    ids.signal,
    dependencies
  )).status).toBe(403);
});
