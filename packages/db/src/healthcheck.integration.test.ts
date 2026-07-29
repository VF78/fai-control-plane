import {randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  createDatabase,
  createPostgresHealthcheckProducer,
  outboxEvents,
  projectTrackerRepositoryScopes,
  riskSignals,
  scheduledJobs,
  secretRefs,
  trackerSnapshotOperations
} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_healthcheck_test_${randomUUID().replaceAll('-', '')}`;
const ids = {
  workspace: randomUUID(),
  project: randomUUID(),
  otherProject: randomUUID(),
  secret: randomUUID(),
  failedOutbox: randomUUID()
};

describePostgres('PostgreSQL healthcheck producer', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  let current = new Date('2026-07-26T12:00:00.000Z');
  let failedQueueCount = 2;

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
    await migrate(db, {migrationsFolder: new URL('../drizzle', import.meta.url).pathname});
    await testPool.query(
      `INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Workspace', $2)`,
      [ids.workspace, `workspace-${randomUUID()}`]
    );
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug) VALUES
       ($1, $2, 'MSA', 'msa'), ($3, $2, 'Other', 'other')`,
      [ids.project, ids.workspace, ids.otherProject]
    );
    await db.insert(secretRefs).values({
      id: ids.secret,
      workspaceId: ids.workspace,
      provider: 'test',
      reference: 'healthcheck',
      scope: []
    });
    await db.insert(projectTrackerRepositoryScopes).values({
      projectId: ids.project,
      provider: 'github',
      repositoryOwner: 'VF78',
      repositoryName: 'MSA',
      repositoryExternalId: 'github:repository:1278325372',
      credentialRefId: ids.secret
    });
    await db.insert(outboxEvents).values({
      id: ids.failedOutbox,
      workspaceId: ids.workspace,
      projectId: ids.project,
      destination: 'github',
      eventType: 'github.project_status.write.v1',
      idempotencyKey: `healthcheck-${randomUUID()}`,
      payload: {},
      status: 'failed',
      failureCode: 'github_project_status_retry_exhausted'
    });
  });

  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try {
        await dropDatabaseWhenDisconnected(adminPool, databaseName);
      } finally {
        await adminPool.end();
      }
    }
  });

  it('creates once, refreshes idempotently, and resolves when confirmed facts clear', async () => {
    const producer = createPostgresHealthcheckProducer(db, {
      now: () => current,
      queueFailures: async () => [{queueName: 'qa-intake', failedCount: failedQueueCount}]
    });
    await producer.run();
    await producer.run();

    const active = await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.project),
      isNull(riskSignals.resolvedAt)
    ));
    expect(active.map((signal) => signal.code).sort()).toEqual([
      'github_status_writeback_failed',
      'queue_work_failed',
      'tracker_sync_missing_or_stale'
    ]);
    expect(active.find((signal) => signal.code === 'github_status_writeback_failed'))
      .toEqual(expect.objectContaining({
        ruleId: 'github_status_writeback_failed',
        ruleVersion: '1',
        signalClass: 'fact',
        evidenceReferences: [{type: 'outbox_event', id: ids.failedOutbox}],
        impact: 'Canonical delivery status was not published to the tracker.',
        ownerActorId: null,
        nextAction: 'inspect_failed_status_writeback',
        observedAt: current,
        deduplicationKey: 'github_status_writeback_failed'
      }));
    expect(await db.select().from(riskSignals).where(eq(
      riskSignals.projectId, ids.otherProject
    ))).toHaveLength(0);
    expect(await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.projectId, ids.project),
      eq(scheduledJobs.name, 'healthcheck')
    ))).toHaveLength(1);

    current = new Date('2026-07-26T12:05:00.000Z');
    failedQueueCount = 0;
    await db.update(outboxEvents).set({status: 'published', updatedAt: current})
      .where(eq(outboxEvents.id, ids.failedOutbox));
    await db.insert(trackerSnapshotOperations).values({
      id: randomUUID(),
      workspaceId: ids.workspace,
      projectId: ids.project,
      provider: 'github',
      repositoryExternalId: 'github:repository:1278325372',
      mode: 'synchronize',
      requestHash: `healthcheck-${randomUUID()}`,
      snapshotExternalVersion: 'github:sha256:current',
      result: {status: 'applied'},
      createdAt: current
    });
    await producer.run();
    await producer.run();

    expect(await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.project),
      isNull(riskSignals.resolvedAt)
    ))).toHaveLength(0);
    expect(await db.select().from(riskSignals).where(eq(
      riskSignals.projectId, ids.project
    ))).toHaveLength(3);
  });
});
