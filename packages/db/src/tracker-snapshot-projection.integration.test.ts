import {randomUUID} from 'node:crypto';
import type {TrackerRepositorySnapshot} from '@fai-control-plane/domain';
import {and, eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  createDatabase,
  createPostgresTrackerSnapshotProjector
} from './index';
import {
  auditEvents,
  buildChecks,
  prLinks,
  trackerBindings,
  trackerSnapshotOperations,
  workItems
} from './schema';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_tracker_test_${randomUUID().replaceAll('-', '')}`;
const ids = {
  workspace: randomUUID(),
  project: randomUUID(),
  actor: randomUUID(),
  owner: randomUUID(),
  otherProject: randomUUID()
};

const issue = (externalId: string, title = 'Issue title') => ({
  externalId,
  externalVersion: `github:sha256:${externalId}:${title}`,
  url: `https://api.github.com/repos/VF78/MSA/issues/${externalId}`,
  htmlUrl: `https://github.com/VF78/MSA/issues/${externalId}`,
  number: Number(externalId.split(':').at(-1)),
  title,
  state: 'open' as const,
  labels: [],
  assignees: [],
  milestone: null
});

const pullRequest = (externalId: string) => ({
  externalId,
  externalVersion: `github:sha256:${externalId}`,
  url: `https://api.github.com/repos/VF78/MSA/pulls/10`,
  htmlUrl: `https://github.com/VF78/MSA/pull/10`,
  number: 10,
  title: 'PR title',
  state: 'open' as const,
  draft: false,
  merged: false,
  headRef: 'feature',
  headSha: 'a'.repeat(40),
  baseRef: 'main',
  labels: [],
  assignees: [],
  milestone: null
});

const check = (externalId: string, pullRequestExternalId: string) => ({
  externalId,
  externalVersion: `github:sha256:${externalId}`,
  pullRequestExternalId,
  name: 'test',
  status: 'completed' as const,
  conclusion: 'success' as const,
  detailsUrl: 'https://github.com/VF78/MSA/actions/runs/1'
});

const snapshot = (
  version: string,
  overrides: Partial<TrackerRepositorySnapshot> = {}
): TrackerRepositorySnapshot => ({
  repository: {
    externalId: 'github:repository:1278325372',
    externalVersion: 'github:sha256:repository',
    owner: 'VF78',
    name: 'MSA'
  },
  externalVersion: version,
  workItems: [issue('github:issue:1')],
  pullRequests: [pullRequest('github:pull_request:10')],
  checks: [check('github:check_run:100', 'github:pull_request:10')],
  ...overrides
});

const operation = (snapshotValue: TrackerRepositorySnapshot) => ({
  operationId: randomUUID(),
  workspaceId: ids.workspace,
  projectId: ids.project,
  actorId: ids.actor,
  correlationId: randomUUID(),
  provider: 'github',
  snapshot: snapshotValue
});

