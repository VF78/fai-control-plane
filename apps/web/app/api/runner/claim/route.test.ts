import {createHash} from 'node:crypto';
import {afterEach, expect, it, vi} from 'vitest';

const token = 'runner-test-token-0123456789abcdef';

vi.mock('../../../../src/runner-claim-runtime', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../src/runner-claim-runtime')
  >();
  return {
    ...actual,
    getLocalRunnerClaimRuntime: async () => ({
      authorization: {
        workspaceId: '00000000-0000-4000-8000-000000000001',
        runnerId: 'test-runner',
        projectIds: ['00000000-0000-4000-8000-000000000002'],
        repositories: [{owner: 'VF78', name: 'fai-control-plane'}]
      },
      tokenHash: createHash('sha256').update(token).digest(),
      service: {claim: async () => null}
    })
  };
});

import {POST} from './route';

const previousEnabled = process.env.LOCAL_RUNNER_TRANSPORT_ENABLED;

afterEach(() => {
  if (previousEnabled === undefined) {
    delete process.env.LOCAL_RUNNER_TRANSPORT_ENABLED;
  } else {
    process.env.LOCAL_RUNNER_TRANSPORT_ENABLED = previousEnabled;
  }
});

it('fails closed when disabled and rejects an inexact bearer token', async () => {
  process.env.LOCAL_RUNNER_TRANSPORT_ENABLED = 'false';
  const disabled = await POST(new Request('http://localhost/api/runner/claim', {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`}
  }));
  expect(disabled.status).toBe(503);
  expect(disabled.headers.get('cache-control')).toBe('no-store');

  process.env.LOCAL_RUNNER_TRANSPORT_ENABLED = 'true';
  const unauthorized = await POST(
    new Request('http://localhost/api/runner/claim', {
      method: 'POST',
      headers: {authorization: `Bearer ${token}x`}
    })
  );
  expect(unauthorized.status).toBe(401);

  const idle = await POST(new Request('http://localhost/api/runner/claim', {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`}
  }));
  expect(idle.status).toBe(204);
});
