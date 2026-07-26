import {randomUUID} from 'node:crypto';
import {and, eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  createDatabase,
  createPostgresRecoveryScanProducer,
  incomingEvents,
  projectTrackerRepositoryScopes,
  scheduledJobs,
  secretRefs
} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_recovery_scan_test_${randomUUID().replaceAll('-', '')}`;
const ids = {
  workspace: randomUUID(),
  project: randomUUID(),
  secret: randomUUID(),
  expired: randomUUID(),
  active: randomUUID()
};

describePostgres('PostgreSQL recovery scan producer', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  const now = new Date('2026-07-26T12:00:00.000Z');
  const sent: string[] = [];

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
      `INSERT INTO projects (id, workspace_id, name, slug) VALUES ($1, $2, 'MSA', 'msa')`,
      [ids.project, ids.workspace]
    );
    await db.insert(secretRefs).values({
      id: ids.secret,
      workspaceId: ids.workspace,
      provider: 'test',
      reference: 'recovery-scan',
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
    await testPool.query(
      `INSERT INTO incoming_events (
         id, project_id, provider, delivery_id, event_type, verification,
         installation_id, repository_id, project_node_id, payload_sha256,
         sanitized_payload, status, attempt_count, processing_token, processing_lease_expires_at
       ) VALUES
         ($1, $2, 'github', 'expired', 'issues', '{"outcome":"verified","method":"hmac-sha256"}', '1', '2', 'PVT_project', repeat('a', 64), '{}', 'processing', 1, gen_random_uuid(), $3),
         ($4, $2, 'github', 'active', 'issues', '{"outcome":"verified","method":"hmac-sha256"}', '1', '2', 'PVT_project', repeat('b', 64), '{}', 'processing', 1, gen_random_uuid(), $5)`,
      [ids.expired, ids.project, new Date(now.getTime() - 1_000), ids.active, new Date(now.getTime() + 60_000)]
    );
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

  it('requeues only an expired processing lease', async () => {
    const producer = createPostgresRecoveryScanProducer(db, {
      async send(_name, data) {
        sent.push((data as {eventId: string}).eventId);
        return randomUUID();
      }
    }, {now: () => now});
    await producer.run();

    const rows = await db.select({
      id: incomingEvents.id,
      status: incomingEvents.status,
      processingToken: incomingEvents.processingToken,
      processingLeaseExpiresAt: incomingEvents.processingLeaseExpiresAt
    }).from(incomingEvents).where(and(
      eq(incomingEvents.projectId, ids.project),
      eq(incomingEvents.status, 'processing')
    ));
    expect(sent).toEqual([ids.expired]);
    expect(rows).toEqual([expect.objectContaining({
      id: ids.active,
      status: 'processing',
      processingToken: expect.any(String),
      processingLeaseExpiresAt: new Date(now.getTime() + 60_000)
    })]);
    expect(await db.select().from(incomingEvents).where(eq(incomingEvents.id, ids.expired)))
      .toEqual([expect.objectContaining({
        status: 'pending',
        processingToken: null,
        processingLeaseExpiresAt: null
      })]);
    expect(await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.projectId, ids.project),
      eq(scheduledJobs.name, 'recovery_scan')
    ))).toHaveLength(1);
  });
});