describePostgres('PostgreSQL tracker repository snapshot projection', () => {
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
      `INSERT INTO workspaces (id, name, slug)
       VALUES ($1, 'Workspace', $2)`,
      [ids.workspace, `workspace-${randomUUID()}`]
    );
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'MSA', $3), ($4, $2, 'Other', $5)`,
      [
        ids.project,
        ids.workspace,
        `msa-${randomUUID()}`,
        ids.otherProject,
        `other-${randomUUID()}`
      ]
    );
    await testPool.query(
      `INSERT INTO actors (
         id, workspace_id, type, role, display_name, auth_mode
       ) VALUES
         ($1, $2, 'system', 'workspace_admin', 'Projector', 'system'),
         ($3, $2, 'human', 'developer', 'Owner', 'user')`,
      [
        ids.actor,
        ids.workspace,
        ids.owner
      ]
    );
  });

  afterAll(async () => {
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

  it('requires bootstrap, then atomically creates audited mirrors and replays idempotently', async () => {
    const projector = createPostgresTrackerSnapshotProjector(db);
    const initial = snapshot('github:sha256:snapshot-1', {
      workItems: [{
        ...issue('github:issue:1'),
        body: 'raw-body-must-not-be-persisted'
      } as (ReturnType<typeof issue> & {body: string})]
    });
    const beforeBootstrap = await projector.synchronize({
      ...operation(initial),
      expectedPreviousExternalVersion: 'none'
    });
    expect(beforeBootstrap).toEqual({
      status: 'conflict',
      code: 'bootstrap_required'
    });

    const bootstrap = {
      ...operation(initial),
      pullRequestBindings: [{
        pullRequestExternalId: 'github:pull_request:10',
        workItemExternalId: 'github:issue:1'
      }]
    };
    const applied = await projector.bootstrap(bootstrap);
    expect(applied).toMatchObject({
      status: 'applied',
      createdWorkItems: 1,
      projectedPullRequests: 1,
      projectedChecks: 1,
      unknownWorkItemExternalIds: [],
      unmappablePullRequestExternalIds: [],
      unknownCheckExternalIds: []
    });
    expect(await projector.bootstrap(bootstrap)).toEqual({
      status: 'replayed',
      result: applied
    });

    const [items, prs, checks, operations, audits] = await Promise.all([
      db.select().from(workItems).where(eq(workItems.projectId, ids.project)),
      db.select().from(prLinks),
      db.select().from(buildChecks),
      db.select().from(trackerSnapshotOperations),
      db.select().from(auditEvents).where(eq(auditEvents.projectId, ids.project))
    ]);
    expect(items).toHaveLength(1);
    expect(prs).toHaveLength(1);
    expect(checks).toHaveLength(1);
    expect(operations).toHaveLength(2);
    expect(audits).toHaveLength(2);
    expect(JSON.stringify([
      ...operations.map(({result}) => result),
      ...(await db.select({metadata: trackerBindings.metadata})
        .from(trackerBindings)).map(({metadata}) => metadata)
    ])).not.toContain('raw-body-must-not-be-persisted');
  });

  it('updates only bound mirror fields, reports unknowns, and rejects stale ordering', async () => {
    const projector = createPostgresTrackerSnapshotProjector(db);
    const [boundIssue] = await db.select()
      .from(trackerBindings)
      .where(and(
        eq(trackerBindings.projectId, ids.project),
        eq(trackerBindings.surface, 'issue')
      ));
    expect(boundIssue).toBeDefined();
    await db.update(workItems).set({
      summary: 'Canonical summary',
      status: 'in_dev',
      blocked: true,
      ownerActorId: ids.owner,
      version: 7
    }).where(eq(workItems.id, boundIssue!.entityId));

    const next = snapshot('github:sha256:snapshot-2', {
      workItems: [
        issue('github:issue:1', 'Updated provider title'),
        issue('github:issue:2', 'Unknown issue')
      ],
      pullRequests: [
        pullRequest('github:pull_request:10'),
        pullRequest('github:pull_request:11')
      ],
      checks: [
        check('github:check_run:100', 'github:pull_request:10'),
        check('github:check_run:101', 'github:pull_request:11')
      ]
    });
    const applied = await projector.synchronize({
      ...operation(next),
      expectedPreviousExternalVersion: 'github:sha256:snapshot-1'
    });
    expect(applied).toMatchObject({
      status: 'applied',
      createdWorkItems: 0,
      updatedWorkItems: 1,
      unknownWorkItemExternalIds: ['github:issue:2'],
      unmappablePullRequestExternalIds: ['github:pull_request:11'],
      unknownCheckExternalIds: ['github:check_run:101']
    });

    const [canonical] = await db.select().from(workItems)
      .where(eq(workItems.id, boundIssue!.entityId));
    expect(canonical).toMatchObject({
      title: 'Updated provider title',
      summary: 'Canonical summary',
      status: 'in_dev',
      blocked: true,
      ownerActorId: ids.owner,
      version: 7
    });
    expect(await db.select().from(workItems)
      .where(eq(workItems.projectId, ids.project))).toHaveLength(1);

    const stale = await projector.synchronize({
      ...operation(snapshot('github:sha256:snapshot-stale')),
      expectedPreviousExternalVersion: 'github:sha256:snapshot-1'
    });
    expect(stale).toEqual({
      status: 'conflict',
      code: 'stale_snapshot',
      currentExternalVersion: 'github:sha256:snapshot-2'
    });
  });

  it('rolls back the entire bootstrap snapshot when an immutable binding collides', async () => {
    await db.insert(trackerBindings).values({
      projectId: ids.otherProject,
      provider: 'github',
      surface: 'issue',
      externalId: 'github:issue:999',
      entityType: 'work_item',
      entityId: randomUUID()
    });
    const projector = createPostgresTrackerSnapshotProjector(db);
    const rollbackProject = randomUUID();
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Rollback', $3)`,
      [rollbackProject, ids.workspace, `rollback-${randomUUID()}`]
    );
    const invalid = snapshot('github:sha256:rollback', {
      repository: {
        externalId: 'github:repository:1279114011',
        externalVersion: 'github:sha256:repository-ascon',
        owner: 'VF78',
        name: 'ascon'
      },
      workItems: [
        issue('github:issue:998'),
        issue('github:issue:999')
      ],
      pullRequests: [],
      checks: []
    });
    await expect(projector.bootstrap({
      ...operation(invalid),
      projectId: rollbackProject
    })).rejects.toThrow('tracker_snapshot_projection_failed');

    expect(await db.select().from(workItems)
      .where(eq(workItems.projectId, rollbackProject))).toHaveLength(0);
    expect(await db.select().from(trackerSnapshotOperations)
      .where(eq(trackerSnapshotOperations.projectId, rollbackProject)))
      .toHaveLength(0);
  });
});
