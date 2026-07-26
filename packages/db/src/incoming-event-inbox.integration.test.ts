import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {
  trackerCheckStatuses,
  type IncomingEvent
} from '@fai-control-plane/domain';
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
import {createPostgresTelegramStatusResponseOutbox} from './telegram-status-response';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {createDatabase} from './index';
import {
  canonicalEvents,
  dailyPmReports,
  incomingEvents,
  outboxEvents
} from './schema';

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
let testDatabaseUrl: string;

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

const telegramStatusEvent = (): IncomingEvent => ({
  eventId: randomUUID(),
  workspaceId: fixture.workspaceId,
  projectId: fixture.projectId,
  provider: 'telegram',
  deliveryId: `tgid:v1:${'a'.repeat(64)}`,
  eventType: 'chat_command',
  action: 'status',
  receivedAt: '2026-07-26T09:00:00.000Z',
  payloadSha256: 'b'.repeat(64),
  verification: {outcome: 'verified', method: 'shared-token'},
  source: {
    kind: 'telegram',
    messageId: `tgid:v1:${'c'.repeat(64)}`,
    chatId: `tgid:v1:${'d'.repeat(64)}`,
    userId: `tgid:v1:${'e'.repeat(64)}`
  },
  projection: {command: {name: 'status'}}
});

const jobs = async () => boss.findJobs<{eventId: string}>(
  INCOMING_EVENT_QUEUE
);

