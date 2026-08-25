import type {
  ClientConversationEnvelope,
  InternalConversationEnvelope,
  ProjectRole,
  TrackerMutationPort
} from '@fai-control-plane/domain';
import {authorizeConversation} from '@fai-control-plane/domain';
import type {ConversationCompletionStore, ReceiptStore} from './contracts.ts';

export type ConversationIdentityPort = Readonly<{
  resolveActiveHuman(input: Readonly<{projectId: string; senderReference: string}>): Promise<Readonly<{
    actorId: string;
    role: ProjectRole;
  }> | null>;
}>;

export type ReceiptBoundRoleRun = Readonly<{
  sessionId: string; actorId: string; projectId: string; requesterRole: ProjectRole;
  role: 'manager' | 'developer' | 'qa'; itemId: string; observedVersion: string; occurredAt: string;
  allowedStageTitles: readonly string[];
}>;

type SharedPorts = Readonly<{
  facts: Readonly<{read(projectId: string): Promise<Readonly<{referenceId: string}>>}>;
  tracker: TrackerMutationPort;
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
  /** One canonical root command. The implementation pins provider facts and starts only that exact item. */
  processStart?: Readonly<{execute(input: Readonly<{actorId: string; projectId: string;
    task: Extract<InternalConversationEnvelope['action'], {type: 'process.start'}>['task'];
    sourceReference: string; idempotencyKey: string}>): Promise<Readonly<{referenceId: string}>>}>;
}>;

export type ClientConversationPorts = SharedPorts;
export type InternalConversationPorts = SharedPorts;
type Result = Readonly<{status: 'completed' | 'duplicate' | 'denied'; referenceId?: string}>;

const dispatch = async (input: Readonly<{
  workspaceId: string;
  envelope: ClientConversationEnvelope | InternalConversationEnvelope;
  ports: ClientConversationPorts | InternalConversationPorts;
  roleRun?: ReceiptBoundRoleRun;
}>): Promise<Result> => {
  const {envelope, ports} = input;
  if (!authorizeConversation(envelope)) return {status: 'denied'};
  if (envelope.message.contour === 'client-edge' && envelope.action.type === 'project_item.stage') {
    return {status: 'denied'};
  }
  if (envelope.message.contour === 'client-edge' && envelope.action.type === 'process.start') return {status: 'denied'};
  const roleRun = input.roleRun;
  if (roleRun !== undefined && (envelope.message.contour !== 'trusted-main' ||
    envelope.message.correlationId !== roleRun.sessionId || envelope.message.projectId !== roleRun.projectId ||
    roleRun.requesterRole === 'client')) return {status: 'denied'};
  const identity = roleRun === undefined
    ? await ports.identities.resolveActiveHuman({projectId: envelope.message.projectId,
      senderReference: envelope.message.senderReference})
    : {actorId: roleRun.actorId, role: roleRun.requesterRole};
  if (identity === null) return {status: 'denied'};
  if (roleRun !== undefined) {
    const action = envelope.action;
    const exactTarget = 'itemId' in action && 'expectedVersion' in action &&
      action.itemId === roleRun.itemId && action.expectedVersion === roleRun.observedVersion;
    const configuredStage = action.type === 'project_item.stage' && exactTarget &&
      roleRun.allowedStageTitles.includes(action.stage);
    const allowed = action.type === 'project_facts.read' || (roleRun.role === 'manager'
      ? action.type === 'issue.create' || configuredStage || (action.type === 'issue.update' && exactTarget)
      : configuredStage);
    if (!allowed) return {status: 'denied'};
  }
  if (envelope.action.type === 'issue.update' && roleRun === undefined &&
    !['project_owner', 'operator'].includes(identity.role)) return {status: 'denied'};
  if (await ports.receipts.exists(envelope.message.idempotencyKey)) return {status: 'duplicate'};
  let referenceId: string;
  const actorId = identity.actorId;
  switch (envelope.action.type) {
    case 'project_facts.read':
      referenceId = (await ports.facts.read(envelope.message.projectId)).referenceId;
      break;
    case 'project_context.read':
      return {status: 'denied'};
    case 'issue.create': {
      referenceId = (await ports.tracker.createIssue({projectId: envelope.message.projectId,
        title: envelope.action.title, statement: envelope.action.statement,
        idempotencyKey: envelope.message.idempotencyKey})).referenceId;
      break;
    }
    case 'process.start': {
      if (envelope.message.contour !== 'trusted-main' || roleRun !== undefined || ports.processStart === undefined ||
        !['project_owner', 'operator'].includes(identity.role)) return {status: 'denied'};
      referenceId = (await ports.processStart.execute({actorId, projectId: envelope.message.projectId,
        task: envelope.action.task, sourceReference: envelope.message.messageReference,
        idempotencyKey: envelope.message.idempotencyKey})).referenceId;
      break;
    }
    case 'issue.update': {
      referenceId = (await ports.tracker.updateIssue({projectId: envelope.message.projectId,
        itemId: envelope.action.itemId, issueId: envelope.action.issueId,
        expectedVersion: envelope.action.expectedVersion, operation: envelope.action.operation,
        value: envelope.action.value, idempotencyKey: envelope.message.idempotencyKey})).referenceId;
      break;
    }
    case 'issue.clarify': {
      referenceId = (await ports.tracker.addIssueContext({referenceId: envelope.action.referenceId,
        expectedVersion: envelope.action.expectedVersion, statement: envelope.action.statement,
        idempotencyKey: envelope.message.idempotencyKey})).referenceId;
      break;
    }
    case 'project_item.stage': {
      referenceId = (await ports.tracker.setProjectItemStage({projectId: envelope.message.projectId,
        itemId: envelope.action.itemId, issueId: envelope.action.issueId,
        expectedVersion: envelope.action.expectedVersion, stage: envelope.action.stage,
        idempotencyKey: envelope.message.idempotencyKey})).referenceId;
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

export const dispatchClientConversationAction = (input: Readonly<{
  workspaceId: string; envelope: ClientConversationEnvelope; ports: ClientConversationPorts;
}>): Promise<Result> => dispatch(input);

export const dispatchConversationAction = (input: Readonly<{
  workspaceId: string; envelope: InternalConversationEnvelope; ports: InternalConversationPorts;
  roleRun?: ReceiptBoundRoleRun;
}>): Promise<Result> => dispatch(input);
