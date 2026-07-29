import {randomUUID} from 'node:crypto';
import {createActorContextIssuer} from '@fai-control-plane/domain';
import {describe, expect, it, vi} from 'vitest';
import {createDeliveryJourneyService, type DeliveryJourneyStore} from './delivery-journey';

const actor = () => {
  const actorId = randomUUID();
  const issuer = createActorContextIssuer({
    users: [{actorId, capabilities: ['write:control_plane:development']}],
    agents: [], systems: []
  });
  if (!issuer.ok) throw new Error('issuer');
  const issued = issuer.value.issueUser(actorId);
  if (!issued.ok) throw new Error('actor');
  return issued.value;
};
describe('delivery journey service', () => {
  it('accepts only canonical trusted-human CAS commands and hashes requests', async () => {
    const execute = vi.fn(async (input) => ({
      status: 'completed' as const,
      receipt: {
        commandId: input.command.commandId, workspaceId: input.command.workspaceId,
        correlationId: input.command.correlationId, idempotencyKey: input.command.idempotencyKey,
        requestHash: input.requestHash, commandType: input.command.type,
        result: {ok: false as const, error: {code: 'NOT_FOUND' as const, message: 'fixture'}},
        createdAt: input.command.issuedAt
      }
    }));
    const service = createDeliveryJourneyService({execute, read: vi.fn()} as DeliveryJourneyStore);
    await expect(service.execute({
      commandId: randomUUID(), workspaceId: randomUUID(), correlationId: randomUUID(),
      idempotencyKey: 'start-1', issuedAt: '2026-07-30T10:00:00.000Z',
      actor: actor(), type: 'delivery_journey.start',
      payload: {workItemId: randomUUID(), protocolId: randomUUID(),
        expectedWorkItemVersion: 1, deadlineAt: null}
    })).resolves.toMatchObject({status: 'completed'});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      authorized: true, requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    }));
  });
});