const waitFor = async <T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs = 10_000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!matches(latest)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test state.');
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await read();
  }
  return latest;
};

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
      testDatabaseUrl = sourceUrl.toString();
      const created = createDatabase(testDatabaseUrl);
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
        try {
          await dropDatabaseWhenDisconnected(adminPool, databaseName);
        } finally {
          await adminPool.end();
        }
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

    it.each(trackerCheckStatuses)(
      'persists the %s check-run status',
      async (status) => {
        const candidate = event({
          eventType: 'check_run',
          action: 'created',
          projection: {
            checkRun: {
              id: 503,
              status,
              conclusion: 'success',
              headSha: 'a'.repeat(40)
            }
          }
        });
        const inbox = createPostgresIncomingEventInbox(testDb, boss);

        await expect(inbox.accept(candidate)).resolves.toEqual({
          status: 'accepted',
          eventId: candidate.eventId
        });
        const [row] = await testDb
          .select({sanitizedPayload: incomingEvents.sanitizedPayload})
          .from(incomingEvents)
          .where(eq(incomingEvents.id, candidate.eventId));
        expect(row?.sanitizedPayload).toEqual(candidate.projection);
      }
    );

    it('rejects an unknown check-run status before persistence', async () => {
      const candidate = event({
        eventType: 'check_run',
        action: 'created',
        projection: {
          checkRun: {
            id: 503,
            status: 'unknown',
            conclusion: 'success',
            headSha: 'a'.repeat(40)
          }
        }
      });
      const inbox = createPostgresIncomingEventInbox(testDb, boss);

      await expect(inbox.accept(candidate)).rejects.toThrow(
        'Incoming event projection is not persistable.'
      );
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
        source: {
          ...(original.source as Extract<IncomingEvent['source'], {kind: 'github'}>),
          repositoryId: '1279114011'
        }
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

    it('creates one status outbox response from a processed canonical Telegram command on replay', async () => {
      const candidate = telegramStatusEvent();
      const inbox = createPostgresIncomingEventInbox(testDb, boss);
      const processor = createPostgresIncomingEventProcessor(testDb);
      const responder = createPostgresTelegramStatusResponseOutbox(testDb, {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId
      });
      await testDb.insert(dailyPmReports).values({
        projectId: fixture.projectId,
        reportDate: '2026-07-26',
        createdAt: new Date('2026-07-26T09:00:00.000Z'),
        payload: {
          schemaVersion: 1,
          timezone: 'UTC',
          reportDate: '2026-07-26',
          generatedAt: '2026-07-26T09:00:00.000Z',
          dataAsOf: '2026-07-26T09:00:00.000Z',
          workItems: {
            statusCounts: {backlog: 1, ready: 2, in_dev: 3, qa: 4, acceptance: 5, done: 6},
            blockedCount: 2
          },
          riskSignals: {unresolvedCountsBySeverity: {green: 3, yellow: 2, red: 1}},
          approvals: {pendingCount: 7},
          github: {
            failedWritebackCount: 8,
            latestSuccessfulTrackerSnapshot: {at: null, freshness: 'missing'}
          }
        }
      });
      await inbox.accept(candidate);

      await expect(processor.process(candidate.eventId)).resolves.toEqual({
        status: 'processed', eventId: candidate.eventId
      });
      await expect(responder.prepare(candidate.eventId)).resolves.toBe('prepared');
      await expect(processor.process(candidate.eventId)).resolves.toEqual({
        status: 'replayed', eventId: candidate.eventId
      });
      await expect(responder.prepare(candidate.eventId)).resolves.toBe('prepared');

      const responses = await testDb.select().from(outboxEvents).where(eq(
        outboxEvents.idempotencyKey,
        `telegram-status:${candidate.eventId}`
      ));
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        destination: 'telegram',
        eventType: 'telegram.status.response.v1',
        status: 'pending',
        payload: {
          chatIdentity: candidate.source.kind === 'telegram' ? candidate.source.chatId : undefined,
          userIdentity: candidate.source.kind === 'telegram' ? candidate.source.userId : undefined,
          text: 'Status 2026-07-26 UTC\n' +
            'Work: backlog 1, ready 2, in_dev 3, qa 4, acceptance 5, done 6\n' +
            'Blocked: 2\nPending approvals: 7\nRisks: green 3, yellow 2, red 1\n' +
            'Tracker: missing\nGitHub writebacks failed: 8'
        }
      });
    });

    it('allows only one concurrent claimant to finalize a duplicate event', async () => {
      const candidate = event();
      const inbox = createPostgresIncomingEventInbox(testDb, boss);
      const processor = createPostgresIncomingEventProcessor(testDb);
      await inbox.accept(candidate);

      const results = await Promise.allSettled([
        processor.process(candidate.eventId),
        processor.process(candidate.eventId)
      ]);
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<{
          status: 'processed' | 'replayed';
          eventId: string;
        }> => result.status === 'fulfilled'
      );
      expect(fulfilled.some((result) => result.value.status === 'processed'))
        .toBe(true);
      expect(results.every((result) =>
        result.status === 'fulfilled' ||
        result.reason instanceof Error &&
          result.reason.message === 'Incoming event is not available for processing.'
      )).toBe(true);
      const observations = await testDb
        .select({id: canonicalEvents.id})
        .from(canonicalEvents)
        .where(eq(canonicalEvents.incomingEventId, candidate.eventId));
      expect(observations).toHaveLength(1);
      const [inboxRow] = await testDb
        .select({
          status: incomingEvents.status,
          attemptCount: incomingEvents.attemptCount,
          processingToken: incomingEvents.processingToken
        })
        .from(incomingEvents)
        .where(eq(incomingEvents.id, candidate.eventId));
      expect(inboxRow).toEqual({
        status: 'processed',
        attemptCount: 1,
        processingToken: null
      });
    });

    it('fences a stale owner after a lease takeover', async () => {
      const candidate = event();
      const inbox = createPostgresIncomingEventInbox(testDb, boss);
      const processor = createPostgresIncomingEventProcessor(testDb);
      const lockPool = new Pool({connectionString: testDatabaseUrl});
      const advisoryLock = 9_874_321;
      let oldOwner: Promise<unknown> | undefined;
      let newOwner: Promise<unknown> | undefined;
      let locked = false;

      await inbox.accept(candidate);
      await testPool.query(`
        CREATE TABLE incoming_event_fencing_guard (
          incoming_event_id uuid PRIMARY KEY,
          processing_token uuid NOT NULL
        );
        CREATE FUNCTION pause_canonical_observation()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.incoming_event_id = '${candidate.eventId}'::uuid THEN
            PERFORM pg_advisory_xact_lock(${advisoryLock});
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE FUNCTION require_current_processing_token()
        RETURNS trigger AS $$
        DECLARE expected_token uuid;
        BEGIN
          IF NEW.status = 'processed' THEN
            SELECT processing_token INTO expected_token
            FROM incoming_event_fencing_guard
            WHERE incoming_event_id = NEW.id;
            IF expected_token IS NOT NULL
              AND OLD.processing_token <> expected_token THEN
              RAISE EXCEPTION 'stale owner attempted finalization';
            END IF;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER pause_canonical_observation
          BEFORE INSERT ON canonical_events
          FOR EACH ROW EXECUTE FUNCTION pause_canonical_observation();
        CREATE TRIGGER require_current_processing_token
          BEFORE UPDATE OF status ON incoming_events
          FOR EACH ROW EXECUTE FUNCTION require_current_processing_token();
      `);

      try {
        await lockPool.query('SELECT pg_advisory_lock($1)', [advisoryLock]);
        locked = true;
        oldOwner = processor.process(candidate.eventId);
        const firstClaim = await waitFor(
          async () => (await testPool.query(
            `SELECT attempt_count, processing_token, status
             FROM incoming_events WHERE id = $1`,
            [candidate.eventId]
          )).rows[0] as {
            attempt_count: number;
            processing_token: string;
            status: string;
          },
          (row) => row.attempt_count === 1 && row.status === 'processing'
        );
        await waitFor(
          async () => Number((await testPool.query(
            `SELECT count(*) FROM pg_stat_activity
             WHERE datname = current_database()
               AND wait_event_type = 'Lock'
               AND wait_event = 'advisory'`
          )).rows[0]?.count),
          (count) => count > 0
        );
        await testPool.query(
          `UPDATE incoming_events
           SET processing_lease_expires_at = now() - interval '1 second'
           WHERE id = $1 AND processing_token = $2::uuid`,
          [candidate.eventId, firstClaim.processing_token]
        );

        newOwner = processor.process(candidate.eventId);
        const secondClaim = await waitFor(
          async () => (await testPool.query(
            `SELECT attempt_count, processing_token, status
             FROM incoming_events WHERE id = $1`,
            [candidate.eventId]
          )).rows[0] as {
            attempt_count: number;
            processing_token: string;
            status: string;
          },
          (row) =>
            row.attempt_count === 2 &&
            row.status === 'processing' &&
            row.processing_token !== firstClaim.processing_token
        );
        await testPool.query(
          `INSERT INTO incoming_event_fencing_guard (
             incoming_event_id, processing_token
           ) VALUES ($1, $2::uuid)`,
          [candidate.eventId, secondClaim.processing_token]
        );
        await lockPool.query('SELECT pg_advisory_unlock($1)', [advisoryLock]);
        locked = false;

        await expect(oldOwner).rejects.toThrow('Incoming event processing failed.');
        await expect(newOwner).resolves.toEqual({
          status: 'processed',
          eventId: candidate.eventId
        });
        const [inboxRow] = await testDb
          .select({
            status: incomingEvents.status,
            attemptCount: incomingEvents.attemptCount,
            processingToken: incomingEvents.processingToken
          })
          .from(incomingEvents)
          .where(eq(incomingEvents.id, candidate.eventId));
        expect(inboxRow).toEqual({
          status: 'processed',
          attemptCount: 2,
          processingToken: null
        });
        const observations = await testDb
          .select({id: canonicalEvents.id})
          .from(canonicalEvents)
          .where(eq(canonicalEvents.incomingEventId, candidate.eventId));
        expect(observations).toHaveLength(1);
      } finally {
        if (locked) {
          await lockPool.query('SELECT pg_advisory_unlock($1)', [advisoryLock]);
        }
        await Promise.allSettled([oldOwner, newOwner].filter(
          (owner): owner is Promise<unknown> => owner !== undefined
        ));
        await testPool.query(`
          DROP TRIGGER IF EXISTS require_current_processing_token ON incoming_events;
          DROP TRIGGER IF EXISTS pause_canonical_observation ON canonical_events;
          DROP FUNCTION IF EXISTS require_current_processing_token();
          DROP FUNCTION IF EXISTS pause_canonical_observation();
          DROP TABLE IF EXISTS incoming_event_fencing_guard;
        `);
        await lockPool.end();
      }
    }, 30_000);

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
            processedAt: incomingEvents.processedAt,
            processingToken: incomingEvents.processingToken,
            processingLeaseExpiresAt: incomingEvents.processingLeaseExpiresAt,
            failureCode: incomingEvents.failureCode
          })
          .from(incomingEvents)
          .where(eq(incomingEvents.id, candidate.eventId));
        expect(inboxRow).toEqual({
          status: 'failed',
          processedAt: null,
          processingToken: null,
          processingLeaseExpiresAt: null,
          failureCode: 'canonical_observation_failed'
        });
      } finally {
        await testPool.query(`
          DROP TRIGGER fail_incoming_event_completion ON incoming_events;
          DROP FUNCTION fail_incoming_event_completion();
        `);
      }
      await expect(processor.process(candidate.eventId)).resolves.toEqual({
        status: 'processed',
        eventId: candidate.eventId
      });
      const observations = await testDb
        .select({id: canonicalEvents.id})
        .from(canonicalEvents)
        .where(eq(canonicalEvents.incomingEventId, candidate.eventId));
      expect(observations).toHaveLength(1);
    });

    it('does not claim legacy events without a project', async () => {
      const eventId = randomUUID();
      const processor = createPostgresIncomingEventProcessor(testDb);
      await testPool.query(
        `INSERT INTO incoming_events (
           id, provider, delivery_id, event_type, verification, sanitized_payload
         ) VALUES (
           $1, 'legacy-github', $2, 'issues',
           '{"outcome":"unverified","method":"none"}', '{}'
         )`,
        [eventId, randomUUID()]
      );

      await expect(processor.process(eventId)).rejects.toThrow(
        'Incoming event is not available for processing.'
      );
      const [row] = await testDb
        .select({
          status: incomingEvents.status,
          attemptCount: incomingEvents.attemptCount,
          processingToken: incomingEvents.processingToken,
          processingLeaseExpiresAt: incomingEvents.processingLeaseExpiresAt,
          failureCode: incomingEvents.failureCode
        })
        .from(incomingEvents)
        .where(eq(incomingEvents.id, eventId));
      expect(row).toEqual({
        status: 'pending',
        attemptCount: 0,
        processingToken: null,
        processingLeaseExpiresAt: null,
        failureCode: null
      });
      const observations = await testDb
        .select({id: canonicalEvents.id})
        .from(canonicalEvents)
        .where(eq(canonicalEvents.incomingEventId, eventId));
      expect(observations).toHaveLength(0);
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
    const processingId = randomUUID();
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
      await pool.query(
        `INSERT INTO incoming_events (
           id, provider, delivery_id, event_type, verification,
           sanitized_payload, status
         ) VALUES (
           $1, 'tracker', $2, 'issue',
           '{"outcome":"unverified","method":"none"}', '{}', 'processing'
         )`,
        [processingId, randomUUID()]
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
      await applySqlMigration(pool, '0006_incoming_event_consumer.sql');
      const [recovered] = (await pool.query(
        `SELECT status, processing_token, processing_lease_expires_at
         FROM incoming_events WHERE id = $1`,
        [processingId]
      )).rows;
      expect(recovered).toEqual({
        status: 'pending',
        processing_token: null,
        processing_lease_expires_at: null
      });
      const indexes = (await pool.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename IN ('incoming_events', 'canonical_events')`
      )).rows.map((row) => row.indexname);
      expect(indexes).toEqual(expect.arrayContaining([
        'incoming_events_processing_lease_idx',
        'canonical_events_incoming_event_unique'
      ]));
      } finally {
        await pool.end();
        try {
          await dropDatabaseWhenDisconnected(admin, upgradeName);
        } finally {
          await admin.end();
        }
      }
  }, 30_000);
});
