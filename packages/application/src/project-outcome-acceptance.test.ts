import {randomUUID} from 'node:crypto';
import {createActorContextIssuer} from '@fai-control-plane/domain';
import {describe, expect, it, vi} from 'vitest';
import {createProjectOutcomeAcceptanceService, PROJECT_OUTCOME_ACCEPTANCE_COMMAND, type ProjectOutcomeAcceptanceStore} from './project-outcome-acceptance';

const actor = (capabilities: readonly string[] = ['write:control_plane:development']) => {
  const actorId = randomUUID();
  const issuer = createActorContextIssuer({users: [{actorId, capabilities: capabilities as never}], agents: [], systems: []});
  if (!issuer.ok) throw new Error('issuer');
  const issued = issuer.value.issueUser(actorId); if (!issued.ok) throw new Error('actor');
  return issued.value;
};
const command = (issued = actor()) => ({
  commandId: randomUUID(), workspaceId: randomUUID(), correlationId: randomUUID(),
  idempotencyKey: '', issuedAt: '2026-08-09T10:00:00.000Z', actor: issued,
  type: PROJECT_OUTCOME_ACCEPTANCE_COMMAND,
  payload: {projectId: randomUUID(), baselineId: randomUUID(), outcomeId: randomUUID(), expectedExecutionVersion: 2}
});

describe('project outcome acceptance service', () => {
  it('accepts only an exact trusted-human CAS command and hashes its receipt request', async () => {
    const execute = vi.fn(async (input) => ({status: 'completed' as const, receipt: {
      commandId: input.command.commandId, workspaceId: input.command.workspaceId,
      correlationId: input.command.correlationId, idempotencyKey: input.command.idempotencyKey,
      requestHash: input.requestHash, commandType: PROJECT_OUTCOME_ACCEPTANCE_COMMAND,
      result: {ok: false as const, error: {code: 'NOT_FOUND' as const, message: 'fixture'}},
      createdAt: input.command.issuedAt
    }}));
    const issued = actor(); const draft = command(issued);
    const canonical = {...draft, idempotencyKey: `project-outcome-accept:v1:${draft.payload.outcomeId}:2:${issued.actorId}`};
    const service = createProjectOutcomeAcceptanceService({execute} as ProjectOutcomeAcceptanceStore);
    await expect(service.execute(canonical)).resolves.toMatchObject({status: 'completed'});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({authorized: true, requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)}));
  });

  it('rejects poisoned shapes and policy-denied actors before a store mutation', async () => {
    const execute = vi.fn(async (input) => ({status: 'completed' as const, receipt: {
      commandId: input.command.commandId, workspaceId: input.command.workspaceId,
      correlationId: input.command.correlationId, idempotencyKey: input.command.idempotencyKey,
      requestHash: input.requestHash, commandType: PROJECT_OUTCOME_ACCEPTANCE_COMMAND,
      result: {ok: false as const, error: input.policyError ?? {
        code: 'POLICY_DENIED' as const, message: 'fixture policy denial'
      }}, createdAt: input.command.issuedAt
    }}));
    const service = createProjectOutcomeAcceptanceService({execute} as ProjectOutcomeAcceptanceStore);
    const issued = actor(); const draft = command(issued);
    await expect(service.execute({...draft, idempotencyKey: 'wrong'})).resolves.toMatchObject({status: 'rejected', error: {code: 'INVALID_COMMAND'}});
    const denied = actor([]); const deniedDraft = command(denied);
    await expect(service.execute({...deniedDraft, idempotencyKey: `project-outcome-accept:v1:${deniedDraft.payload.outcomeId}:2:${denied.actorId}`})).resolves.toMatchObject({status: 'completed'});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({authorized: false}));
  });
});
