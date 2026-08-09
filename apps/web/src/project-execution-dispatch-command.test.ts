import {createActorContextIssuer} from '@fai-control-plane/domain';
import {expect, it, vi} from 'vitest';
import {projectExecutionDispatchCommand, type ProjectExecutionDispatchCommandDependencies} from './project-execution-dispatch-command';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const request = (body: unknown, headers: HeadersInit = {}) => new Request(
  'https://control.test/api/project-execution/dispatch', {
    method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)
  }
);
const payload = {_csrf: 'csrf', projectId, executionVersion: 4};
const actor = (allowed = true) => {
  const issuer = createActorContextIssuer({users: [{actorId, capabilities: allowed
    ? ['write:control_plane:development'] : []}], agents: [], systems: []});
  if (!issuer.ok) throw new Error('issuer');
  return issuer.value.issueUser(actorId);
};
const projection = (overrides: Record<string, unknown> = {}) => ({projectId, status: 'running', version: 4,
  selection: {boundary: 'autonomous_ready'}, dispatch: {agentRunId: 'run-1', agentRunStatus: 'queued'},
  blockReason: null, decisions: [], startedAt: null, pausedAt: null, completedAt: null, updatedAt: null,
  ...overrides});
const dependencies = (run = vi.fn().mockResolvedValue({dispatched: 1, blocked: 0, replayed: 0, denied: 0}),
  projectExecutionProjection = vi.fn().mockResolvedValue(projection()), allowed = true,
  requireSession: ProjectExecutionDispatchCommandDependencies['requireSession'] = async (_request, options) => {
    expect(options).toEqual({csrfToken: 'csrf'});
    return {ok: true, session: {actorId}, runtime: {config: {workspaceId}}, sessionToken: 'session'} as never;
  }): ProjectExecutionDispatchCommandDependencies => ({requireSession, getRuntime: async () => ({
    actor: async () => actor(allowed), projectExecutionDispatch: {run}, projectExecutionProjection
  } as never)});

it('uses the CSRF session actor and exact execution CAS with the reviewed dispatcher', async () => {
  const run = vi.fn().mockResolvedValue({dispatched: 1, blocked: 0, replayed: 0, denied: 0});
  const response = await projectExecutionDispatchCommand(request(payload), dependencies(run));
  expect(response.status).toBe(200);
  expect(run).toHaveBeenCalledWith({workspaceId, projectId, expectedVersion: 4,
    requestedByActorId: actorId});
  await expect(response.json()).resolves.toMatchObject({activation: 'queued',
    receipt: {commandType: 'project_execution.dispatch.v1'}, execution: {version: 4,
      dispatch: {agentRunStatus: 'queued'}}});
});

it('fails closed before dispatch for session, capability, extra fields, and 2 KiB violations', async () => {
  const run = vi.fn();
  const deniedSession = await projectExecutionDispatchCommand(request(payload), dependencies(run, vi.fn(), true,
    async () => ({ok: false, response: new Response(null, {status: 403})})));
  expect(deniedSession.status).toBe(403);
  expect((await projectExecutionDispatchCommand(request({...payload, provider: 'github'}), dependencies(run))).status).toBe(400);
  expect((await projectExecutionDispatchCommand(request(payload, {'content-length': '2049'}), dependencies(run))).status).toBe(400);
  expect((await projectExecutionDispatchCommand(request(payload), dependencies(run, vi.fn(), false))).status).toBe(403);
  let pulls = 0;
  const chunked = new Request('https://control.test/api/project-execution/dispatch', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: new ReadableStream<Uint8Array>({
      pull(controller) { if (pulls++ < 3) controller.enqueue(new Uint8Array(1_024).fill(120)); else controller.close(); }
    }), duplex: 'half'} as RequestInit);
  expect((await projectExecutionDispatchCommand(chunked, dependencies(run))).status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});

it('maps stale, paused, and policy outcomes without claiming a queued run', async () => {
  const noDispatch = vi.fn().mockResolvedValue({dispatched: 0, blocked: 0, replayed: 0, denied: 0});
  const stale = await projectExecutionDispatchCommand(request(payload), dependencies(noDispatch,
    vi.fn().mockResolvedValue(projection({version: 5, dispatch: null}))));
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({status: 'version_conflict'});
  const paused = await projectExecutionDispatchCommand(request(payload), dependencies(noDispatch,
    vi.fn().mockResolvedValue(projection({status: 'paused', dispatch: null}))));
  expect(paused.status).toBe(409);
  await expect(paused.json()).resolves.toMatchObject({status: 'project_execution_paused'});
  const blocked = vi.fn().mockResolvedValue({dispatched: 0, blocked: 1, replayed: 0, denied: 0});
  const policy = await projectExecutionDispatchCommand(request(payload), dependencies(blocked,
    vi.fn().mockResolvedValue(projection({status: 'blocked', version: 5, dispatch: null,
      blockReason: 'dispatch_policy_denied'}))));
  expect(policy.status).toBe(403);
  await expect(policy.json()).resolves.toMatchObject({status: 'policy_denied',
    receipt: {commandType: 'project_execution.dispatch.v1'}});
});

it('accepts only a replay backed by the current persisted dispatch', async () => {
  const response = await projectExecutionDispatchCommand(request(payload), dependencies(
    vi.fn().mockResolvedValue({dispatched: 0, blocked: 0, replayed: 1, denied: 0})
  ));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({activation: 'replayed'});
});

it('maps an audited authority denial to 403 without loading or disclosing dispatch facts', async () => {
  const loadProjection = vi.fn();
  const response = await projectExecutionDispatchCommand(request(payload), dependencies(
    vi.fn().mockResolvedValue({dispatched: 0, blocked: 0, replayed: 0, denied: 1}), loadProjection
  ));
  expect(response.status).toBe(403);
  expect(loadProjection).not.toHaveBeenCalled();
  const body = await response.json();
  expect(body).toMatchObject({status: 'capability_denied'});
  expect(body).not.toHaveProperty('execution');
});
