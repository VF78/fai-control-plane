import {
  validateConversationInboundMessage,
  type ConversationInboundMessage,
  type ConversationRuntimeDeliveryAcknowledgement,
  type ConversationRuntimeDeliveryPort
} from '@fai-control-plane/domain';
import {
  createConversationDispatcher,
  type ConversationCapabilityPorts,
  type ConversationDispatchResult,
  type TrustedConversationCapabilityPorts
} from './conversation-dispatcher.ts';

export type ConversationIngressPort<Request, Rejection extends string> = Readonly<{
  receive(request: Request): Promise<
    | Readonly<{status: 'accepted'; message: ConversationInboundMessage}>
    | Readonly<{status: 'rejected'; reason: Rejection}>
  >;
}>;

export type ConversationMessageProcess = Readonly<{
  deliverMessage(value: unknown): Promise<ConversationRuntimeDeliveryAcknowledgement>;
}>;

/** One transport ingress bound to one composition-owned process contour. */
export const bindConversationIngress = <Request, Rejection extends string>(input: Readonly<{
  ingress: ConversationIngressPort<Request, Rejection>;
  process: ConversationMessageProcess;
}>) => ({
  async handle(request: Request): Promise<
    | Readonly<{status: 'rejected'; reason: Rejection}>
    | Readonly<{status: 'delivered'; acknowledgement: ConversationRuntimeDeliveryAcknowledgement}>
  > {
    const received = await input.ingress.receive(request);
    if (received.status === 'rejected') return received;
    return {
      status: 'delivered',
      acknowledgement: await input.process.deliverMessage(received.message)
    };
  }
});

export class ConversationProcessCompositionError extends Error {
  readonly name = 'ConversationProcessCompositionError';
  constructor(readonly code: 'invalid_message' | 'visibility_boundary') {
    super(code);
  }
}

const acceptedMessage = (
  value: unknown,
  visibility: ConversationInboundMessage['origin']['visibility']
): ConversationInboundMessage => {
  const message = validateConversationInboundMessage(value);
  if (message === null) throw new ConversationProcessCompositionError('invalid_message');
  if (message.origin.visibility !== visibility) {
    throw new ConversationProcessCompositionError('visibility_boundary');
  }
  return message;
};

/** Composition-owned client process. Its type cannot contain AgentDeliveryPort. */
export const createClientEdgeConversationProcess = (input: Readonly<{
  delivery: ConversationRuntimeDeliveryPort;
  capabilities: ConversationCapabilityPorts;
}>) => {
  const dispatcher = createConversationDispatcher({
    contour: 'client-edge',
    ports: input.capabilities
  });
  return Object.freeze({
    contour: 'client-edge' as const,
    async deliverMessage(value: unknown): Promise<ConversationRuntimeDeliveryAcknowledgement> {
      return input.delivery.deliver(acceptedMessage(value, 'client'));
    },
    dispatchAction(value: unknown): Promise<ConversationDispatchResult> {
      return dispatcher.dispatch(value);
    }
  });
};

/** Composition-owned internal process with the existing bounded role-delivery port. */
export const createTrustedMainConversationProcess = (input: Readonly<{
  delivery: ConversationRuntimeDeliveryPort;
  capabilities: TrustedConversationCapabilityPorts;
}>) => {
  const dispatcher = createConversationDispatcher({
    contour: 'trusted-main',
    ports: input.capabilities
  });
  return Object.freeze({
    contour: 'trusted-main' as const,
    async deliverMessage(value: unknown): Promise<ConversationRuntimeDeliveryAcknowledgement> {
      return input.delivery.deliver(acceptedMessage(value, 'internal'));
    },
    dispatchAction(value: unknown): Promise<ConversationDispatchResult> {
      return dispatcher.dispatch(value);
    }
  });
};
