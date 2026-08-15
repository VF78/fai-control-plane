import {createHash} from 'node:crypto';
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
    notificationSummary(count: number, sourceUrl: string, idempotencyKey: string): Promise<MessengerDeliveryInput>;
  }>;
}>;

export type ReconciliationResult = Readonly<{
  observedItems: number;
  queuedActions: number;
  cursor: string | null;
}>;

const summaryKey = (bindingId: string, externalVersion: string): string =>
  `tracker-notification-summary:sha256:${createHash('sha256').update(`${bindingId}\n${externalVersion}`).digest('hex')}`;

/** One provider read, one factual snapshot, and notifications only for human-owned action. */
export const reconcileTracker = async (input: Readonly<{
  bindingId: string;
  workspaceId: string;
  projectId: string;
  cursor: string | null;
  statusMap: StatusMap;
  ports: ReconciliationPorts;
}>): Promise<ReconciliationResult> => {
  const previous = await input.ports.snapshots.readLatest(input.bindingId);
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
  // Provider adapters may replace an opaque/null cursor model while still returning a
  // full repair snapshot. Both the first observation and that model transition establish
  // a baseline; neither is evidence that every historical item changed.
  const establishesBaseline = previous === null || (previous.cursor === null && snapshot.cursor !== null);
  const previousItems = new Map(previous?.items.map((item) => [item.itemId, item]));
  const changedItems = establishesBaseline ? [] : snapshot.items.filter((item) => {
    const prior = previousItems.get(item.itemId);
    return prior === undefined || prior.version !== item.version;
  });
  const notificationItems = changedItems.filter((item) => decideNextAction(item, input.statusMap).kind === 'human');
  let queuedActions = 0;
  if (notificationItems.length === 1) {
    const item = notificationItems[0]!;
    const decision = decideNextAction(item, input.statusMap);
    // Tracker state is factual input, never authority to start an agent. Agent execution
    // is available only through an authenticated human conversation command. The first
    // provider read establishes a baseline, so historical human-status items cannot
    // flood the internal chat; only version-different facts can notify a person.
    const delivery = {topic: 'messenger-notification' as const, payload: {message:
      await input.ports.compose.notification(item, decision.reason, decision.idempotencyKey)}};
    const result = await input.ports.outbox.enqueue({
      projectId: input.projectId,
      ...delivery,
      idempotencyKey: decision.idempotencyKey,
      availableAt: snapshot.observedAt
    });
    if (result === 'enqueued') queuedActions += 1;
  } else if (notificationItems.length > 1) {
    const idempotencyKey = summaryKey(input.bindingId, snapshot.externalVersion);
    const message = await input.ports.compose.notificationSummary(
      notificationItems.length, snapshot.sourceUrl, idempotencyKey
    );
    const result = await input.ports.outbox.enqueue({projectId: input.projectId,
      topic: 'messenger-notification', payload: {message}, idempotencyKey, availableAt: snapshot.observedAt});
    if (result === 'enqueued') queuedActions += 1;
  }
  // Advance the comparison baseline only after durable notification intent. A retry
  // after compose/outbox failure sees the same changes; idempotency handles partial success.
  await input.ports.snapshots.replace(snapshot);
  await input.ports.audit.append({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorId: null,
    action: 'tracker.snapshot_observed',
    targetReference: input.bindingId,
    correlationId: `reconcile:${input.bindingId}:${snapshot.cursor ?? snapshot.observedAt}`,
    occurredAt: snapshot.observedAt,
    details: {itemCount: snapshot.items.length, changedItemCount: changedItems.length,
      notificationCandidateCount: notificationItems.length,
      aggregatedNotificationCount: notificationItems.length > 1 ? notificationItems.length : 0,
      baselineEstablished: establishesBaseline, queuedActions, sourceUrl: snapshot.sourceUrl}
  });
  return {observedItems: snapshot.items.length, queuedActions, cursor: snapshot.cursor};
};
