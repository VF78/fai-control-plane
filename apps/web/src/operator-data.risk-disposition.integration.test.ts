import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  RISK_SIGNAL_REENTRY_CONDITION,
  actors,
  createDatabase,
  projects,
  riskSignalDispositionEvents,
  riskSignals,
  workspaces
} from '@fai-control-plane/db';
import {dropDatabaseWhenDisconnected} from '../../../packages/db/src/integration-test-utils';
import {loadPortfolioData} from './operator-data';

const adminDatabaseUrl = process.env.DATABASE_URL;
if (process.env.CI && adminDatabaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for operator risk projection tests in CI.');
}
const describePostgres =
  adminDatabaseUrl === undefined ? describe.skip : describe;
const databaseName =
  `fai_operator_risk_${randomUUID().replaceAll('-', '')}`;

describePostgres('operator risk disposition projection', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  let testDatabaseUrl: string;

  beforeAll(async () => {
    const adminUrl = new URL(adminDatabaseUrl!);
    adminUrl.pathname = '/postgres';
    adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(adminDatabaseUrl!);
    testUrl.pathname = `/${databaseName}`;
    testDatabaseUrl = testUrl.toString();
    const created = createDatabase(testDatabaseUrl);
    db = created.db;
    testPool = created.pool;
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL('../../../packages/db/drizzle', import.meta.url)
      )
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

  it('shows acknowledgement, suppresses active snooze, and re-enters an expired unresolved risk', async () => {
    const now = new Date();
    const ids = {
      workspace: randomUUID(),
      project: randomUUID(),
      actor: randomUUID(),
      acknowledged: randomUUID(),
      snoozed: randomUUID(),
      expired: randomUUID()
    };
    await db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Workspace',
      slug: `operator-risk-${randomUUID()}`
    });
    await db.insert(projects).values({
      id: ids.project,
      workspaceId: ids.workspace,
      name: 'MSA',
      slug: 'msa'
    });
    await db.insert(actors).values({
      id: ids.actor,
      workspaceId: ids.workspace,
      type: 'human',
      role: 'workspace_admin',
      displayName: 'Operator',
      authMode: 'user'
    });
    const risk = (id: string, summary: string) => ({
      id,
      projectId: ids.project,
      code: 'stale_task',
      ruleId: 'stale_task',
      ruleVersion: 'v1',
      signalClass: 'fact' as const,
      severity: 'yellow' as const,
      summary,
      impact: 'Delivery may slip',
      nextAction: 'review_task',
      observedAt: new Date(now.getTime() - 60_000),
      deduplicationKey: `stale:${id}`
    });
    await db.insert(riskSignals).values([
      risk(ids.acknowledged, 'Acknowledged risk'),
      risk(ids.snoozed, 'Snoozed risk'),
      risk(ids.expired, 'Expired snooze risk')
    ]);
    const event = (
      riskSignalId: string,
      kind: 'acknowledged' | 'snoozed',
      occurredAt: Date,
      expiresAt: Date
    ) => ({
      workspaceId: ids.workspace,
      projectId: ids.project,
      riskSignalId,
      actorId: ids.actor,
      commandId: randomUUID(),
      correlationId: randomUUID(),
      kind,
      reason: 'awaiting_evidence' as const,
      expiresAt,
      reentryCondition: RISK_SIGNAL_REENTRY_CONDITION,
      version: 1,
      occurredAt
    });
    await db.insert(riskSignalDispositionEvents).values([
      event(
        ids.acknowledged,
        'acknowledged',
        now,
        new Date(now.getTime() + 60 * 60 * 1_000)
      ),
      event(
        ids.snoozed,
        'snoozed',
        now,
        new Date(now.getTime() + 60 * 60 * 1_000)
      ),
      event(
        ids.expired,
        'snoozed',
        new Date(now.getTime() - 2 * 60 * 60 * 1_000),
        new Date(now.getTime() - 60 * 60 * 1_000)
      )
    ]);

    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testDatabaseUrl;
    const loaded = await loadPortfolioData();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;

    expect(loaded.state).toBe('ready');
    if (loaded.state !== 'ready') return;
    const canonical = loaded.data.attention.filter(
      ({riskSignalId}) => riskSignalId !== null
    );
    expect(canonical.map(({riskSignalId}) => riskSignalId))
      .toEqual(expect.arrayContaining([ids.acknowledged, ids.expired]));
    expect(canonical.map(({riskSignalId}) => riskSignalId))
      .not.toContain(ids.snoozed);
    expect(canonical.find(({riskSignalId}) =>
      riskSignalId === ids.acknowledged)?.disposition).toMatchObject({
      kind: 'acknowledged',
      reason: 'awaiting_evidence',
      reentryCondition: RISK_SIGNAL_REENTRY_CONDITION,
      version: 1
    });
    expect(canonical.find(({riskSignalId}) =>
      riskSignalId === ids.expired)?.disposition).toBeNull();
    expect(canonical.find(({riskSignalId}) =>
      riskSignalId === ids.expired)?.dispositionVersion).toBe(1);
    expect(loaded.data.projects[0]?.unresolvedRiskCount).toBe(3);
  });
});
