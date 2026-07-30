import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors,
  createDatabase,
  createPostgresNotificationDeliveryReceiptStore,
  loadFailedNotificationDeliveryFacts,
  notificationDeliveryReceipts,
  notificationIntents,
  projects,
  reconcileRiskSignal,
  riskSignals,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for notification intent integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName =
  `fai_notification_intent_${randomUUID().replaceAll('-', '')}`;

describePostgres('notification intent and receipt persistence', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!);
    adminUrl.pathname = '/postgres';
    adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(databaseUrl!);
    testUrl.pathname = `/${databaseName}`;
    const created = createDatabase(testUrl.toString());
    db = created.db;
    testPool = created.pool;
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))
    });
  }, 30_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try {
        await dropDatabaseWhenDisconnected(adminPool, databaseName);
      } finally {
        await adminPool.end();
      }
    }
  }, 30_000);

  it('creates one deterministic intent per risk occurrence in the reconciliation transaction', async () => {
    const ids = {
      workspace: randomUUID(),
      project: randomUUID(),
      otherProject: randomUUID(),
      owner: randomUUID()
    };
    await db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Workspace',
      slug: `notification-${randomUUID()}`
    });
    await db.insert(projects).values([
      {id: ids.project, workspaceId: ids.workspace, name: 'MSA', slug: 'msa'},
      {id: ids.otherProject, workspaceId: ids.workspace, name: 'ASCON', slug: 'ascon'}
    ]);
    await db.insert(actors).values({
      id: ids.owner,
      workspaceId: ids.workspace,
      type: 'human',
      role: 'delivery_lead',
      displayName: 'Owner',
      authMode: 'user'
    });
    const observedAt = new Date('2026-07-30T12:00:00.000Z');
    const condition = {
      code: 'stale_active_task',
      ruleId: 'stale_active_task',
      ruleVersion: 'v1',
      signalClass: 'fact' as const,
      severity: 'yellow' as const,
      summary: 'Task has no recent canonical update',
      details: {},
      evidenceReferences: [{type: 'work_item', id: 'task-1'}],
      impact: 'Delivery may slip',
      ownerActorId: ids.owner,
      nextAction: 'review_stale_task'
    };
    const reconcile = (at: Date, value: typeof condition | null) =>
      db.transaction((tx) => reconcileRiskSignal(tx, {
        projectId: ids.project,
        deduplicationKey: 'stale_active_task:task-1',
        observedAt: at,
        condition: value
      }));

    await reconcile(observedAt, condition);
    await reconcile(new Date(observedAt.getTime() + 60_000), condition);
    const firstSignals = await db.select().from(riskSignals)
      .where(eq(riskSignals.projectId, ids.project));
    const firstIntents = await db.select().from(notificationIntents)
      .where(eq(notificationIntents.projectId, ids.project));
    expect(firstSignals).toHaveLength(1);
    expect(firstIntents).toHaveLength(1);
    expect(firstIntents[0]).toMatchObject({
      riskSignalId: firstSignals[0]!.id,
      audienceKind: 'actor',
      audienceActorId: ids.owner,
      category: condition.code,
      severity: condition.severity,
      summary: condition.summary,
      nextAction: condition.nextAction,
      evidenceReferences: condition.evidenceReferences,
      deduplicationKey: `risk_signal_occurrence:${firstSignals[0]!.id}`
    });

    await reconcile(new Date(observedAt.getTime() + 120_000), null);
    await reconcile(new Date(observedAt.getTime() + 180_000), condition);
    const occurrences = await db.select().from(riskSignals)
      .where(eq(riskSignals.projectId, ids.project));
    const intents = await db.select().from(notificationIntents)
      .where(eq(notificationIntents.projectId, ids.project));
    expect(occurrences).toHaveLength(2);
    expect(intents).toHaveLength(2);
    expect(new Set(intents.map(({deduplicationKey}) => deduplicationKey)).size)
      .toBe(2);

    await expect(db.transaction((tx) => reconcileRiskSignal(tx, {
      projectId: ids.otherProject,
      deduplicationKey: 'invalid-category',
      observedAt,
      condition: {...condition, code: 'Invalid category'}
    }))).rejects.toThrow();
    expect(await db.select().from(riskSignals)
      .where(eq(riskSignals.projectId, ids.otherProject))).toHaveLength(0);

    const store = createPostgresNotificationDeliveryReceiptStore(db);
    const activeIntent = intents.find(({riskSignalId}) =>
      riskSignalId === occurrences.find(({resolvedAt}) =>
        resolvedAt === null)?.id)!;
    const failedCommand = {
      projectId: ids.project,
      notificationIntentId: activeIntent.id,
      commandId: randomUUID(),
      correlationId: randomUUID(),
      status: 'failed' as const,
      failureCode: 'transport_unavailable',
      expectedVersion: 0,
      occurredAt: new Date('2026-07-30T12:05:00.000Z')
    };
    await expect(store.append(failedCommand)).resolves.toMatchObject({
      status: 'applied',
      receipt: {status: 'failed', version: 1}
    });
    await expect(store.append(failedCommand)).resolves.toMatchObject({
      status: 'replayed',
      receipt: {status: 'failed', version: 1}
    });
    await expect(store.append({
      ...failedCommand,
      correlationId: randomUUID()
    })).resolves.toEqual({status: 'conflict'});
    await expect(store.append({
      ...failedCommand,
      projectId: ids.otherProject,
      commandId: randomUUID()
    })).resolves.toEqual({status: 'not_found'});
    expect(await loadFailedNotificationDeliveryFacts(db, [ids.project]))
      .toMatchObject([{
        notificationIntentId: activeIntent.id,
        failureCode: 'transport_unavailable',
        receiptVersion: 1
      }]);
    expect(await loadFailedNotificationDeliveryFacts(db, [ids.otherProject]))
      .toEqual([]);

    await expect(store.append({
      ...failedCommand,
      commandId: randomUUID(),
      correlationId: randomUUID(),
      status: 'delivered',
      failureCode: null,
      expectedVersion: 1,
      occurredAt: new Date('2026-07-30T12:06:00.000Z')
    })).resolves.toMatchObject({
      status: 'applied',
      receipt: {status: 'delivered', version: 2}
    });
    expect(await loadFailedNotificationDeliveryFacts(db, [ids.project]))
      .toEqual([]);
    await expect(store.append({
      ...failedCommand,
      commandId: randomUUID(),
      expectedVersion: 2
    })).resolves.toEqual({status: 'terminal'});
    expect(await db.select().from(notificationDeliveryReceipts)
      .where(eq(
        notificationDeliveryReceipts.notificationIntentId,
        activeIntent.id
      ))).toHaveLength(2);
  });
});
