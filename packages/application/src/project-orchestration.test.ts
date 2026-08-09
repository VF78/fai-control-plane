import {randomUUID} from 'node:crypto';
import {createActorContextIssuer} from '@fai-control-plane/domain';
import {describe, expect, it, vi} from 'vitest';
import {createProjectExecutionService, type ProjectExecutionStore} from './project-orchestration';

const trusted = (capabilities: readonly string[] = ['write:control_plane:development']) => {
  const actorId = randomUUID();
  const issuer = createActorContextIssuer({users: [{actorId, capabilities: capabilities as never}], agents: [], systems: []});
  if (!issuer.ok) throw new Error('issuer');
  const actor = issuer.value.issueUser(actorId);
  if (!actor.ok) throw new Error('actor');
  return actor.value;
};
const command = (actor = trusted()) => ({
  commandId: randomUUID(), workspaceId: randomUUID(), correlationId: randomUUID(),
  idempotencyKey: randomUUID(), issuedAt: '2026-08-09T10:00:00.000Z', actor,
  type: 'project_execution.start' as const,
  payload: {projectId: randomUUID(), expectedVersion: 0}
});

describe('project execution service', () => {
  it('validates trusted-human CAS commands and forwards a stable request hash', async () => {
    const execute = vi.fn(async (input) => ({status: 'completed' as const, receipt: {
      commandId: input.command.commandId, workspaceId: input.command.workspaceId,
      correlationId: input.command.correlationId, idempotencyKey: input.command.idempotencyKey,
      requestHash: input.requestHash, commandType: input.command.type,
      result: {ok: false as const, error: {code: 'NOT_FOUND' as const, message: 'fixture'}},
      createdAt: input.command.issuedAt
    }}));
    const service = createProjectExecutionService({execute} as ProjectExecutionStore);
    const initial = command();
    await expect(service.execute(initial)).resolves.toMatchObject({status: 'completed'});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({authorized: true, requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)}));
    const firstHash = execute.mock.calls[0]![0].requestHash;
    await service.execute({...initial, commandId: randomUUID(), correlationId: randomUUID(), issuedAt: '2026-08-09T10:00:01.000Z'});
    expect(execute.mock.calls[1]![0].requestHash).toBe(firstHash);
    await expect(service.execute({...command(), payload: {projectId: randomUUID(), expectedVersion: 1}})).resolves.toMatchObject({status: 'rejected', error: {code: 'INVALID_COMMAND'}});
  });

  it('rejects missing capability before persistence and maps idempotency reuse', async () => {
    const execute = vi.fn().mockResolvedValue({status: 'key_reused', existingRequestHash: 'a'.repeat(64)});
    const service = createProjectExecutionService({execute} as ProjectExecutionStore);
    await service.execute(command(trusted([])));
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({authorized: false}));
    await expect(service.execute(command())).resolves.toMatchObject({status: 'key_reused', error: {code: 'IDEMPOTENCY_KEY_REUSED'}});
  });
});
