import {createActorContextIssuer} from '@fai-control-plane/domain';
import {expect, it, vi} from 'vitest';
import {agentRunRetryContinuationCommand, type RetryContinuationDependencies} from './agent-run-retry-continuation-command';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const failedRunId = '44444444-4444-4444-8444-444444444444';
const retryRunId = '55555555-5555-4555-8555-555555555555';
const payload = {_csrf: 'csrf', projectId, failedRunId, retryRunId,
  expectedExecutionVersion: 3};
const request = (body: unknown) => new Request('https://control.test/api/project-execution/retry', {
  method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)
});
const issuedActor = () => {
  const issuer = createActorContextIssuer({users: [{actorId,
    capabilities: ['write:control_plane:development']}], agents: [], systems: []});
  if (!issuer.ok) throw new Error('issuer');
  return issuer.value.issueUser(actorId);
};
const dependencies = (execute: ReturnType<typeof vi.fn>): RetryContinuationDependencies => ({
  requireSession: async (_request, options) => {
    expect(options).toEqual({csrfToken: 'csrf'});
    return {ok: true, session: {actorId}, runtime: {config: {workspaceId}}, sessionToken: 'session'} as never;
  },
  getRuntime: async () => ({actor: async () => issuedActor(),
    agentRunRetryContinuation: {execute}} as never),
  nextId: vi.fn().mockReturnValueOnce('66666666-6666-4666-8666-666666666666')
    .mockReturnValueOnce('77777777-7777-4777-8777-777777777777'),
  now: () => new Date('2026-08-09T12:00:00.000Z')
});

it('binds the Russian GUI request to session actor, CSRF, CAS, and exact bounded policy', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {
    commandId: '66666666-6666-4666-8666-666666666666', commandType: 'agent_run.retry_continuation.v1',
    result: {ok: true, value: {disposition: 'queued', retryRunId}}
  }});
  const response = await agentRunRetryContinuationCommand(request(payload), dependencies(execute));
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({payload: expect.objectContaining({
    projectId, failedRunId, retryRunId, expectedExecutionVersion: 3
  })}));
});

it('rejects stale and non-canonical requests without a partial mutation', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {result: {ok: false,
    error: {code: 'VERSION_CONFLICT', message: 'stale'}}}});
  expect((await agentRunRetryContinuationCommand(request(payload), dependencies(execute))).status).toBe(409);
  const invalidExecute = vi.fn();
  expect((await agentRunRetryContinuationCommand(request({...payload, stopBefore: []}),
    dependencies(invalidExecute))).status).toBe(400);
  let pulls = 0;
  const oversized = new Request('https://control.test/api/project-execution/retry', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: new ReadableStream<Uint8Array>({
      pull(controller) { if (pulls++ < 3) controller.enqueue(new Uint8Array(1_024).fill(120)); else controller.close(); }
    }), duplex: 'half'} as RequestInit);
  const oversizedSession: RetryContinuationDependencies['requireSession'] = async (_request, options) => {
      expect(options).toEqual({csrfToken: null});
      return {ok: true, session: {actorId}, runtime: {config: {workspaceId}}, sessionToken: 'session'} as never;
    };
  const oversizedDependencies = {...dependencies(invalidExecute), requireSession: oversizedSession};
  expect((await agentRunRetryContinuationCommand(oversized, oversizedDependencies)).status).toBe(400);
  expect(invalidExecute).not.toHaveBeenCalled();
});
