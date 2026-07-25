import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type {IncomingEvent} from '@fai-control-plane/domain';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {PgBoss} from 'pg-boss';
import {Pool} from 'pg';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';
import {
  createPostgresIncomingEventInbox,
  INCOMING_EVENT_QUEUE
} from './incoming-event-inbox';
import {createPostgresIncomingEventProcessor} from './incoming-event-consumer';
import {createDatabase} from './index';
import {canonicalEvents, incomingEvents} from './schema';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error(
    'DATABASE_URL is required for incoming event integration tests in CI.'
  );
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_inbox_test_${randomUUID().replaceAll('-', '')}`;
const fixture = {
  workspaceId: randomUUID(),
  projectId: randomUUID(),
  otherProjectId: randomUUID()
};

let adminPool: Pool;
let testPool: Pool;
let testDb: ReturnType<typeof createDatabase>['db'];
let boss: PgBoss;

const event = (overrides: Partial<IncomingEvent> = {}): IncomingEvent => ({
  eventId: randomUUID(),
  workspaceId: fixture.workspaceId,
  projectId: fixture.projectId,
  provider: 'github',
  deliveryId: randomUUID(),
  eventType: 'issues',
  action: 'opened',
  receivedAt: new Date().toISOString(),
  payloadSha256: 'a'.repeat(64),
  verification: {outcome: 'verified', method: 'hmac-sha256'},
  source: {
    kind: 'github',
    installationId: '1001',
    repositoryId: '1278325372',
    projectNodeId: 'PVT_kwHOBIUvJs4Bbefq'
  },
  projection: {issue: {id: 10, number: 4, state: 'open'}},
  ...overrides
});

const jobs = async () => boss.findJobs<{eventId: string}>(
  INCOMING_EVENT_QUEUE
);

describePostgres(
  databaseUrl === undefined
    ? 'incoming event inbox integration (skipped: DATABASE_URL is absent)'
    : 'incoming event inbox integration',
  () => {
    beforeAll(async () => {
      const sourceUrl = new URL(databaseUrl!);
      adminPool = new Pool({connectionString: sourceUrl.toString()});
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      sourceUrl.pathname = `/${databaseName}`;
      const created = createDatabase(sourceUrl.toString());
      testPool = created.pool;
      testDb = created.db;
      await migrate(testDb, {
        migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))
      });
      await testPool.query(
        `INSERT INTO workspaces (id, name, slug)
         VALUES ($1, 'Inbox workspace', $2)`,
        [fixture.workspaceId, `inbox-${randomUUID()}`]
      );
      for (const [projectId, label] of [
        [fixture.projectId, 'primary'],
        [fixture.otherProjectId, 'other']
      ] as const) {
        await testPool.query(
          `INSERT INTO projects (id, workspace_id, name, slug)
           VALUES ($1, $2, $3, $4)`,
          [
            projectId,
            fixture.workspaceId,
            `Inbox ${label}`,
            `inbox-${label}-${randomUUID()}`
          ]
        );
      }
      boss = new PgBoss({connectionString: sourceUrl.toString()});
      await boss.start();
      await boss.createQueue(INCOMING_EVENT_QUEUE);
    }, 30_000);

    afterAll(async () => {
      await boss?.stop({graceful: false});
      await testPool?.end();
      if (adminPool !== undefined) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [databaseName]
        );
        await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await adminPool.end();
      }
    });

    it('atomically stores one sanitized row and one event-id-only job', async () => {
      const candidate = event();
      const inbox = createPostgresIncomingEventInbox(testDb, boss);

      await expect(inbox.accept(candidate)).resolves.toEqual({
        status: 'accepted',
        eventId: candidate.eventId
      });
      const [row] = await testDb
        .select()
        .from(incomingEvents)
        .where(eq(incomingEvents.id, candidate.eventId));
      expect(row).toMatchObject({
        projectId: fixture.projectId,
        payloadSha256: candidate.payloadSha256,
        sanitizedPayload: candidate.projection
      });
      expect(JSON.stringify(row?.sanitizedPayload)).not.toMatch(
        /title|body|url|sender|header|signature/i
      );
      const createdJobs = await jobs();
      expect(createdJobs.filter((job) => job.data.eventId === candidate.eventId))
        .toHaveLength(1);
      expect(
        Object.keys(
          createdJobs.find((job) => job.data.eventId === candidate.eventId)
            ?.data ?? {}
        )
      ).toEqual(['eventId']);
    });

    it('accepts one concurrent delivery, replays the other, and creates one job', async () => {
      const deliveryId = randomUUID();
      const first = event({deliveryId});
      const second = event({
        deliveryId,
        receivedAt: new Date(Date.now() + 1).toISOString()
      });
      const inbox = createPostgresIncomingEventInbox(testDb, boss);

      const results = await Promise.all([
        inbox.accept(first),
        inbox.accept(second)
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        'accepted',
        'replayed'
      ]);
      expect(
        (await jobs()).filter((job) =>
          job.data.eventId === first.eventId ||
          job.data.eventId === second.eventId
        )
      ).toHaveLength(1);
    });

    it('reports collisions for payload or immutable identity mismatches', async () => {
      const inbox = createPostgresIncomingEventInbox(testDb, boss);
      const original = event();
      await inbox.accept(original);

      await expect(inbox.accept(event({
        deliveryId: original.deliveryId,
        payloadSha256: 'b'.repeat(64)
      }))).resolves.toEqual({
        status: 'collision',
        eventId: original.eventId
      });
      await expect(inbox.accept(event({
        deliveryId: original.deliveryId,
        source: {...original.source, repositoryId: '1279114011'}
      }))).resolves.toEqual({
        status: 'collision',
        eventId: original.eventId
      });
    });

    it('rejects projections with extra or raw fields before persistence', async () => {
      const candidate = event({
        projection: {
          issue: {id: 10, number: 4, state: 'open'},
          body: 'must never be persisted'
        }
      });
      const inbox = createPostgresIncomingEventInbox(testDb, boss);

      await expect(inbox.accept(candidate)).rejects.toThrow(
        'Incoming event projection is not persistable.'
      );
      const [row] = await testDb
        .select({id: incomingEvents.id})
        .from(incomingEvents)
        .where(eq(incomingEvents.id, candidate.eventId));
      expect(row).toBeUndefined();
    });

    it.each(['null', 'throw'] as const)(
      'rolls back the row when enqueue returns %s',
      async (failure) => {
        const candidate = event();
        const inbox = createPostgresIncomingEventInbox(testDb, {
          send: async () => {
            if (failure === 'throw') throw new Error('queue unavailable');
            return null;
          }
        });

        await expect(inbox.accept(candidate)).rejects.toThrow();
        const [row] = await testDb
          .select({id: incomingEvents.id})
          .from(incomingEvents)
          .where(eq(incomingEvents.id, candidate.eventId));
        expect(row).toBeUndefined();
      }
    );

    it('rejects unverified and incomplete GitHub rows at the database boundary', async () => {
      const directInsert = (
        verification: string,
        identity: readonly [string | null, string | null, string | null]
      ) => testPool.query(
        `INSERT INTO incoming_events (
           id, project_id, provider, delivery_id, event_type, action,
           installation_id, repository_id, project_node_id,
           payload_sha256, verification, sanitized_payload
         ) VALUES (
           $1, $2, 'github', $3, 'issues', 'opened', $4, $5, $6, $7, $8, '{}'
         )`,
        [
          randomUUID(),
          fixture.projectId,
          randomUUID(),
          ...identity,
          'c'.repeat(64),
          verification
        ]
      );

      await expect(directInsert(
        '{"outcome":"unverified","method":"none"}',
        ['1001', '1278325372', 'PVT_kwHOBIUvJs4Bbefq']
      )).rejects.toMatchObject({code: '23514'});
      await expect(directInsert(
        '{"outcome":"verified","method":"hmac-sha256"}',
        [null, null, null]
      )).rejects.toMatchObject({code: '23514'});
      await expect(testPool.query(
        `INSERT INTO incoming_events (
           id, project_id, provider, delivery_id, event_type,
           payload_sha256, verification, sanitized_payload
         ) VALUES (
           $1, $2, 'tracker', $3, 'issue', NULL,
           '{"outcome":"unverified","method":"none"}', '{}'
         )`,
        [randomUUID(), fixture.projectId, randomUUID()]
      )).rejects.toMatchObject({code: '23514'});
      await expect(testPool.query(
        `INSERT INTO incoming_events (
           id, project_id, provider, delivery_id, event_type,
           payload_sha256, verification, sanitized_payload
         ) VALUES (
           $1, $2, 'legacy-tracker', $3, 'issue', $4,
           '{"outcome":"unverified","method":"none"}', '{}'
         )`,
        [randomUUID(), fixture.projectId, randomUUID(), 'd'.repeat(64)]
      )).rejects.toMatchObject({code: '23514'});
    });

    it('rejects a project that is not owned by the exact workspace', async () => {
      const inbox = createPostgresIncomingEventInbox(testDb, boss);
      await expect(inbox.accept(event({
        workspaceId: randomUUID()
      }))).rejects.toThrow('Incoming event project scope is invalid.');
    });

    it('creates one canonical observation and replays duplicate queue work', async () => {
      const candidate = event();
      const inbox = createPostgresIncomingEventInbox(testDb, boss);
      const processor = createPostgresIncomingEventProcessor(testDb);
      await inbox.accept(candidate);

      await expect(processor.process(candidate.eventId)).resolves.toEqual({
        status: 'processed',
        eventId: candidate.eventId
      });
      await expect(processor.process(candidate.eventId)).resolves.toEqual({
        status: 'replayed',
        eventId: candidate.eventId
      });
      const observations = await testDb
        .select()
        .from(canonicalEvents)
        .where(eq(canonicalEvents.incomingEventId, candidate.eventId));
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        projectId: fixture.projectId,
        eventType: 'incoming_event.observed',
        aggregateType: 'project',
        aggregateId: fixture.projectId,
        deduplicationKey: `incoming-event:${candidate.eventId}`,
        payload: {
          provider: 'github',
          deliveryId: candidate.deliveryId,
          projection: candidate.projection
        }
      });
    });

    it('rolls back the canonical observation when terminal inbox marking fails', async () => {
      const candidate = event();
      const inbox = createPostgresIncomingEventInbox(testDb, boss);
      const processor = createPostgresIncomingEventProcessor(testDb);
      await inbox.accept(candidate);
      await testPool.query(`
        CREATE FUNCTION fail_incoming_event_completion()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.status = 'processed' THEN
            RAISE EXCEPTION 'test terminal update failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_incoming_event_completion
          BEFORE UPDATE OF status ON incoming_events
          FOR EACH ROW EXECUTE FUNCTION fail_incoming_event_completion();
      `);

      try {
        await expect(processor.process(candidate.eventId)).rejects.toThrow();
        const observations = await testDb
          .select({id: canonicalEvents.id})
          .from(canonicalEvents)
          .where(eq(canonicalEvents.incomingEventId, candidate.eventId));
        expect(observations).toHaveLength(0);
        const [inboxRow] = await testDb
          .select({
            status: incomingEvents.status,
            processedAt: incomingEvents.processedAt
          })
          .from(incomingEvents)
          .where(eq(incomingEvents.id, candidate.eventId));
        expect(inboxRow).toEqual({status: 'processing', processedAt: null});
      } finally {
        await testPool.query(`
          DROP TRIGGER fail_incoming_event_completion ON incoming_events;
          DROP FUNCTION fail_incoming_event_completion();
        `);
      }
    });

    it('recovers a stale lease and retries it into one observation', async () => {
      const candidate = event();
      const inbox = createPostgresIncomingEventInbox(testDb, boss);
      const processor = createPostgresIncomingEventProcessor(testDb);
      await inbox.accept(candidate);
      await testPool.query(
        `UPDATE incoming_events
         SET status = 'processing',
             processing_token = gen_random_uuid(),
             processing_lease_expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [candidate.eventId]
      );

      await expect(processor.process(candidate.eventId)).resolves.toEqual({
        status: 'processed',
        eventId: candidate.eventId
      });
      const [row] = await testDb
        .select({
          status: incomingEvents.status,
          attemptCount: incomingEvents.attemptCount,
          processingToken: incomingEvents.processingToken,
          processingLeaseExpiresAt: incomingEvents.processingLeaseExpiresAt
        })
        .from(incomingEvents)
        .where(eq(incomingEvents.id, candidate.eventId));
      expect(row).toEqual({
        status: 'processed',
        attemptCount: 1,
        processingToken: null,
        processingLeaseExpiresAt: null
      });
    });

    it('does not mutate terminal replay state or unrelated business tables', async () => {
      const candidate = event();
      const inbox = createPostgresIncomingEventInbox(testDb, boss);
      const processor = createPostgresIncomingEventProcessor(testDb);
      await inbox.accept(candidate);

      await testPool.query(`
        CREATE FUNCTION reject_non_event_mutation()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'unexpected business mutation';
        END;
        $$ LANGUAGE plpgsql;
        DO $$
        DECLARE target record;
        BEGIN
          FOR target IN
            SELECT quote_ident(tablename) AS name
            FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename NOT IN ('incoming_events', 'canonical_events')
          LOOP
            EXECUTE format(
              'CREATE TRIGGER reject_non_event_mutation BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION reject_non_event_mutation()',
              target.name
            );
          END LOOP;
        END;
        $$;
      `);
      try {
        await expect(processor.process(candidate.eventId)).resolves.toEqual({
          status: 'processed',
          eventId: candidate.eventId
        });
        const [beforeReplay] = await testDb
          .select({
            attemptCount: incomingEvents.attemptCount,
            processedAt: incomingEvents.processedAt
          })
          .from(incomingEvents)
          .where(eq(incomingEvents.id, candidate.eventId));
        await expect(processor.process(candidate.eventId)).resolves.toEqual({
          status: 'replayed',
          eventId: candidate.eventId
        });
        const [afterReplay] = await testDb
          .select({
            attemptCount: incomingEvents.attemptCount,
            processedAt: incomingEvents.processedAt
          })
          .from(incomingEvents)
          .where(eq(incomingEvents.id, candidate.eventId));
        expect(afterReplay).toEqual(beforeReplay);
      } finally {
        await testPool.query(`
          DO $$
          DECLARE target record;
          BEGIN
            FOR target IN
              SELECT quote_ident(tablename) AS name
              FROM pg_tables
              WHERE schemaname = 'public'
                AND tablename NOT IN ('incoming_events', 'canonical_events')
            LOOP
              EXECUTE format('DROP TRIGGER reject_non_event_mutation ON %s', target.name);
            END LOOP;
          END;
          $$;
          DROP FUNCTION reject_non_event_mutation();
        `);
      }
    });
  }
);

