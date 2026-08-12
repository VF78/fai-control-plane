import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {AgentRoleRequest} from '@fai-control-plane/domain';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {createDatabase, createPostgresAgentRoleRequestOutbox} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {actors, auditEvents, commandReceipts, outboxEvents, projects, workspaces} from './schema';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) throw new Error('DATABASE_URL is required for agent outbox integration tests in CI.');
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_agent_outbox_${randomUUID().replaceAll('-', '')}`;

describePostgres('agent role request outbox', () => {
  let adminPool: Pool; let testPool: Pool; let db: ReturnType<typeof createDatabase>['db'];
  const workspaceId = randomUUID(); const projectId = randomUUID(); const actorId = randomUUID();
  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!); adminUrl.pathname = '/postgres'; adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(databaseUrl!); testUrl.pathname = `/${databaseName}`; const created = createDatabase(testUrl.toString()); db = created.db; testPool = created.pool;
    await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))});
    await db.insert(workspaces).values({id: workspaceId, name: 'Agent delivery', slug: `agent-delivery-${randomUUID()}`});
    await db.insert(projects).values({id: projectId, workspaceId, name: 'ASCON', slug: `ascon-${randomUUID()}`});
    await db.insert(actors).values({id: actorId, workspaceId, type: 'human', role: 'workspace_admin', displayName: 'PO', authMode: 'user'});
  }, 30_000);
  afterAll(async () => { await testPool?.end(); if (adminPool !== undefined) { try { await dropDatabaseWhenDisconnected(adminPool, databaseName); } finally { await adminPool.end(); } } }, 30_000);

  const request = (key: string): AgentRoleRequest => ({role: 'qa', repository: {id: 'github:repository:1', url: 'https://github.com/VF78/ascon'},
    projectItem: {id: 'PVTI_1', projectId: 'PVT_1', issueId: 'github:issue:1', url: 'https://github.com/VF78/ascon/issues/1'}, observedVersion: 'v1',
    sourceReferences: [{id: randomUUID(), sha256: 'a'.repeat(64), kind: 'client_requirements', provenance: 'PO'}],
    constraints: ['Same item only.'], acceptanceCriteria: ['Report evidence.'], approval: null, correlationId: `correlation-${key}`, idempotencyKey: key});

  it('delivers once and closes both successful and terminal receipts without persisting secrets', async () => {
    const accepted = createPostgresAgentRoleRequestOutbox(db, {submit: async (value) => ({deliveryReference: 'run-1', sessionReference: value.correlationId})});
    const first = request('hermes-success');
    await expect(accepted.prepare({workspaceId, projectId, actorId, request: first})).resolves.toBe('prepared');
    await expect(accepted.prepare({workspaceId, projectId, actorId, request: first})).resolves.toBe('replayed');
    await expect(accepted.publishAvailable()).resolves.toBe('published');
    await expect(accepted.publishAvailable()).resolves.toBe('idle');
    const successfulReceipt = (await db.select().from(commandReceipts).where(eq(commandReceipts.idempotencyKey, first.idempotencyKey)))[0];
    expect(successfulReceipt).toMatchObject({state: 'completed', result: {deliveryReference: 'run-1', sessionReference: first.correlationId}});

    const denied = createPostgresAgentRoleRequestOutbox(db, {submit: async () => { throw Object.assign(new Error('redacted'), {code: 'identity_denied'}); }});
    const second = request('hermes-denied');
    await expect(denied.prepare({workspaceId, projectId, actorId, request: second})).resolves.toBe('prepared');
    await expect(denied.publishAvailable()).resolves.toBe('failed');
    const failedReceipt = (await db.select().from(commandReceipts).where(eq(commandReceipts.idempotencyKey, second.idempotencyKey)))[0];
    expect(failedReceipt).toMatchObject({state: 'completed', result: {errorCode: 'agent_identity_denied'}});
    const failedOutbox = (await db.select().from(outboxEvents).where(eq(outboxEvents.idempotencyKey, second.idempotencyKey)))[0];
    expect(failedOutbox).toMatchObject({status: 'failed', attemptCount: 1, failureCode: 'agent_identity_denied'});

    const stale = request('hermes-stale-lease');
    await expect(accepted.prepare({workspaceId, projectId, actorId, request: stale})).resolves.toBe('prepared');
    await db.update(outboxEvents).set({status: 'publishing', attemptCount: 3, availableAt: new Date(0)}).where(eq(outboxEvents.idempotencyKey, stale.idempotencyKey));
    const submit = vi.fn();
    await expect(createPostgresAgentRoleRequestOutbox(db, {submit}).publishAvailable()).resolves.toBe('failed');
    expect(submit).not.toHaveBeenCalled();
    expect((await db.select().from(commandReceipts).where(eq(commandReceipts.idempotencyKey, stale.idempotencyKey)))[0])
      .toMatchObject({state: 'completed', result: {errorCode: 'agent_retry_exhausted'}});
    expect(JSON.stringify(await db.select().from(outboxEvents))).not.toContain('never-log-me');
    expect((await db.select().from(auditEvents)).map(({action}) => action)).toEqual(expect.arrayContaining([
      'agent.role_request.prepared', 'agent.role_request.accepted', 'agent.role_request.failed'
    ]));
  });
});
