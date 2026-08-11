import {randomUUID} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {createActorContextIssuer} from '@fai-control-plane/domain';
import {createDeploymentEvidenceService, DEPLOYMENT_OBSERVE_RESULT_COMMAND,
  DEPLOYMENT_PRODUCTION_APPROVE_COMMAND, DEPLOYMENT_REQUEST_COMMAND} from './release-evidence.ts';

const ids = {workspace: randomUUID(), actor: randomUUID(), system: randomUUID(), deployment: randomUUID(),
  project: randomUUID(), plan: randomUUID(), materialization: randomUUID()};
const issuer = createActorContextIssuer({users: [{actorId: ids.actor, capabilities: ['write:control_plane:development']}],
  agents: [], systems: [{actorId: ids.system, capabilities: ['write:runtime_observation:development']} ]});
if (!issuer.ok) throw new Error('issuer');
const user = issuer.value.issueUser(ids.actor); const system = issuer.value.issueSystem(ids.system);
if (!user.ok || !system.ok) throw new Error('contexts');
const base = (actor: typeof user.value | typeof system.value) => ({commandId: randomUUID(), workspaceId: ids.workspace,
  correlationId: randomUUID(), issuedAt: '2026-08-11T10:00:00.000Z', actor});

describe('deployment evidence service', () => {
  it('keeps production approval separate and observations system-only', async () => {
    const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {}});
    const service = createDeploymentEvidenceService({execute});
    const request = await service.execute({...base(user.value), type: DEPLOYMENT_REQUEST_COMMAND,
      idempotencyKey: `deployment-request:v1:${ids.deployment}:1:${ids.actor}`, payload: {deploymentId: ids.deployment,
        projectId: ids.project, workItemId: null, planVersionId: ids.plan, materializationId: ids.materialization,
        environment: 'production', reference: {kind: 'commit', reference: 'git-commit:abc'}, expectedProjectVersion: 1}});
    expect(request.status).toBe('completed');
    expect((await service.execute({...base(user.value), type: DEPLOYMENT_PRODUCTION_APPROVE_COMMAND,
      idempotencyKey: `deployment-production-approve:v1:${ids.deployment}:1:${ids.actor}`,
      payload: {deploymentId: ids.deployment, expectedVersion: 1}})).status).toBe('completed');
    const observation = {outcome: 'succeeded' as const, reference: 'evidence:result',
      startedAt: '2026-08-11T10:00:00.000Z', completedAt: '2026-08-11T10:01:00.000Z',
      smokeChecks: [{name: 'health', status: 'passed' as const, reference: 'evidence:health'}],
      rollback: {outcome: 'not_required' as const, reference: null}};
    expect(await service.execute({...base(user.value), type: DEPLOYMENT_OBSERVE_RESULT_COMMAND,
      idempotencyKey: `deployment-observe:v1:${ids.deployment}:2:${ids.actor}`,
      payload: {deploymentId: ids.deployment, expectedVersion: 2, observation}}))
      .toMatchObject({status: 'rejected', error: {code: 'INVALID_ACTOR_CONTEXT'}});
    expect((await service.execute({...base(system.value), type: DEPLOYMENT_OBSERVE_RESULT_COMMAND,
      idempotencyKey: `deployment-observe:v1:${ids.deployment}:2:${ids.system}`,
      payload: {deploymentId: ids.deployment, expectedVersion: 2, observation}})).status).toBe('completed');
  });
});
