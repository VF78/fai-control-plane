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
if (process.env.CI && databaseUrl === undefined) throw new Error('DATABASE_URL is required for migration integration tests in CI.');
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_role_sets_migration_${randomUUID().replaceAll('-', '')}`;

describePostgres('0053 project membership role sets migration', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let legacyMigrations: string;
  const ids = {workspace: randomUUID(), project: randomUUID(), actor: randomUUID(), membership: randomUUID()};
  const createdAt = new Date('2026-07-01T10:00:00.000Z');
  const updatedAt = new Date('2026-07-02T11:00:00.000Z');

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!); adminUrl.pathname = '/postgres';
    adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(databaseUrl!); testUrl.pathname = `/${databaseName}`;
    const created = createDatabase(testUrl.toString()); testPool = created.pool;
    const migrationFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
    legacyMigrations = await mkdtemp(join(tmpdir(), 'fai-role-sets-0052-'));
    await cp(migrationFolder, legacyMigrations, {recursive: true});
    await rm(join(legacyMigrations, '0053_project_role_sets.sql'));
    const journalPath = join(legacyMigrations, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {entries: Array<{idx: number}>};
    journal.entries = journal.entries.filter(({idx}) => idx < 53);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await migrate(created.db, {migrationsFolder: legacyMigrations});
    await testPool.query('insert into workspaces (id, name, slug) values ($1, $2, $3)',
      [ids.workspace, 'Migration workspace', `migration-${randomUUID()}`]);
    await testPool.query('insert into projects (id, workspace_id, name, slug) values ($1, $2, $3, $4)',
      [ids.project, ids.workspace, 'Migration project', `project-${randomUUID()}`]);
    await testPool.query("insert into actors (id, workspace_id, type, role, display_name, auth_mode) values ($1, $2, 'human', 'developer', 'Legacy member', 'user')",
      [ids.actor, ids.workspace]);
    await testPool.query("insert into project_memberships (id, project_id, actor_id, role, active, version, created_at, updated_at) values ($1, $2, $3, 'contributor', false, 7, $4, $5)",
      [ids.membership, ids.project, ids.actor, createdAt, updatedAt]);
    await migrate(created.db, {migrationsFolder: migrationFolder});
  }, 30_000);

  afterAll(async () => {
    await testPool?.end();
    if (legacyMigrations !== undefined) await rm(legacyMigrations, {recursive: true, force: true});
    if (adminPool !== undefined) { try { await dropDatabaseWhenDisconnected(adminPool, databaseName); } finally { await adminPool.end(); } }
  }, 30_000);

  it('backfills a singleton array without changing membership identity, state, version, or timestamps', async () => {
    const result = await testPool.query<{id: string; project_id: string; actor_id: string; roles: string[];
      active: boolean; version: number; created_at: Date; updated_at: Date}>(
      'select id, project_id, actor_id, roles::text[] as roles, active, version, created_at, updated_at from project_memberships where id = $1',
      [ids.membership]
    );
    expect(result.rows[0]).toEqual({id: ids.membership, project_id: ids.project, actor_id: ids.actor,
      roles: ['contributor'], active: false, version: 7, created_at: createdAt, updated_at: updatedAt});
  });

  it('enforces nonempty, sorted, unique, bounded roles and an agent-only singleton', async () => {
    const update = (roles: string[]) => testPool.query(
      'update project_memberships set roles = $2::project_membership_role[] where id = $1',
      [ids.membership, roles]
    );
    await expect(update([])).rejects.toMatchObject({code: '23514'});
    await expect(update(['contributor', 'project_owner'])).rejects.toMatchObject({code: '23514'});
    await expect(update(['contributor', 'contributor'])).rejects.toMatchObject({code: '23514'});
    await expect(update(['agent', 'contributor'])).rejects.toMatchObject({code: '23514'});
    await expect(update(['project_owner', 'contributor'])).resolves.toBeDefined();
  });
});
