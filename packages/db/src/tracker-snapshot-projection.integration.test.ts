import {randomUUID} from 'node:crypto';
import type {TrackerRepositorySnapshot} from '@fai-control-plane/domain';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  createDatabase,
  createPostgresProjectTaskProjectionReader,
  createPostgresTrackerSnapshotProjector
} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  auditEvents,
  buildChecks,
  projectTrackerRepositoryScopes,
  prLinks,
  secretRefs,
  trackerBindings,
  trackerSnapshotOperations,
  trackerStatusObservationInbox,
  workItems
} from './schema';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_tracker_test_${randomUUID().replaceAll('-', '')}`;
const ids = {workspace: randomUUID(), actor: randomUUID(), secretRef: randomUUID()};

const snapshot = (version: string, repositoryName: 'MSA' | 'ascon' = 'MSA'):
TrackerRepositorySnapshot => {
  const ascon = repositoryName === 'ascon';
  const projectExternalId = ascon ? 'PVT_kwHOBIUvJs4Bbi0Q' : 'PVT_kwHOBIUvJs4Bbefq';
  const statusFieldExternalId = ascon
    ? 'PVTSSF_lAHOBIUvJs4Bbi0QzhWSnmU'
    : 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc';
  const optionExternalId = ascon ? 'f1d63022' : '1f121483';
  const item = {
    externalId: `PVTI_${repositoryName}_1`,
    issueExternalId: 'github:issue:1',
    url: `https://api.github.com/repos/VF78/${repositoryName}/issues/1`,
    htmlUrl: `https://github.com/VF78/${repositoryName}/issues/1`,
    number: 1,
    title: 'Provider task',
    state: 'open' as const,
    labels: [],
    assignees: [],
    milestone: null,
    projectExternalId,
    status: {fieldExternalId: statusFieldExternalId, optionExternalId, optionName: 'Ready'},
    targetDate: ascon ? '2026-08-31' : null,
    parentIssueExternalId: null,
    subIssueExternalIds: [],
    dependencyExternalIds: []
  };
  const projectItem = {...item, externalVersion: `github:sha256:item:${version}`};
  return {
    repository: {
      externalId: `github:repository:${ascon ? 1279114011 : 1278325372}`,
      externalVersion: `github:sha256:repository:${version}`,
      owner: 'VF78', name: repositoryName, defaultBranch: 'main', headSha: 'a'.repeat(40)
    },
    externalVersion: version,
    projectItems: [projectItem],
    pullRequests: [],
    checks: []
  };
};

