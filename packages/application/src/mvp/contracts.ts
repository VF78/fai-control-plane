import type {
  AgentRoleRequest,
  ApprovalEvidence,
  MessengerDeliveryInput,
  TrackerSnapshot
} from '@fai-control-plane/domain';

export type ReceiptStore = Readonly<{
  exists(idempotencyKey: string): Promise<boolean>;
  record(input: Readonly<{
    projectId: string;
    idempotencyKey: string;
    commandType: string;
    resultReference: string;
    occurredAt: string;
  }>): Promise<void>;
}>;

export type SnapshotStore = Readonly<{
  replace(snapshot: TrackerSnapshot): Promise<void>;
  recordFailure(input: Readonly<{
    bindingId: string;
    observedAt: string;
    errorCode: string;
  }>): Promise<void>;
}>;

export type PublishedApprovalTargetPort = Readonly<{
  resolve(input: Readonly<{projectId: string; targetReference: string}>): Promise<ApprovalEvidence['target'] | null>;
}>;

/** Implementations own one transaction containing evidence, receipt and audit. */
export type ApprovalTransactionStore = Readonly<{
  record(input: Readonly<{workspaceId: string; evidence: ApprovalEvidence}>): Promise<'recorded' | 'duplicate' | 'conflict'>;
}>;

export type OutboxRecord = Readonly<{
  projectId: string;
  idempotencyKey: string;
  availableAt: string;
}> & (
  | Readonly<{topic: 'agent-role-request'; payload: Readonly<{request: AgentRoleRequest}>}>
  | Readonly<{topic: 'messenger-notification'; payload: Readonly<{message: MessengerDeliveryInput}>}>
);

export type OutboxStore = Readonly<{
  enqueue(record: OutboxRecord): Promise<'enqueued' | 'duplicate'>;
  claim(limit: number, now: string): Promise<readonly Readonly<OutboxRecord & {id: string; attempts: number}>[]>;
  complete(id: string, deliveryReference: string, occurredAt: string): Promise<void>;
  retry(id: string, nextAttemptAt: string, errorCode: string): Promise<void>;
}>;

export type AuditStore = Readonly<{
  append(input: Readonly<{
    workspaceId: string;
    projectId: string | null;
    actorId: string | null;
    action: string;
    targetReference: string;
    correlationId: string;
    occurredAt: string;
    details: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
}>;

export type ConversationCompletionStore = Readonly<{
  complete(input: Readonly<{
    workspaceId: string; projectId: string; actorId: string | null; idempotencyKey: string;
    commandType: string; resultReference: string; action: string; targetReference: string;
    correlationId: string; occurredAt: string; details: Readonly<Record<string, unknown>>;
  }>): Promise<'recorded' | 'duplicate'>;
}>;
