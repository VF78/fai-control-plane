import {
  type AgentRoleRequest,
  validateAgentRoleRequest
} from './agent-role-request.ts';

export const conversationTrustContours = ['trusted-main', 'client-edge'] as const;
export type ConversationTrustContour = (typeof conversationTrustContours)[number];

export const conversationCapabilities = [
  'client_project_facts.read',
  'issue_intake.create',
  'issue_intake.clarify',
  'source_context.add',
  'external_approval.request',
  'agent_role_request.submit'
] as const;
export type ConversationCapability = (typeof conversationCapabilities)[number];

export type ConversationSourceReference = Readonly<{
  referenceId: string;
  url: string;
}>;

export type ConversationExternalReference = Readonly<{
  referenceId: string;
  url: string;
  expectedVersion: string;
}>;

/**
 * Provider-native message, channel and sender identities are converted to
 * opaque references by composition. The envelope is transient action input,
 * never a persisted transcript.
 */
export type ConversationOrigin = Readonly<{
  visibility: 'internal' | 'client';
  channelRef: string;
  actorRef: string;
  messageRef: string;
  observedAt: string;
}>;

export type ConversationAction =
  | Readonly<{type: 'client_project_facts.read'}>
  | Readonly<{
      type: 'issue_intake.create';
      title: string;
      statement: string;
      source: ConversationSourceReference;
    }>
  | Readonly<{
      type: 'issue_intake.clarify';
      issueReference: ConversationExternalReference;
      clarification: string;
      source: ConversationSourceReference;
    }>
  | Readonly<{
      type: 'source_context.add';
      targetReference: ConversationExternalReference;
      statement: string;
      source: ConversationSourceReference;
    }>
  | Readonly<{
      type: 'external_approval.request';
      reference: ConversationExternalReference;
    }>
  | Readonly<{
      type: 'agent_role_request.submit';
      request: AgentRoleRequest;
    }>;

export type ConversationActionEnvelope = Readonly<{
  projectRef: string;
  origin: ConversationOrigin;
  action: ConversationAction;
  correlationId: string;
  idempotencyKey: string;
}>;

/**
 * A bounded, provider-neutral message passed across a conversation trust
 * contour for interpretation. It is transient input, never chat history.
 */
export type ConversationInboundMessage = Readonly<{
  projectRef: string;
  origin: ConversationOrigin;
  text: string;
  correlationId: string;
  idempotencyKey: string;
}>;

/**
 * Runtime-owned references proving only that a transient message was accepted
 * for delivery. They are not run state or conversation history.
 */
export type ConversationRuntimeDeliveryAcknowledgement = Readonly<{
  deliveryReference: string;
  sessionReference: string;
}>;

/**
 * Implemented by the composition-selected conversation runtime. A replacement
 * runtime receives the same bounded envelope and returns only opaque evidence.
 */
export type ConversationRuntimeDeliveryPort = Readonly<{
  deliver(
    message: ConversationInboundMessage
  ): Promise<ConversationRuntimeDeliveryAcknowledgement>;
}>;

/** The only conversation-derived shape allowed to reach persistence. */
export type ConversationActionEvidence = Readonly<{
  projectRef: string;
  capability: ConversationCapability;
  actorRef: string;
  messageRef: string;
  observedAt: string;
  correlationId: string;
  idempotencyKey: string;
  result: Readonly<{
    kind: 'issue' | 'source' | 'approval' | 'agent_delivery';
    referenceId: string;
    url?: string;
    version?: string;
  }>;
}>;

