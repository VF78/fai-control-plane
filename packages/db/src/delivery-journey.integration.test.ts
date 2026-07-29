import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  defaultDeliveryProtocolDefinition,
  hashDeliveryProtocolDefinition
} from '@fai-control-plane/domain';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors,
  createDatabase,
  createPostgresDeliveryJourneyStore,
  deliveryJourneyEvidence,
  deliveryJourneys,
  projectMemberships,
  projects,
  runbooks,
  workItems,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for delivery journey integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_delivery_journey_${randomUUID().replaceAll('-', '')}`;

describePostgres('delivery journey persistence', () => {
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
    await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))});
  }, 30_000);
  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try { await dropDatabaseWhenDisconnected(adminPool, databaseName); }
      finally { await adminPool.end(); }
    }
  }, 30_000);

  it('binds immutable protocol version, denies missing evidence, advances with CAS, and projects legacy state', async () => {
    const ids = {
      workspace: randomUUID(), project: randomUUID(), owner: randomUUID(),
      contributor: randomUUID(), membership: randomUUID(),
      contributorMembership: randomUUID(), protocol: randomUUID(), task: randomUUID(),
      legacy: randomUUID()
    };
    await db.insert(workspaces).values({
      id: ids.workspace, name: 'Journey', slug: `journey-${randomUUID()}`
    });
    await db.insert(projects).values({
      id: ids.project, workspaceId: ids.workspace, name: 'Project',
      slug: `project-${randomUUID()}`
    });
    await db.insert(actors).values([
      {id: ids.owner, workspaceId: ids.workspace, type: 'human',
        role: 'workspace_admin', displayName: 'Owner', authMode: 'user'},
      {id: ids.contributor, workspaceId: ids.workspace, type: 'human',
        role: 'developer', displayName: 'Contributor', authMode: 'user'}
    ]);
    await db.insert(projectMemberships).values([
      {id: ids.membership, projectId: ids.project, actorId: ids.owner,
        role: 'project_owner'},
      {id: ids.contributorMembership, projectId: ids.project,
        actorId: ids.contributor, role: 'contributor'}
    ]);
    const baseDefinition = defaultDeliveryProtocolDefinition();
    const definition = {
      ...baseDefinition,
      stages: baseDefinition.stages.map((stage, index, stages) => ({
        ...stage,
        key: `lane_${index}`,
        allowedNextStageKey: index === stages.length - 1 ? null : `lane_${index + 1}`
      }))
    };
    await db.insert(runbooks).values({
      id: ids.protocol, projectId: ids.project, name: 'Delivery', version: 1,
      definition: definition as never, active: true, protocolState: 'published',
      revision: 2, contentHash: hashDeliveryProtocolDefinition(definition)
    });
    await db.insert(workItems).values([
      {id: ids.task, projectId: ids.project, title: 'Bound'},
      {id: ids.legacy, projectId: ids.project, title: 'Legacy'}
    ]);
    const store = createPostgresDeliveryJourneyStore(db);
    const envelope = (type: 'delivery_journey.start' | 'delivery_journey.advance',
      payload: any, key: string) => ({
      commandId: randomUUID(), workspaceId: ids.workspace, correlationId: randomUUID(),
      idempotencyKey: key, actor: {actorId: ids.owner}, type, payload
    });
    const start = envelope('delivery_journey.start', {
      workItemId: ids.task, protocolId: ids.protocol, expectedWorkItemVersion: 1,
      deadlineAt: '2026-08-01T10:00:00.000Z'
    }, 'start');
    await expect(store.execute({
      command: start as never, requestHash: createHash('sha256').update('start').digest('hex'),
      authorized: true
    })).resolves.toMatchObject({
      receipt: {result: {ok: true, value: {
        state: 'configured', task: {status: 'ready', version: 2},
        protocol: {id: ids.protocol, version: 1}, journeyVersion: 1,
        stage: {key: 'lane_0'}
      }}}
    });
    await db.update(workItems).set({blocked: true}).where(eq(workItems.id, ids.task));
    const blocked = await store.execute({
      command: envelope('delivery_journey.advance', {
        workItemId: ids.task, expectedWorkItemVersion: 2, expectedJourneyVersion: 1,
        evidenceReferences: [{
          requirement: 'Accepted task brief', reference: 'artifact://brief/blocked'
        }]
      }, 'blocked') as never,
      requestHash: createHash('sha256').update('blocked').digest('hex'), authorized: true
    });
    expect(blocked).toMatchObject({receipt: {result: {error: {code: 'WORK_ITEM_BLOCKED'}}}});
    expect(await db.select().from(deliveryJourneyEvidence)).toHaveLength(0);
    expect((await db.select().from(deliveryJourneys)
      .where(eq(deliveryJourneys.workItemId, ids.task)))[0]).toMatchObject({
      stageKey: 'lane_0', version: 1
    });
    expect((await db.select().from(workItems).where(eq(workItems.id, ids.task)))[0])
      .toMatchObject({status: 'ready', blocked: true, version: 2});
    await db.update(workItems).set({blocked: false}).where(eq(workItems.id, ids.task));
    const missing = await store.execute({
      command: envelope('delivery_journey.advance', {
        workItemId: ids.task, expectedWorkItemVersion: 2,
        expectedJourneyVersion: 1, evidenceReferences: []
      }, 'missing') as never,
      requestHash: createHash('sha256').update('missing').digest('hex'), authorized: true
    });
    expect(missing).toMatchObject({receipt: {result: {error: {code: 'INVALID_COMMAND'}}}});
    expect(await db.select().from(deliveryJourneyEvidence)).toHaveLength(0);
    const advanced = await store.execute({
      command: envelope('delivery_journey.advance', {
        workItemId: ids.task, expectedWorkItemVersion: 2, expectedJourneyVersion: 1,
        evidenceReferences: [{
          requirement: 'Accepted task brief', reference: 'artifact://brief/accepted'
        }]
      }, 'advance') as never,
      requestHash: createHash('sha256').update('advance').digest('hex'), authorized: true
    });
    expect(advanced).toMatchObject({receipt: {result: {ok: true, value: {
      task: {status: 'in_dev', version: 3}, journeyVersion: 2,
      stage: {key: 'lane_1'}
    }}}});
    expect(await db.select().from(deliveryJourneyEvidence)).toHaveLength(1);
    expect((await db.select().from(deliveryJourneys)
      .where(eq(deliveryJourneys.workItemId, ids.task)))[0]).toMatchObject({
      protocolId: ids.protocol, protocolVersion: 1, stageKey: 'lane_1', version: 2
    });
    await expect(store.read({
      workspaceId: ids.workspace, workItemId: ids.legacy,
      actorId: ids.owner, at: '2026-07-30T10:00:00.000Z'
    })).resolves.toMatchObject({state: 'not_configured', reason: 'protocol_not_bound'});
  });
});
