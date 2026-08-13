import type {AgentRoleRequest, ClientMessengerInbound, InternalMessengerInbound, MessengerInbound} from './ports.ts';
import {approvalKinds, isBoundedId, isInstant, type ApprovalDecision, type ApprovalKind} from './model.ts';
import {validateAgentRoleRequest} from './agent-role-request.ts';

export type ConversationAction =
  | Readonly<{type: 'project_facts.read'}>
  | Readonly<{type: 'issue.create'; title: string; statement: string}>
  | Readonly<{type: 'issue.clarify'; referenceId: string; expectedVersion: string; statement: string}>
  | Readonly<{type: 'approval.decide'; approvalId: string; kind: 'plan' | 'internal_operation' | 'production' | 'acceptance' | 'client_uat'; targetReference: string; decision: 'approved' | 'rejected'}>
  | Readonly<{type: 'agent.submit'; request: AgentRoleRequest}>;

export type ConversationEnvelope = Readonly<{
  message: MessengerInbound;
  action: ConversationAction;
}>;
export type InternalConversationEnvelope = Readonly<{message: InternalMessengerInbound; action: ConversationAction}>;
export type ClientConversationAction = Exclude<ConversationAction, Readonly<{type: 'agent.submit'; request: AgentRoleRequest}>>;
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
    case 'project_facts.read': return true;
    case 'issue.create': return text(input.action.title, 160) && text(input.action.statement, 4_000);
    case 'issue.clarify': return isBoundedId(input.action.referenceId) &&
      isBoundedId(input.action.expectedVersion) && text(input.action.statement, 4_000);
    case 'approval.decide': return isBoundedId(input.action.approvalId) && isBoundedId(input.action.targetReference);
    case 'agent.submit': return validateAgentRoleRequest(input.action.request);
  }
};

/** Deliberately small deterministic command grammar; free text remains pending. */
export const parseConversationCommand = (value: string): ConversationAction | null => {
  if (!text(value, 4_000)) return null;
  if (value === '/facts') return {type: 'project_facts.read'};
  if (value.startsWith('/issue ')) {
    const [title, ...statement] = value.slice(7).split(' | ');
    return text(title, 160) && text(statement.join(' | '), 4_000)
      ? {type: 'issue.create', title, statement: statement.join(' | ')} : null;
  }
  if (value.startsWith('/clarify ')) {
    const [head, ...statement] = value.slice(9).split(' | '); const [referenceId, expectedVersion] = head?.split(' ') ?? [];
    return isBoundedId(referenceId) && isBoundedId(expectedVersion) && text(statement.join(' | '), 4_000)
      ? {type: 'issue.clarify', referenceId, expectedVersion, statement: statement.join(' | ')} : null;
  }
  if (value.startsWith('/approve ')) {
    const [kind, approvalId, targetReference, decision] = value.slice(9).split(' ');
    return approvalKinds.includes(kind as (typeof approvalKinds)[number]) && isBoundedId(approvalId) &&
      isBoundedId(targetReference) && (decision === 'approved' || decision === 'rejected')
      ? {type: 'approval.decide', kind: kind as (typeof approvalKinds)[number], approvalId,
        targetReference, decision} : null;
  }
  return null;
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
  if (action.type === 'project_facts.read') parsedAction = {type: 'project_facts.read'};
  else if (action.type === 'issue.create') parsedAction = {type: 'issue.create', title: String(action.title ?? ''), statement: String(action.statement ?? '')};
  else if (action.type === 'issue.clarify') parsedAction = {type: 'issue.clarify', referenceId: String(action.referenceId ?? ''),
    expectedVersion: String(action.expectedVersion ?? ''), statement: String(action.statement ?? '')};
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
  if (!validateConversationEnvelope(input)) return false;
  if (input.message.contour === 'client-edge' && input.action.type === 'agent.submit') return false;
  return true;
};
