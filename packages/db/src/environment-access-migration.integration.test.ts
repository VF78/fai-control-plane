import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createDatabase} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for migration integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_environment_access_migration_${randomUUID().replaceAll('-', '')}`;

describePostgres('0054 environment access legacy quarantine', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let legacyMigrations: string;
  const ids = {workspace: randomUUID(), project: randomUUID(), actor: randomUUID()};

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!); adminUrl.pathname = '/postgres';
    adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(databaseUrl!); testUrl.pathname = `/${databaseName}`;
    const created = createDatabase(testUrl.toString()); testPool = created.pool;
    const migrationFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
    legacyMigrations = await mkdtemp(join(tmpdir(), 'fai-environment-access-0053-'));
    await cp(migrationFolder, legacyMigrations, {recursive: true});
    await rm(join(legacyMigrations, '0054_foundation.sql'));
    const journalPath = join(legacyMigrations, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {entries: Array<{idx: number}>};
    journal.entries = journal.entries.filter(({idx}) => idx < 54);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await migrate(created.db, {migrationsFolder: legacyMigrations});
    await testPool.query('insert into workspaces (id, name, slug) values ($1, $2, $3)',
      [ids.workspace, 'Legacy environment workspace', `environment-${randomUUID()}`]);
    await testPool.query('insert into projects (id, workspace_id, name, slug) values ($1, $2, $3, $4)',
      [ids.project, ids.workspace, 'Legacy environment project', `project-${randomUUID()}`]);
    await testPool.query("insert into actors (id, workspace_id, type, role, display_name, auth_mode) values ($1, $2, 'human', 'developer', 'Legacy environment member', 'user')",
      [ids.actor, ids.workspace]);
    for (const desiredLevel of ['read', 'admin', 'write', 'none'] as const) {
      for (const observed of [false, true]) {
        const grantId = randomUUID();
        await testPool.query(`insert into resource_access_grants
          (id, project_id, actor_id, resource_type, resource_id, desired_level,
           observed_provider, observed_external_resource_ref, observed_level, observed_at, version)
          values ($1, $2, $3, 'environment', $4, $5,
            $6, $7, $8, $9, 1)`, [grantId, ids.project, ids.actor, randomUUID(), desiredLevel,
          observed ? 'legacy' : null, observed ? `legacy:${grantId}` : null,
          observed ? desiredLevel : null, observed ? new Date('2026-07-01T10:00:00.000Z') : null]);
      }
    }
    await migrate(created.db, {migrationsFolder: migrationFolder});
  }, 30_000);

  afterAll(async () => {
    await testPool?.end();
    if (legacyMigrations !== undefined) await rm(legacyMigrations, {recursive: true, force: true});
    if (adminPool !== undefined) {
      try { await dropDatabaseWhenDisconnected(adminPool, databaseName); } finally { await adminPool.end(); }
    }
  }, 30_000);

  it('migrates every legacy environment grant to safe revoked and unobserved state', async () => {
    const result = await testPool.query<{
      desired_level: string; credential_ref_id: string | null; approval_request_id: string | null;
      expires_at: Date | null; observed_provider: string | null; observed_level: string | null;
      observed_at: Date | null; version: number;
    }>(`select desired_level, credential_ref_id, approval_request_id, expires_at,
        observed_provider, observed_level, observed_at, version
      from resource_access_grants where resource_type = 'environment' order by id`);
    expect(result.rows).toHaveLength(8);
    expect(result.rows).toEqual(result.rows.map(() => ({
      desired_level: 'none', credential_ref_id: null, approval_request_id: null,
      expires_at: null, observed_provider: null, observed_level: null,
      observed_at: null, version: 2
    })));
    await expect(testPool.query(`update resource_access_grants set desired_level = 'admin'
      where resource_type = 'environment'`)).rejects.toMatchObject({code: '23514'});
  });
});
