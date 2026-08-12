import {expect, it, vi} from 'vitest';
import {releaseEvidenceCommand, type ReleaseEvidenceCommandDependencies} from './release-evidence-command';

const ids = {workspace: '11111111-1111-4111-8111-111111111111', actor: '22222222-2222-4222-8222-222222222222',
  deployment: '33333333-3333-4333-8333-333333333333', project: '44444444-4444-4444-8444-444444444444',
  plan: '55555555-5555-4555-8555-555555555555', materialization: '66666666-6666-4666-8666-666666666666'};
const body = {_csrf: 'csrf', action: 'request', deploymentId: ids.deployment, projectId: ids.project,
  workItemId: null, planVersionId: ids.plan, materializationId: ids.materialization, environment: 'production',
  sourceCommit: 'a'.repeat(40), releasePackageReference: 'artifact:release-package:1',
  releasePackageSha256: 'b'.repeat(64), expectedProjectVersion: 1};
const request = (value: unknown) => new Request('https://control.test/api/deployments', {method: 'POST',
  headers: {'content-type': 'application/json'}, body: JSON.stringify(value)});
const deps = (execute: ReturnType<typeof vi.fn>, requireSession: ReleaseEvidenceCommandDependencies['requireSession'] =
  async () => ({ok: true, session: {actorId: ids.actor}, runtime: {config: {workspaceId: ids.workspace}}} as never)):
  ReleaseEvidenceCommandDependencies => ({requireSession, getRuntime: async () => ({actor: async () => ({ok: true,
    value: {actorId: ids.actor} as never}), deploymentEvidence: {execute}} as never),
    nextId: () => '77777777-7777-4777-8777-777777777777', now: () => new Date('2026-08-11T10:00:00.000Z')});

it('requires CSRF session and emits exact human request/production approval commands only', async () => {
  const denied = vi.fn();
  expect((await releaseEvidenceCommand(request(body), deps(denied, async () => ({ok: false,
    response: new Response(null, {status: 403})})))).status).toBe(403);
  expect(denied).not.toHaveBeenCalled();
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: 'command',
    commandType: 'deployment.request.v1', result: {ok: true, value: {state: 'requested'}}}});
  expect((await releaseEvidenceCommand(request(body), deps(execute))).status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({type: 'deployment.request.v1',
    idempotencyKey: `deployment-request:v1:${ids.deployment}:1:${ids.actor}`,
    payload: expect.objectContaining({environment: 'production', workItemId: null,
      reference: {kind: 'commit', reference: `git-commit:${'a'.repeat(40)}`},
      releasePackage: expect.objectContaining({artifactSha256: 'b'.repeat(64)})})}));
  execute.mockClear();
  await releaseEvidenceCommand(request({_csrf: 'csrf', action: 'approve_production', deploymentId: ids.deployment,
    expectedVersion: 1}), deps(execute));
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({type: 'deployment.production_approve.v1'}));
  expect((await releaseEvidenceCommand(request({...body, observation: {}}), deps(execute))).status).toBe(400);
  expect((await releaseEvidenceCommand(request({...body,
    releasePackageReference: 'x'.repeat(513)}), deps(execute))).status).toBe(400);
});
