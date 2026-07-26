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
      service: {
        claim: async () => null,
        heartbeat: async () => ({leaseExpiresAt: '2026-07-26T10:02:00.000Z'}),
        complete: async () => ({
          terminal: 'done' as const,
          completedAt: '2026-07-26T10:02:00.000Z'
        })
      }
    })
  };
});

import {POST} from './route';
import {POST as heartbeat} from '../heartbeat/route';
import {POST as complete} from '../complete/route';

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

it('keeps lease transport disabled by default and denies malformed completion without details', async () => {
  process.env.LOCAL_RUNNER_TRANSPORT_ENABLED = 'false';
  const disabled = await heartbeat(new Request('http://localhost/api/runner/heartbeat', {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`},
    body: JSON.stringify({runId: '00000000-0000-4000-8000-000000000003', attempt: 1})
  }));
  expect(disabled.status).toBe(503);
  expect(disabled.headers.get('cache-control')).toBe('no-store');

  process.env.LOCAL_RUNNER_TRANSPORT_ENABLED = 'true';
  const forged = await complete(new Request('http://localhost/api/runner/complete', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-fai-runner-lease-token': 'forged',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      runId: '00000000-0000-4000-8000-000000000003',
      attempt: 1,
      terminal: 'done',
      receiptSha256: 'a'.repeat(64),
      receiptSizeBytes: 128,
      finalStatus: 'succeeded',
      changedFiles: ['../../secret'],
      checks: [],
      riskCount: 0,
      nextAction: 'review_receipt'
    })
  }));
  expect(forged.status).toBe(404);
  expect(forged.headers.get('cache-control')).toBe('no-store');
});
