import {randomUUID} from 'node:crypto';
import {
  createActorContextIssuer,
  type TrackerRepositorySnapshot
} from '@fai-control-plane/domain';
import {and, eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createCanonicalCommandService} from '../../application/src/index.ts';
import {
  createDatabase,
  createPostgresTrackerEvidenceProjectionReader,
  createPostgresTrackerStatusObservationProcessor,
  createPostgresTrackerSnapshotProjector,
  createPostgresUnitOfWork
} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  auditEvents,
  buildChecks,
  outboxEvents,
  prLinks,
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

type SnapshotOverrides = Omit<Partial<TrackerRepositorySnapshot>, 'repository'> & Readonly<{
  repository?: Partial<TrackerRepositorySnapshot['repository']>;
}>;

const snapshot = (
  version: string,
  {repository: repositoryOverrides, ...overrides}: SnapshotOverrides = {}
): TrackerRepositorySnapshot => ({
  repository: {
    externalId: 'github:repository:1278325372',
    externalVersion: 'github:sha256:repository',
    owner: 'VF78',
    name: 'MSA',
    defaultBranch: 'main',
    headSha: 'b'.repeat(40),
    ...repositoryOverrides
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

  it('retains absent PR/check history and exposes scoped provider-neutral evidence', async () => {
    const projectId = randomUUID();
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Evidence lifecycle', $3)`,
      [projectId, ids.workspace, `evidence-${randomUUID()}`]
    );
    const projector = createPostgresTrackerSnapshotProjector(db);
    const repository = {
      externalId: 'test:repository:evidence',
      externalVersion: 'test:repository:evidence:1',
      owner: 'Test',
      name: 'Evidence'
    };
    const initial = snapshot('test:snapshot:evidence:1', {
      repository,
      workItems: [issue('test:issue:4001')],
      pullRequests: [pullRequest('test:pull_request:4010', ['test:issue:4001'])],
      checks: [check('test:check:4100', 'test:pull_request:4010')]
    });
    const bootstrap = {...operation(initial), projectId, provider: 'test-evidence'};
    const applied = await projector.bootstrap(bootstrap);
    expect(applied.status).toBe('applied');
    const initialProjection = await createPostgresTrackerEvidenceProjectionReader(db).read({
      workspaceId: ids.workspace,
      projectId,
      providerRef: 'test-evidence',
      repositoryExternalRef: repository.externalId
    });
    expect(initialProjection?.pullRequests[0]?.evidence).toMatchObject({
      externalVersion: 'github:sha256:test:pull_request:4010',
      state: 'observed',
      confirmedAt: null,
      conflictReason: null
    });
    expect(initialProjection?.buildChecks[0]?.evidence.state).toBe('observed');

    const absent = {...initial, externalVersion: 'test:snapshot:evidence:2', pullRequests: [], checks: []};
    await projector.synchronize({
      ...operation(absent),
      projectId,
      provider: 'test-evidence',
      expectedPreviousExternalVersion: initial.externalVersion
    });
    const reader = createPostgresTrackerEvidenceProjectionReader(db);
    const missingProjection = await reader.read({
      workspaceId: ids.workspace,
      projectId,
      providerRef: 'test-evidence',
      repositoryExternalRef: repository.externalId
    });
    expect(missingProjection?.pullRequests).toHaveLength(1);
    expect(missingProjection?.pullRequests[0]?.evidence.state).toBe('missing');
    expect(missingProjection?.buildChecks).toHaveLength(1);
    expect(missingProjection?.buildChecks[0]?.evidence.state).toBe('stale');

    const reappeared = {...initial, externalVersion: 'test:snapshot:evidence:3'};
    await projector.synchronize({
      ...operation(reappeared),
      projectId,
      provider: 'test-evidence',
      expectedPreviousExternalVersion: absent.externalVersion
    });
    const confirmedProjection = await reader.read({
      workspaceId: ids.workspace,
      projectId,
      providerRef: 'test-evidence',
      repositoryExternalRef: repository.externalId
    });
    expect(confirmedProjection?.pullRequests[0]?.evidence).toMatchObject({
      state: 'confirmed',
      conflictReason: null
    });
    expect(confirmedProjection?.pullRequests[0]?.evidence.confirmedAt).not.toBeNull();
    expect(confirmedProjection?.buildChecks[0]?.evidence.state).toBe('confirmed');
    await expect(reader.read({
      workspaceId: ids.workspace,
      projectId,
      providerRef: 'test-evidence',
      repositoryExternalRef: 'test:repository:other'
    })).resolves.toBeNull();
    await expect(reader.read({
      workspaceId: randomUUID(),
      projectId,
      providerRef: 'test-evidence',
      repositoryExternalRef: repository.externalId
    })).resolves.toBeNull();
  });

  it('keeps a newer canonical GitHub status and outbound marker when a stale provider status arrives', async () => {
    const projectId = randomUUID();
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Reconciliation', $3)`,
      [projectId, ids.workspace, `reconciliation-${randomUUID()}`]
    );
    const projector = createPostgresTrackerSnapshotProjector(db);
    const projectStatus = {
      projectExternalId: 'PVT_kwHOBIUvJs4Bbefq',
      projectItemExternalId: 'PVTI_MSA_1',
      fieldExternalId: 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc',
      optionExternalId: '1f121483',
      status: 'ready' as const
    };
    const initial = snapshot('github:sha256:reconcile-1', {
      repository: {
        externalId: 'github:repository:9001',
        externalVersion: 'github:sha256:repository-reconcile',
        owner: 'VF78',
        name: 'Reconciliation'
      },
      workItems: [{...issue('github:issue:9001'), projectStatus}],
      pullRequests: [],
      checks: []
    });
    await projector.bootstrap({...operation(initial), projectId});
    const [binding] = await db.select().from(trackerBindings).where(and(
      eq(trackerBindings.projectId, projectId),
      eq(trackerBindings.surface, 'issue'),
      eq(trackerBindings.externalId, 'github:issue:9001')
    ));
    expect(binding).toBeDefined();
    const outboundMutationId = randomUUID();
    await db.update(workItems).set({status: 'in_dev', version: 2})
      .where(eq(workItems.id, binding!.entityId));
    await db.update(trackerBindings).set({lastOutboundMutationId: outboundMutationId})
      .where(eq(trackerBindings.id, binding!.id));

    const staleInput = {
      ...operation({...initial, externalVersion: 'github:sha256:reconcile-2'}),
      projectId,
      expectedPreviousExternalVersion: 'github:sha256:reconcile-1'
    };
    const stale = await projector.synchronize(staleInput);
    expect(stale).toMatchObject({status: 'applied', updatedWorkItemStatuses: 0});
    const [afterStale, staleBinding] = await Promise.all([
      db.select().from(workItems).where(eq(workItems.id, binding!.entityId)),
      db.select().from(trackerBindings).where(eq(trackerBindings.id, binding!.id))
    ]);
    expect(afterStale[0]).toMatchObject({status: 'in_dev', version: 2});
    expect(staleBinding[0]).toMatchObject({
      lastOutboundMutationId: outboundMutationId,
      lastInboundVersion: 'github:sha256:github:issue:9001:Issue title',
      evidenceState: 'conflict',
      conflictReason: 'outbound_race'
    });

    const confirmedStatus = {...projectStatus, optionExternalId: '47fc9ee4', status: 'in_dev' as const};
    const confirmedIssue = issue('github:issue:9001', 'Provider-confirmed title');
    const confirmation = await projector.synchronize({
      ...operation({...initial, externalVersion: 'github:sha256:reconcile-3', workItems: [{
        ...confirmedIssue, projectStatus: confirmedStatus
      }]}),
      projectId,
      expectedPreviousExternalVersion: 'github:sha256:reconcile-2'
    });
    expect(confirmation).toMatchObject({status: 'applied', updatedWorkItemStatuses: 0});
    const [confirmedBinding, audits, writes] = await Promise.all([
      db.select().from(trackerBindings).where(eq(trackerBindings.id, binding!.id)),
      db.select().from(auditEvents).where(and(
        eq(auditEvents.projectId, projectId),
        eq(auditEvents.commandId, staleInput.operationId),
        eq(auditEvents.reasonCode, 'GITHUB_PROJECT_STATUS_MISMATCH')
      )),
      db.select().from(outboxEvents).where(eq(outboxEvents.projectId, projectId))
    ]);
    expect(confirmedBinding[0]).toMatchObject({
      lastOutboundMutationId: null,
      externalVersion: confirmedIssue.externalVersion,
      lastInboundVersion: confirmedIssue.externalVersion,
      evidenceState: 'confirmed',
      conflictReason: null,
      metadata: {projectStatus: confirmedStatus}
    });
    expect(confirmedBinding[0]?.confirmedAt).not.toBeNull();
    expect(audits).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });

  it('adopts the Project status when a repository binding gains its initial identity', async () => {
    const projectId = randomUUID();
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Project identity bootstrap', $3)`,
      [projectId, ids.workspace, `project-identity-${randomUUID()}`]
    );
    const projector = createPostgresTrackerSnapshotProjector(db);
    const initial = snapshot('github:sha256:identity-1', {
      repository: {
        externalId: 'github:repository:9010',
        externalVersion: 'github:sha256:repository-identity-bootstrap',
        owner: 'VF78',
        name: 'ProjectIdentityBootstrap'
      },
      workItems: [issue('github:issue:9010')],
      pullRequests: [],
      checks: []
    });
    await projector.bootstrap({...operation(initial), projectId});

    const projectStatus = {
      projectExternalId: 'PVT_kwHOBIUvJs4Bbefq',
      projectItemExternalId: 'PVTI_MSA_10',
      fieldExternalId: 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc',
      optionExternalId: '1f121483',
      status: 'ready' as const
    };
    const projected = await projector.synchronize({
      ...operation({
        ...initial,
        externalVersion: 'github:sha256:identity-2',
        workItems: [{...issue('github:issue:9010'), projectStatus}]
      }),
      projectId,
      expectedPreviousExternalVersion: 'github:sha256:identity-1'
    });

    expect(projected).toMatchObject({
      status: 'applied',
      updatedWorkItemStatuses: 1,
      unknownProjectStatusWorkItemExternalIds: []
    });
    const [bindings, adoptedWorkItems] = await Promise.all([
      db.select().from(trackerBindings).where(and(
        eq(trackerBindings.projectId, projectId),
        eq(trackerBindings.externalId, 'github:issue:9010')
      )),
      db.select().from(workItems).where(eq(workItems.projectId, projectId))
    ]);
    const [binding] = bindings;
    expect(binding).toMatchObject({metadata: {projectStatus}});
    const observations = await db.select().from(trackerStatusObservationInbox)
      .where(eq(trackerStatusObservationInbox.projectId, projectId));
    expect(adoptedWorkItems).toHaveLength(1);
    expect(adoptedWorkItems[0]).toMatchObject({status: 'ready', version: 2});
    expect(observations).toHaveLength(0);
  });

  it('projects a status observation, applies it through the canonical command, and acknowledges its echo', async () => {
    const projectId = randomUUID();
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Status command', $3)`,
      [projectId, ids.workspace, `status-command-${randomUUID()}`]
    );
    const projector = createPostgresTrackerSnapshotProjector(db);
    const ready = {
      projectExternalId: 'PVT_status_command',
      projectItemExternalId: 'PVTI_status_command',
      fieldExternalId: 'PVTSSF_status_command',
      optionExternalId: 'option-ready',
      status: 'ready' as const
    };
    const initial = snapshot('github:sha256:status-command-1', {
      repository: {
        externalId: 'github:repository:9002',
        externalVersion: 'github:sha256:repository-status-command',
        owner: 'VF78',
        name: 'StatusCommand'
      },
      workItems: [{...issue('github:issue:9002'), projectStatus: ready}],
      pullRequests: [],
      checks: []
    });
    await projector.bootstrap({...operation(initial), actorId: ids.owner, projectId});
    const inDev = {...ready, optionExternalId: 'option-in-dev', status: 'in_dev' as const};
    const projected = await projector.synchronize({
      ...operation({...initial, externalVersion: 'github:sha256:status-command-2', workItems: [{
        ...issue('github:issue:9002'), projectStatus: inDev
      }]}),
      projectId,
      actorId: ids.owner,
      expectedPreviousExternalVersion: 'github:sha256:status-command-1'
    });
    expect(projected).toMatchObject({status: 'applied', updatedWorkItemStatuses: 0});

    const [beforeCommand, observation] = await Promise.all([
      db.select().from(workItems).where(eq(workItems.projectId, projectId)),
      db.select().from(trackerStatusObservationInbox).where(eq(
        trackerStatusObservationInbox.projectId,
        projectId
      ))
    ]);
    expect(beforeCommand[0]).toMatchObject({status: 'ready', version: 1});
    expect(observation).toHaveLength(1);
    expect(observation[0]).toMatchObject({
      mappedStatus: 'in_dev', expectedCanonicalVersion: 1, state: 'pending'
    });

    const issuer = createActorContextIssuer({
      users: [{actorId: ids.owner, capabilities: ['write:control_plane:development']}],
      agents: [], systems: []
    });
    if (!issuer.ok) throw new Error('Test actor issuer did not initialize.');
    const actor = issuer.value.issueUser(ids.owner);
    if (!actor.ok) throw new Error('Test user actor did not initialize.');
    const processor = createPostgresTrackerStatusObservationProcessor(
      db,
      createCanonicalCommandService({unitOfWork: createPostgresUnitOfWork(db)}),
      actor.value
    );
    await expect(processor.processAvailable()).resolves.toEqual({
      status: 'applied', observationId: observation[0]!.id
    });
    const [afterCommand, bound] = await Promise.all([
      db.select().from(workItems).where(eq(workItems.projectId, projectId)),
      db.select().from(trackerBindings).where(eq(trackerBindings.id, observation[0]!.bindingId))
    ]);
    expect(afterCommand[0]).toMatchObject({status: 'in_dev', version: 2});
    expect(bound[0]?.lastOutboundMutationId).not.toBeNull();

    await projector.synchronize({
      ...operation({...initial, externalVersion: 'github:sha256:status-command-3', workItems: [{
        ...issue('github:issue:9002'), projectStatus: inDev
      }]}),
      projectId,
      actorId: ids.owner,
      expectedPreviousExternalVersion: 'github:sha256:status-command-2'
    });
    const echoes = await db.select().from(trackerStatusObservationInbox).where(eq(
      trackerStatusObservationInbox.projectId,
      projectId
    ));
    expect(echoes).toHaveLength(2);
    expect(echoes[1]).toMatchObject({state: 'acknowledged', mappedStatus: 'in_dev'});
    await expect(processor.processAvailable()).resolves.toEqual({status: 'idle'});
  });

  it('persists outbound-race and invalid-transition conflicts without mutating canonical status', async () => {
    const projectId = randomUUID();
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, 'Status conflict', $3)`,
      [projectId, ids.workspace, `status-conflict-${randomUUID()}`]
    );
    const projector = createPostgresTrackerSnapshotProjector(db);
    const ready = {
      projectExternalId: 'PVT_status_conflict',
      projectItemExternalId: 'PVTI_status_conflict',
      fieldExternalId: 'PVTSSF_status_conflict',
      optionExternalId: 'option-ready',
      status: 'ready' as const
    };
    const initial = snapshot('github:sha256:status-conflict-1', {
      repository: {
        externalId: 'github:repository:9003',
        externalVersion: 'github:sha256:repository-status-conflict',
        owner: 'VF78',
        name: 'StatusConflict'
      },
      workItems: [{...issue('github:issue:9003'), projectStatus: ready}],
      pullRequests: [],
      checks: []
    });
    await projector.bootstrap({...operation(initial), actorId: ids.owner, projectId});
    const [binding] = await db.select().from(trackerBindings).where(and(
      eq(trackerBindings.projectId, projectId),
      eq(trackerBindings.surface, 'issue')
    ));
    await db.update(workItems).set({status: 'in_dev', version: 2})
      .where(eq(workItems.id, binding!.entityId));
    await db.update(trackerBindings).set({lastOutboundMutationId: randomUUID()})
      .where(eq(trackerBindings.id, binding!.id));

    await projector.synchronize({
      ...operation({...initial, externalVersion: 'github:sha256:status-conflict-2'}),
      projectId,
      actorId: ids.owner,
      expectedPreviousExternalVersion: 'github:sha256:status-conflict-1'
    });
    const [outboundRace] = await db.select().from(trackerStatusObservationInbox).where(eq(
      trackerStatusObservationInbox.projectId,
      projectId
    ));
    expect(outboundRace).toMatchObject({state: 'conflict', conflictCode: 'outbound_race'});

    await db.update(trackerBindings).set({lastOutboundMutationId: null})
      .where(eq(trackerBindings.id, binding!.id));
    const done = {...ready, optionExternalId: 'option-done', status: 'done' as const};
    await projector.synchronize({
      ...operation({...initial, externalVersion: 'github:sha256:status-conflict-3', workItems: [{
        ...issue('github:issue:9003'), projectStatus: done
      }]}),
      projectId,
      actorId: ids.owner,
      expectedPreviousExternalVersion: 'github:sha256:status-conflict-2'
    });
    const issuer = createActorContextIssuer({
      users: [{actorId: ids.owner, capabilities: ['write:control_plane:development']}],
      agents: [], systems: []
    });
    if (!issuer.ok) throw new Error('Test actor issuer did not initialize.');
    const actor = issuer.value.issueUser(ids.owner);
    if (!actor.ok) throw new Error('Test user actor did not initialize.');
    const processor = createPostgresTrackerStatusObservationProcessor(
      db,
      createCanonicalCommandService({unitOfWork: createPostgresUnitOfWork(db)}),
      actor.value
    );
    await expect(processor.processAvailable()).resolves.toMatchObject({
      status: 'conflict', code: 'invalid_transition'
    });
    const [canonical, observations] = await Promise.all([
      db.select().from(workItems).where(eq(workItems.id, binding!.entityId)),
      db.select().from(trackerStatusObservationInbox).where(eq(
        trackerStatusObservationInbox.projectId,
        projectId
      ))
    ]);
    expect(canonical[0]).toMatchObject({status: 'in_dev', version: 2});
    expect(observations.map(({conflictCode}) => conflictCode).sort()).toEqual([
      'invalid_transition',
      'outbound_race'
    ]);
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
      name: 'MSA-renamed',
      defaultBranch: 'main',
      headSha: 'b'.repeat(40)
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
