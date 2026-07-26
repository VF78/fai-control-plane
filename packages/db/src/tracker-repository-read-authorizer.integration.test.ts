import {randomUUID} from 'node:crypto';
import {and, eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  createDatabase,
  createPostgresTrackerRepositoryReadScopeAuthorizer,
  projectTrackerRepositoryScopes,
  secretRefs
} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_scope_test_${randomUUID().replaceAll('-', '')}`;
const ids = {
  workspace: randomUUID(),
  project: randomUUID(),
  actor: randomUUID(),
  secretRef: randomUUID(),
  otherWorkspace: randomUUID(),
  otherProject: randomUUID(),
  otherActor: randomUUID()
};
const credentialRef = {
  provider: 'test-secrets', reference: 'tracker/repository-read', scope: ['repository:read']
};
const input = {
  workspaceId: ids.workspace,
  projectId: ids.project,
  actorId: ids.actor,
  provider: 'test-tracker',
  repository: {owner: 'owner', repository: 'repository'},
  credentialRef
};

describePostgres('PostgreSQL tracker repository read scope authorizer', () => {
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
    await migrate(db, {migrationsFolder: new URL('../drizzle', import.meta.url).pathname});
    await testPool.query(
      `INSERT INTO workspaces (id, name, slug) VALUES
       ($1, 'Primary', $2), ($3, 'Other', $4)`,
      [ids.workspace, `primary-${randomUUID()}`, ids.otherWorkspace, `other-${randomUUID()}`]
    );
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug) VALUES
       ($1, $2, 'Project', $3), ($4, $5, 'Other project', $6)`,
      [
        ids.project, ids.workspace, `project-${randomUUID()}`,
        ids.otherProject, ids.otherWorkspace, `other-project-${randomUUID()}`
      ]
    );
    await testPool.query(
      `INSERT INTO actors (id, workspace_id, type, role, display_name, auth_mode) VALUES
       ($1, $2, 'human', 'developer', 'Primary actor', 'user'),
       ($3, $4, 'human', 'developer', 'Other actor', 'user')`,
      [ids.actor, ids.workspace, ids.otherActor, ids.otherWorkspace]
    );
    await db.insert(secretRefs).values({
      id: ids.secretRef,
      workspaceId: ids.workspace,
      ...credentialRef
    });
    await db.insert(projectTrackerRepositoryScopes).values({
      projectId: ids.project,
      provider: input.provider,
      repositoryOwner: input.repository.owner,
      repositoryName: input.repository.repository,
      repositoryExternalId: 'test-tracker:repository:1',
      credentialRefId: ids.secretRef
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

  it('authorizes only the configured project repository and opaque credential reference', async () => {
    const authorizer = createPostgresTrackerRepositoryReadScopeAuthorizer(db);

    await expect(authorizer.authorize(input)).resolves.toEqual({
      status: 'authorized', repositoryExternalId: 'test-tracker:repository:1'
    });
    await expect(authorizer.authorize({
      ...input,
      credentialRef: {...credentialRef, reference: 'tracker/other'}
    })).resolves.toEqual({status: 'denied'});
  });

  it('denies a cross-workspace actor and project before any repository read', async () => {
    const authorizer = createPostgresTrackerRepositoryReadScopeAuthorizer(db);

    await expect(authorizer.authorize({
      ...input,
      workspaceId: ids.otherWorkspace,
      projectId: ids.otherProject,
      actorId: ids.otherActor
    })).resolves.toEqual({status: 'denied'});
    expect(await db.select().from(projectTrackerRepositoryScopes).where(and(
      eq(projectTrackerRepositoryScopes.projectId, ids.project),
      eq(projectTrackerRepositoryScopes.provider, input.provider)
    ))).toHaveLength(1);
  });

  it('denies a disabled actor', async () => {
    const authorizer = createPostgresTrackerRepositoryReadScopeAuthorizer(db);
    await testPool.query(
      'UPDATE actors SET disabled_at = now() WHERE id = $1',
      [ids.actor]
    );

    await expect(authorizer.authorize(input)).resolves.toEqual({status: 'denied'});
    await testPool.query(
      'UPDATE actors SET disabled_at = null WHERE id = $1',
      [ids.actor]
    );
  });
});
