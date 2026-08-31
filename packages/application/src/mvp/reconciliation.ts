import {createHash} from 'node:crypto';
import {
  type MessengerDeliveryInput,
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
    statusChanged(prior: TrackerItemFact, current: TrackerItemFact,
      idempotencyKey: string): Promise<MessengerDeliveryInput>;
  }>;
  continueAgentChain?(item: TrackerItemFact): Promise<'not-authorized' | 'started' | 'duplicate'>;
}>;

export type ReconciliationResult = Readonly<{
  observedItems: number;
  queuedActions: number;
  cursor: string | null;
  externalVersion: string;
}>;

const statusChangeKey = (bindingId: string, prior: TrackerItemFact, current: TrackerItemFact): string =>
  `tracker-status-change:sha256:${createHash('sha256').update([
    bindingId, prior.itemId, prior.statusOptionId ?? 'missing', current.statusOptionId ?? 'missing', current.version
  ].join('\n')).digest('hex')}`;

/** One provider read, one factual snapshot, and one notification per observed Status transition. */
export const reconcileTracker = async (input: Readonly<{
  bindingId: string;
  workspaceId: string;
  projectId: string;
  cursor: string | null;
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
  const statusChanges = establishesBaseline ? [] : snapshot.items.flatMap((item) => {
    const prior = previousItems.get(item.itemId);
    return prior !== undefined && prior.statusOptionId !== item.statusOptionId ? [{prior, item}] : [];
  });
  let queuedActions = 0;
  for (const {prior, item} of statusChanges) {
    const idempotencyKey = statusChangeKey(input.bindingId, prior, item);
    // A version/title/owner change without a Status transition is merely refreshed
    // factual context. Status is still never authority to start Hermes.
    const delivery = {topic: 'messenger-notification' as const, payload: {message:
      await input.ports.compose.statusChanged(prior, item, idempotencyKey)}};
    const result = await input.ports.outbox.enqueue({
      projectId: input.projectId,
      ...delivery,
      idempotencyKey,
      availableAt: snapshot.observedAt
    });
    if (result === 'enqueued') queuedActions += 1;
  }
  // Evaluate the current provider-native stage, not only a transition edge. This repairs
  // an automatic continuation if the fast terminal-result path was interrupted after
  // its verified Status mutation. Receipt and submission idempotency make every poll safe.
  if (input.ports.continueAgentChain !== undefined) for (const item of snapshot.items) {
    const continuation = await input.ports.continueAgentChain(item);
    if (continuation === 'started') queuedActions += 1;
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
    details: {itemCount: snapshot.items.length, statusChangeCount: statusChanges.length,
      baselineEstablished: establishesBaseline, queuedActions, sourceUrl: snapshot.sourceUrl}
  });
  return {observedItems: snapshot.items.length, queuedActions, cursor: snapshot.cursor,
    externalVersion: snapshot.externalVersion};
};
