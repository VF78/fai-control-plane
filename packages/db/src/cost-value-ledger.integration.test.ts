import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors,
  agentProfiles,
  agentRunReceipts,
  agentRuns,
  approvalRequests,
  auditEvents,
  canonicalEvents,
  commandReceipts,
  createDatabase,
  createPostgresCostValueLedgerStore,
  ledgerRoi,
  outboxEvents,
  projects,
  taskPackets,
  workItems,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for cost/value ledger integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_cost_value_ledger_test_${randomUUID().replaceAll('-', '')}`;

describePostgres('AgentRun cost/value ledger', () => {
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

  it('keeps raw usage immutable, appends corrections, gates ROI, dedupes replay, and does not mutate workflow state', async () => {
    const ids = {
      workspace: randomUUID(),
      project: randomUUID(),
      operator: randomUUID(),
      agent: randomUUID(),
      profile: randomUUID(),
      workItem: randomUUID(),
      event: randomUUID(),
      packet: randomUUID(),
      run: randomUUID()
    };
    const now = new Date('2026-07-28T10:00:00.000Z');
    await db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Ledger workspace',
      slug: `ledger-${randomUUID()}`
    });
    await db.insert(projects).values({
      id: ids.project,
      workspaceId: ids.workspace,
      name: 'Ledger project',
      slug: 'ledger'
    });
    await db.insert(actors).values([
      {
        id: ids.operator,
        workspaceId: ids.workspace,
        type: 'human',
        role: 'workspace_admin',
        displayName: 'Ledger operator',
        authMode: 'user'
      },
      {
        id: ids.agent,
        workspaceId: ids.workspace,
        type: 'agent',
        role: 'agent_operator',
        displayName: 'Ledger runner',
        authMode: 'agent'
      }
    ]);
    await db.insert(agentProfiles).values({
      id: ids.profile,
      workspaceId: ids.workspace,
      actorId: ids.agent,
      runtimeId: 'provider-neutral-runner',
      runtimeProfile: 'write_scoped',
      configHash: 'a'.repeat(64)
    });
    await db.insert(workItems).values({
      id: ids.workItem,
      projectId: ids.project,
      title: 'Measure bounded value',
      status: 'done',
      version: 1
    });
    await db.insert(canonicalEvents).values({
      id: ids.event,
      workspaceId: ids.workspace,
      projectId: ids.project,
      eventType: 'test.seed',
      aggregateType: 'work_item',
      aggregateId: ids.workItem,
      deduplicationKey: `ledger-${randomUUID()}`,
      payload: {},
      occurredAt: now
    });
    await db.insert(taskPackets).values({
      id: ids.packet,
      projectId: ids.project,
      workItemId: ids.workItem,
      workItemVersion: 1,
      goal: 'Prove the bounded ledger',
      dataPolicy: {},
      timeboxMinutes: 15,
      expectedOutputSchema: {},
      reviewerActorId: ids.operator,
      approverActorId: ids.operator,
      runtimeProfile: 'write_scoped',
      authMode: 'agent',
      createdFromEventId: ids.event,
      contentHash: 'b'.repeat(64),
      createdByActorId: ids.operator
    });
    await db.insert(agentRuns).values({
      id: ids.run,
      taskPacketId: ids.packet,
      agentProfileId: ids.profile,
      confirmedPacketHash: 'b'.repeat(64),
      baseCommit: 'c'.repeat(40),
      status: 'done',
      idempotencyKey: `ledger-run-${randomUUID()}`,
      attempt: 1,
      completedAt: now
    });
    const rawMetadata = {
      runtimeId: 'provider-neutral-runner',
      runtimeProfile: 'write_scoped',
      cost: {
        state: 'unknown',
        reason: 'runtime_cost_not_available'
      },
      usage: {
        state: 'available',
        unit: 'tokens',
        input: 1_000,
        output: 250
      }
    };
    await db.insert(agentRunReceipts).values({
      agentRunId: ids.run,
      runnerId: 'test-runner',
      attempt: 1,
      terminal: 'done',
      receiptSha256: 'd'.repeat(64),
      receiptSizeBytes: 512,
      completionReplayHash: 'e'.repeat(64),
      metadata: rawMetadata,
      completedAt: now
    });
    const initialRun = await db.select().from(agentRuns)
      .where(eq(agentRuns.id, ids.run));
    const store = createPostgresCostValueLedgerStore(db);
    let tick = 0;
    const common = () => ({
      workspaceId: ids.workspace,
      actorId: ids.operator,
      agentRunId: ids.run,
      commandId: randomUUID(),
      correlationId: randomUUID(),
      recordedAt: new Date(now.getTime() + ++tick * 1_000)
    });

    const pending = await store.append({
      ...common(),
      idempotencyKey: 'ledger-cost-pending',
      kind: 'cost',
      correctsCommandId: null,
      cost: {state: 'pending', reason: 'pricing_pending'}
    });
    if (pending.status !== 'completed') throw new Error('Pending cost was not appended.');
    const calculated = await store.append({
      ...common(),
      idempotencyKey: 'ledger-cost-calculated',
      kind: 'cost',
      correctsCommandId: pending.record.commandId,
      cost: {
        state: 'calculated',
        amountMinor: 1_000,
        currency: 'USD',
        pricingVersion: 'pricing-2026-07',
        pricingEffectiveAt: now.toISOString(),
        allocationFormulaVersion: 'usage-allocation-v1'
      }
    });
    if (calculated.status !== 'completed' || calculated.record.cost === undefined) {
      throw new Error('Calculated cost was not appended.');
    }
    expect(calculated.record.correctsCommandId).toBe(pending.record.commandId);
    expect(calculated.record.usageProvenance).toEqual({
      source: 'agent_run_receipt',
      receiptSha256: 'd'.repeat(64)
    });
    expect(ledgerRoi(calculated.record.cost, null)).toEqual({
      state: 'not_configured',
      reason: 'value_evidence_missing'
    });

    const valueInput = {
      ...common(),
      idempotencyKey: 'ledger-value-observed',
      kind: 'value_evidence' as const,
      valueEvidence: {
        baselineAmountMinor: 10_000,
        outcomeAmountMinor: 7_000,
        currency: 'USD',
        method: 'matched_invoice_total',
        observedAt: now.toISOString(),
        evidenceReference: 'artifact://value-observation-1',
        formulaVersion: 'roi_v1'
      }
    };
    const value = await store.append(valueInput);
    const replay = await store.append({
      ...valueInput,
      commandId: randomUUID(),
      correlationId: randomUUID(),
      recordedAt: new Date(now.getTime() + 60_000)
    });
    if (value.status !== 'completed' || replay.status !== 'replayed') {
      throw new Error('Value evidence did not persist and replay.');
    }
    expect(ledgerRoi(calculated.record.cost, value.record.valueEvidence ?? null))
      .toEqual({state: 'calculated', ratio: 2, formulaVersion: 'roi_v1'});

    const correction = await store.append({
      ...common(),
      idempotencyKey: 'ledger-cost-correction',
      kind: 'cost',
      correctsCommandId: calculated.record.commandId,
      cost: {
        state: 'calculated',
        amountMinor: 1_200,
        currency: 'USD',
        pricingVersion: 'pricing-2026-07-corrected',
        pricingEffectiveAt: now.toISOString(),
        allocationFormulaVersion: 'usage-allocation-v1'
      }
    });
    expect(correction).toMatchObject({
      status: 'completed',
      record: {correctsCommandId: calculated.record.commandId}
    });

    const persistedReceipt = await db.select({
      metadata: agentRunReceipts.metadata
    }).from(agentRunReceipts).where(eq(agentRunReceipts.agentRunId, ids.run));
    expect(persistedReceipt[0]?.metadata).toEqual(rawMetadata);
    await expect(db.select().from(commandReceipts)).resolves.toHaveLength(4);
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(4);
    await expect(db.select().from(agentRuns)).resolves.toEqual(initialRun);
    await expect(db.select().from(approvalRequests)).resolves.toHaveLength(0);
    await expect(db.select().from(outboxEvents)).resolves.toHaveLength(0);
  });
});
