import {and, desc, eq, inArray, isNull, max} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type NotificationIntentInput = Readonly<{
  projectId: string;
  riskSignalId: string;
  category: string;
  severity: 'green' | 'yellow' | 'red';
  summary: string;
  nextAction: string;
  evidenceReferences: readonly Readonly<{type: string; id: string}>[];
  ownerActorId: string | null;
  createdAt: Date;
}>;

export const ensureNotificationIntentForRiskSignal = async (
  tx: Transaction,
  input: NotificationIntentInput
): Promise<void> => {
  if (input.nextAction.trim() === '') return;
  await tx.insert(schema.notificationIntents).values({
    projectId: input.projectId,
    riskSignalId: input.riskSignalId,
    audienceKind: input.ownerActorId === null ? 'project_operators' : 'actor',
    audienceActorId: input.ownerActorId,
    category: input.category,
    severity: input.severity,
    summary: input.summary,
    nextAction: input.nextAction,
    evidenceReferences: input.evidenceReferences,
    deduplicationKey: `risk_signal_occurrence:${input.riskSignalId}`,
    createdAt: input.createdAt
  }).onConflictDoNothing({
    target: schema.notificationIntents.riskSignalId
  });
};

export type NotificationDeliveryReceiptCommand = Readonly<{
  projectId: string;
  notificationIntentId: string;
  commandId: string;
  correlationId: string;
  status: 'accepted' | 'delivered' | 'failed';
  failureCode: string | null;
  expectedVersion: number;
  occurredAt: Date;
}>;

export type NotificationDeliveryReceipt = Readonly<{
  notificationIntentId: string;
  status: NotificationDeliveryReceiptCommand['status'];
  failureCode: string | null;
  version: number;
  occurredAt: Date;
}>;

export type NotificationDeliveryReceiptResult =
  | Readonly<{
      status: 'applied' | 'replayed';
      receipt: NotificationDeliveryReceipt;
    }>
  | Readonly<{
      status: 'invalid' | 'not_found' | 'conflict' | 'terminal';
    }>;

const failureCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const receiptFrom = (
  row: typeof schema.notificationDeliveryReceipts.$inferSelect
): NotificationDeliveryReceipt => ({
  notificationIntentId: row.notificationIntentId,
  status: row.status,
  failureCode: row.failureCode,
  version: row.version,
  occurredAt: row.occurredAt
});
const sameCommand = (
  row: typeof schema.notificationDeliveryReceipts.$inferSelect,
  command: NotificationDeliveryReceiptCommand
): boolean =>
  row.notificationIntentId === command.notificationIntentId &&
  row.correlationId === command.correlationId &&
  row.status === command.status &&
  row.failureCode === command.failureCode &&
  row.version === command.expectedVersion + 1 &&
  row.occurredAt.getTime() === command.occurredAt.getTime();
const validShape = (command: NotificationDeliveryReceiptCommand): boolean =>
  command.expectedVersion >= 0 &&
  Number.isInteger(command.expectedVersion) &&
  (command.status === 'failed'
    ? command.failureCode !== null &&
      failureCodePattern.test(command.failureCode)
    : command.failureCode === null);
const validTransition = (
  previous: NotificationDeliveryReceiptCommand['status'] | null,
  next: NotificationDeliveryReceiptCommand['status']
): boolean =>
  previous === null ||
  (previous === 'accepted' && (next === 'delivered' || next === 'failed')) ||
  (previous === 'failed' && (next === 'accepted' || next === 'delivered'));

