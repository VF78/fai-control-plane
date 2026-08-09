import {expect, it, vi} from 'vitest';
import {projectOutcomeAcceptanceCommand, type ProjectOutcomeAcceptanceDependencies} from './project-outcome-acceptance-command';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const baselineId = '33333333-3333-4333-8333-333333333333';
const outcomeId = '44444444-4444-4444-8444-444444444444';
const actorId = '55555555-5555-4555-8555-555555555555';
const commandId = '66666666-6666-4666-8666-666666666666';
const body = {_csrf: 'csrf', projectId, baselineId, outcomeId, expectedExecutionVersion: 2};
const request = (value: unknown, headers: HeadersInit = {}) => new Request('https://control.test/api/project-outcomes/accept', {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(value)});
const dependencies = (execute: ReturnType<typeof vi.fn>, requireSession: ProjectOutcomeAcceptanceDependencies['requireSession'] = async (_request, options) => {
  expect(options).toEqual({csrfToken: 'csrf'});
  return {ok: true, session: {actorId}, runtime: {config: {workspaceId}}, sessionToken: 'session'} as never;
}): ProjectOutcomeAcceptanceDependencies => ({requireSession, getRuntime: async () => ({actor: async () => ({ok: true, value: {actorId} as never}), projectOutcomeAcceptance: {execute}} as never), nextId: () => commandId, now: () => new Date('2026-08-09T10:00:00.000Z')});

it('requires a CSRF-bound operator session before accepting an outcome', async () => {
  const execute = vi.fn();
  const response = await projectOutcomeAcceptanceCommand(request(body), dependencies(execute, async () => ({ok: false, response: new Response(null, {status: 403})})));
  expect(response.status).toBe(403); expect(execute).not.toHaveBeenCalled();
});

it('emits the exact Product Owner idempotency/CAS command and returns only its receipt', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId, commandType: 'project_scope_outcome.accept.v1', result: {ok: true, value: {projectId, outcomeId, acceptedWeight: 50, totalWeight: 100, executionStatus: 'blocked', executionVersion: 2}}}});
  const response = await projectOutcomeAcceptanceCommand(request(body), dependencies(execute));
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({type: 'project_scope_outcome.accept.v1', idempotencyKey: `project-outcome-accept:v1:${outcomeId}:2:${actorId}`, payload: {projectId, baselineId, outcomeId, expectedExecutionVersion: 2}}));
  await expect(response.json()).resolves.toMatchObject({receipt: {commandType: 'project_scope_outcome.accept.v1'}, acceptance: {acceptedWeight: 50}});
});

it('rejects poisoned payloads before the runtime and maps stale outcomes without success', async () => {
  const execute = vi.fn();
  const requireSession = vi.fn(async () => ({ok: true, session: {actorId},
    runtime: {config: {workspaceId}}, sessionToken: 'session'} as never));
  expect((await projectOutcomeAcceptanceCommand(request({...body, provider: 'github'}),
    dependencies(execute, requireSession))).status).toBe(400);
  expect((await projectOutcomeAcceptanceCommand(request(body, {'content-length': '2049'}),
    dependencies(execute, requireSession))).status).toBe(400);
  expect(requireSession).toHaveBeenNthCalledWith(1, expect.any(Request), {csrfToken: 'csrf'});
  expect(requireSession).toHaveBeenNthCalledWith(2, expect.any(Request), {csrfToken: null});
  expect(execute).not.toHaveBeenCalled();
  execute.mockResolvedValueOnce({status: 'completed', receipt: {commandId, commandType: 'project_scope_outcome.accept.v1', result: {ok: false, error: {code: 'VERSION_CONFLICT', message: 'stale'}}}});
  const stale = await projectOutcomeAcceptanceCommand(request(body), dependencies(execute));
  expect(stale.status).toBe(409); await expect(stale.json()).resolves.toMatchObject({status: 'version_conflict'});
});
