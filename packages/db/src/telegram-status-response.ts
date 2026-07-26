import type {ChatAdapter} from '@fai-control-plane/domain';
import {and, desc, eq} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const destination = 'telegram';
const eventType = 'telegram.status.response.v1';
const canonicalEventType = 'chat.command.status.requested';
const identityPattern = /^tgid:v1:[0-9a-f]{64}$/;
const reportDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const statuses = ['backlog', 'ready', 'in_dev', 'qa', 'acceptance', 'done'] as const;
const severities = ['green', 'yellow', 'red'] as const;

type Database = NodePgDatabase<typeof schema>;
type StatusPayload = Readonly<{
  chatIdentity: string;
  userIdentity: string;
  text: string;
}>;

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const formatTelegramStatusResponse = (
  report: schema.DailyPmReportPayload
): string | null => {
  if (
    report.schemaVersion !== 1 ||
    !reportDatePattern.test(report.reportDate) ||
    !['fresh', 'stale', 'missing'].includes(report.github.latestSuccessfulTrackerSnapshot.freshness) ||
    !nonNegativeInteger(report.workItems.blockedCount) ||
    !nonNegativeInteger(report.approvals.pendingCount) ||
    !nonNegativeInteger(report.github.failedWritebackCount)
  ) return null;
  const statusCounts = statuses.map((status) => report.workItems.statusCounts[status]);
  const riskCounts = severities.map((severity) => report.riskSignals.unresolvedCountsBySeverity[severity]);
  if (![...statusCounts, ...riskCounts].every(nonNegativeInteger)) return null;
  return [
    `Status ${report.reportDate} UTC`,
    `Work: ${statuses.map((status, index) => `${status} ${statusCounts[index]}`).join(', ')}`,
    `Blocked: ${report.workItems.blockedCount}`,
    `Pending approvals: ${report.approvals.pendingCount}`,
    `Risks: ${severities.map((severity, index) => `${severity} ${riskCounts[index]}`).join(', ')}`,
    `Tracker: ${report.github.latestSuccessfulTrackerSnapshot.freshness}`,
    `GitHub writebacks failed: ${report.github.failedWritebackCount}`
  ].join('\n');
};

const parsePayload = (value: Record<string, unknown>): StatusPayload | null => {
  if (
    Object.keys(value).length !== 3 ||
    typeof value.chatIdentity !== 'string' ||
    typeof value.userIdentity !== 'string' ||
    typeof value.text !== 'string' ||
    !identityPattern.test(value.chatIdentity) ||
    !identityPattern.test(value.userIdentity) ||
    !/^[A-Za-z0-9 .,:;()/_\-\n]{1,1024}$/.test(value.text)
  ) return null;
  return {chatIdentity: value.chatIdentity, userIdentity: value.userIdentity, text: value.text};
};

