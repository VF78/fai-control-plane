import {randomUUID} from 'node:crypto';
import {createActorContextIssuer} from '@fai-control-plane/domain';
import {expect, it, vi} from 'vitest';
import {createProjectAcceptanceService, PROJECT_UAT_PREPARE_COMMAND, type ProjectAcceptanceStore} from './project-acceptance';

const actor = (capabilities: readonly string[] = ['write:control_plane:development']) => {
  const actorId = randomUUID(); const issuer = createActorContextIssuer({users: [{actorId,
    capabilities: capabilities as never}], agents: [], systems: []});
  if (!issuer.ok) throw new Error('issuer'); const issued = issuer.value.issueUser(actorId);
  if (!issued.ok) throw new Error('actor'); return issued.value;
};

it('accepts only exact trusted-human acceptance commands and passes policy denials for canonical audit', async () => {
  const execute = vi.fn(async (input) => ({status: 'completed' as const, receipt: {commandId: input.command.commandId,
    workspaceId: input.command.workspaceId, correlationId: input.command.correlationId,
    idempotencyKey: input.command.idempotencyKey, requestHash: input.requestHash, commandType: input.command.type,
    result: {ok: false as const, error: input.policyError ?? {code: 'NOT_FOUND' as const, message: 'fixture'}},
    createdAt: input.command.issuedAt}}));
  const service = createProjectAcceptanceService({execute} as ProjectAcceptanceStore); const issued = actor();
  const payload = {projectId: randomUUID(), protocolId: randomUUID(), expectedExecutionVersion: 4,
    requiredSmokeChecks: ['health'], requiredDeploymentEnvironment: 'production' as const,
    deploymentId: randomUUID()};
  const command = {commandId: randomUUID(), workspaceId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `project-uat-prepare:v1:${payload.projectId}:4:${payload.protocolId}:${issued.actorId}`,
    issuedAt: '2026-08-11T10:00:00.000Z', actor: issued, type: PROJECT_UAT_PREPARE_COMMAND, payload};
  await expect(service.execute(command)).resolves.toMatchObject({status: 'completed'});
  await expect(service.execute({...command, payload: {...payload, requiredDeploymentEnvironment: 'development'}} as never))
    .resolves.toMatchObject({status: 'rejected', error: {code: 'INVALID_COMMAND'}});
  await expect(service.execute({...command, idempotencyKey: 'wrong'})).resolves.toMatchObject({status: 'rejected',
    error: {code: 'INVALID_COMMAND'}});
  const denied = actor([]); const deniedCommand = {...command, actor: denied,
    idempotencyKey: `project-uat-prepare:v1:${payload.projectId}:4:${payload.protocolId}:${denied.actorId}`};
  await expect(service.execute(deniedCommand)).resolves.toMatchObject({status: 'completed'});
  expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({authorized: false,
    requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)}));
});
