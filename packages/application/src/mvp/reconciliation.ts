import {
  decideNextAction,
  type AgentRole,
  type AgentRoleRequest,
  type MessengerDeliveryInput,
  type StatusMap,
  type TrackerReadPort,
  type TrackerItemFact,
  type TrackerSnapshot
} from '@fai-control-plane/domain';
import type {AuditStore, OutboxStore, SnapshotStore} from './contracts.ts';

export type ReconciliationPorts = Readonly<{
  tracker: TrackerReadPort;
  snapshots: SnapshotStore;
  outbox: OutboxStore;
  audit: AuditStore;
  compose: Readonly<{
    agentRequest(item: TrackerItemFact, role: AgentRole, idempotencyKey: string): Promise<AgentRoleRequest>;
    notification(item: TrackerItemFact, reason: string, idempotencyKey: string): Promise<MessengerDeliveryInput>;
  }>;
}>;

export type ReconciliationResult = Readonly<{
  observedItems: number;
  queuedActions: number;
  cursor: string | null;
}>;

/** One provider read, one factual snapshot, and intent only for actionable items. */
export const reconcileTracker = async (input: Readonly<{
  bindingId: string;
  workspaceId: string;
  projectId: string;
  cursor: string | null;
  statusMap: StatusMap;
  ports: ReconciliationPorts;
}>): Promise<ReconciliationResult> => {
  const snapshot: TrackerSnapshot = await input.ports.tracker.readSnapshot(input.bindingId, input.cursor);
  if (snapshot.bindingId !== input.bindingId) throw new Error('tracker_binding_mismatch');
  if (snapshot.items.some((item) => item.projectId !== input.projectId)) throw new Error('tracker_project_mismatch');
  await input.ports.snapshots.replace(snapshot);
  let queuedActions = 0;
  for (const item of snapshot.items) {
    const decision = decideNextAction(item, input.statusMap);
    if (decision.kind === 'none') continue;
    const delivery = decision.kind === 'agent' && decision.role !== null
      ? {topic: 'agent-role-request' as const, payload: {request:
          await input.ports.compose.agentRequest(item, decision.role, decision.idempotencyKey)}}
      : {topic: 'messenger-notification' as const, payload: {message:
          await input.ports.compose.notification(item, decision.reason, decision.idempotencyKey)}};
    const result = await input.ports.outbox.enqueue({
      projectId: input.projectId,
      ...delivery,
      idempotencyKey: decision.idempotencyKey,
      availableAt: snapshot.observedAt
    });
    if (result === 'enqueued') queuedActions += 1;
  }
  await input.ports.audit.append({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorId: null,
    action: 'tracker.snapshot_observed',
    targetReference: input.bindingId,
    correlationId: `reconcile:${input.bindingId}:${snapshot.cursor ?? snapshot.observedAt}`,
    occurredAt: snapshot.observedAt,
    details: {itemCount: snapshot.items.length, queuedActions, sourceUrl: snapshot.sourceUrl}
  });
  return {observedItems: snapshot.items.length, queuedActions, cursor: snapshot.cursor};
};
