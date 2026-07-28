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
  agentRuns,
  approvalRequests,
  auditEvents,
  canonicalEvents,
  commandReceipts,
  createDatabase,
  createPostgresPolicySimulationStore,
  outboxEvents,
  projects,
  taskPackets,
  trackerBindings,
  workItems,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for policy simulation integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_policy_simulation_test_${randomUUID().replaceAll('-', '')}`;

describePostgres('policy simulation', () => {
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

  it('is context-bound, idempotent, fail-closed, and mutates only receipt and audit records', async () => {
    const ids = {
      workspace: randomUUID(),
      project: randomUUID(),
      operator: randomUUID(),
      agent: randomUUID(),
      profile: randomUUID(),
      workItem: randomUUID(),
      event: randomUUID(),
      packet: randomUUID()
    };
    const now = new Date('2026-07-28T09:00:00.000Z');
    await db.insert(workspaces).values({
      id: ids.workspace, name: 'Policy simulation', slug: `policy-${randomUUID()}`
    });
    await db.insert(projects).values({
      id: ids.project, workspaceId: ids.workspace, name: 'Policy project', slug: 'policy'
    });
    await db.insert(actors).values([
      {
        id: ids.operator, workspaceId: ids.workspace, type: 'human',
        role: 'workspace_admin', displayName: 'Operator', authMode: 'user',
        capabilities: {'write:control_plane:development': true}
      },
      {
        id: ids.agent, workspaceId: ids.workspace, type: 'agent',
        role: 'agent_operator', displayName: 'Runner', authMode: 'agent'
      }
    ]);
    await db.insert(agentProfiles).values({
      id: ids.profile,
      workspaceId: ids.workspace,
      actorId: ids.agent,
      runtimeId: 'coding-runner',
      runtimeProfile: 'write-scoped',
      configHash: 'a'.repeat(64)
    });
    await db.insert(workItems).values({
      id: ids.workItem, projectId: ids.project, title: 'Simulate me',
      status: 'ready', version: 1
    });
    await db.insert(canonicalEvents).values({
      id: ids.event,
      workspaceId: ids.workspace,
      projectId: ids.project,
      eventType: 'test.seed',
      aggregateType: 'work_item',
      aggregateId: ids.workItem,
      deduplicationKey: `policy-${randomUUID()}`,
      payload: {},
      occurredAt: now
    });
    await db.insert(taskPackets).values({
      id: ids.packet,
      projectId: ids.project,
      workItemId: ids.workItem,
      workItemVersion: 1,
      goal: 'Prove policy simulation invariants',
      dataPolicy: {},
      timeboxMinutes: 15,
      expectedOutputSchema: {},
      reviewerActorId: ids.operator,
      approverActorId: ids.operator,
      runtimeProfile: 'write-scoped',
      authMode: 'agent',
      createdFromEventId: ids.event,
      contentHash: 'b'.repeat(64),
      createdByActorId: ids.operator
    });
    await db.insert(trackerBindings).values({
      projectId: ids.project,
      provider: 'github',
      surface: 'repository',
      externalId: 'policy-repository',
      entityType: 'project',
      entityId: ids.project,
      metadata: {defaultBranch: 'main', headSha: 'c'.repeat(40)}
    });
    let clockTick = 0;
    const store = createPostgresPolicySimulationStore(db, {
      runnerQueueEnabled: true,
      hermesRunnerEnabled: false,
      now: () => new Date(now.getTime() + clockTick++ * 1_000)
    });
    const input = {
      workspaceId: ids.workspace,
      actorId: ids.operator,
      taskPacketId: ids.packet,
      profileId: ids.profile
    };

    const first = await store.simulate(input);
    const replay = await store.simulate(input);
    expect(first).toMatchObject({status: 'completed', simulation: {decision: 'allow'}});
    expect(replay).toMatchObject({status: 'replayed', simulation: {
      simulationHash: first.status === 'forbidden' ? '' : first.simulation.simulationHash
    }});
    await expect(db.select().from(commandReceipts)).resolves.toHaveLength(1);

    await db.update(workItems).set({version: 2}).where(eq(workItems.id, ids.workItem));
    const stale = await store.simulate(input);
    expect(stale).toMatchObject({
      status: 'completed',
      simulation: {decision: 'deny', missingContext: ['stale.work_item_version']}
    });
    if (first.status === 'forbidden' || stale.status === 'forbidden') {
      throw new Error('Configured policy simulations must persist.');
    }
    expect(stale.simulation.contextHash).not.toBe(first.simulation.contextHash);
    expect(stale.simulation.simulationHash).not.toBe(first.simulation.simulationHash);

    const missing = await store.simulate({...input, profileId: randomUUID()});
    expect(missing).toMatchObject({
      status: 'completed',
      simulation: {decision: 'deny', missingContext: expect.arrayContaining(['missing.agent_profile'])}
    });
    await expect(db.select().from(commandReceipts)).resolves.toHaveLength(3);
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(3);
    await expect(db.select().from(agentRuns)).resolves.toHaveLength(0);
    await expect(db.select().from(approvalRequests)).resolves.toHaveLength(0);
    await expect(db.select().from(outboxEvents)).resolves.toHaveLength(0);
  });
});
