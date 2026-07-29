import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {
  OpaqueSecretRef,
  TaskTrackerTransitionPort
} from '@fai-control-plane/domain';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {createPostgresGitHubProjectStatusPublisher} from './github-project-status-writeback';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {createDatabase} from './index';
import {outboxEvents, projects, trackerBindings, workItems, workspaces} from './schema';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for GitHub status write-back integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_writeback_test_${randomUUID().replaceAll('-', '')}`;
const ids = {workspace: randomUUID(), project: randomUUID()};
const credentialRef: OpaqueSecretRef = {
  provider: 'file', reference: '/run/secrets/github-projects-oauth-token', scope: ['project']
};

let adminPool: Pool;
let testPool: Pool;
let db: ReturnType<typeof createDatabase>['db'];

const taskTracker = (
  overrides: Partial<TaskTrackerTransitionPort> = {}
): TaskTrackerTransitionPort => ({
  provider: 'github',
  capabilities: {readWorkItems: false, writeWorkItems: true},
  ...overrides
});

const seedWriteback = async () => {
  const workItemId = randomUUID();
  const bindingId = randomUUID();
  const eventId = randomUUID();
  const mutationId = randomUUID();
  const projectStatus = {
    projectExternalId: 'PVT_kwHOBIUvJs4Bbefq',
    projectItemExternalId: 'PVTI_MSA_1',
    fieldExternalId: 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc',
    optionExternalId: '1f121483',
    status: 'ready'
  };
  await db.insert(workItems).values({
    id: workItemId, projectId: ids.project, title: `Writeback ${eventId}`, status: 'in_dev', version: 2
  });
  await db.insert(trackerBindings).values({
    id: bindingId,
    projectId: ids.project,
    provider: 'github',
    surface: 'issue',
    externalId: `github:issue:${eventId}`,
    entityType: 'work_item',
    entityId: workItemId,
    externalVersion: 'github:issue:v1',
    lastOutboundMutationId: mutationId,
    metadata: {repositoryExternalId: 'github:repository:1278325372', projectStatus}
  });
  await db.insert(outboxEvents).values({
    id: eventId,
    workspaceId: ids.workspace,
    projectId: ids.project,
    destination: 'github',
    eventType: 'github.project_status.write.v1',
    idempotencyKey: `github-project-status:${bindingId}:${mutationId}`,
    payload: {
      version: 1,
      bindingId,
      workItemId,
      canonicalVersion: 2,
      status: 'in_dev',
      expected: {bindingExternalVersion: 'github:issue:v1', providerOptionId: '1f121483'},
      target: {
        repositoryExternalId: 'github:repository:1278325372',
        projectExternalId: projectStatus.projectExternalId,
        projectItemExternalId: projectStatus.projectItemExternalId,
        fieldExternalId: projectStatus.fieldExternalId
      },
      mutationId
    }
  });
  return {bindingId, eventId, mutationId};
};

describePostgres('PostgreSQL GitHub Project status write-back', () => {
  beforeAll(async () => {
    const sourceUrl = new URL(databaseUrl!);
    adminPool = new Pool({connectionString: sourceUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    sourceUrl.pathname = `/${databaseName}`;
    const created = createDatabase(sourceUrl.toString());
    db = created.db;
    testPool = created.pool;
    await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))});
    await db.insert(workspaces).values({id: ids.workspace, name: 'Writeback workspace', slug: `writeback-${randomUUID()}`});
    await db.insert(projects).values({
      id: ids.project, workspaceId: ids.workspace, name: 'Writeback project', slug: `writeback-${randomUUID()}`
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

  it('fails closed when task-tracker writes are disabled or unavailable', async () => {
    const disabled = await seedWriteback();
    const disabledTransition = vi.fn();
    await expect(createPostgresGitHubProjectStatusPublisher(db, taskTracker({
      capabilities: {readWorkItems: true, writeWorkItems: false},
      transitionWorkItem: disabledTransition
    }), credentialRef).publishAvailable()).resolves.toEqual({
      status: 'failed', eventId: disabled.eventId, code: 'github_project_status_capability_unavailable'
    });
    expect(disabledTransition).not.toHaveBeenCalled();

    const missing = await seedWriteback();
    await expect(createPostgresGitHubProjectStatusPublisher(db, taskTracker(), credentialRef)
      .publishAvailable()).resolves.toEqual({
      status: 'failed', eventId: missing.eventId, code: 'github_project_status_capability_unavailable'
    });

    for (const eventId of [disabled.eventId, missing.eventId]) {
      const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
      expect(event).toMatchObject({
        status: 'failed',
        failureCode: 'github_project_status_capability_unavailable',
        publishedAt: null,
        payload: expect.objectContaining({providerReceipt: {outcome: 'identity_denied'}})
      });
    }
  });

  it('publishes only a confirmed read-after-write receipt', async () => {
    const stale = await seedWriteback();
    const staleTransition = vi.fn(async () => ({status: 'stale'} as const));
    await expect(createPostgresGitHubProjectStatusPublisher(db, taskTracker({
      transitionWorkItem: staleTransition
    }), credentialRef).publishAvailable()).resolves.toEqual({
      status: 'failed', eventId: stale.eventId, code: 'github_project_status_stale'
    });
    const [staleEvent] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, stale.eventId));
    expect(staleEvent).toMatchObject({status: 'failed', publishedAt: null});

    const confirmed = await seedWriteback();
    await expect(createPostgresGitHubProjectStatusPublisher(db, taskTracker({
      transitionWorkItem: async () => ({status: 'confirmed', receipt: {
        verification: 'read_after_write',
        projectItemExternalId: 'PVTI_MSA_1',
        optionExternalId: 'f37309f6',
        clientMutationId: confirmed.mutationId
      }})
    }), credentialRef).publishAvailable()).resolves.toEqual({
      status: 'published', eventId: confirmed.eventId
    });
    const [publishedEvent] = await db.select().from(outboxEvents)
      .where(eq(outboxEvents.id, confirmed.eventId));
    const [binding] = await db.select().from(trackerBindings)
      .where(eq(trackerBindings.id, confirmed.bindingId));
    expect(publishedEvent?.status).toBe('published');
    expect((publishedEvent?.payload as Record<string, unknown>).providerReceipt).toEqual({
      verification: 'read_after_write',
      projectItemExternalId: 'PVTI_MSA_1',
      optionExternalId: 'f37309f6',
      clientMutationId: confirmed.mutationId
    });
    expect(binding?.metadata).toMatchObject({projectStatus: {
      optionExternalId: 'f37309f6', status: 'in_dev'
    }});
  });
});
