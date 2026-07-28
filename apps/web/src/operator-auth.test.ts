import {describe, expect, it, vi} from 'vitest';
import {
  OperatorAuthError,
  createOperatorAuthService,
  type EnabledAuthConfig,
  type OperatorAuthStore
} from './operator-auth';

describe('operator GitHub OAuth replay boundary', () => {
  it('uses empty-scope PKCE with hash-only state/session persistence, revocation, and replay rejection', async () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    const config: EnabledAuthConfig = {
      enabled: true,
      workspaceId: '11111111-1111-4111-8111-111111111111',
      clientId: 'githubclient123',
      clientSecret: 'client-secret-not-persisted',
      sessionSecret: Buffer.alloc(32, 7),
      publicBaseUrl: new URL('https://control.example/'),
      callbackUrl: 'https://control.example/api/auth/github/callback',
      allowedUserIds: new Set([123, 456]),
      secureCookies: true
    };
    const attempts = new Map<string, {consumed: boolean}>();
    const persistedSessions = new Map<string, {
      actorId: string;
      githubUserId: number;
      expiresAt: Date;
      revokedAt: Date | null;
    }>();
    const store: OperatorAuthStore = {
      async createLoginAttempt(stateHash) {
        attempts.set(stateHash, {consumed: false});
      },
      async consumeLoginAttempt(stateHash) {
        const attempt = attempts.get(stateHash);
        if (attempt === undefined || attempt.consumed) return false;
        attempt.consumed = true;
        return true;
      },
      async findBoundOperator(_workspaceId, githubUserId) {
        return {actorId: '22222222-2222-4222-8222-222222222222', displayName: 'Vladimir', githubUserId};
      },
      async createSession(input) {
        persistedSessions.set(input.tokenHash, {
          actorId: input.actorId,
          githubUserId: input.githubUserId,
          expiresAt: input.expiresAt,
          revokedAt: null
        });
      },
      async findActiveSession(tokenHash, _workspaceId, at) {
        const session = persistedSessions.get(tokenHash);
        if (session === undefined || session.revokedAt !== null || session.expiresAt <= at) return null;
        return {
          actorId: session.actorId,
          displayName: 'Vladimir',
          githubUserId: session.githubUserId,
          expiresAt: session.expiresAt
        };
      },
      async revokeSession(tokenHash, revokedAt) {
        const session = persistedSessions.get(tokenHash);
        if (session !== undefined && session.revokedAt === null) session.revokedAt = revokedAt;
      }
    };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        access_token: 'github-access-token-never-persisted',
        token_type: 'bearer',
        scope: ''
      }))
      .mockResolvedValueOnce(Response.json({id: 123, login: 'display-only'}));
    const service = createOperatorAuthService(config, store, fetchImpl);

    const started = await service.beginLogin(now);
    const authorizeUrl = new URL(started.authorizeUrl);
    const state = authorizeUrl.searchParams.get('state');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeUrl.searchParams.has('code_verifier')).toBe(false);
    expect(authorizeUrl.searchParams.has('scope')).toBe(true);
    expect(authorizeUrl.searchParams.get('scope')).toBe('');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...attempts.keys()]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect([...attempts.keys()]).not.toContain(state);

    const callbackUrl = new URL(config.callbackUrl);
    callbackUrl.search = new URLSearchParams({code: 'one-time-code', state: state!}).toString();
    const completed = await service.completeLogin(callbackUrl.toString(), started.transientCookie, now);
    expect([...persistedSessions.keys()]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect([...persistedSessions.keys()]).not.toContain(completed.sessionToken);

    await expect(service.authenticate(completed.sessionToken, now)).resolves.toEqual(
      expect.objectContaining({actorId: completed.operator.actorId, githubUserId: 123})
    );
    await service.revoke(completed.sessionToken, now);
    expect([...persistedSessions.values()][0]?.revokedAt).toEqual(now);
    await expect(service.authenticate(completed.sessionToken, now)).resolves.toBeNull();

    await expect(
      service.completeLogin(callbackUrl.toString(), started.transientCookie, now)
    ).rejects.toEqual(expect.objectContaining<Partial<OperatorAuthError>>({code: 'invalid_request'}));
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    fetchImpl.mockResolvedValueOnce(Response.json({
      access_token: 'repo-capable-token-must-be-rejected',
      token_type: 'bearer',
      scope: 'repo'
    }));
    const scopedAttempt = await service.beginLogin(now);
    const scopedAuthorizeUrl = new URL(scopedAttempt.authorizeUrl);
    const scopedCallbackUrl = new URL(config.callbackUrl);
    scopedCallbackUrl.search = new URLSearchParams({
      code: 'scoped-code',
      state: scopedAuthorizeUrl.searchParams.get('state')!
    }).toString();
    await expect(
      service.completeLogin(scopedCallbackUrl.toString(), scopedAttempt.transientCookie, now)
    ).rejects.toEqual(expect.objectContaining<Partial<OperatorAuthError>>({
      code: 'upstream_unavailable'
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(persistedSessions.size).toBe(1);
  });
});
