import {expect, it, vi} from 'vitest';
import {
  acceptAgentRunReceiptCommand,
  type ReceiptHandoffCommandDependencies
} from './agent-run-receipt-handoff';

const runId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000003';
const workspaceId = '00000000-0000-4000-8000-000000000004';
const csrfToken = 'csrf-token';
const receiptSha256 = 'a'.repeat(64);

const request = (overrides: Record<string, string> = {}, project = 'msa') => new Request(
  `https://control.example.test/api/agent-runs/${runId}/accept-receipt?project=${project}`,
  {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      _csrf: csrfToken,
      expectedWorkItemVersion: '7',
      expectedReceiptSha256: receiptSha256,
      ...overrides
    })
  }
);

const authenticated = async (
  _request: Request,
  options?: Readonly<{csrfToken?: string | null}>
) => (options?.csrfToken === csrfToken
  ? {ok: true, session: {actorId}, runtime: {config: {workspaceId}}}
  : {ok: false, response: new Response(null, {status: 403})}) as never;

const dependencies = (
  result: 'accepted' | 'stale' | 'forbidden' | 'not_found' | 'unavailable'
) => {
  const execute = vi.fn(async () => result);
  return {
    execute,
    value: {
      requireSession: authenticated,
      getRuntime: async () => ({execute})
    } satisfies ReceiptHandoffCommandDependencies
  };
};

it('passes only the session-bound atomic acceptance facts to the runtime', async () => {
  const runtime = dependencies('accepted');
  const response = await acceptAgentRunReceiptCommand(request(), runId, runtime.value);
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(
    `https://control.example.test/projects/msa/runs/${runId}?handoff=accepted`
  );
  expect(runtime.execute).toHaveBeenCalledWith({
    workspaceId,
    actorId,
    runId,
    receiptSha256,
    expectedWorkItemVersion: 7
  });
});

it('returns to any valid canonical project slug', async () => {
  const runtime = dependencies('accepted');
  const response = await acceptAgentRunReceiptCommand(
    request({}, 'new-project'), runId, runtime.value
  );
  expect(response.headers.get('location')).toBe(
    `https://control.example.test/projects/new-project/runs/${runId}?handoff=accepted`
  );
});

it.each(['stale', 'forbidden', 'not_found', 'unavailable'] as const)(
  'renders the exact command outcome %s',
  async (result) => {
    const runtime = dependencies(result);
    const response = await acceptAgentRunReceiptCommand(request(), runId, runtime.value);
    expect(response.headers.get('location')).toContain(`handoff=${result}`);
    expect(runtime.execute).toHaveBeenCalledOnce();
  }
);

it('requires the authorized CSRF session before loading the database runtime', async () => {
  const getRuntime = vi.fn();
  const response = await acceptAgentRunReceiptCommand(request({_csrf: 'wrong'}), runId, {
    requireSession: authenticated,
    getRuntime
  });
  expect(response.status).toBe(403);
  expect(getRuntime).not.toHaveBeenCalled();
});

it.each([
  ['duplicate field', {_csrf: csrfToken, expectedWorkItemVersion: '7',
    expectedReceiptSha256: receiptSha256, extra: 'x'}],
  ['zero version', {expectedWorkItemVersion: '0'}],
  ['invalid receipt hash', {expectedReceiptSha256: 'nope'}]
])('rejects %s without executing a command', async (_label, form) => {
  const runtime = dependencies('accepted');
  const response = await acceptAgentRunReceiptCommand(request(form), runId, runtime.value);
  expect(response.status).toBe(403);
  expect(runtime.execute).not.toHaveBeenCalled();
});

it('fails closed when runtime execution throws', async () => {
  const response = await acceptAgentRunReceiptCommand(request(), runId, {
    requireSession: authenticated,
    getRuntime: async () => ({execute: async () => { throw new Error('database unavailable'); }})
  });
  expect(response.headers.get('location')).toContain('handoff=unavailable');
});