export type ConversationAuthorization =
  | Readonly<{
      decision: 'allow';
      capability: ConversationCapability;
      envelope: ConversationActionEnvelope;
    }>
  | Readonly<{
      decision: 'deny';
      reason: 'invalid_envelope' | 'visibility_boundary' | 'capability_denied';
    }>;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const bounded = (value: unknown, maximum = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum &&
  !/[\0\r]/.test(value);
const singleLine = (value: unknown, maximum = 256): value is string =>
  bounded(value, maximum) && !value.includes('\n');
const httpsUrl = (value: unknown): value is string => {
  if (!singleLine(value, 2048)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
};
const instant = (value: unknown): value is string =>
  singleLine(value, 64) && !Number.isNaN(new Date(value).getTime());

const sourceReference = (value: unknown): value is ConversationSourceReference => {
  const candidate = object(value);
  return candidate !== null && exact(candidate, ['referenceId', 'url']) &&
    singleLine(candidate.referenceId) && httpsUrl(candidate.url);
};
const externalReference = (value: unknown): value is ConversationExternalReference => {
  const candidate = object(value);
  return candidate !== null && exact(candidate, ['expectedVersion', 'referenceId', 'url']) &&
    singleLine(candidate.referenceId) && httpsUrl(candidate.url) &&
    singleLine(candidate.expectedVersion);
};
const origin = (value: unknown): value is ConversationOrigin => {
  const candidate = object(value);
  return candidate !== null && exact(candidate, [
    'actorRef', 'channelRef', 'messageRef', 'observedAt', 'visibility'
  ]) && (candidate.visibility === 'internal' || candidate.visibility === 'client') &&
    singleLine(candidate.channelRef) && singleLine(candidate.actorRef) &&
    singleLine(candidate.messageRef) && instant(candidate.observedAt);
};

const action = (value: unknown): value is ConversationAction => {
  const candidate = object(value);
  if (candidate === null || !singleLine(candidate.type, 64)) return false;
  switch (candidate.type) {
    case 'client_project_facts.read':
      return exact(candidate, ['type']);
    case 'issue_intake.create':
      return exact(candidate, ['source', 'statement', 'title', 'type']) &&
        singleLine(candidate.title, 160) && bounded(candidate.statement, 4000) &&
        sourceReference(candidate.source);
    case 'issue_intake.clarify':
      return exact(candidate, ['clarification', 'issueReference', 'source', 'type']) &&
        bounded(candidate.clarification, 4000) && externalReference(candidate.issueReference) &&
        sourceReference(candidate.source);
    case 'source_context.add':
      return exact(candidate, ['source', 'statement', 'targetReference', 'type']) &&
        bounded(candidate.statement, 4000) && externalReference(candidate.targetReference) &&
        sourceReference(candidate.source);
    case 'external_approval.request':
      return exact(candidate, ['reference', 'type']) && externalReference(candidate.reference);
    case 'agent_role_request.submit':
      return exact(candidate, ['request', 'type']) && validateAgentRoleRequest(candidate.request) !== null;
    default:
      return false;
  }
};

export const validateConversationActionEnvelope = (
  value: unknown
): ConversationActionEnvelope | null => {
  const candidate = object(value);
  if (
    candidate === null ||
    !exact(candidate, ['action', 'correlationId', 'idempotencyKey', 'origin', 'projectRef']) ||
    !singleLine(candidate.projectRef) ||
    !origin(candidate.origin) ||
    !action(candidate.action) ||
    !singleLine(candidate.correlationId) ||
    !singleLine(candidate.idempotencyKey)
  ) return null;
  return value as ConversationActionEnvelope;
};

export const validateConversationInboundMessage = (
  value: unknown
): ConversationInboundMessage | null => {
  const candidate = object(value);
  if (
    candidate === null ||
    !exact(candidate, ['correlationId', 'idempotencyKey', 'origin', 'projectRef', 'text']) ||
    !singleLine(candidate.projectRef) || !origin(candidate.origin) ||
    !bounded(candidate.text, 4_000) || !singleLine(candidate.correlationId) ||
    !singleLine(candidate.idempotencyKey)
  ) return null;
  return value as ConversationInboundMessage;
};

export const validateConversationRuntimeDeliveryAcknowledgement = (
  value: unknown
): ConversationRuntimeDeliveryAcknowledgement | null => {
  const candidate = object(value);
  if (
    candidate === null ||
    !exact(candidate, ['deliveryReference', 'sessionReference']) ||
    !singleLine(candidate.deliveryReference) ||
    !singleLine(candidate.sessionReference)
  ) return null;
  return value as ConversationRuntimeDeliveryAcknowledgement;
};

const clientEdgeCapabilities = new Set<ConversationCapability>([
  'client_project_facts.read',
  'issue_intake.create',
  'issue_intake.clarify',
  'source_context.add',
  'external_approval.request'
]);

/**
 * The trust contour is supplied by OS-isolated composition, never by a caller,
 * child agent, chat identity or envelope field.
 */
export const authorizeConversationAction = (
  contour: ConversationTrustContour,
  value: unknown
): ConversationAuthorization => {
  const envelope = validateConversationActionEnvelope(value);
  if (envelope === null) return {decision: 'deny', reason: 'invalid_envelope'};
  if (
    (contour === 'trusted-main' && envelope.origin.visibility !== 'internal') ||
    (contour === 'client-edge' && envelope.origin.visibility !== 'client')
  ) return {decision: 'deny', reason: 'visibility_boundary'};
  const capability = envelope.action.type;
  if (contour === 'client-edge' && !clientEdgeCapabilities.has(capability)) {
    return {decision: 'deny', reason: 'capability_denied'};
  }
  return {decision: 'allow', capability, envelope};
};

export const validateConversationActionEvidence = (
  value: unknown
): ConversationActionEvidence | null => {
  const candidate = object(value);
  const result = object(candidate?.result);
  if (
    candidate === null ||
    !exact(candidate, [
      'actorRef', 'capability', 'correlationId', 'idempotencyKey', 'messageRef',
      'observedAt', 'projectRef', 'result'
    ]) ||
    !singleLine(candidate.projectRef) ||
    !conversationCapabilities.includes(candidate.capability as ConversationCapability) ||
    !singleLine(candidate.actorRef) || !singleLine(candidate.messageRef) ||
    !instant(candidate.observedAt) || !singleLine(candidate.correlationId) ||
    !singleLine(candidate.idempotencyKey) || result === null ||
    !['issue', 'source', 'approval', 'agent_delivery'].includes(result.kind as string) ||
    !singleLine(result.referenceId) ||
    (result.url !== undefined && !httpsUrl(result.url)) ||
    (result.version !== undefined && !singleLine(result.version)) ||
    !exact(result, [
      'kind', 'referenceId',
      ...(result.url === undefined ? [] : ['url']),
      ...(result.version === undefined ? [] : ['version'])
    ])
  ) return null;
  return value as ConversationActionEvidence;
};
