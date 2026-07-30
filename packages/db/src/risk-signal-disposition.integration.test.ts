import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {and, asc, eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  RISK_SIGNAL_REENTRY_CONDITION,
  actors,
  auditEvents,
  createDatabase,
  createPostgresRiskSignalDispositionStore,
  projectMemberships,
  projects,
  riskSignalDispositionEvents,
  riskSignals,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for risk disposition integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_risk_disposition_${randomUUID().replaceAll('-', '')}`;

describePostgres('risk signal disposition persistence', () => {
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

  it('audits immutable CAS dispositions, replays exactly, and denies unauthorized or cross-project writes', async () => {
    const ids = {
      workspace: randomUUID(),
      otherWorkspace: randomUUID(),
      project: randomUUID(),
      otherProject: randomUUID(),
      operator: randomUUID(),
      viewer: randomUUID(),
      otherOperator: randomUUID(),
      viewerMembership: randomUUID(),
      signal: randomUUID(),
      otherSignal: randomUUID(),
      resolvedSignal: randomUUID()
    };
    await db.insert(workspaces).values([
      {id: ids.workspace, name: 'Workspace', slug: `risk-${randomUUID()}`},
      {id: ids.otherWorkspace, name: 'Other', slug: `risk-${randomUUID()}`}
    ]);
    await db.insert(projects).values([
      {id: ids.project, workspaceId: ids.workspace, name: 'MSA', slug: 'msa'},
      {id: ids.otherProject, workspaceId: ids.otherWorkspace, name: 'ASCON', slug: 'ascon'}
    ]);
    await db.insert(actors).values([
      {id: ids.operator, workspaceId: ids.workspace, type: 'human',
        role: 'workspace_admin', displayName: 'Operator', authMode: 'user'},
      {id: ids.viewer, workspaceId: ids.workspace, type: 'human',
        role: 'developer', displayName: 'Viewer', authMode: 'user'},
      {id: ids.otherOperator, workspaceId: ids.otherWorkspace, type: 'human',
        role: 'workspace_admin', displayName: 'Other', authMode: 'user'}
    ]);
    await db.insert(projectMemberships).values({
      id: ids.viewerMembership,
      projectId: ids.project,
      actorId: ids.viewer,
      role: 'client_viewer'
    });
    const risk = (
      id: string,
      projectId: string,
      resolvedAt: Date | null = null
    ) => ({
      id,
      projectId,
      code: 'stale_task',
      ruleId: 'stale_task',
      ruleVersion: 'v1',
      signalClass: 'fact' as const,
      severity: 'yellow' as const,
      summary: 'Task is stale',
      impact: 'Delivery may slip',
      nextAction: 'review_task',
      observedAt: new Date('2026-07-30T10:00:00.000Z'),
      deduplicationKey: `stale:${id}`,
      resolvedAt
    });
    await db.insert(riskSignals).values([
      risk(ids.signal, ids.project),
      risk(ids.otherSignal, ids.otherProject),
      risk(ids.resolvedSignal, ids.project, new Date('2026-07-30T11:00:00.000Z'))
    ]);

    const store = createPostgresRiskSignalDispositionStore(db);
    const occurredAt = new Date('2026-07-30T12:00:00.000Z');
    const commandId = randomUUID();
    const command = {
      workspaceId: ids.workspace,
      projectId: ids.project,
      riskSignalId: ids.signal,
      actorId: ids.operator,
      commandId,
      correlationId: randomUUID(),
      kind: 'acknowledged' as const,
      reason: 'investigating' as const,
      expiresAt: new Date('2026-07-31T12:00:00.000Z'),
      reentryCondition: RISK_SIGNAL_REENTRY_CONDITION,
      expectedVersion: 0,
      occurredAt
    };

    await expect(store.execute(command)).resolves.toMatchObject({
      status: 'applied',
      disposition: {
        kind: 'acknowledged',
        reason: 'investigating',
        version: 1
      }
    });
    await expect(store.execute({...command, correlationId: randomUUID()}))
      .resolves.toMatchObject({status: 'replayed', disposition: {version: 1}});
    await expect(store.execute({...command, reason: 'awaiting_evidence'}))
      .resolves.toEqual({status: 'conflict'});
    await expect(store.execute({
      ...command,
      commandId: randomUUID(),
      correlationId: randomUUID()
    })).resolves.toEqual({status: 'conflict'});

    await expect(store.execute({
      ...command,
      commandId: randomUUID(),
      correlationId: randomUUID(),
      kind: 'snoozed',
      reason: 'awaiting_evidence',
      expectedVersion: 1
    })).resolves.toMatchObject({
      status: 'applied',
      disposition: {kind: 'snoozed', version: 2}
    });
    await expect(store.execute({
      ...command,
      actorId: ids.viewer,
      commandId: randomUUID()
    })).resolves.toEqual({status: 'forbidden'});
    await expect(store.execute({
      ...command,
      riskSignalId: ids.otherSignal,
      commandId: randomUUID()
    })).resolves.toEqual({status: 'not_found'});
    await expect(store.execute({
      ...command,
      riskSignalId: ids.resolvedSignal,
      commandId: randomUUID()
    })).resolves.toEqual({status: 'not_found'});

    const events = await db.select().from(riskSignalDispositionEvents)
      .where(eq(riskSignalDispositionEvents.riskSignalId, ids.signal));
    expect(events).toHaveLength(2);
    expect(events.map(({version}) => version).sort()).toEqual([1, 2]);
    const audits = await db.select().from(auditEvents).where(and(
      eq(auditEvents.workspaceId, ids.workspace),
      eq(auditEvents.targetId, ids.signal)
    )).orderBy(asc(auditEvents.resultVersion));
    expect(audits).toHaveLength(2);
    expect(audits.map(({reasonCode, expectedVersion, resultVersion}) =>
      [reasonCode, expectedVersion, resultVersion])).toEqual([
      ['investigating', 0, 1],
      ['awaiting_evidence', 1, 2]
    ]);
  });
});
