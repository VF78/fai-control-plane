import {randomUUID} from 'node:crypto';
import {
  mkdtemp,
  rm,
  writeFile
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase, createPostgresIncomingEventInbox, INCOMING_EVENT_QUEUE} from '@fai-control-plane/db';
import type {IncomingEvent, OpaqueSecretRef} from '@fai-control-plane/domain';
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
  createFileSecretsProvider,
  createPgBossProducer
} from './github-webhook-runtime';

describe('file webhook secrets provider', () => {
  it('resolves only the exact approved ref and removes one trailing line ending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fai-webhook-secret-'));
    const path = join(directory, 'secret');
    const value = 'exact secret';
    const reference: OpaqueSecretRef = {
      provider: 'file',
      reference: path,
      scope: ['github:webhook:verify']
    };
    try {
      await writeFile(path, `${value}\n`, {mode: 0o600});
      const provider = createFileSecretsProvider(reference);

      await expect(
        provider.resolve(reference, 'github.webhook.verify')
      ).resolves.toEqual({value});
      await expect(
        provider.resolve(
          {...reference, reference: `${path}-other`},
          'github.webhook.verify'
        )
      ).rejects.toThrow('Secret reference is not allowed.');
      await expect(
        provider.resolve(reference, 'other.purpose')
      ).rejects.toThrow('Secret reference is not allowed.');
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
});

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for web producer integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres('web pg-boss producer integration', () => {
  const databaseName = `fai_web_producer_${randomUUID().replaceAll('-', '')}`;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  let adminPool: Pool;
  let testPool: Pool;
  let testDb: ReturnType<typeof createDatabase>['db'];
  let owner: PgBoss;
  let connectionString: string;

  beforeAll(async () => {
    const sourceUrl = new URL(databaseUrl!);
    adminPool = new Pool({connectionString: sourceUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    sourceUrl.pathname = `/${databaseName}`;
    connectionString = sourceUrl.toString();
    const created = createDatabase(connectionString);
    testPool = created.pool;
    testDb = created.db;
    await migrate(created.db, {
      migrationsFolder: fileURLToPath(
        new URL('../../../packages/db/drizzle', import.meta.url)
      )
    });
    await testPool.query(
      `INSERT INTO workspaces (id, name, slug)
       VALUES ($1, 'Web producer workspace', $2)`,
      [workspaceId, `web-producer-${randomUUID()}`]
    );
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Web producer project', $3)`,
      [projectId, workspaceId, `web-producer-${randomUUID()}`]
    );
    owner = new PgBoss(connectionString);
    await owner.start();
    await owner.createQueue(INCOMING_EVENT_QUEUE);
  }, 30_000);

  afterAll(async () => {
    await owner?.stop({graceful: false});
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

  it('atomically sends through a producer that has no lifecycle start', async () => {
    const producer = createPgBossProducer(testPool);
    const inbox = createPostgresIncomingEventInbox(testDb, producer);
    const eventId = randomUUID();
    const event: IncomingEvent = {
      eventId,
      workspaceId,
      projectId,
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
      projection: {issue: {id: 501, number: 42, state: 'open'}}
    };

    await expect(inbox.accept(event)).resolves.toEqual({
      status: 'accepted',
      eventId
    });
    const jobs = await owner.findJobs<{eventId: string}>(
      INCOMING_EVENT_QUEUE
    );
    expect(jobs.filter((job) => job.data.eventId === eventId)).toHaveLength(1);
  });
});
