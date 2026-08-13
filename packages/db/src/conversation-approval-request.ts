import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {and, eq, isNull} from 'drizzle-orm';
import {validateConversationActionEnvelope} from '@fai-control-plane/domain';
import type {
  ConversationCapabilityInput,
  ConversationExternalResult,
  ExternalApprovalRequestPort
} from '@fai-control-plane/application';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Request = ConversationCapabilityInput<'external_approval.request'>;

export type ConversationApprovalRequestErrorCode =
  | 'actor_denied'
  | 'configuration_invalid'
  | 'idempotency_conflict'
  | 'project_denied';

export class ConversationApprovalRequestError extends Error {
  readonly name = 'ConversationApprovalRequestError';
  constructor(readonly code: ConversationApprovalRequestErrorCode) {
    super(code);
  }
}

const canonical = (value: Request): string => JSON.stringify({
  projectRef: value.projectRef,
  origin: {
    visibility: value.origin.visibility,
    channelRef: value.origin.channelRef,
    actorRef: value.origin.actorRef,
    messageRef: value.origin.messageRef,
    observedAt: value.origin.observedAt
  },
  action: {
    type: value.action.type,
    reference: {
      referenceId: value.action.reference.referenceId,
      url: value.action.reference.url,
      expectedVersion: value.action.reference.expectedVersion
    }
  },
  correlationId: value.correlationId,
  idempotencyKey: value.idempotencyKey
});
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export type ConversationApprovalRequestPlan = Readonly<{
  commandId: string;
  receiptKey: string;
  requestHash: string;
  result: ConversationExternalResult;
  receiptResult: Readonly<{
    ok: true;
    value: Readonly<{
      approvalReference: Readonly<{
        referenceId: string;
        url: string;
        expectedVersion: string;
      }>;
      targetReference: Request['action']['reference'];
      origin: Pick<Request['origin'], 'actorRef' | 'messageRef' | 'observedAt'>;
    }>;
  }>;
}>;

export const prepareConversationApprovalRequest = (
  value: Request
): ConversationApprovalRequestPlan => {
  const requestHash = sha256(canonical(value));
  const referenceId = `approval:v1:${requestHash}`;
  const expectedVersion = `approval-request:v1:${requestHash}`;
  const result = {
    kind: 'approval' as const,
    referenceId,
    url: value.action.reference.url,
    version: expectedVersion
  };
  return {
    commandId: `conversation-approval-request:v1:${requestHash}`,
    receiptKey: `conversation-approval-request:${value.idempotencyKey}`,
    requestHash,
    result,
    receiptResult: {
      ok: true,
      value: {
        approvalReference: {
          referenceId,
          url: value.action.reference.url,
          expectedVersion
        },
        targetReference: value.action.reference,
        origin: {
          actorRef: value.origin.actorRef,
          messageRef: value.origin.messageRef,
          observedAt: value.origin.observedAt
        }
      }
    }
  };
};

/**
 * Persists only an exact external-reference approval fact in the generic
 * receipt/audit primitives. It does not use the legacy WorkItem/AgentRun
 * approval table and does not persist message text or a transcript.
 */
export const createPostgresConversationApprovalRequestPort = (
  db: Database,
  configuration: Readonly<{
    workspaceId: string;
    projectId: string;
    projectRef: string;
    requestedByActorId: string;
  }>
): ExternalApprovalRequestPort => ({
  async requestExternalApproval(value): Promise<ConversationExternalResult> {
    if (value.projectRef !== configuration.projectRef ||
      validateConversationActionEnvelope(value) === null) {
      throw new ConversationApprovalRequestError('configuration_invalid');
    }
    const plan = prepareConversationApprovalRequest(value);
    return db.transaction(async (tx) => {
      const [project] = await tx.select({id: schema.projects.id})
        .from(schema.projects).where(and(
          eq(schema.projects.id, configuration.projectId),
          eq(schema.projects.workspaceId, configuration.workspaceId)
        )).limit(1);
      if (project === undefined) throw new ConversationApprovalRequestError('project_denied');
      const [actor] = await tx.select({id: schema.actors.id})
        .from(schema.actors)
        .innerJoin(schema.projectMemberships, and(
          eq(schema.projectMemberships.projectId, configuration.projectId),
          eq(schema.projectMemberships.actorId, schema.actors.id),
          eq(schema.projectMemberships.active, true)
        ))
        .where(and(
          eq(schema.actors.id, configuration.requestedByActorId),
          eq(schema.actors.workspaceId, configuration.workspaceId),
          isNull(schema.actors.disabledAt)
        )).limit(1);
      if (actor === undefined) throw new ConversationApprovalRequestError('actor_denied');

      const now = new Date();
      const [inserted] = await tx.insert(schema.commandReceipts).values({
        workspaceId: configuration.workspaceId,
        idempotencyKey: plan.receiptKey,
        requestHash: plan.requestHash,
        commandId: plan.commandId,
        correlationId: value.correlationId,
        state: 'completed',
        commandType: 'conversation.external_approval.request.v1',
        aggregateType: 'external_approval',
        result: plan.receiptResult,
        createdAt: now,
        completedAt: now
      }).onConflictDoNothing({
        target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
      }).returning({id: schema.commandReceipts.id});

      if (inserted === undefined) {
        const [existing] = await tx.select({
          requestHash: schema.commandReceipts.requestHash,
          result: schema.commandReceipts.result
        }).from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.workspaceId, configuration.workspaceId),
          eq(schema.commandReceipts.idempotencyKey, plan.receiptKey)
        )).limit(1);
        if (existing?.requestHash !== plan.requestHash ||
          !isDeepStrictEqual(existing.result, plan.receiptResult)) {
          throw new ConversationApprovalRequestError('idempotency_conflict');
        }
        return plan.result;
      }

      await tx.insert(schema.auditEvents).values({
        workspaceId: configuration.workspaceId,
        projectId: configuration.projectId,
        actorId: configuration.requestedByActorId,
        commandId: plan.commandId,
        actionCategory: 'write',
        action: 'conversation.external_approval.request.v1',
        targetType: 'external_reference',
        targetId: value.action.reference.referenceId,
        policyDecision: 'ask',
        outcome: 'approval_required',
        correlationId: value.correlationId,
        occurredAt: now,
        metadata: {}
      }).onConflictDoNothing({
        target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]
      });
      return plan.result;
    });
  }
});
