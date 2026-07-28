import {afterEach, expect, it} from 'vitest';
import type {EnabledAuthConfig} from '../../../src/operator-auth';
import {
  createProjectShareCommand,
  revokeProjectShareCommand,
  type ProjectShareCommandDependencies
} from '../../../src/project-share-commands';

const previousSharingEnabled = process.env.PUBLIC_SHARING_ENABLED;

afterEach(() => {
  if (previousSharingEnabled === undefined) {
    delete process.env.PUBLIC_SHARING_ENABLED;
  } else {
    process.env.PUBLIC_SHARING_ENABLED = previousSharingEnabled;
  }
});

it('enforces operator CSRF and returns a one-time configured-origin URL without persisting it', async () => {
  const now = new Date('2026-07-27T10:00:00.000Z');
  const csrfToken = 'csrf-token-0123456789';
  const actorId = '00000000-0000-4000-8000-000000000001';
  const workspaceId = '00000000-0000-4000-8000-000000000002';
  const projectId = '00000000-0000-4000-8000-000000000003';
  const workItemId = '00000000-0000-4000-8000-000000000004';
  const shareId = '00000000-0000-4000-8000-000000000005';
  const plaintextToken = 's'.repeat(43);
  const config: EnabledAuthConfig = {
    enabled: true,
    workspaceId,
    clientId: 'githubclient123',
    clientSecret: 'not-used-by-test',
    sessionSecret: Buffer.alloc(32, 1),
    publicBaseUrl: new URL('https://control.example/base-is-ignored'),
    callbackUrl: 'https://control.example/api/auth/github/callback',
    allowedUserIds: new Set([123, 456]),
    secureCookies: true
  };
  let createInput: unknown;
  const revoked: unknown[] = [];
  let idCounter = 0;
  const dependencies: ProjectShareCommandDependencies = {
    now: () => now,
    nextId: () => `server-command-${++idCounter}`,
    requireSession: async (request, options) => {
      if (request.headers.get('x-test-auth') !== 'operator') {
        return {
          ok: false,
          response: new Response(null, {
            status: 401,
            headers: {'Cache-Control': 'no-store'}
          })
        };
      }
      if (options?.csrfToken !== csrfToken) {
        return {
          ok: false,
          response: new Response(null, {
            status: 403,
            headers: {'Cache-Control': 'no-store'}
          })
        };
      }
      return {
        ok: true,
        session: {
          actorId,
          displayName: 'Operator',
          githubUserId: 123,
          expiresAt: new Date('2026-07-27T18:00:00.000Z'),
          csrfToken
        },
        runtime: {config, service: {} as never},
        sessionToken: 'session-token'
      };
    },
    getRuntime: async () => ({
      findProjectId: async (requestedWorkspaceId, slug) =>
        requestedWorkspaceId === workspaceId && slug === 'msa'
          ? projectId
          : null,
      service: {
        create: async (input) => {
          createInput = input;
          return {
            shareId,
            token: plaintextToken,
            expiresAt: input.expiresAt
          };
        },
        revoke: async (input) => {
          revoked.push(input);
          return false;
        },
        resolve: async () => null
      }
    })
  };
  const request = (
    csrf: string,
    authenticated: boolean,
    expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  ) => new Request('https://attacker.invalid/api/project-shares', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: config.publicBaseUrl.origin,
      ...(authenticated ? {'x-test-auth': 'operator'} : {})
    },
    body: JSON.stringify({
      _csrf: csrf,
      projectSlug: 'msa',
      workItemIds: [workItemId],
      expiresAt
    })
  });

  process.env.PUBLIC_SHARING_ENABLED = 'true';
  const unauthenticated = await createProjectShareCommand(
    request(csrfToken, false),
    dependencies
  );
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get('cache-control')).toBe('no-store');

  const wrongCsrf = await createProjectShareCommand(
    request('wrong-csrf', true),
    dependencies
  );
  expect(wrongCsrf.status).toBe(403);
  expect(createInput).toBeUndefined();

  process.env.PUBLIC_SHARING_ENABLED = 'false';
  const disabled = await createProjectShareCommand(
    request(csrfToken, true),
    dependencies
  );
  expect(disabled.status).toBe(404);

  process.env.PUBLIC_SHARING_ENABLED = 'true';
  const overlong = await createProjectShareCommand(
    request(
      csrfToken,
      true,
      new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString()
    ),
    dependencies
  );
  expect(overlong.status).toBe(400);

  const created = await createProjectShareCommand(
    request(csrfToken, true),
    dependencies
  );
  expect(created.status).toBe(201);
  expect(created.headers.get('cache-control')).toBe('no-store');
  await expect(created.json()).resolves.toEqual({
    shareUrl: `https://control.example/share/${plaintextToken}`,
    expiresAt: '2026-07-28T10:00:00.000Z'
  });
  expect(createInput).toEqual(expect.objectContaining({
    workspaceId,
    projectId,
    createdByActorId: actorId,
    workItemIds: [workItemId]
  }));
  expect(JSON.stringify(createInput)).not.toContain(plaintextToken);
  expect(JSON.stringify(createInput)).not.toContain('attacker.invalid');

  const revokeRequest = () => new Request(
    `https://attacker.invalid/api/project-shares/${shareId}/revoke`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: config.publicBaseUrl.origin,
        'x-test-auth': 'operator'
      },
      body: JSON.stringify({_csrf: csrfToken})
    }
  );
  const firstRevoke = await revokeProjectShareCommand(
    revokeRequest(),
    shareId,
    dependencies
  );
  const repeatedRevoke = await revokeProjectShareCommand(
    revokeRequest(),
    shareId,
    dependencies
  );
  expect(firstRevoke.status).toBe(204);
  expect(repeatedRevoke.status).toBe(204);
  expect(repeatedRevoke.headers.get('cache-control')).toBe('no-store');
  expect(revoked).toHaveLength(2);
  expect(revoked[0]).toEqual(expect.objectContaining({
    workspaceId,
    shareId,
    revokedByActorId: actorId
  }));
});
