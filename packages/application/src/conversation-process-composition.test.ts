import {describe, expect, it, vi} from 'vitest';
import {
  bindConversationIngress,
  createClientEdgeConversationProcess,
  createTrustedMainConversationProcess
} from './conversation-process-composition.ts';

const origin = (visibility: 'client' | 'internal') => ({
  visibility,
  channelRef: 'channel:opaque',
  actorRef: 'actor:opaque',
  messageRef: 'message:opaque',
  observedAt: '2026-08-13T00:00:00.000Z'
});
const message = (visibility: 'client' | 'internal') => ({
  projectRef: 'project:opaque', origin: origin(visibility), text: 'One bounded message',
  correlationId: 'correlation-1', idempotencyKey: 'idempotency-1'
});
const externalResult = {kind: 'approval' as const, referenceId: 'approval:opaque'};
const clientCapabilities = {
  readClientProjectFacts: vi.fn(),
  createIssueIntake: vi.fn(),
  clarifyIssueIntake: vi.fn(),
  addSourceContext: vi.fn(),
  requestExternalApproval: vi.fn(async () => externalResult)
};

describe('conversation process composition', () => {
  it('binds a transport ingress to exactly one configured process', async () => {
    const deliverMessage = vi.fn(async () => ({
      deliveryReference: 'delivery:bound', sessionReference: 'session:bound'
    }));
    const ingress = {receive: vi.fn(async () => ({
      status: 'accepted' as const, message: message('client')
    }))};
    const binding = bindConversationIngress({ingress, process: {deliverMessage}});
    await expect(binding.handle({requestRef: 'opaque'})).resolves.toEqual({
      status: 'delivered', acknowledgement: {
        deliveryReference: 'delivery:bound', sessionReference: 'session:bound'
      }
    });
    expect(deliverMessage).toHaveBeenCalledWith(message('client'));
    const rejectedDelivery = vi.fn();
    const rejectedBinding = bindConversationIngress({
      ingress: {receive: vi.fn(async () => ({status: 'rejected' as const, reason: 'source_denied'}))},
      process: {deliverMessage: rejectedDelivery}
    });
    await expect(rejectedBinding.handle({requestRef: 'opaque'})).resolves.toEqual({
      status: 'rejected', reason: 'source_denied'
    });
    expect(rejectedDelivery).not.toHaveBeenCalled();
  });

  it('binds client-edge to client messages and a replaceable runtime delivery port', async () => {
    const deliver = vi.fn(async () => ({deliveryReference: 'delivery:1', sessionReference: 'session:1'}));
    const process = createClientEdgeConversationProcess({
      delivery: {deliver}, capabilities: clientCapabilities
    });
    await expect(process.deliverMessage(message('client'))).resolves.toEqual({
      deliveryReference: 'delivery:1', sessionReference: 'session:1'
    });
    expect(deliver).toHaveBeenCalledWith(message('client'));
    await expect(process.deliverMessage(message('internal'))).rejects.toMatchObject({
      code: 'visibility_boundary'
    });
    const agentDelivery = {submit: vi.fn(async () => ({
      deliveryReference: 'role:1', sessionReference: 'session:role'
    }))};
    const trustedProcess = createTrustedMainConversationProcess({
      delivery: {deliver: vi.fn(async () => ({
        deliveryReference: 'delivery:2', sessionReference: 'session:2'
      }))},
      capabilities: {...clientCapabilities, agentDelivery}
    });
    await expect(trustedProcess.deliverMessage(message('internal'))).resolves.toMatchObject({
      deliveryReference: 'delivery:2'
    });
    await expect(trustedProcess.deliverMessage(message('client'))).rejects.toMatchObject({
      code: 'visibility_boundary'
    });
    deliver.mockClear();
    await expect(process.deliverMessage({...message('client'), contour: 'trusted-main'}))
      .rejects.toMatchObject({code: 'invalid_message'});
    expect(deliver).not.toHaveBeenCalled();
  });
});
