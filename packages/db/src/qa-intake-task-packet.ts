import {createHash} from 'node:crypto';
import {
  createActorContextIssuer,
  type CanonicalCommand,
  type CommandError,
  type CommandReceipt
} from '@fai-control-plane/domain';
import {and, asc, eq, inArray, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type CreateTaskPacketCommand = Extract<CanonicalCommand, {type: 'task_packet.create'}>;

export type QaIntakeTaskPacketCommandExecutor = Readonly<{
  execute(command: CreateTaskPacketCommand): Promise<
    | Readonly<{status: 'completed' | 'replayed'; receipt: CommandReceipt}>
    | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>
  >;
}>;

export type QaIntakeTaskPacketConsumerResult =
  | Readonly<{status: 'created' | 'replayed'; eventId: string; packetIds: readonly string[]}>
  | Readonly<{status: 'skipped'; eventId: string}>
  | Readonly<{status: 'failed_closed'; eventId: string; reason: string}>;

const reviewRequestedEventType = 'qa_intake.review_requested.v1';
const noWorkEventType = 'qa_intake.no_work.v1';
const resultEventType = 'qa_intake.task_packet.not_created.v1';
const requiredCapability = 'write:control_plane:development';
const maximumReviewWorkItems = 10;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const deterministicUuid = (value: string): string => {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${
    (Number.parseInt(hex[16]!, 16) & 0x3 | 0x8).toString(16)
  }${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const reviewedWorkItems = (payload: Record<string, unknown>): readonly Readonly<{
  workItemId: string;
  workItemVersion: number;
}>[] | null => {
  if (payload.schemaVersion !== 1 || payload.outcome !== 'review_requested' ||
    !Array.isArray(payload.workItems) || payload.workItems.length === 0 ||
    payload.workItems.length > maximumReviewWorkItems) return null;
  const workItems: Readonly<{workItemId: string; workItemVersion: number}>[] = [];
  const ids = new Set<string>();
  for (const value of payload.workItems) {
    if (!isRecord(value) || typeof value.workItemId !== 'string' ||
      !uuidPattern.test(value.workItemId) || typeof value.workItemVersion !== 'number' ||
      !Number.isSafeInteger(value.workItemVersion) || value.workItemVersion <= 0 ||
      ids.has(value.workItemId)) return null;
    ids.add(value.workItemId);
    workItems.push({workItemId: value.workItemId, workItemVersion: value.workItemVersion});
  }
  return workItems;
};

const configuredActorProfile = async (db: Database, workspaceId: string) => {
  const profiles = await db.select({
    actorId: schema.actors.id,
    capabilities: schema.actors.capabilities,
    runtimeProfile: schema.agentProfiles.runtimeProfile
  }).from(schema.agentProfiles).innerJoin(
    schema.actors,
    eq(schema.actors.id, schema.agentProfiles.actorId)
  ).where(and(
    eq(schema.agentProfiles.workspaceId, workspaceId),
    eq(schema.agentProfiles.enabled, true),
    eq(schema.actors.workspaceId, workspaceId),
    eq(schema.actors.type, 'human'),
    eq(schema.actors.authMode, 'user'),
    inArray(schema.actors.role, ['delivery_lead', 'workspace_admin']),
    isNull(schema.actors.disabledAt)
  )).orderBy(asc(schema.actors.id), asc(schema.agentProfiles.id));
  return profiles.find((profile) => profile.capabilities[requiredCapability] === true);
};

const persistFailure = async (
  db: Database,
  event: Readonly<{id: string; workspaceId: string; projectId: string | null}>,
  reason: string
): Promise<void> => {
  await db.insert(schema.canonicalEvents).values({
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    eventType: resultEventType,
    aggregateType: 'qa_intake_task_packet',
    aggregateId: event.id,
    deduplicationKey: `qa_intake.task_packet.not_created:${event.id}`,
    payload: {schemaVersion: 1, outcome: 'not_created', sourceEventId: event.id, reason},
    occurredAt: new Date()
  }).onConflictDoNothing({
    target: [schema.canonicalEvents.workspaceId, schema.canonicalEvents.deduplicationKey]
  });
};

export const createPostgresQaIntakeTaskPacketConsumer = (
  db: Database,
  commands: QaIntakeTaskPacketCommandExecutor
): Readonly<{consume(eventId: string): Promise<QaIntakeTaskPacketConsumerResult>}> => ({
  async consume(eventId): Promise<QaIntakeTaskPacketConsumerResult> {
    const [event] = await db.select({
      id: schema.canonicalEvents.id,
      workspaceId: schema.canonicalEvents.workspaceId,
      projectId: schema.canonicalEvents.projectId,
      eventType: schema.canonicalEvents.eventType,
      aggregateType: schema.canonicalEvents.aggregateType,
      payload: schema.canonicalEvents.payload,
      occurredAt: schema.canonicalEvents.occurredAt
    }).from(schema.canonicalEvents).where(eq(schema.canonicalEvents.id, eventId));
    if (event === undefined || event.eventType === noWorkEventType) return {status: 'skipped', eventId};
    if (event.eventType !== reviewRequestedEventType || event.aggregateType !== 'qa_intake' ||
      event.projectId === null) return {status: 'skipped', eventId};

    const workItems = reviewedWorkItems(event.payload);
    if (workItems === null) {
      await persistFailure(db, event, 'invalid_review_requested_event');
      return {status: 'failed_closed', eventId, reason: 'invalid_review_requested_event'};
    }
    const currentWorkItems = await db.select({
      id: schema.workItems.id,
      version: schema.workItems.version
    }).from(schema.workItems).where(and(
      eq(schema.workItems.projectId, event.projectId),
      inArray(schema.workItems.id, workItems.map((workItem) => workItem.workItemId)),
      isNull(schema.workItems.deletedAt)
    ));
    const versions = new Map(currentWorkItems.map((workItem) => [workItem.id, workItem.version]));
    if (versions.size !== workItems.length || workItems.some((workItem) =>
      versions.get(workItem.workItemId) !== workItem.workItemVersion
    )) {
      await persistFailure(db, event, 'work_item_reference_not_current');
      return {status: 'failed_closed', eventId, reason: 'work_item_reference_not_current'};
    }
    const profile = await configuredActorProfile(db, event.workspaceId);
    if (profile === undefined) {
      await persistFailure(db, event, 'trusted_pm_qa_actor_profile_not_configured');
      return {status: 'failed_closed', eventId, reason: 'trusted_pm_qa_actor_profile_not_configured'};
    }
    const issuer = createActorContextIssuer({
      users: [{actorId: profile.actorId, capabilities: [requiredCapability]}],
      agents: [],
      systems: []
    });
    if (!issuer.ok) {
      await persistFailure(db, event, 'trusted_pm_qa_actor_profile_not_configured');
      return {status: 'failed_closed', eventId, reason: 'trusted_pm_qa_actor_profile_not_configured'};
    }
    const actor = issuer.value.issueUser(profile.actorId);
    if (!actor.ok) {
      await persistFailure(db, event, 'trusted_pm_qa_actor_profile_not_configured');
      return {status: 'failed_closed', eventId, reason: 'trusted_pm_qa_actor_profile_not_configured'};
    }

    const packetIds: string[] = [];
    let replayed = true;
    for (const workItem of workItems) {
      const packetId = deterministicUuid(
        `qa_intake.task_packet.v1:${event.id}:${workItem.workItemId}`
      );
      const result = await commands.execute({
        commandId: deterministicUuid(
          `qa_intake.task_packet.command.v1:${event.id}:${workItem.workItemId}`
        ),
        workspaceId: event.workspaceId,
        correlationId: event.id,
        idempotencyKey: `qa_intake.task_packet.create.v1:${event.id}:${workItem.workItemId}`,
        issuedAt: event.occurredAt.toISOString(),
        actor: actor.value,
        type: 'task_packet.create',
        payload: {
          packetId,
          content: {
            projectId: event.projectId,
            workItemId: workItem.workItemId,
            workItemVersion: workItem.workItemVersion,
            goal: 'QA intake review packet.',
            acceptanceCriteria: ['Review remains unqueued until an explicit human confirmation.'],
            inScope: ['canonical_qa_intake_event'],
            outOfScope: ['external_message', 'merge', 'deploy', 'run_enqueue'],
            relevantLinks: [],
            relevantFiles: [],
            allowedTools: [],
            forbiddenSurfaces: ['github_write', 'telegram', 'runner', 'production'],
            dataPolicy: {source: 'canonical_db_only'},
            timeboxMinutes: 15,
            expectedOutputSchema: {review: 'human_confirmation_required'},
            reviewerActorId: profile.actorId,
            approverActorId: profile.actorId,
            runtimeProfile: profile.runtimeProfile,
            authMode: 'user',
            secretsRef: null,
            createdFromEventId: event.id,
            createdByActorId: profile.actorId
          }
        }
      });
      if (result.status === 'completed') {
        if (!result.receipt.result.ok) {
          const reason = `command_${result.receipt.result.error.code}`;
          await persistFailure(db, event, reason);
          return {status: 'failed_closed', eventId, reason};
        }
        replayed = false;
      } else if (result.status !== 'replayed') {
        const reason = `command_${result.status}`;
        await persistFailure(db, event, reason);
        return {status: 'failed_closed', eventId, reason};
      }
      packetIds.push(packetId);
    }
    return {status: replayed ? 'replayed' : 'created', eventId, packetIds};
  }
});
