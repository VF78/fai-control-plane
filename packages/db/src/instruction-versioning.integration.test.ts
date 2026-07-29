import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors,
  agentProfileInstructionVersions,
  agentProfiles,
  auditEvents,
  commandReceipts,
  createDatabase,
  createPostgresInstructionVersionStore,
  workspaceInstructionVersions,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for instruction version integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_instruction_versions_${randomUUID().replaceAll('-', '')}`;

describePostgres('instruction version persistence', () => {
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

  it('appends baseline/override versions, replays receipts, isolates scopes, and rolls back by appending', async () => {
    const ids = {
      workspace: randomUUID(), otherWorkspace: randomUUID(),
      author: randomUUID(), approver: randomUUID(), agent: randomUUID(),
      profile: randomUUID(), baseline1: randomUUID(), override1: randomUUID(),
      rollback: randomUUID()
    };
    await db.insert(workspaces).values([
      {id: ids.workspace, name: 'Instructions', slug: `instructions-${randomUUID()}`},
      {id: ids.otherWorkspace, name: 'Other', slug: `other-${randomUUID()}`}
    ]);
    await db.insert(actors).values([
      {
        id: ids.author, workspaceId: ids.workspace, type: 'human',
        role: 'workspace_admin', displayName: 'Author', authMode: 'user'
      },
      {
        id: ids.approver, workspaceId: ids.workspace, type: 'human',
        role: 'delivery_lead', displayName: 'Approver', authMode: 'user'
      },
      {
        id: ids.agent, workspaceId: ids.workspace, type: 'agent',
        role: 'agent_operator', displayName: 'Agent', authMode: 'agent'
      }
    ]);
    await db.insert(agentProfiles).values({
      id: ids.profile, workspaceId: ids.workspace, actorId: ids.agent,
      runtimeId: 'generic', runtimeProfile: 'default', configHash: 'a'.repeat(64)
    });
    const store = createPostgresInstructionVersionStore(db);
    const envelope = (type: 'instruction_version.publish' | 'instruction_version.rollback', payload: any, key: string) => ({
      commandId: randomUUID(), workspaceId: ids.workspace, correlationId: randomUUID(),
      idempotencyKey: key, issuedAt: '2026-07-29T12:00:00.000Z',
      actor: {actorId: ids.author}, type, payload
    });
    const baseline = envelope('instruction_version.publish', {
      scope: 'workspace', versionId: ids.baseline1, expectedVersion: null,
      approvedByActorId: ids.author,
      content: {instructions: 'Common', settings: {limits: {steps: 10}}}
    }, 'baseline-1');
    const first = await store.execute({
      command: baseline, requestHash: 'a'.repeat(64), authorized: true
    });
    expect(first).toMatchObject({
      status: 'completed',
      receipt: {result: {ok: true, value: {workspaceVersion: 1, effective: {instructions: 'Common'}}}}
    });
    await expect(store.execute({
      command: baseline, requestHash: 'a'.repeat(64), authorized: true
    })).resolves.toMatchObject({status: 'replayed'});

    const override = await store.execute({
      command: envelope('instruction_version.publish', {
        scope: 'agent_profile', agentProfileId: ids.profile,
        versionId: ids.override1, expectedVersion: null,
        approvedByActorId: ids.author,
        content: {instructions: 'Profile', settings: {limits: {steps: 20}}}
      }, 'override-1'),
      requestHash: 'b'.repeat(64), authorized: true
    });
    expect(override).toMatchObject({
      receipt: {result: {ok: true, value: {
        profileVersion: 1,
        effective: {instructions: 'Common\n\nProfile', settings: {limits: {steps: 20}}},
        diff: {settings: [{path: '/limits/steps', before: 10, after: 20}]}
      }}}
    });

    const isolated = await store.execute({
      command: envelope('instruction_version.rollback', {
        scope: 'agent_profile', agentProfileId: ids.profile,
        versionId: randomUUID(), expectedVersion: 1,
        approvedByActorId: ids.author, rollbackOfVersionId: ids.baseline1
      }, 'wrong-scope'),
      requestHash: 'c'.repeat(64), authorized: true
    });
    expect(isolated).toMatchObject({receipt: {result: {error: {code: 'NOT_FOUND'}}}});

    const rolledBack = await store.execute({
      command: envelope('instruction_version.rollback', {
        scope: 'workspace', versionId: ids.rollback, expectedVersion: 1,
        approvedByActorId: ids.author, rollbackOfVersionId: ids.baseline1
      }, 'rollback-1'),
      requestHash: 'd'.repeat(64), authorized: true
    });
    expect(rolledBack).toMatchObject({
      receipt: {result: {ok: true, value: {workspaceVersion: 2}}}
    });
    expect(await db.select().from(workspaceInstructionVersions)
      .where(eq(workspaceInstructionVersions.workspaceId, ids.workspace))).toHaveLength(2);
    expect(await db.select().from(agentProfileInstructionVersions)
      .where(eq(agentProfileInstructionVersions.agentProfileId, ids.profile))).toHaveLength(1);
    expect(await db.select().from(commandReceipts)).toHaveLength(4);
    expect(await db.select().from(auditEvents)).toHaveLength(4);
  });
});
