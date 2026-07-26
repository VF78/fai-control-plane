import {
  trackerCheckStatuses,
  type IncomingEvent,
  type IncomingEventAcceptance,
  type IncomingEventInbox,
  type IncomingEventQueuePayload
} from '@fai-control-plane/domain';
import {and, eq, sql} from 'drizzle-orm';
import type {ExtractTablesWithRelations} from 'drizzle-orm';
import type {
  NodePgDatabase,
  NodePgTransaction
} from 'drizzle-orm/node-postgres';
import {fromDrizzle, type SendOptions} from 'pg-boss';
import * as schema from './schema';

export const INCOMING_EVENT_QUEUE = 'incoming-event.process.v1';

type Database = NodePgDatabase<typeof schema>;
type Transaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
export interface PgBossTransactionalSender {
  send(
    name: string,
    data: object | null,
    options?: SendOptions
  ): Promise<string | null>;
}

const exactDataObject = (
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> | null => {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !('value' in descriptor)
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
};

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const boundedRef = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 255;

const assertSanitizedProjection = (event: IncomingEvent): void => {
  if (event.eventType === 'chat_command') {
    const projection = exactDataObject(event.projection, ['command']);
    const command = projection === null
      ? null
      : exactDataObject(projection.command, ['name']);
    if (
      event.provider !== 'telegram' ||
      event.action !== 'status' ||
      event.verification.method !== 'shared-token' ||
      event.source.kind !== 'telegram' ||
      command?.name !== 'status'
    ) {
      throw new TypeError('Incoming event projection is not persistable.');
    }
    return;
  }
  const projectionKey =
    event.eventType === 'issues'
      ? 'issue'
      : event.eventType === 'pull_request'
        ? 'pullRequest'
        : event.eventType === 'check_run'
          ? 'checkRun'
          : null;
  const projection =
    projectionKey === null
      ? null
      : exactDataObject(event.projection, [projectionKey]);
  if (projection === null) {
    throw new TypeError('Incoming event projection is not persistable.');
  }

  if (event.eventType === 'issues') {
    const issue = exactDataObject(projection.issue, ['id', 'number', 'state']);
    if (
      issue === null ||
      !positiveSafeInteger(issue.id) ||
      !positiveSafeInteger(issue.number) ||
      (issue.state !== 'open' && issue.state !== 'closed')
    ) {
      throw new TypeError('Incoming event projection is not persistable.');
    }
    return;
  }

  if (event.eventType === 'pull_request') {
    const pullRequest = exactDataObject(projection.pullRequest, [
      'baseRef',
      'headRef',
      'id',
      'merged',
      'number',
      'state'
    ]);
    if (
      pullRequest === null ||
      !positiveSafeInteger(pullRequest.id) ||
      !positiveSafeInteger(pullRequest.number) ||
      (pullRequest.state !== 'open' && pullRequest.state !== 'closed') ||
      typeof pullRequest.merged !== 'boolean' ||
      !boundedRef(pullRequest.headRef) ||
      !boundedRef(pullRequest.baseRef)
    ) {
      throw new TypeError('Incoming event projection is not persistable.');
    }
    return;
  }

  const checkRun = exactDataObject(projection.checkRun, [
    'conclusion',
    'headSha',
    'id',
    'status'
  ]);
  const conclusions = new Set([
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'skipped',
    'stale',
    'success',
    'timed_out'
  ]);
  if (
    checkRun === null ||
    !positiveSafeInteger(checkRun.id) ||
    typeof checkRun.status !== 'string' ||
    !trackerCheckStatuses.includes(checkRun.status as (typeof trackerCheckStatuses)[number]) ||
    !(
      checkRun.conclusion === null ||
      (typeof checkRun.conclusion === 'string' &&
        conclusions.has(checkRun.conclusion))
    ) ||
    typeof checkRun.headSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(checkRun.headSha)
  ) {
    throw new TypeError('Incoming event projection is not persistable.');
  }
};

const projectBelongsToWorkspace = async (
  tx: Transaction,
  workspaceId: string,
  projectId: string
): Promise<boolean> => {
  const [project] = await tx
    .select({id: schema.projects.id})
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.workspaceId, workspaceId)
      )
    );
  return project !== undefined;
};

