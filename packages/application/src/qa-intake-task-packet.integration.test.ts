import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  actors,
  agentProfiles,
  auditEvents,
  canonicalEvents,
  commandReceipts,
  createDatabase,
  createPostgresQaIntakeTaskPacketConsumer,
  createPostgresUnitOfWork,
  projects,
  taskPackets,
  workItems,
  workspaces
} from '@fai-control-plane/db';
import {dropDatabaseWhenDisconnected} from '../../db/src/integration-test-utils';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createCanonicalCommandService} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_qa_packet_test_${randomUUID().replaceAll('-', '')}`;

describePostgres('QA intake task packet consumer', () => {
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
      migrationsFolder: fileURLToPath(new URL('../../db/drizzle', import.meta.url))
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

  it('creates one packet for review_requested, replays without duplication, and skips no_work', async () => {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const actorId = randomUUID();
    const workItemId = randomUUID();
    const otherWorkItemId = randomUUID();
    const reviewEventId = randomUUID();
    const noWorkEventId = randomUUID();
    const observedAt = new Date('2026-07-26T09:20:00.000Z');

    await db.insert(workspaces).values({
      id: workspaceId, name: 'QA intake workspace', slug: `qa-intake-${randomUUID()}`
    });
    await db.insert(projects).values({
      id: projectId, workspaceId, name: 'QA intake project', slug: `qa-project-${randomUUID()}`
    });
    await db.insert(actors).values({
      id: actorId,
      workspaceId,
      type: 'human',
      role: 'delivery_lead',
      displayName: 'QA delivery lead',
      authMode: 'user',
      capabilities: {'write:control_plane:development': true}
    });
    await db.insert(agentProfiles).values({
      workspaceId,
      actorId,
      runtimeId: 'qa-intake',
      runtimeProfile: 'qa-read-only',
      allowedTools: [],
      forbiddenSurfaces: ['github_write', 'telegram', 'runner', 'production']
    });
    await db.insert(workItems).values([
      {id: workItemId, projectId, title: 'Review me', status: 'qa', version: 3},
      {id: otherWorkItemId, projectId, title: 'Review me too', status: 'qa', version: 4}
    ]);
    await db.insert(canonicalEvents).values([
      {
        id: reviewEventId,
        workspaceId,
        projectId,
        eventType: 'qa_intake.review_requested.v1',
        aggregateType: 'qa_intake',
        deduplicationKey: `qa-review-${randomUUID()}`,
        payload: {
          schemaVersion: 1,
          runKey: '2026-07-26',
          outcome: 'review_requested',
          observedAt: observedAt.toISOString(),
          limits: {workItems: 10, pullRequestsPerWorkItem: 3, checksPerPullRequest: 20},
          truncated: false,
          workItems: [
            {workItemId, workItemVersion: 3, pullRequests: []},
            {workItemId: otherWorkItemId, workItemVersion: 4, pullRequests: []}
          ]
        },
        occurredAt: observedAt
      },
      {
        id: noWorkEventId,
        workspaceId,
        projectId,
        eventType: 'qa_intake.no_work.v1',
        aggregateType: 'qa_intake',
        deduplicationKey: `qa-no-work-${randomUUID()}`,
        payload: {
          schemaVersion: 1,
          runKey: '2026-07-27',
          outcome: 'no_work',
          observedAt: observedAt.toISOString(),
          workItems: []
        },
        occurredAt: observedAt
      }
    ]);

    const consumer = createPostgresQaIntakeTaskPacketConsumer(
      db,
      createCanonicalCommandService({unitOfWork: createPostgresUnitOfWork(db)})
    );
    await expect(consumer.consume(reviewEventId)).resolves.toMatchObject({status: 'created'});
    await expect(consumer.consume(reviewEventId)).resolves.toMatchObject({status: 'replayed'});
    await expect(consumer.consume(noWorkEventId)).resolves.toEqual({
      status: 'skipped', eventId: noWorkEventId
    });

    const packets = await db.select().from(taskPackets);
    expect(packets).toHaveLength(2);
    expect(packets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectId,
        workItemId,
        workItemVersion: 3,
        createdFromEventId: reviewEventId,
        runtimeProfile: 'qa-read-only',
        secretRefId: null,
        reviewerActorId: actorId,
        approverActorId: actorId,
        createdByActorId: actorId
      }),
      expect.objectContaining({
        projectId,
        workItemId: otherWorkItemId,
        workItemVersion: 4,
        createdFromEventId: reviewEventId,
        runtimeProfile: 'qa-read-only',
        secretRefId: null,
        reviewerActorId: actorId,
        approverActorId: actorId,
        createdByActorId: actorId
      })
    ]));
    await expect(db.select().from(commandReceipts)).resolves.toHaveLength(2);
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(2);
    await expect(db.select().from(taskPackets).where(eq(
      taskPackets.createdFromEventId, noWorkEventId
    ))).resolves.toHaveLength(0);
    await expect(db.select().from(canonicalEvents)).resolves.toHaveLength(2);
  });
});
