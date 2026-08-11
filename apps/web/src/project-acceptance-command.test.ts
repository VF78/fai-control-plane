import {expect, it, vi} from 'vitest';
import {projectAcceptanceCommand, type ProjectAcceptanceCommandDependencies} from './project-acceptance-command';

const ids = {workspace: '11111111-1111-4111-8111-111111111111', actor: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333', protocol: '44444444-4444-4444-8444-444444444444'};
const request = (body: unknown) => new Request('https://control.test/api/project-acceptance', {method: 'POST',
  headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
const deps = (execute: ReturnType<typeof vi.fn>, requireSession: ProjectAcceptanceCommandDependencies['requireSession'] =
  async () => ({ok: true, session: {actorId: ids.actor}, runtime: {config: {workspaceId: ids.workspace}}} as never)):
  ProjectAcceptanceCommandDependencies => ({requireSession, getRuntime: async () => ({actor: async () => ({ok: true,
    value: {actorId: ids.actor} as never}), projectAcceptance: {execute}} as never),
    nextId: () => '55555555-5555-4555-8555-555555555555', now: () => new Date('2026-08-11T10:00:00.000Z')});

it('requires session CSRF and emits only exact provider-neutral acceptance commands', async () => {
  const body = {_csrf: 'csrf', action: 'prepare', projectId: ids.project, protocolId: ids.protocol,
    expectedExecutionVersion: 4, requiredSmokeChecks: ['health'], requiredDeploymentEnvironment: 'production'};
  const denied = vi.fn();
  expect((await projectAcceptanceCommand(request(body), deps(denied, async () => ({ok: false,
    response: new Response(null, {status: 403})})))).status).toBe(403);
  expect(denied).not.toHaveBeenCalled();
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: 'command',
    commandType: 'project_uat.prepare.v1', result: {ok: true, value: {version: 1}}}});
  expect((await projectAcceptanceCommand(request(body), deps(execute))).status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({type: 'project_uat.prepare.v1',
    idempotencyKey: `project-uat-prepare:v1:${ids.project}:4:${ids.actor}`,
    payload: expect.objectContaining({requiredDeploymentEnvironment: 'production'})}));
  expect((await projectAcceptanceCommand(request({...body, requiredDeploymentEnvironment: 'development'}),
    deps(execute))).status).toBe(400);
  expect((await projectAcceptanceCommand(request({...body, unknown: true}), deps(execute))).status).toBe(400);
});
