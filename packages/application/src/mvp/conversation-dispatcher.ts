import type {
  InternalConversationEnvelope,
  ProjectRole
} from '@fai-control-plane/domain';
import {authorizeConversation} from '@fai-control-plane/domain';
import type {ConversationCompletionStore, ReceiptStore} from './contracts.ts';

export type ConversationIdentityPort = Readonly<{
  resolveActiveHuman(input: Readonly<{projectId: string; senderReference: string}>): Promise<Readonly<{
    actorId: string;
    role: ProjectRole;
  }> | null>;
}>;

type SharedPorts = Readonly<{
  sources: Readonly<{add(input: Readonly<{
    projectId: string;
    actorId: string;
    name: string;
    content: string;
    messageReference: string;
  }>): Promise<Readonly<{referenceId: string}>>}>;
  approvals: Readonly<{decide(input: Readonly<{
    projectId: string; actorId: string; approvalId: string;
    kind: 'plan' | 'internal_operation' | 'production' | 'acceptance' | 'client_uat';
    targetReference: string; decision: 'approved' | 'rejected'; idempotencyKey: string;
  }>): Promise<Readonly<{referenceId: string}>>}>;
  identities: ConversationIdentityPort;
  receipts: ReceiptStore;
  completion: ConversationCompletionStore;
  executionMode: Readonly<{configure(input: Readonly<{actorId: string; projectId: string;
    mode: 'manual'|'autonomous'; idempotencyKey: string; observedAt: string}>): Promise<Readonly<{referenceId: string}>>}>;
}>;

export type InternalConversationPorts = SharedPorts;
type Result = Readonly<{status: 'completed' | 'duplicate' | 'denied'; referenceId?: string}>;

const dispatch = async (input: Readonly<{
  workspaceId: string;
  envelope: InternalConversationEnvelope;
  ports: InternalConversationPorts;
}>): Promise<Result> => {
  const {envelope, ports} = input;
  if (!authorizeConversation(envelope) || envelope.message.contour !== 'trusted-main') return {status: 'denied'};
  const identity = await ports.identities.resolveActiveHuman({projectId: envelope.message.projectId,
    senderReference: envelope.message.senderReference});
  if (identity === null || identity.role === 'client') return {status: 'denied'};
  if (await ports.receipts.exists(envelope.message.idempotencyKey)) return {status: 'duplicate'};
  let referenceId: string;
  const actorId = identity.actorId;
  switch (envelope.action.type) {
    case 'project_context.read':
      return {status: 'denied'};
    case 'project.execution.mode': {
      if (!['project_owner','operator'].includes(identity.role)) return {status: 'denied'};
      referenceId = (await ports.executionMode.configure({actorId, projectId: envelope.message.projectId,
        mode: envelope.action.mode, idempotencyKey: envelope.message.idempotencyKey,
        observedAt: envelope.message.observedAt})).referenceId;
      break;
    }
    case 'source.add': {
      referenceId = (await ports.sources.add({projectId: envelope.message.projectId, actorId,
        name: envelope.action.name, content: envelope.action.content,
        messageReference: envelope.message.messageReference})).referenceId;
      break;
    }
    case 'approval.decide': {
      referenceId = (await ports.approvals.decide({projectId: envelope.message.projectId, actorId,
        approvalId: envelope.action.approvalId, kind: envelope.action.kind,
        targetReference: envelope.action.targetReference, decision: envelope.action.decision,
        idempotencyKey: envelope.message.idempotencyKey})).referenceId;
      break;
    }
  }
  await ports.completion.complete({workspaceId: input.workspaceId, projectId: envelope.message.projectId,
    actorId, idempotencyKey: envelope.message.idempotencyKey, commandType: envelope.action.type,
    resultReference: referenceId, action: `conversation.${envelope.action.type}`, targetReference: referenceId,
    correlationId: envelope.message.correlationId, occurredAt: envelope.message.observedAt,
    details: {contour: envelope.message.contour, senderReference: envelope.message.senderReference,
      messageReference: envelope.message.messageReference}});
  return {status: 'completed', referenceId};
};

export const dispatchConversationAction = (input: Readonly<{
  workspaceId: string; envelope: InternalConversationEnvelope; ports: InternalConversationPorts;
}>): Promise<Result> => dispatch(input);
