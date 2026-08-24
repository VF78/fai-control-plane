import {describe, expect, it, vi} from 'vitest';
import {createRepositoryAuthorizationHandler} from './repository-authorization.ts';

const input = {projectId: 'project', receiptReference: `browser:${'a'.repeat(64)}`,
  repository: {id: 'R_repo', url: 'https://github.com/acme/repo'}, issueNumber: 42,
  base: {ref: 'refs/heads/trunk', sha: 'b'.repeat(40)}};
const request = (token: string, body: unknown = input) => new Request('https://app.example/api/hermes/repository-authorizations', {
  method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
  body: JSON.stringify(body)
});

describe('repository authorization bridge', () => {
  it('denies before canonical receipt resolution when the internal token differs', async () => {
    const authorize = vi.fn(async () => input);
    const handler = createRepositoryAuthorizationHandler({token: async () => 'x'.repeat(48), authorize});
    expect((await handler(request('y'.repeat(48)))).status).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('returns only the exact server-confirmed repository authorization', async () => {
    const handler = createRepositoryAuthorizationHandler({token: async () => 'x'.repeat(48),
      authorize: async (candidate) => candidate.base.sha === input.base.sha ? candidate : null});
    const accepted = await handler(request('x'.repeat(48)));
    expect(accepted.status).toBe(200); await expect(accepted.json()).resolves.toEqual(input);
    expect((await handler(request('x'.repeat(48), {...input,
      base: {...input.base, sha: 'c'.repeat(40)}}))).status).toBe(403);
  });
});
