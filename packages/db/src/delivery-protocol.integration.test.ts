import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  defaultDeliveryProtocolDefinition
} from '@fai-control-plane/domain';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors,
  auditEvents,
  commandReceipts,
  createDatabase,
  createPostgresDeliveryProtocolStore,
  projectMemberships,
  projects,
  runbooks,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for delivery protocol integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_delivery_protocol_${randomUUID().replaceAll('-', '')}`;

describePostgres('delivery protocol persistence', () => {
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
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))
    });
  }, 30_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try {
        await dropDatabaseWhenDisconnected(adminPool, databaseName);
      } finally {
        await adminPool.end();
      }
    }
  }, 30_000);

  it('drafts, hash-binds publication, activates, preserves immutability, and audits CAS', async () => {
    const ids = {
      workspace: randomUUID(),
      project: randomUUID(),
      owner: randomUUID(),
      contributor: randomUUID(),
      reviewer: randomUUID(),
      outsider: randomUUID(),
      ownerMembership: randomUUID(),
      contributorMembership: randomUUID(),
      reviewerMembership: randomUUID(),
      first: randomUUID(),
      second: randomUUID()
    };
    await db.insert(workspaces).values({
      id: ids.workspace,
      name: 'Protocol',
      slug: `protocol-${randomUUID()}`
    });
    await db.insert(projects).values({
      id: ids.project,
      workspaceId: ids.workspace,
      name: 'Project',
      slug: `project-${randomUUID()}`
    });
    await db.insert(actors).values([
      {
        id: ids.owner,
        workspaceId: ids.workspace,
        type: 'human',
        role: 'workspace_admin',
        displayName: 'Owner',
        authMode: 'user'
      },
      {
        id: ids.contributor,
        workspaceId: ids.workspace,
        type: 'human',
        role: 'developer',
        displayName: 'Contributor',
        authMode: 'user'
      },
      {
        id: ids.reviewer,
        workspaceId: ids.workspace,
        type: 'human',
        role: 'developer',
        displayName: 'Reviewer',
        authMode: 'user'
      },
      {
        id: ids.outsider,
        workspaceId: ids.workspace,
        type: 'human',
        role: 'developer',
        displayName: 'Outsider',
        authMode: 'user'
      }
    ]);
    await db.insert(projectMemberships).values([
      {
        id: ids.ownerMembership,
        projectId: ids.project,
        actorId: ids.owner,
        roles: ['project_owner']
      },
      {
        id: ids.contributorMembership,
        projectId: ids.project,
        actorId: ids.contributor,
        roles: ['contributor']
      },
      {
        id: ids.reviewerMembership,
        projectId: ids.project,
        actorId: ids.reviewer,
        roles: ['reviewer']
      }
    ]);
    const store = createPostgresDeliveryProtocolStore(db);
    const definition = defaultDeliveryProtocolDefinition();
    const envelope = (
      type: 'delivery_protocol.draft' | 'delivery_protocol.publish' |
        'delivery_protocol.activate' | 'delivery_protocol.retire',
      payload: unknown,
      key: string
    ) => ({
      commandId: randomUUID(),
      workspaceId: ids.workspace,
      correlationId: randomUUID(),
      idempotencyKey: key,
      issuedAt: '2026-07-29T12:00:00.000Z',
      actor: {actorId: ids.owner},
      type,
      payload
    });
    const draftCommand = envelope('delivery_protocol.draft', {
      protocolId: ids.first,
      projectId: ids.project,
      name: 'Delivery',
      expectedRevision: null,
      definition
    }, 'draft-1');
    const drafted = await store.execute({
      command: draftCommand as never,
      requestHash: 'a'.repeat(64),
      authorized: true
    });
    expect(drafted).toMatchObject({
      receipt: {result: {ok: true, value: {protocol: {state: 'draft', version: 1, revision: 1}}}}
    });
    await expect(store.execute({
      command: draftCommand as never,
      requestHash: 'a'.repeat(64),
      authorized: true
    })).resolves.toMatchObject({status: 'replayed'});

    const simulation = await store.simulate({
      workspaceId: ids.workspace,
      projectId: ids.project,
      actorId: ids.owner,
      definition
    });
    expect(simulation).toMatchObject({valid: true});
    expect(await db.select().from(commandReceipts)).toHaveLength(1);
    expect(await db.select().from(auditEvents)).toHaveLength(1);
    const stale = await store.execute({
      command: envelope('delivery_protocol.publish', {
        protocolId: ids.first,
        expectedRevision: 1,
        expectedSimulationHash: 'b'.repeat(64)
      }, 'publish-stale') as never,
      requestHash: 'b'.repeat(64),
      authorized: true
    });
    expect(stale).toMatchObject({
      receipt: {result: {error: {code: 'INVALID_COMMAND'}}}
    });
    const published = await store.execute({
      command: envelope('delivery_protocol.publish', {
        protocolId: ids.first,
        expectedRevision: 1,
        expectedSimulationHash: simulation!.simulationHash
      }, 'publish-1') as never,
      requestHash: 'c'.repeat(64),
      authorized: true
    });
    expect(published).toMatchObject({
      receipt: {result: {ok: true, value: {protocol: {state: 'published', revision: 2}}}}
    });
    const immutable = await store.execute({
      command: envelope('delivery_protocol.draft', {
        protocolId: ids.first,
        projectId: ids.project,
        name: 'Delivery',
        expectedRevision: 2,
        definition
      }, 'immutable') as never,
      requestHash: 'd'.repeat(64),
      authorized: true
    });
    expect(immutable).toMatchObject({
      receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}
    });
    await expect(store.execute({
      command: envelope('delivery_protocol.activate', {
        protocolId: ids.first,
        expectedRevision: 2
      }, 'activate-1') as never,
      requestHash: 'e'.repeat(64),
      authorized: true
    })).resolves.toMatchObject({
      receipt: {result: {ok: true, value: {protocol: {active: true, revision: 3}}}}
    });

    const secondDefinition = structuredClone(definition);
    await store.execute({
      command: envelope('delivery_protocol.draft', {
        protocolId: ids.second,
        projectId: ids.project,
        name: 'Delivery',
        expectedRevision: null,
        definition: secondDefinition
      }, 'draft-2') as never,
      requestHash: 'f'.repeat(64),
      authorized: true
    });
    const secondSimulation = await store.simulate({
      workspaceId: ids.workspace,
      projectId: ids.project,
      actorId: ids.owner,
      definition: secondDefinition
    });
    const secondPublished = await store.execute({
      command: envelope('delivery_protocol.publish', {
        protocolId: ids.second,
        expectedRevision: 1,
        expectedSimulationHash: secondSimulation!.simulationHash
      }, 'publish-2') as never,
      requestHash: '1'.repeat(64),
      authorized: true
    });
    expect(secondPublished).toMatchObject({
      receipt: {result: {ok: true, value: {protocol: {version: 2, state: 'published'}}}}
    });
    const replacement = await store.execute({
      command: envelope('delivery_protocol.activate', {
        protocolId: ids.second,
        expectedRevision: 2
      }, 'activate-conflict') as never,
      requestHash: '2'.repeat(64),
      authorized: true
    });
    expect(replacement).toMatchObject({
      receipt: {result: {ok: true, value: {
        protocol: {active: true, revision: 3},
        replacedProtocolId: ids.first
      }}}
    });
    const protocolRows = await db.select({
      id: runbooks.id,
      state: runbooks.protocolState,
      active: runbooks.active,
      revision: runbooks.revision
    }).from(runbooks).where(eq(runbooks.projectId, ids.project));
    expect(protocolRows).toEqual(expect.arrayContaining([
      {id: ids.first, state: 'retired', active: false, revision: 4},
      {id: ids.second, state: 'published', active: true, revision: 3}
    ]));
    expect(protocolRows.filter((protocol) => protocol.active)).toHaveLength(1);
    const versionConflict = await store.execute({
      command: envelope('delivery_protocol.retire', {
        protocolId: ids.first,
        expectedRevision: 2
      }, 'retire-stale') as never,
      requestHash: '3'.repeat(64),
      authorized: true
    });
    expect(versionConflict).toMatchObject({
      receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}
    });
    const denied = await store.execute({
      command: {
        ...envelope('delivery_protocol.draft', {
          protocolId: randomUUID(),
          projectId: ids.project,
          name: 'Denied',
          expectedRevision: null,
          definition
        }, 'outsider'),
        actor: {actorId: ids.outsider}
      } as never,
      requestHash: '4'.repeat(64),
      authorized: true
    });
    expect(denied).toMatchObject({
      receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}
    });
    expect(await db.select().from(runbooks).where(eq(runbooks.projectId, ids.project)))
      .toHaveLength(2);
    expect(await db.select().from(commandReceipts)).toHaveLength(10);
    expect(await db.select().from(auditEvents)).toHaveLength(10);
  });
});
