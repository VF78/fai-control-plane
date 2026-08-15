import {
  decideNextAction,
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
    notification(item: TrackerItemFact, reason: string, idempotencyKey: string): Promise<MessengerDeliveryInput>;
  }>;
}>;

export type ReconciliationResult = Readonly<{
  observedItems: number;
  queuedActions: number;
  cursor: string | null;
}>;

/** One provider read, one factual snapshot, and notifications only for human-owned action. */
export const reconcileTracker = async (input: Readonly<{
  bindingId: string;
  workspaceId: string;
  projectId: string;
  cursor: string | null;
  statusMap: StatusMap;
  ports: ReconciliationPorts;
}>): Promise<ReconciliationResult> => {
  let snapshot: TrackerSnapshot;
  try {
    snapshot = await input.ports.tracker.readSnapshot(input.bindingId, input.cursor);
  } catch (error) {
    const errorCode = error instanceof Error && /^[a-z0-9_]{1,100}$/.test(error.message)
      ? error.message
      : 'tracker_read_failed';
    const observedAt = new Date().toISOString();
    await input.ports.snapshots.recordFailure({bindingId: input.bindingId, observedAt, errorCode});
    await input.ports.audit.append({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorId: null,
      action: 'tracker.snapshot_failed',
      targetReference: input.bindingId,
      correlationId: `reconcile:${input.bindingId}:${observedAt}`,
      occurredAt: observedAt,
      details: {errorCode}
    });
    throw error;
  }
  if (snapshot.bindingId !== input.bindingId) throw new Error('tracker_binding_mismatch');
  if (snapshot.items.some((item) => item.projectId !== input.projectId)) throw new Error('tracker_project_mismatch');
  await input.ports.snapshots.replace(snapshot);
  let queuedActions = 0;
  for (const item of snapshot.items) {
    const decision = decideNextAction(item, input.statusMap);
    // Tracker state is factual input, never authority to start an agent. Agent execution
    // is available only through an authenticated human conversation command. The first
    // provider read establishes a baseline, so historical human-status items cannot
    // flood the internal chat; only later changes can notify a person.
    if (input.cursor === null || decision.kind !== 'human') continue;
    const delivery = {topic: 'messenger-notification' as const, payload: {message:
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