const applySqlMigration = async (
  pool: Pool,
  migrationName: string
): Promise<void> => {
  const sqlText = await readFile(
    fileURLToPath(new URL(`../drizzle/${migrationName}`, import.meta.url)),
    'utf8'
  );
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    if (statement.trim().length > 0) await pool.query(statement);
  }
};

describePostgres('incoming event migration upgrade', () => {
  it('preserves pre-0005 rows with explicit legacy scope and no false payload hash', async () => {
    const upgradeName = `fai_inbox_upgrade_${randomUUID().replaceAll('-', '')}`;
    const sourceUrl = new URL(databaseUrl!);
    const admin = new Pool({connectionString: sourceUrl.toString()});
    await admin.query(`CREATE DATABASE "${upgradeName}"`);
    sourceUrl.pathname = `/${upgradeName}`;
    const pool = new Pool({connectionString: sourceUrl.toString()});
    const legacyId = randomUUID();
    const legacyTrackerId = randomUUID();
    const alreadyLegacyId = randomUUID();
    const sharedDeliveryId = randomUUID();
    try {
      for (const migration of [
        '0000_foundation.sql',
        '0001_inbound_event_data_safety.sql',
        '0002_canonical_persistence.sql',
        '0003_audit_command_uniqueness.sql',
        '0004_approval_target_xor.sql'
      ]) {
        await applySqlMigration(pool, migration);
      }
      await pool.query(
        `INSERT INTO incoming_events (
           id, provider, delivery_id, event_type, verification,
           sanitized_payload
         ) VALUES (
           $1, 'github', $2, 'issues',
           '{"outcome":"unverified","method":"none"}', '{}'
        )`,
        [legacyId, sharedDeliveryId]
      );
      await pool.query(
        `INSERT INTO incoming_events (
           id, provider, delivery_id, event_type, verification,
           sanitized_payload
         ) VALUES (
           $1, 'tracker', $2, 'issue',
           '{"outcome":"unverified","method":"none"}', '{}'
         )`,
        [legacyTrackerId, randomUUID()]
      );
      await pool.query(
        `INSERT INTO incoming_events (
           id, provider, delivery_id, event_type, verification,
           sanitized_payload
         ) VALUES (
           $1, 'legacy-github', $2, 'issues',
           '{"outcome":"unverified","method":"none"}', '{}'
         )`,
        [alreadyLegacyId, sharedDeliveryId]
      );

      await applySqlMigration(pool, '0005_incoming_event_inbox.sql');
      const result = await pool.query(
        `SELECT provider, project_id, payload_sha256
         FROM incoming_events WHERE id = ANY($1::uuid[])
         ORDER BY provider`,
        [[legacyId, legacyTrackerId, alreadyLegacyId]]
      );
      expect(result.rows).toEqual([
        {
          provider: 'legacy-github',
          project_id: null,
          payload_sha256: null
        },
        {
          provider: 'legacy-legacy-github',
          project_id: null,
          payload_sha256: null
        },
        {
          provider: 'legacy-tracker',
          project_id: null,
          payload_sha256: null
        }
      ]);
    } finally {
      await pool.end();
      await admin.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [upgradeName]
      );
      await admin.query(`DROP DATABASE IF EXISTS "${upgradeName}"`);
      await admin.end();
    }
  }, 30_000);
});