export const createPostgresNotificationDeliveryReceiptStore = (
  db: Database
) => ({
  async append(
    command: NotificationDeliveryReceiptCommand
  ): Promise<NotificationDeliveryReceiptResult> {
    if (!validShape(command)) return {status: 'invalid'};
    return db.transaction(async (tx) => {
      const [intent] = await tx.select({id: schema.notificationIntents.id})
        .from(schema.notificationIntents)
        .where(and(
          eq(schema.notificationIntents.id, command.notificationIntentId),
          eq(schema.notificationIntents.projectId, command.projectId)
        ))
        .limit(1)
        .for('update');
      if (intent === undefined) return {status: 'not_found' as const};

      const [existing] = await tx.select()
        .from(schema.notificationDeliveryReceipts)
        .where(and(
          eq(schema.notificationDeliveryReceipts.projectId, command.projectId),
          eq(schema.notificationDeliveryReceipts.commandId, command.commandId)
        ))
        .limit(1);
      if (existing !== undefined) {
        return sameCommand(existing, command)
          ? {status: 'replayed' as const, receipt: receiptFrom(existing)}
          : {status: 'conflict' as const};
      }

      const [latest] = await tx.select({
        status: schema.notificationDeliveryReceipts.status,
        version: schema.notificationDeliveryReceipts.version
      }).from(schema.notificationDeliveryReceipts)
        .where(eq(
          schema.notificationDeliveryReceipts.notificationIntentId,
          command.notificationIntentId
        ))
        .orderBy(desc(schema.notificationDeliveryReceipts.version))
        .limit(1);
      const currentVersion = latest?.version ?? 0;
      if (currentVersion !== command.expectedVersion) {
        return {status: 'conflict' as const};
      }
      if (latest?.status === 'delivered') return {status: 'terminal' as const};
      if (!validTransition(latest?.status ?? null, command.status)) {
        return {status: 'invalid' as const};
      }

      const [inserted] = await tx.insert(schema.notificationDeliveryReceipts)
        .values({
          projectId: command.projectId,
          notificationIntentId: command.notificationIntentId,
          commandId: command.commandId,
          correlationId: command.correlationId,
          status: command.status,
          failureCode: command.failureCode,
          version: currentVersion + 1,
          occurredAt: command.occurredAt
        })
        .returning();
      return inserted === undefined
        ? {status: 'conflict' as const}
        : {status: 'applied' as const, receipt: receiptFrom(inserted)};
    });
  }
});

export type FailedNotificationDeliveryFact = Readonly<{
  notificationIntentId: string;
  projectId: string;
  riskSignalId: string;
  category: string;
  severity: 'green' | 'yellow' | 'red';
  summary: string;
  nextAction: string;
  evidenceReferences: readonly Readonly<{type: string; id: string}>[];
  audienceActorId: string | null;
  failureCode: string;
  failedAt: Date;
  receiptVersion: number;
}>;

export const loadFailedNotificationDeliveryFacts = async (
  db: Database,
  projectIds: readonly string[]
): Promise<FailedNotificationDeliveryFact[]> => {
  if (projectIds.length === 0) return [];
  const latestVersions = db.select({
    notificationIntentId:
      schema.notificationDeliveryReceipts.notificationIntentId,
    latestVersion: max(schema.notificationDeliveryReceipts.version)
      .as('latest_version')
  }).from(schema.notificationDeliveryReceipts)
    .where(inArray(
      schema.notificationDeliveryReceipts.projectId,
      [...projectIds]
    ))
    .groupBy(schema.notificationDeliveryReceipts.notificationIntentId)
    .as('latest_notification_receipt_versions');
  const rows = await db.select({
    notificationIntentId: schema.notificationIntents.id,
    projectId: schema.notificationIntents.projectId,
    riskSignalId: schema.notificationIntents.riskSignalId,
    category: schema.notificationIntents.category,
    severity: schema.notificationIntents.severity,
    summary: schema.notificationIntents.summary,
    nextAction: schema.notificationIntents.nextAction,
    evidenceReferences: schema.notificationIntents.evidenceReferences,
    audienceActorId: schema.notificationIntents.audienceActorId,
    failureCode: schema.notificationDeliveryReceipts.failureCode,
    failedAt: schema.notificationDeliveryReceipts.occurredAt,
    receiptVersion: schema.notificationDeliveryReceipts.version
  }).from(schema.notificationDeliveryReceipts)
    .innerJoin(latestVersions, and(
      eq(
        latestVersions.notificationIntentId,
        schema.notificationDeliveryReceipts.notificationIntentId
      ),
      eq(
        latestVersions.latestVersion,
        schema.notificationDeliveryReceipts.version
      )
    ))
    .innerJoin(
      schema.notificationIntents,
      eq(
        schema.notificationIntents.id,
        schema.notificationDeliveryReceipts.notificationIntentId
      )
    )
    .innerJoin(
      schema.riskSignals,
      eq(schema.riskSignals.id, schema.notificationIntents.riskSignalId)
    )
    .where(and(
      inArray(schema.notificationIntents.projectId, [...projectIds]),
      eq(schema.notificationDeliveryReceipts.status, 'failed'),
      isNull(schema.riskSignals.resolvedAt)
    ));
  return rows.flatMap((row) => row.failureCode === null
    ? []
    : [{...row, failureCode: row.failureCode}]);
};