const immutableIdentityMatches = (
  row: typeof schema.incomingEvents.$inferSelect,
  event: IncomingEvent
): boolean =>
  row.projectId === event.projectId &&
  row.provider === event.provider &&
  row.deliveryId === event.deliveryId &&
  row.eventType === event.eventType &&
  row.action === event.action &&
  (event.source.kind === 'github'
    ? row.installationId === event.source.installationId &&
      row.repositoryId === event.source.repositoryId &&
      row.projectNodeId === event.source.projectNodeId &&
      row.telegramMessageId === null &&
      row.telegramChatId === null &&
      row.telegramUserId === null
    : row.installationId === null &&
      row.repositoryId === null &&
      row.projectNodeId === null &&
      row.telegramMessageId === event.source.messageId &&
      row.telegramChatId === event.source.chatId &&
      row.telegramUserId === event.source.userId) &&
  row.payloadSha256 === event.payloadSha256 &&
  row.verification.outcome === event.verification.outcome &&
  row.verification.method === event.verification.method;

export const createPostgresIncomingEventInbox = (
  db: Database,
  boss: PgBossTransactionalSender
): IncomingEventInbox => ({
  accept(event): Promise<IncomingEventAcceptance> {
    return db.transaction(async (tx) => {
      assertSanitizedProjection(event);
      if (
        !(await projectBelongsToWorkspace(
          tx,
          event.workspaceId,
          event.projectId
        ))
      ) {
        throw new Error('Incoming event project scope is invalid.');
      }

      const [inserted] = await tx
        .insert(schema.incomingEvents)
        .values({
          id: event.eventId,
          projectId: event.projectId,
          provider: event.provider,
          deliveryId: event.deliveryId,
          eventType: event.eventType,
          action: event.action,
          installationId:
            event.source.kind === 'github' ? event.source.installationId : null,
          repositoryId:
            event.source.kind === 'github' ? event.source.repositoryId : null,
          projectNodeId:
            event.source.kind === 'github' ? event.source.projectNodeId : null,
          telegramMessageId:
            event.source.kind === 'telegram' ? event.source.messageId : null,
          telegramChatId:
            event.source.kind === 'telegram' ? event.source.chatId : null,
          telegramUserId:
            event.source.kind === 'telegram' ? event.source.userId : null,
          payloadSha256: event.payloadSha256,
          verification: event.verification,
          sanitizedPayload: event.projection,
          receivedAt: new Date(event.receivedAt)
        })
        .onConflictDoNothing({
          target: [
            schema.incomingEvents.provider,
            schema.incomingEvents.deliveryId
          ]
        })
        .returning({id: schema.incomingEvents.id});

      if (inserted !== undefined) {
        const payload: IncomingEventQueuePayload = {eventId: event.eventId};
        const jobId = await boss.send(
          INCOMING_EVENT_QUEUE,
          payload,
          {db: fromDrizzle(tx, sql)}
        );
        if (jobId === null) {
          throw new Error('Incoming event enqueue failed.');
        }
        return {status: 'accepted', eventId: event.eventId};
      }

      const [existing] = await tx
        .select()
        .from(schema.incomingEvents)
        .where(
          and(
            eq(schema.incomingEvents.provider, event.provider),
            eq(schema.incomingEvents.deliveryId, event.deliveryId)
          )
        )
        .for('update');
      if (existing === undefined) {
        throw new Error('Incoming event delivery conflict could not be resolved.');
      }
      return immutableIdentityMatches(existing, event)
        ? {status: 'replayed', eventId: existing.id}
        : {status: 'collision', eventId: existing.id};
    });
  }
});
