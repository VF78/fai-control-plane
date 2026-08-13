import {
  authorizeConversationAction,
  validateConversationActionEvidence,
  type AgentDeliveryPort,
  type ConversationAction,
  type ConversationActionEnvelope,
  type ConversationActionEvidence,
  type ConversationAuthorization
} from '@fai-control-plane/domain';

type ActionOf<T extends ConversationAction['type']> = Extract<ConversationAction, {type: T}>;
export type ConversationCapabilityInput<T extends ConversationAction['type']> = Readonly<{
  projectRef: string;
  origin: ConversationActionEnvelope['origin'];
  action: ActionOf<T>;
  correlationId: string;
  idempotencyKey: string;
}>;

export type ConversationExternalResult = ConversationActionEvidence['result'];
export type ClientProjectFacts = Readonly<{
  projectUrl: string;
  projectVersion: string;
  closed: boolean;
  itemCount: number;
}>;
export type ClientProjectFactsReadResult = Readonly<{
  evidence: ConversationExternalResult & Readonly<{kind: 'source'}>;
  facts: ClientProjectFacts;
}>;

export type ClientProjectFactsReadPort = Readonly<{
  readClientProjectFacts(
    input: ConversationCapabilityInput<'client_project_facts.read'>
  ): Promise<ClientProjectFactsReadResult>;
}>;

export type IssueIntakePort = Readonly<{
  createIssueIntake(
    input: ConversationCapabilityInput<'issue_intake.create'>
  ): Promise<ConversationExternalResult>;
  clarifyIssueIntake(
    input: ConversationCapabilityInput<'issue_intake.clarify'>
  ): Promise<ConversationExternalResult>;
}>;

export type SourceContextPort = Readonly<{
  addSourceContext(
    input: ConversationCapabilityInput<'source_context.add'>
  ): Promise<ConversationExternalResult>;
}>;

export type ExternalApprovalRequestPort = Readonly<{
  requestExternalApproval(
    input: ConversationCapabilityInput<'external_approval.request'>
  ): Promise<ConversationExternalResult>;
}>;

export type ConversationCapabilityPorts = ClientProjectFactsReadPort & IssueIntakePort &
  SourceContextPort & ExternalApprovalRequestPort;

export type TrustedConversationCapabilityPorts = ConversationCapabilityPorts & Readonly<{
  agentDelivery: AgentDeliveryPort;
}>;

export type ConversationDispatcherInput =
  | Readonly<{
      contour: 'client-edge';
      ports: ConversationCapabilityPorts;
    }>
  | Readonly<{
      contour: 'trusted-main';
      ports: TrustedConversationCapabilityPorts;
    }>;

type DenialReason = Extract<ConversationAuthorization, {decision: 'deny'}>['reason'];
export type ConversationDispatchResult =
  | Readonly<{status: 'denied'; reason: DenialReason | 'correlation_binding_invalid'}>
  | Readonly<{status: 'failed'; reason: 'invalid_external_result'}>
  | Readonly<{
      status: 'completed';
      evidence: ConversationActionEvidence;
      /** Transient caller output; unlike evidence, this is never a persistence shape. */
      transient?: Readonly<{kind: 'client_project_facts'; facts: ClientProjectFacts}>;
    }>;

const expectedResultKind: Readonly<Record<ConversationAction['type'], ConversationExternalResult['kind']>> = {
  'client_project_facts.read': 'source',
  'issue_intake.create': 'issue',
  'issue_intake.clarify': 'issue',
  'source_context.add': 'source',
  'external_approval.request': 'approval',
  'agent_role_request.submit': 'agent_delivery'
};

const capabilityInput = <T extends ConversationAction['type']>(
  envelope: ConversationActionEnvelope,
  action: ActionOf<T>
): ConversationCapabilityInput<T> => ({
  projectRef: envelope.projectRef,
  origin: envelope.origin,
  action,
  correlationId: envelope.correlationId,
  idempotencyKey: envelope.idempotencyKey
});

const evidence = (
  envelope: ConversationActionEnvelope,
  result: ConversationExternalResult
): ConversationActionEvidence | null => {
  if (result.kind !== expectedResultKind[envelope.action.type]) return null;
  return validateConversationActionEvidence({
    projectRef: envelope.projectRef,
    capability: envelope.action.type,
    actorRef: envelope.origin.actorRef,
    messageRef: envelope.origin.messageRef,
    observedAt: envelope.origin.observedAt,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    result
  });
};

const validFacts = (
  value: unknown,
  result: ConversationExternalResult
): value is ClientProjectFacts => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const facts = value as Record<string, unknown>;
  return Object.keys(facts).length === 4 && typeof facts.projectUrl === 'string' &&
    typeof facts.projectVersion === 'string' && facts.projectUrl === result.url &&
    facts.projectVersion === result.version && typeof facts.closed === 'boolean' &&
    Number.isSafeInteger(facts.itemCount) && (facts.itemCount as number) >= 0;
};

/**
 * Dispatches one already-bounded conversational action. The trust contour is
 * supplied by process composition and is never read from the caller envelope.
 */
export const createConversationDispatcher = (input: ConversationDispatcherInput) => ({
  async dispatch(value: unknown): Promise<ConversationDispatchResult> {
    const authorization = authorizeConversationAction(input.contour, value);
    if (authorization.decision === 'deny') {
      return {status: 'denied', reason: authorization.reason};
    }
    const envelope = authorization.envelope;
    let externalResult: ConversationExternalResult;
    let transient: Extract<ConversationDispatchResult, {status: 'completed'}>['transient'];
    switch (envelope.action.type) {
      case 'client_project_facts.read': {
        const result = await input.ports.readClientProjectFacts(
          capabilityInput(envelope, envelope.action)
        );
        externalResult = result.evidence;
        if (!validFacts(result.facts, externalResult)) {
          return {status: 'failed', reason: 'invalid_external_result'};
        }
        transient = {kind: 'client_project_facts', facts: result.facts};
        break;
      }
      case 'issue_intake.create':
        externalResult = await input.ports.createIssueIntake(
          capabilityInput(envelope, envelope.action)
        );
        break;
      case 'issue_intake.clarify':
        externalResult = await input.ports.clarifyIssueIntake(
          capabilityInput(envelope, envelope.action)
        );
        break;
      case 'source_context.add':
        externalResult = await input.ports.addSourceContext(
          capabilityInput(envelope, envelope.action)
        );
        break;
      case 'external_approval.request':
        externalResult = await input.ports.requestExternalApproval(
          capabilityInput(envelope, envelope.action)
        );
        break;
      case 'agent_role_request.submit': {
        if (input.contour !== 'trusted-main') {
          return {status: 'denied', reason: 'capability_denied'};
        }
        if (
          envelope.action.request.correlationId !== envelope.correlationId ||
          envelope.action.request.idempotencyKey !== envelope.idempotencyKey
        ) return {status: 'denied', reason: 'correlation_binding_invalid'};
        const acknowledgement = await input.ports.agentDelivery.submit(envelope.action.request);
        externalResult = {
          kind: 'agent_delivery',
          referenceId: acknowledgement.deliveryReference,
          version: acknowledgement.sessionReference
        };
        break;
      }
    }
    const completedEvidence = evidence(envelope, externalResult);
    return completedEvidence === null
      ? {status: 'failed', reason: 'invalid_external_result'}
      : {status: 'completed', evidence: completedEvidence, ...(transient === undefined ? {} : {transient})};
  }
});