describePostgres('provider-native tracker snapshot projection', () => {
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
      `insert into workspaces (id, name, slug) values ($1, 'Workspace', $2)`,
      [ids.workspace, `workspace-${randomUUID()}`]
    );
    await testPool.query(
      `insert into actors (id, workspace_id, type, role, display_name, auth_mode)
       values ($1, $2, 'system', 'workspace_admin', 'Projector', 'system')`,
      [ids.actor, ids.workspace]
    );
    await db.insert(secretRefs).values({
      id: ids.secretRef,
      workspaceId: ids.workspace,
      provider: 'file',
      reference: '/test/github-token',
      scope: ['read:project']
    });
  });

  beforeEach(async () => {
    await db.delete(trackerBindings);
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

  const createProject = async (name = 'MSA') => {
    const projectId = randomUUID();
    await testPool.query(
      `insert into projects (id, workspace_id, name, slug) values ($1, $2, $3, $4)`,
      [projectId, ids.workspace, name, `${name.toLowerCase()}-${randomUUID()}`]
    );
    await db.insert(projectTrackerRepositoryScopes).values({
      projectId,
      provider: 'github',
      repositoryOwner: 'VF78',
      repositoryName: name,
      repositoryExternalId: name === 'ASCON'
        ? 'github:repository:1279114011'
        : 'github:repository:1278325372',
      credentialRefId: ids.secretRef
    });
    return projectId;
  };

  const operation = (projectId: string, value: TrackerRepositorySnapshot) => ({
    operationId: randomUUID(),
    workspaceId: ids.workspace,
    projectId,
    actorId: ids.actor,
    correlationId: randomUUID(),
    provider: 'github',
    snapshot: value
  });

  it('requires an explicit provider repository bootstrap', async () => {
    const projectId = await createProject();
    const value = snapshot('github:sha256:v1');
    await expect(createPostgresTrackerSnapshotProjector(db).synchronize({
      ...operation(projectId, value),
      expectedPreviousExternalVersion: ''
    })).resolves.toEqual({status: 'conflict', code: 'bootstrap_required'});
  });

  it('stores one repository mirror and immutable provider snapshot without local lifecycle rows', async () => {
    const projectId = await createProject();
    const value = snapshot('github:sha256:v1');
    const input = operation(projectId, value);
    const projector = createPostgresTrackerSnapshotProjector(db);

    await expect(projector.bootstrap(input)).resolves.toMatchObject({
      status: 'applied', snapshotExternalVersion: value.externalVersion, snapshot: value, decisions: []
    });
    await expect(projector.bootstrap(input)).resolves.toMatchObject({
      status: 'replayed', result: {status: 'applied'}
    });

    const bindings = await db.select().from(trackerBindings)
      .where(eq(trackerBindings.projectId, projectId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      surface: 'repository', entityType: 'project', entityId: projectId
    });
    await expect(db.select().from(workItems).where(eq(workItems.projectId, projectId)))
      .resolves.toHaveLength(0);
    await expect(db.select().from(prLinks)).resolves.toHaveLength(0);
    await expect(db.select().from(buildChecks)).resolves.toHaveLength(0);
    await expect(db.select().from(trackerStatusObservationInbox)
      .where(eq(trackerStatusObservationInbox.projectId, projectId))).resolves.toHaveLength(0);

    const operations = await db.select().from(trackerSnapshotOperations)
      .where(eq(trackerSnapshotOperations.projectId, projectId));
    expect(operations).toHaveLength(1);
    expect(operations[0]?.result).toMatchObject({snapshot: value, decisions: []});
  });

  it('returns unchanged for the same provider version and one deterministic ASCON decision', async () => {
    const projectId = await createProject('ASCON');
    const first = snapshot('github:sha256:v1', 'ascon');
    const projector = createPostgresTrackerSnapshotProjector(db);
    await projector.bootstrap(operation(projectId, first));

    const synchronized = await projector.synchronize({
      ...operation(projectId, first),
      expectedPreviousExternalVersion: first.externalVersion
    });
    expect(synchronized).toMatchObject({
      status: 'unchanged',
      decisions: [{action: 'hermes_role_request', hermesRole: 'developer'}]
    });
  });

  it('rejects operation-id reuse without replacing the immutable receipt', async () => {
    const projectId = await createProject();
    const projector = createPostgresTrackerSnapshotProjector(db);
    const first = operation(projectId, snapshot('github:sha256:v1'));
    await projector.bootstrap(first);

    await expect(projector.bootstrap({...first, snapshot: snapshot('github:sha256:v2')}))
      .resolves.toEqual({status: 'conflict', code: 'idempotency_key_reused'});
    await expect(db.select().from(trackerSnapshotOperations)
      .where(eq(trackerSnapshotOperations.projectId, projectId))).resolves.toHaveLength(1);
    const [binding] = await db.select().from(trackerBindings)
      .where(eq(trackerBindings.projectId, projectId));
    expect(binding?.lastInboundVersion).toBe('github:sha256:v1');
    const rejected = await db.select().from(auditEvents)
      .where(eq(auditEvents.projectId, projectId));
    expect(rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({reasonCode: 'IDEMPOTENCY_KEY_REUSED', outcome: 'rejected'})
    ]));
  });

  it('serializes competing first snapshots at the project/provider boundary', async () => {
    const projectId = await createProject();
    const projector = createPostgresTrackerSnapshotProjector(db);
    const results = await Promise.all([
      projector.bootstrap(operation(projectId, snapshot('github:sha256:v1'))),
      projector.bootstrap(operation(projectId, snapshot('github:sha256:v2')))
    ]);
    expect(results.map(({status}) => status).sort()).toEqual(['applied', 'conflict']);
    await expect(db.select().from(trackerBindings)
      .where(eq(trackerBindings.projectId, projectId))).resolves.toHaveLength(1);
  });

  it('converges concurrent webhook and poll reads of the same provider version', async () => {
    const projectId = await createProject();
    const projector = createPostgresTrackerSnapshotProjector(db);
    const first = snapshot('github:sha256:v1');
    const next = snapshot('github:sha256:v2');
    await projector.bootstrap(operation(projectId, first));

    const results = await Promise.all([
      projector.synchronize({...operation(projectId, next),
        expectedPreviousExternalVersion: first.externalVersion}),
      projector.synchronize({...operation(projectId, next),
        expectedPreviousExternalVersion: first.externalVersion})
    ]);
    expect(results.map(({status}) => status).sort()).toEqual(['applied', 'unchanged']);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({status: 'unchanged', snapshotExternalVersion: next.externalVersion})
    ]));
  });

  it('keeps the last successful provider snapshot visible after any number of failed attempts', async () => {
    const projectId = await createProject();
    const successfulSnapshot = snapshot('github:sha256:v1');
    const conflictingSnapshot = snapshot('github:sha256:v2');
    const projector = createPostgresTrackerSnapshotProjector(db);
    await projector.bootstrap(operation(projectId, successfulSnapshot));
    for (let index = 0; index < 21; index += 1) {
      await projector.synchronize({
        ...operation(projectId, conflictingSnapshot),
        expectedPreviousExternalVersion: `github:sha256:stale:${index}`
      });
    }

    const reader = createPostgresProjectTaskProjectionReader(db);
    const projection = await reader.read({
      workspaceId: ids.workspace,
      projectId
    });
    expect(projection).toMatchObject({
      project: {freshness: 'fresh', error: 'stale_snapshot'},
      tasks: [{id: 'PVTI_MSA_1', issueExternalId: 'github:issue:1'}]
    });

    await db.insert(auditEvents).values({
      id: randomUUID(),
      workspaceId: ids.workspace,
      projectId,
      actorId: ids.actor,
      commandId: `tracker-reconcile-failure:${randomUUID()}`,
      actionCategory: 'write',
      action: 'tracker_snapshot.reconcile',
      targetType: 'tracker_repository',
      targetId: successfulSnapshot.repository.externalId,
      outcome: 'failed',
      reasonCode: 'REPOSITORY_READ_FAILED',
      correlationId: randomUUID(),
      occurredAt: new Date()
    });
    await expect(reader.read({workspaceId: ids.workspace, projectId})).resolves.toMatchObject({
      project: {error: 'repository_read_failed'},
      tasks: [{id: 'PVTI_MSA_1'}]
    });
  });
});
