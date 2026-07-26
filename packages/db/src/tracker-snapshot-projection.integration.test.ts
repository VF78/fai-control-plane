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
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
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
  milestone: null,
  projectStatus: null
});

const pullRequest = (externalId: string, linkedWorkItemExternalIds: readonly string[] = []) => ({
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
  milestone: null,
  linkedWorkItemExternalIds
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
  pullRequests: [pullRequest('github:pull_request:10', ['github:issue:1'])],
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
      try {
        await dropDatabaseWhenDisconnected(adminPool, databaseName);
      } finally {
        await adminPool.end();
      }
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

    const bootstrap = operation(initial);
    const applied = await projector.bootstrap(bootstrap);
    expect(applied).toMatchObject({
      status: 'applied',
      createdWorkItems: 1,
      projectedPullRequests: 1,
      projectedChecks: 1,
      unknownWorkItemExternalIds: [],
      unmappablePullRequestExternalIds: [],
      ambiguousPullRequestExternalIds: [],
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
        pullRequest('github:pull_request:10', ['github:issue:1']),
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

  it('serializes simultaneous identical bootstrap and synchronize operations', async () => {
    const projectId = randomUUID();
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Concurrent', $3)`,
      [projectId, ids.workspace, `concurrent-${randomUUID()}`]
    );
    const projector = createPostgresTrackerSnapshotProjector(db);
    const initial = snapshot('concurrent:1', {
      repository: {
        externalId: 'test:repository:concurrent',
        externalVersion: 'test:repository:concurrent:1',
        owner: 'Test',
        name: 'Concurrent'
      },
      workItems: [issue('test:issue:2001')],
      pullRequests: [],
      checks: []
    });
    const bootstrap = {
      ...operation(initial),
      projectId,
      provider: 'test-concurrency'
    };
    const bootstrapResults = await Promise.all([
      projector.bootstrap(bootstrap),
      projector.bootstrap(bootstrap)
    ]);
    expect(bootstrapResults.map(({status}) => status).sort()).toEqual([
      'applied',
      'replayed'
    ]);
    expect(await db.select().from(workItems)
      .where(eq(workItems.projectId, projectId))).toHaveLength(1);

    const next = {
      ...initial,
      externalVersion: 'concurrent:2',
      workItems: [issue('test:issue:2001', 'Concurrent update')]
    };
    const synchronization = {
      ...operation(next),
      projectId,
      provider: 'test-concurrency',
      expectedPreviousExternalVersion: 'concurrent:1'
    };
    const synchronizationResults = await Promise.all([
      projector.synchronize(synchronization),
      projector.synchronize(synchronization)
    ]);
    expect(synchronizationResults.map(({status}) => status).sort()).toEqual([
      'applied',
      'replayed'
    ]);
    expect(await db.select().from(trackerSnapshotOperations)
      .where(eq(trackerSnapshotOperations.projectId, projectId)))
      .toHaveLength(2);
    expect(await db.select().from(auditEvents)
      .where(eq(auditEvents.projectId, projectId))).toHaveLength(2);
  });

  it('serializes competing first bootstraps at the project/provider identity boundary', async () => {
    const projectId = randomUUID();
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Competing bootstrap', $3)`,
      [projectId, ids.workspace, `competing-${randomUUID()}`]
    );
    const projector = createPostgresTrackerSnapshotProjector(db);
    const first = snapshot('competing:first', {
      repository: {
        externalId: 'test:repository:first',
        externalVersion: 'test:repository:first:1',
        owner: 'Test',
        name: 'First'
      },
      workItems: [issue('test:issue:2101')],
      pullRequests: [],
      checks: []
    });
    const second = snapshot('competing:second', {
      repository: {
        externalId: 'test:repository:second',
        externalVersion: 'test:repository:second:1',
        owner: 'Test',
        name: 'Second'
      },
      workItems: [issue('test:issue:2102')],
      pullRequests: [],
      checks: []
    });
    const results = await Promise.all([
      projector.bootstrap({
        ...operation(first),
        projectId,
        provider: 'test-competing'
      }),
      projector.bootstrap({
        ...operation(second),
        projectId,
        provider: 'test-competing'
      })
    ]);

    expect(results.filter(({status}) => status === 'applied')).toHaveLength(1);
    expect(results.filter(({status}) => status === 'conflict')).toHaveLength(1);
    expect(results).toContainEqual({
      status: 'conflict',
      code: 'repository_identity_conflict'
    });
    expect(await db.select().from(workItems)
      .where(eq(workItems.projectId, projectId))).toHaveLength(1);
    expect(await db.select().from(trackerBindings).where(and(
      eq(trackerBindings.projectId, projectId),
      eq(trackerBindings.provider, 'test-competing'),
      eq(trackerBindings.surface, 'repository')
    ))).toHaveLength(1);
    expect(await db.select().from(trackerSnapshotOperations)
      .where(eq(trackerSnapshotOperations.projectId, projectId)))
      .toHaveLength(2);
    expect(await db.select().from(auditEvents)
      .where(eq(auditEvents.projectId, projectId))).toHaveLength(2);
  });

  it('audits idempotency-key reuse without replacing the original receipt', async () => {
    const projectId = randomUUID();
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Reuse', $3)`,
      [projectId, ids.workspace, `reuse-${randomUUID()}`]
    );
    const projector = createPostgresTrackerSnapshotProjector(db);
    const initial = snapshot('reuse:1', {
      repository: {
        externalId: 'test:repository:reuse',
        externalVersion: 'test:repository:reuse:1',
        owner: 'Test',
        name: 'Reuse'
      },
      workItems: [],
      pullRequests: [],
      checks: []
    });
    const bootstrap = {
      ...operation(initial),
      projectId,
      provider: 'test-reuse'
    };
    await projector.bootstrap(bootstrap);
    const [originalReceipt] = await db.select()
      .from(trackerSnapshotOperations)
      .where(eq(trackerSnapshotOperations.id, bootstrap.operationId));

    const reused = {
      ...bootstrap,
      snapshot: {...initial, externalVersion: 'reuse:changed'}
    };
    await expect(projector.bootstrap(reused)).resolves.toEqual({
      status: 'conflict',
      code: 'idempotency_key_reused'
    });
    await projector.bootstrap(reused);

    const [persistedReceipt] = await db.select()
      .from(trackerSnapshotOperations)
      .where(eq(trackerSnapshotOperations.id, bootstrap.operationId));
    expect(persistedReceipt).toEqual(originalReceipt);
    const reuseAudits = await db.select()
      .from(auditEvents)
      .where(and(
        eq(auditEvents.projectId, projectId),
        eq(auditEvents.action, 'tracker_snapshot.idempotency_reuse')
      ));
    expect(reuseAudits).toHaveLength(1);
    expect(reuseAudits[0]).toMatchObject({
      actorId: null,
      outcome: 'rejected',
      reasonCode: 'IDEMPOTENCY_KEY_REUSED',
      targetId: 'test:repository:reuse'
    });
    expect(reuseAudits[0]?.commandId).not.toContain('reuse:changed');
  });

  it('refreshes repository names and PR repository refs for a stable external ID', async () => {
    const projector = createPostgresTrackerSnapshotProjector(db);
    const renamed = snapshot('github:sha256:snapshot-renamed', {
      repository: {
        externalId: 'github:repository:1278325372',
        externalVersion: 'github:sha256:repository-renamed',
        owner: 'VF78-renamed',
        name: 'MSA-renamed'
      },
      workItems: [issue('github:issue:1', 'Updated provider title')]
    });
    const result = await projector.synchronize({
      ...operation(renamed),
      expectedPreviousExternalVersion: 'github:sha256:snapshot-2'
    });
    expect(result.status).toBe('applied');

    const [repositoryBinding] = await db.select()
      .from(trackerBindings)
      .where(and(
        eq(trackerBindings.projectId, ids.project),
        eq(trackerBindings.surface, 'repository')
      ));
    expect(repositoryBinding?.externalId)
      .toBe('github:repository:1278325372');
    expect(repositoryBinding?.metadata).toMatchObject({
      owner: 'VF78-renamed',
      name: 'MSA-renamed'
    });
    const [pullRequestRow] = await db.select().from(prLinks)
      .where(eq(prLinks.externalId, 'github:pull_request:10'));
    expect(pullRequestRow?.repositoryRef).toBe('VF78-renamed/MSA-renamed');
  });

  it('does not advance orphan PR/check bindings or projection counters after cascade deletion', async () => {
    const projectId = randomUUID();
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Orphans', $3)`,
      [projectId, ids.workspace, `orphans-${randomUUID()}`]
    );
    const projector = createPostgresTrackerSnapshotProjector(db);
    const initial = snapshot('orphans:1', {
      repository: {
        externalId: 'test:repository:orphans',
        externalVersion: 'test:repository:orphans:1',
        owner: 'Test',
        name: 'Orphans'
      },
      workItems: [issue('test:issue:3001')],
      pullRequests: [pullRequest('test:pull_request:3010', ['test:issue:3001'])],
      checks: [check('test:check:3100', 'test:pull_request:3010')]
    });
    await projector.bootstrap({
      ...operation(initial),
      projectId,
      provider: 'test-orphans'
    });
    const before = await db.select({
      surface: trackerBindings.surface,
      externalId: trackerBindings.externalId,
      lastInboundVersion: trackerBindings.lastInboundVersion
    }).from(trackerBindings).where(and(
      eq(trackerBindings.projectId, projectId),
      eq(trackerBindings.provider, 'test-orphans')
    ));
    await db.delete(workItems).where(eq(workItems.projectId, projectId));
    expect(await db.select().from(prLinks)
      .where(eq(prLinks.externalId, 'test:pull_request:3010'))).toHaveLength(0);
    expect(await db.select().from(buildChecks)
      .where(eq(buildChecks.externalId, 'test:check:3100'))).toHaveLength(0);

    const next = snapshot('orphans:2', {
      repository: {
        ...initial.repository,
        externalVersion: 'test:repository:orphans:2'
      },
      workItems: [{
        ...issue('test:issue:3001'),
        externalVersion: 'test:issue:3001:2'
      }],
      pullRequests: [{
        ...pullRequest('test:pull_request:3010', ['test:issue:3001']),
        externalVersion: 'test:pull_request:3010:2'
      }],
      checks: [{
        ...check('test:check:3100', 'test:pull_request:3010'),
        externalVersion: 'test:check:3100:2'
      }]
    });
    const result = await projector.synchronize({
      ...operation(next),
      projectId,
      provider: 'test-orphans',
      expectedPreviousExternalVersion: 'orphans:1'
    });
    expect(result).toMatchObject({
      status: 'applied',
      createdWorkItems: 0,
      updatedWorkItems: 0,
      projectedPullRequests: 0,
      projectedChecks: 0,
      unknownWorkItemExternalIds: ['test:issue:3001'],
      unmappablePullRequestExternalIds: ['test:pull_request:3010'],
      unknownCheckExternalIds: ['test:check:3100']
    });

    const after = await db.select({
      surface: trackerBindings.surface,
      externalId: trackerBindings.externalId,
      lastInboundVersion: trackerBindings.lastInboundVersion
    }).from(trackerBindings).where(and(
      eq(trackerBindings.projectId, projectId),
      eq(trackerBindings.provider, 'test-orphans')
    ));
    for (const surface of ['issue', 'pull_request', 'check']) {
      expect(after.find((binding) => binding.surface === surface))
        .toEqual(before.find((binding) => binding.surface === surface));
    }
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
