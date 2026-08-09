import {expect, it, vi} from 'vitest';
import {projectExecutionCommand, type ProjectExecutionCommandDependencies} from './project-execution-commands';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const commandId = '44444444-4444-4444-8444-444444444444';
const request = (body: unknown, headers: HeadersInit = {}) => new Request('https://control.test/api/project-execution', {
  method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)
});
const payload = { _csrf: 'csrf', action: 'start', projectId, expectedVersion: 0, idempotencyKey: 'start-once'};
const dependencies = (execute: ReturnType<typeof vi.fn>, requireSession: ProjectExecutionCommandDependencies['requireSession'] = async (_request, options) => {
  expect(options).toEqual({csrfToken: 'csrf'});
  return {ok: true, session: {actorId}, runtime: {config: {workspaceId}}, sessionToken: 'session'} as never;
}): ProjectExecutionCommandDependencies => ({
  requireSession,
  getRuntime: async () => ({actor: async () => ({ok: true, value: {} as never}),
    projectExecution: {execute}, protocol: {} as never, journey: {} as never, plan: {} as never} as never),
  nextId: () => commandId,
  now: () => new Date('2026-08-09T10:00:00.000Z')
});

it('requires an authenticated CSRF-bound session before the project command', async () => {
  const execute = vi.fn();
  const response = await projectExecutionCommand(request(payload), dependencies(execute,
    async () => ({ok: false, response: new Response(null, {status: 403})})));
  expect(response.status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
});

it('emits the exact Start CAS/idempotency command and returns only a persisted receipt', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId,
    commandType: 'project_execution.start', result: {ok: true, value: {projectId, status: 'running', version: 1}}}});
  const response = await projectExecutionCommand(request(payload), dependencies(execute));
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({
    idempotencyKey: 'start-once', type: 'project_execution.start',
    payload: {projectId, expectedVersion: 0}
  }));
  await expect(response.json()).resolves.toMatchObject({receipt: {commandType: 'project_execution.start'}, execution: {status: 'running', version: 1}});
});

it('rejects extra, oversized, and stale command outcomes without claiming success', async () => {
  const execute = vi.fn();
  expect((await projectExecutionCommand(request({...payload, provider: 'github'}), dependencies(execute))).status).toBe(400);
  expect((await projectExecutionCommand(request(payload, {'content-length': '2049'}), dependencies(execute))).status).toBe(400);
  expect(execute).not.toHaveBeenCalled();
  execute.mockResolvedValueOnce({status: 'completed', receipt: {commandId,
    commandType: 'project_execution.start', result: {ok: false, error: {code: 'VERSION_CONFLICT', message: 'stale'}}}});
  const stale = await projectExecutionCommand(request(payload), dependencies(execute));
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({status: 'version_conflict'});
});

it('bounds chunked JSON before authentication', async () => {
  const requireSession = vi.fn(); let pulls = 0;
  const oversized = new Request('https://control.test/api/project-execution', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: new ReadableStream<Uint8Array>({
      pull(controller) { if (pulls++ < 3) controller.enqueue(new Uint8Array(1_024).fill(120)); else controller.close(); }
    }), duplex: 'half'} as RequestInit);
  const response = await projectExecutionCommand(oversized, {requireSession, getRuntime: vi.fn(),
    nextId: () => commandId, now: () => new Date()} as never);
  expect(response.status).toBe(400);
  expect(requireSession).not.toHaveBeenCalled();
});