export const createPostgresTelegramStatusResponseOutbox = (
  db: Database,
  config: Readonly<{workspaceId: string; projectId: string}>
): Readonly<{prepare(eventId: string): Promise<'prepared' | 'skipped'>}> => ({
  async prepare(eventId) {
    return db.transaction(async (tx) => {
      const [incoming] = await tx.select({
        workspaceId: schema.projects.workspaceId,
        projectId: schema.incomingEvents.projectId,
        status: schema.incomingEvents.status,
        provider: schema.incomingEvents.provider,
        eventType: schema.incomingEvents.eventType,
        action: schema.incomingEvents.action,
        chatIdentity: schema.incomingEvents.telegramChatId,
        userIdentity: schema.incomingEvents.telegramUserId
      }).from(schema.incomingEvents)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.incomingEvents.projectId))
        .where(and(
          eq(schema.incomingEvents.id, eventId),
          eq(schema.incomingEvents.projectId, config.projectId)
        ))
        .limit(1);
      if (
        incoming === undefined || incoming.workspaceId !== config.workspaceId ||
        incoming.status !== 'processed' ||
        incoming.provider !== 'telegram' || incoming.eventType !== 'chat_command' ||
        incoming.action !== 'status' || incoming.chatIdentity === null || incoming.userIdentity === null ||
        !identityPattern.test(incoming.chatIdentity) || !identityPattern.test(incoming.userIdentity)
      ) return 'skipped';
      const [canonical] = await tx.select({id: schema.canonicalEvents.id})
        .from(schema.canonicalEvents).where(and(
          eq(schema.canonicalEvents.incomingEventId, eventId),
          eq(schema.canonicalEvents.projectId, config.projectId),
          eq(schema.canonicalEvents.eventType, canonicalEventType)
        )).limit(1);
      if (canonical === undefined) return 'skipped';
      const [report] = await tx.select({payload: schema.dailyPmReports.payload})
        .from(schema.dailyPmReports).where(eq(schema.dailyPmReports.projectId, config.projectId))
        .orderBy(desc(schema.dailyPmReports.reportDate), desc(schema.dailyPmReports.createdAt)).limit(1);
      if (report === undefined) return 'skipped';
      const text = formatTelegramStatusResponse(report.payload);
      if (text === null) return 'skipped';
      await tx.insert(schema.outboxEvents).values({
        workspaceId: incoming.workspaceId,
        projectId: config.projectId,
        destination,
        eventType,
        idempotencyKey: `telegram-status:${eventId}`,
        payload: {
          chatIdentity: incoming.chatIdentity,
          userIdentity: incoming.userIdentity,
          text
        }
      }).onConflictDoNothing();
      return 'prepared';
    });
  }
});

export const createPostgresTelegramStatusPublisher = (
  db: Database,
  adapter: Pick<ChatAdapter, 'sendNotification'>,
  projectId: string
): Readonly<{publishAvailable(): Promise<'published' | 'failed' | 'idle'>}> => ({
  async publishAvailable() {
    const claimed = await db.transaction(async (tx) => {
      const [candidate] = await tx.select().from(schema.outboxEvents).where(and(
        eq(schema.outboxEvents.destination, destination),
        eq(schema.outboxEvents.eventType, eventType),
        eq(schema.outboxEvents.projectId, projectId),
        eq(schema.outboxEvents.status, 'pending')
      )).orderBy(schema.outboxEvents.availableAt, schema.outboxEvents.createdAt)
        .limit(1).for('update', {skipLocked: true});
      if (candidate === undefined) return undefined;
      const payload = parsePayload(candidate.payload);
      if (payload === null) {
        await tx.update(schema.outboxEvents).set({
          status: 'failed', failureCode: 'telegram_status_payload_invalid', updatedAt: new Date()
        }).where(eq(schema.outboxEvents.id, candidate.id));
        return undefined;
      }
      const [updated] = await tx.update(schema.outboxEvents).set({
        status: 'publishing',
        attemptCount: candidate.attemptCount + 1,
        updatedAt: new Date()
      }).where(and(
        eq(schema.outboxEvents.id, candidate.id),
        eq(schema.outboxEvents.status, 'pending')
      )).returning({id: schema.outboxEvents.id});
      return updated === undefined ? undefined : {id: candidate.id, payload, idempotencyKey: candidate.idempotencyKey};
    });
    if (claimed === undefined) return 'idle';
    try {
      await adapter.sendNotification({
        destinationRef: claimed.payload.chatIdentity,
        template: eventType,
        variables: {userIdentity: claimed.payload.userIdentity, text: claimed.payload.text},
        idempotencyKey: claimed.idempotencyKey
      });
    } catch {
      await db.update(schema.outboxEvents).set({
        status: 'failed', failureCode: 'telegram_status_send_failed', updatedAt: new Date()
      }).where(and(
        eq(schema.outboxEvents.id, claimed.id),
        eq(schema.outboxEvents.status, 'publishing')
      ));
      return 'failed';
    }
    const [published] = await db.update(schema.outboxEvents).set({
      status: 'published', publishedAt: new Date(), updatedAt: new Date()
    }).where(and(
      eq(schema.outboxEvents.id, claimed.id),
      eq(schema.outboxEvents.status, 'publishing')
    )).returning({id: schema.outboxEvents.id});
    return published === undefined ? 'failed' : 'published';
  }
});
