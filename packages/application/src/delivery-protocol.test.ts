import {randomUUID} from 'node:crypto';
import {
  createActorContextIssuer,
  defaultDeliveryProtocolDefinition
} from '@fai-control-plane/domain';
import {describe, expect, it, vi} from 'vitest';
import {
  createDeliveryProtocolService,
  type DeliveryProtocolStore
} from './delivery-protocol';

const actorFor = (capabilities: readonly (
  'read:control_plane:development' | 'write:control_plane:development'
)[]) => {
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

describe('delivery protocol service', () => {
  it('validates, authorizes, and hashes canonical draft commands', async () => {
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
    const store = {execute, simulate: vi.fn(), get: vi.fn()} as unknown as DeliveryProtocolStore;
    const actor = actorFor(['write:control_plane:development']);
    await expect(createDeliveryProtocolService(store).execute({
      commandId: randomUUID(),
      workspaceId: randomUUID(),
      correlationId: randomUUID(),
      idempotencyKey: 'draft-1',
      issuedAt: '2026-07-29T12:00:00.000Z',
      actor,
      type: 'delivery_protocol.draft',
      payload: {
        protocolId: randomUUID(),
        projectId: randomUUID(),
        name: 'Delivery',
        expectedRevision: null,
        definition: defaultDeliveryProtocolDefinition()
      }
    })).resolves.toMatchObject({status: 'completed'});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      authorized: true,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    }));
  });

  it('keeps simulation side-effect free and denies missing read capability', async () => {
    const simulate = vi.fn(async () => null);
    const execute = vi.fn();
    const store = {execute, simulate, get: vi.fn()} as unknown as DeliveryProtocolStore;
    const actor = actorFor([]);
    const result = await createDeliveryProtocolService(store).simulate({
      commandId: randomUUID(),
      workspaceId: randomUUID(),
      correlationId: randomUUID(),
      idempotencyKey: 'simulate-1',
      issuedAt: '2026-07-29T12:00:00.000Z',
      actor,
      type: 'delivery_protocol.simulate',
      payload: {
        projectId: randomUUID(),
        definition: defaultDeliveryProtocolDefinition()
      }
    });
    expect(result).toBeNull();
    expect(simulate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
