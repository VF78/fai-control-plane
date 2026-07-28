import {and, eq} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

export type PmQaBotResult =
  | Readonly<{status: 'completed' | 'replayed'; eventId: string; resultEventIds: readonly string[]}>
  | Readonly<{status: 'skipped'; eventId: string}>
  | Readonly<{status: 'failed_closed'; eventId: string; reason: string}>;

type CheckSnapshot = Readonly<{name: string; status: string; conclusion: string | null}>;
type WorkItemSnapshot = Readonly<{
  workItemId: string;
  workItemVersion: number;
  checks: readonly CheckSnapshot[];
}>;

const reviewRequestedEventType = 'qa_intake.review_requested.v1';
const resultEventType = 'pm_qa.precheck.completed.v1';
const failureEventType = 'pm_qa.precheck.failed.v1';
const ruleVersion = 'pm_qa_precheck_v1';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failedConclusions = new Set([
  'action_required', 'cancelled', 'failure', 'failed', 'stale', 'startup_failure', 'timed_out'
]);
const successfulConclusions = new Set(['neutral', 'skipped', 'success']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseWorkItems = (payload: Record<string, unknown>): readonly WorkItemSnapshot[] | null => {
  if (payload.schemaVersion !== 1 || payload.outcome !== 'review_requested' ||
    !Array.isArray(payload.workItems) || payload.workItems.length === 0) return null;
  const snapshots: WorkItemSnapshot[] = [];
  const ids = new Set<string>();
  for (const item of payload.workItems) {
    if (!isRecord(item) || typeof item.workItemId !== 'string' ||
      !uuidPattern.test(item.workItemId) || ids.has(item.workItemId) ||
      typeof item.workItemVersion !== 'number' ||
      !Number.isSafeInteger(item.workItemVersion) || item.workItemVersion <= 0 ||
      !Array.isArray(item.pullRequests)) return null;
    const checks: CheckSnapshot[] = [];
    for (const pullRequest of item.pullRequests) {
      if (!isRecord(pullRequest) || !Array.isArray(pullRequest.checks)) return null;
      for (const check of pullRequest.checks) {
        if (!isRecord(check) || typeof check.name !== 'string' || check.name.length === 0 ||
          typeof check.status !== 'string' || check.status.length === 0 ||
          !(check.conclusion === null || typeof check.conclusion === 'string')) return null;
        checks.push({name: check.name, status: check.status, conclusion: check.conclusion});
      }
    }
    ids.add(item.workItemId);
    snapshots.push({
      workItemId: item.workItemId,
      workItemVersion: item.workItemVersion,
      checks
    });
  }
  return snapshots;
};

const classify = (checks: readonly CheckSnapshot[]) => {
  const normalized = checks.map((check) => ({
    name: check.name,
    status: check.status.toLowerCase(),
    conclusion: check.conclusion?.toLowerCase() ?? null
  }));
  const failed = normalized.filter((check) =>
    check.conclusion !== null && failedConclusions.has(check.conclusion)
  );
  const pending = normalized.filter((check) =>
    check.status !== 'completed' || check.conclusion === null
  );
  const unknown = normalized.filter((check) =>
    check.status === 'completed' && check.conclusion !== null &&
    !failedConclusions.has(check.conclusion) && !successfulConclusions.has(check.conclusion)
  );
  return {
    evidence: {
      checkCount: normalized.length,
      failedCheckNames: failed.map((check) => check.name),
      pendingCheckNames: pending.map((check) => check.name),
      unknownCheckNames: unknown.map((check) => check.name)
    },
    nextAction: failed.length > 0
      ? 'fix_failed_checks'
      : normalized.length === 0 || pending.length > 0
        ? 'wait_for_checks'
        : unknown.length > 0
          ? 'inspect_check_results'
          : 'human_acceptance_review'
  };
};

const persistFailure = async (
  db: Database,
  event: Readonly<{id: string; workspaceId: string; projectId: string | null}>,
  reason: string,
  occurredAt: Date
): Promise<void> => {
  await db.insert(schema.canonicalEvents).values({
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    eventType: failureEventType,
    aggregateType: 'qa_intake',
    aggregateId: event.id,
    deduplicationKey: `pm_qa.precheck.failed.v1:${event.id}`,
    payload: {
      schemaVersion: 1,
      outcome: 'failed_closed',
      mode: 'deterministic_rules',
      ruleVersion,
      sourceEventId: event.id,
      reason,
      nextAction: 'repair_canonical_qa_intake_data'
    },
    occurredAt
  }).onConflictDoNothing({
    target: [schema.canonicalEvents.workspaceId, schema.canonicalEvents.deduplicationKey]
  });
};

export const createPostgresPmQaBotRunner = (
  db: Database,
  options: Readonly<{now?: () => Date}> = {}
): Readonly<{run(eventId: string): Promise<PmQaBotResult>}> => ({
  async run(eventId): Promise<PmQaBotResult> {
    const now = options.now ?? (() => new Date());
    const [event] = await db.select({
      id: schema.canonicalEvents.id,
      workspaceId: schema.canonicalEvents.workspaceId,
      projectId: schema.canonicalEvents.projectId,
      eventType: schema.canonicalEvents.eventType,
      aggregateType: schema.canonicalEvents.aggregateType,
      payload: schema.canonicalEvents.payload
    }).from(schema.canonicalEvents).where(eq(schema.canonicalEvents.id, eventId));
    if (event === undefined || event.eventType !== reviewRequestedEventType ||
      event.aggregateType !== 'qa_intake' || event.projectId === null) {
      return {status: 'skipped', eventId};
    }

    const snapshots = parseWorkItems(event.payload);
    if (snapshots === null) {
      await persistFailure(db, event, 'invalid_review_requested_event', now());
      return {status: 'failed_closed', eventId, reason: 'invalid_review_requested_event'};
    }
    const packets = await db.select({
      id: schema.taskPackets.id,
      workItemId: schema.taskPackets.workItemId,
      workItemVersion: schema.taskPackets.workItemVersion,
      runtimeProfile: schema.taskPackets.runtimeProfile,
      forbiddenSurfaces: schema.taskPackets.forbiddenSurfaces
    }).from(schema.taskPackets).where(eq(schema.taskPackets.createdFromEventId, event.id));
    const packetByWorkItem = new Map(packets.map((packet) => [packet.workItemId, packet]));
    if (packets.length !== snapshots.length || snapshots.some((snapshot) => {
      const packet = packetByWorkItem.get(snapshot.workItemId);
      return packet === undefined || packet.workItemVersion !== snapshot.workItemVersion ||
        packet.runtimeProfile !== 'read_safe' || !packet.forbiddenSurfaces.includes('runner');
    })) {
      await persistFailure(db, event, 'task_packet_binding_invalid', now());
      return {status: 'failed_closed', eventId, reason: 'task_packet_binding_invalid'};
    }

    const result = await db.transaction(async (tx) => {
      const resultEventIds: string[] = [];
      let replayed = true;
      for (const snapshot of snapshots) {
        const packet = packetByWorkItem.get(snapshot.workItemId)!;
        const precheck = classify(snapshot.checks);
        const deduplicationKey = `pm_qa.precheck.completed.v1:${packet.id}`;
        const [created] = await tx.insert(schema.canonicalEvents).values({
          workspaceId: event.workspaceId,
          projectId: event.projectId,
          eventType: resultEventType,
          aggregateType: 'work_item',
          aggregateId: snapshot.workItemId,
          deduplicationKey,
          payload: {
            schemaVersion: 1,
            outcome: 'precheck_completed',
            mode: 'deterministic_rules',
            ruleVersion,
            sourceEventId: event.id,
            taskPacketId: packet.id,
            workItemId: snapshot.workItemId,
            workItemVersion: snapshot.workItemVersion,
            evidence: precheck.evidence,
            artifacts: [],
            nextAction: precheck.nextAction
          },
          occurredAt: now()
        }).onConflictDoNothing({
          target: [schema.canonicalEvents.workspaceId, schema.canonicalEvents.deduplicationKey]
        }).returning({id: schema.canonicalEvents.id});
        if (created !== undefined) {
          replayed = false;
          resultEventIds.push(created.id);
          continue;
        }
        const [existing] = await tx.select({id: schema.canonicalEvents.id})
          .from(schema.canonicalEvents).where(and(
            eq(schema.canonicalEvents.workspaceId, event.workspaceId),
            eq(schema.canonicalEvents.deduplicationKey, deduplicationKey)
          ));
        if (existing === undefined) throw new Error('PM/QA precheck replay was not found.');
        resultEventIds.push(existing.id);
      }
      return {replayed, resultEventIds};
    });
    return {
      status: result.replayed ? 'replayed' : 'completed',
      eventId,
      resultEventIds: result.resultEventIds
    };
  }
});
