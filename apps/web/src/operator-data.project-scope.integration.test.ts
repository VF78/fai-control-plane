import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {actors, createDatabase, projectMemberships, projects, workspaces} from '@fai-control-plane/db';
import {dropDatabaseWhenDisconnected} from '../../../packages/db/src/integration-test-utils';
import {loadAccessData, loadProjectData} from './operator-data';

const adminDatabaseUrl = process.env.DATABASE_URL;
if (process.env.CI && adminDatabaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for operator project scope tests in CI.');
}
const describePostgres = adminDatabaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_operator_scope_${randomUUID().replaceAll('-', '')}`;

describePostgres('operator project scope', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let testDatabaseUrl: string;
  const ids = {workspace: randomUUID(), otherWorkspace: randomUUID(), actor: randomUUID(),
    otherActor: randomUUID(), project: randomUUID(), otherProject: randomUUID()};

  beforeAll(async () => {
    const adminUrl = new URL(adminDatabaseUrl!);
    adminUrl.pathname = '/postgres';
    adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(adminDatabaseUrl!);
    testUrl.pathname = `/${databaseName}`;
    testDatabaseUrl = testUrl.toString();
    const created = createDatabase(testDatabaseUrl);
    testPool = created.pool;
    await migrate(created.db, {migrationsFolder: fileURLToPath(new URL('../../../packages/db/drizzle', import.meta.url))});
    await created.db.insert(workspaces).values([
      {id: ids.workspace, name: 'Primary', slug: `primary-${randomUUID()}`},
      {id: ids.otherWorkspace, name: 'Other', slug: `other-${randomUUID()}`}
    ]);
    await created.db.insert(projects).values([
      {id: ids.project, workspaceId: ids.workspace, name: 'Correct project', slug: 'same-slug'},
      {id: ids.otherProject, workspaceId: ids.otherWorkspace, name: 'Foreign project', slug: 'same-slug'}
    ]);
    await created.db.insert(actors).values([
      {id: ids.actor, workspaceId: ids.workspace, type: 'human', role: 'workspace_admin', displayName: 'Primary operator', authMode: 'user'},
      {id: ids.otherActor, workspaceId: ids.otherWorkspace, type: 'human', role: 'workspace_admin', displayName: 'Foreign operator', authMode: 'user'}
    ]);
    await created.db.insert(projectMemberships).values([
      {projectId: ids.project, actorId: ids.actor, role: 'project_owner'},
      {projectId: ids.otherProject, actorId: ids.otherActor, role: 'project_owner'}
    ]);
  }, 30_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try { await dropDatabaseWhenDisconnected(adminPool, databaseName); }
      finally { await adminPool.end(); }
    }
  }, 30_000);

  it('loads the authorized project ID and never resolves a foreign same-slug project', async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testDatabaseUrl;
    try {
      const access = await loadAccessData(ids.actor);
      expect(access).toMatchObject({state: 'ready', data: {memberships: [{projectId: ids.project,
        projectSlug: 'same-slug', actorId: ids.actor}]}});
      if (access.state !== 'ready') throw new Error('Access projection unavailable.');
      expect(access.data.memberships.some(({projectId}) => projectId === ids.otherProject)).toBe(false);
      const loaded = await loadProjectData({projectId: ids.project, slug: 'same-slug'});
      expect(loaded).toMatchObject({state: 'ready', data: {project: {id: ids.project,
        workspaceId: ids.workspace, name: 'Correct project'}}});
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it('serializes the enabled runner admission fact without exposing its configuration', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousRunner = process.env.RUNNER_ENABLED;
    const previousTransport = process.env.LOCAL_RUNNER_TRANSPORT_ENABLED;
    process.env.DATABASE_URL = testDatabaseUrl;
    try {
      process.env.RUNNER_ENABLED = 'false'; process.env.LOCAL_RUNNER_TRANSPORT_ENABLED = 'true';
      const disabled = await loadProjectData({projectId: ids.project, slug: 'same-slug'});
      expect(disabled).toMatchObject({state: 'ready', data: {runnerQueueEnabled: false}});
      process.env.RUNNER_ENABLED = 'true'; process.env.LOCAL_RUNNER_TRANSPORT_ENABLED = 'true';
      const enabled = await loadProjectData({projectId: ids.project, slug: 'same-slug'});
      expect(enabled).toMatchObject({state: 'ready', data: {runnerQueueEnabled: true}});
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousRunner === undefined) delete process.env.RUNNER_ENABLED;
      else process.env.RUNNER_ENABLED = previousRunner;
      if (previousTransport === undefined) delete process.env.LOCAL_RUNNER_TRANSPORT_ENABLED;
      else process.env.LOCAL_RUNNER_TRANSPORT_ENABLED = previousTransport;
    }
  });
});
