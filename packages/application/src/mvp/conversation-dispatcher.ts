import type {
  AgentDeliveryPort,
  ClientConversationEnvelope,
  InternalConversationEnvelope,
  TrackerMutationPort
} from '@fai-control-plane/domain';
import {authorizeConversation} from '@fai-control-plane/domain';
import type {ConversationCompletionStore, ReceiptStore} from './contracts.ts';

export type ConversationIdentityPort = Readonly<{
  resolveActiveHuman(input: Readonly<{projectId: string; senderReference: string}>): Promise<Readonly<{actorId: string}> | null>;
}>;

type SharedPorts = Readonly<{
  facts: Readonly<{read(projectId: string): Promise<Readonly<{referenceId: string}>>}>;
  tracker: TrackerMutationPort;
  approvals: Readonly<{decide(input: Readonly<{
    projectId: string; actorId: string; approvalId: string;
    kind: 'plan' | 'internal_operation' | 'production' | 'acceptance' | 'client_uat';
    targetReference: string; decision: 'approved' | 'rejected'; idempotencyKey: string;
  }>): Promise<Readonly<{referenceId: string}>>}>;
  identities: ConversationIdentityPort;
  receipts: ReceiptStore;
  completion: ConversationCompletionStore;
}>;

export type ClientConversationPorts = SharedPorts;
export type InternalConversationPorts = SharedPorts & Readonly<{agent: AgentDeliveryPort}>;
type Result = Readonly<{status: 'completed' | 'duplicate' | 'denied'; referenceId?: string}>;

const dispatch = async (input: Readonly<{
  workspaceId: string;
  envelope: ClientConversationEnvelope | InternalConversationEnvelope;
  ports: ClientConversationPorts | InternalConversationPorts;
}>): Promise<Result> => {
  const {envelope, ports} = input;
  if (!authorizeConversation(envelope)) return {status: 'denied'};
  if (await ports.receipts.exists(envelope.message.idempotencyKey)) return {status: 'duplicate'};
  let referenceId: string;
  let actorId: string | null = null;
  switch (envelope.action.type) {
    case 'project_facts.read':
      referenceId = (await ports.facts.read(envelope.message.projectId)).referenceId;
      break;
    case 'issue.create': {
      const identity = await ports.identities.resolveActiveHuman({projectId: envelope.message.projectId,
        senderReference: envelope.message.senderReference});
      if (identity === null) return {status: 'denied'};
      actorId = identity.actorId;
      referenceId = (await ports.tracker.createIssue({projectId: envelope.message.projectId,
        title: envelope.action.title, statement: envelope.action.statement,
        idempotencyKey: envelope.message.idempotencyKey})).referenceId;
      break;
    }
    case 'issue.clarify': {
      const identity = await ports.identities.resolveActiveHuman({projectId: envelope.message.projectId,
        senderReference: envelope.message.senderReference});
      if (identity === null) return {status: 'denied'};
      actorId = identity.actorId;
      referenceId = (await ports.tracker.addIssueContext({referenceId: envelope.action.referenceId,
        expectedVersion: envelope.action.expectedVersion, statement: envelope.action.statement,
        idempotencyKey: envelope.message.idempotencyKey})).referenceId;
      break;
    }
    case 'approval.decide': {
      const identity = await ports.identities.resolveActiveHuman({projectId: envelope.message.projectId,
        senderReference: envelope.message.senderReference});
      if (identity === null) return {status: 'denied'};
      actorId = identity.actorId;
      referenceId = (await ports.approvals.decide({projectId: envelope.message.projectId, actorId,
        approvalId: envelope.action.approvalId, kind: envelope.action.kind,
        targetReference: envelope.action.targetReference, decision: envelope.action.decision,
        idempotencyKey: envelope.message.idempotencyKey})).referenceId;
      break;
    }
    case 'agent.submit': {
      if (envelope.message.contour !== 'trusted-main' || !('agent' in ports)) return {status: 'denied'};
      referenceId = (await ports.agent.submit(envelope.action.request)).deliveryReference;
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

export const dispatchClientConversationAction = (input: Readonly<{
  workspaceId: string; envelope: ClientConversationEnvelope; ports: ClientConversationPorts;
}>): Promise<Result> => dispatch(input);

export const dispatchConversationAction = (input: Readonly<{
  workspaceId: string; envelope: InternalConversationEnvelope; ports: InternalConversationPorts;
}>): Promise<Result> => dispatch(input);
