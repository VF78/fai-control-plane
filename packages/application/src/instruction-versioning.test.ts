import {randomUUID} from 'node:crypto';
import {createActorContextIssuer} from '@fai-control-plane/domain';
import {describe, expect, it, vi} from 'vitest';
import {createInstructionVersionService, type InstructionVersionStore} from './instruction-versioning';

const actorFor = (capabilities: readonly ('write:control_plane:development')[]) => {
  const actorId = randomUUID();
  const issuer = createActorContextIssuer({
    users: [{actorId, capabilities}],
    agents: [],
    systems: []
  });
  if (!issuer.ok) throw new Error('issuer failed');
  const actor = issuer.value.issueUser(actorId);
  if (!actor.ok) throw new Error('actor failed');
  return actor.value;
};

describe('instruction version commands', () => {
  it('policy-checks a canonical publish command and passes a stable request hash to the store', async () => {
    const execute = vi.fn(async (input) => ({
      status: 'completed' as const,
      receipt: {
        commandId: input.command.commandId,
        workspaceId: input.command.workspaceId,
        correlationId: input.command.correlationId,
        idempotencyKey: input.command.idempotencyKey,
        requestHash: input.requestHash,
        commandType: input.command.type,
        result: {ok: false as const, error: {code: 'NOT_FOUND' as const, message: 'fixture'}},
        createdAt: input.command.issuedAt
      }
    }));
    const store = {execute, preview: vi.fn()} as unknown as InstructionVersionStore;
    const actor = actorFor(['write:control_plane:development']);
    const command = {
      commandId: randomUUID(),
      workspaceId: randomUUID(),
      correlationId: randomUUID(),
      idempotencyKey: 'publish-1',
      issuedAt: '2026-07-29T12:00:00.000Z',
      actor,
      type: 'instruction_version.publish' as const,
      payload: {
        scope: 'workspace' as const,
        versionId: randomUUID(),
        expectedVersion: null,
        approvedByActorId: actor.actorId,
        content: {instructions: 'Common', settings: {format: 'json'}}
      }
    };
    await expect(createInstructionVersionService(store).execute(command))
      .resolves.toMatchObject({status: 'completed'});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      authorized: true,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    }));

    const firstHash = execute.mock.calls[0]?.[0].requestHash;
    await createInstructionVersionService(store).execute({
      ...command,
      commandId: randomUUID(),
      correlationId: randomUUID(),
      issuedAt: '2026-07-29T12:01:00.000Z'
    });
    expect(execute.mock.calls[1]?.[0].requestHash).toBe(firstHash);
  });

  it('fails closed before persistence for secret-bearing content', async () => {
    const store = {execute: vi.fn(), preview: vi.fn()} as unknown as InstructionVersionStore;
    const actor = actorFor(['write:control_plane:development']);
    const result = await createInstructionVersionService(store).execute({
      commandId: randomUUID(), workspaceId: randomUUID(), correlationId: randomUUID(),
      idempotencyKey: 'secret', issuedAt: '2026-07-29T12:00:00.000Z', actor,
      type: 'instruction_version.publish',
      payload: {
        scope: 'workspace', versionId: randomUUID(), expectedVersion: null,
        approvedByActorId: actor.actorId,
        content: {instructions: 'password=hunter2', settings: {}}
      }
    });
    expect(result).toMatchObject({status: 'rejected', error: {code: 'SECRET_VALUE_FORBIDDEN'}});
    expect(store.execute).not.toHaveBeenCalled();
  });

  it('rejects false approval attribution before persistence', async () => {
    const store = {execute: vi.fn(), preview: vi.fn()} as unknown as InstructionVersionStore;
    const actor = actorFor(['write:control_plane:development']);
    const result = await createInstructionVersionService(store).execute({
      commandId: randomUUID(), workspaceId: randomUUID(), correlationId: randomUUID(),
      idempotencyKey: 'false-approval', issuedAt: '2026-07-29T12:00:00.000Z', actor,
      type: 'instruction_version.publish',
      payload: {
        scope: 'workspace', versionId: randomUUID(), expectedVersion: null,
        approvedByActorId: randomUUID(),
        content: {instructions: 'Safe', settings: {}}
      }
    });
    expect(result).toMatchObject({status: 'rejected', error: {code: 'INVALID_COMMAND'}});
    expect(store.execute).not.toHaveBeenCalled();
  });
});
