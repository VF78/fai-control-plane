import type {ClientMessengerInbound, InternalMessengerInbound, MessengerInbound} from './ports.ts';
import {approvalKinds, isBoundedId, isInstant, type ApprovalDecision, type ApprovalKind} from './model.ts';

export type ConversationAction =
  | Readonly<{type: 'project_context.read'; ifVersion: string | null}>
  | Readonly<{type: 'project.execution.mode'; mode: 'manual'|'autonomous'}>
  | Readonly<{type: 'source.add'; name: string; content: string}>
  | Readonly<{type: 'approval.decide'; approvalId: string; kind: 'plan' | 'internal_operation' | 'production' | 'acceptance' | 'client_uat'; targetReference: string; decision: 'approved' | 'rejected'}>;

export type ConversationEnvelope = Readonly<{
  message: MessengerInbound;
  action: ConversationAction;
}>;
export type InternalConversationEnvelope = Readonly<{message: InternalMessengerInbound; action: ConversationAction}>;
export type ClientConversationAction = ConversationAction;
export type ClientConversationEnvelope = Readonly<{message: ClientMessengerInbound; action: ClientConversationAction}>;

const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');

export const validateConversationEnvelope = (input: ConversationEnvelope): boolean => {
  const message = input.message;
  if (!isBoundedId(message.projectId) || !isBoundedId(message.channelReference) ||
    !isBoundedId(message.senderReference) || !isBoundedId(message.messageReference) ||
    !isInstant(message.observedAt) || !text(message.text, 4_000) ||
    !isBoundedId(message.correlationId) || !isBoundedId(message.idempotencyKey)) return false;
  switch (input.action.type) {
    case 'project_context.read': return input.action.ifVersion === null ||
      /^[a-f0-9]{64}$/.test(input.action.ifVersion);
    case 'project.execution.mode': return input.message.contour === 'trusted-main' &&
      (input.action.mode === 'manual' || input.action.mode === 'autonomous');
    case 'source.add': return text(input.action.name, 200) && text(input.action.content, 4_000);
    case 'approval.decide': return isBoundedId(input.action.approvalId) && isBoundedId(input.action.targetReference) &&
      approvalKinds.includes(input.action.kind) &&
      (input.action.decision === 'approved' || input.action.decision === 'rejected');
  }
};

export const parseConversationEnvelope = (value: unknown): ConversationEnvelope | null => {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.message === null || typeof record.message !== 'object' ||
    record.action === null || typeof record.action !== 'object') return null;
  const message = record.message as Record<string, unknown>; const action = record.action as Record<string, unknown>;
  const contour = message.contour;
  if (contour !== 'trusted-main' && contour !== 'client-edge') return null;
  let parsedAction: ConversationAction | null = null;
  if (action.type === 'project_context.read') parsedAction = {type: 'project_context.read',
    ifVersion: action.ifVersion === null || action.ifVersion === undefined ? null : String(action.ifVersion)};
  else if (action.type === 'project.execution.mode') parsedAction = {type: 'project.execution.mode',
    mode: action.mode as 'manual'|'autonomous'};
  else if (action.type === 'source.add') parsedAction = {type: 'source.add', name: String(action.name ?? ''),
    content: String(action.content ?? '')};
  else if (action.type === 'approval.decide') parsedAction = {type: 'approval.decide', approvalId: String(action.approvalId ?? ''),
    kind: action.kind as ApprovalKind, targetReference: String(action.targetReference ?? ''),
    decision: action.decision as ApprovalDecision};
  if (parsedAction === null) return null;
  const envelope: ConversationEnvelope = {message: {projectId: String(message.projectId ?? ''), contour,
    channelReference: String(message.channelReference ?? ''), senderReference: String(message.senderReference ?? ''),
    messageReference: String(message.messageReference ?? ''), observedAt: String(message.observedAt ?? ''),
    text: String(message.text ?? ''), correlationId: String(message.correlationId ?? ''),
    idempotencyKey: String(message.idempotencyKey ?? '')}, action: parsedAction};
  return validateConversationEnvelope(envelope) ? envelope : null;
};

export const authorizeConversation = (input: ConversationEnvelope): boolean => {
  return validateConversationEnvelope(input);
};
