import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  actorExternalIdentities,
  actors,
  conversationMessages,
  conversationParticipants,
  createDatabase,
  projects,
  workspaces
} from './index';
import {
  CONVERSATION_MESSAGE_LIMIT,
  createPostgresConversationStore,
  loadConversationRows
} from './conversations';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_conversations_${randomUUID().replaceAll('-', '')}`;
const ref = (value: string) => `tgid:v1:${createHash('sha256').update(value).digest('hex')}`;

describePostgres('canonical conversation persistence', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  const workspaceId = randomUUID();
  const msaId = randomUUID();
  const asconId = randomUUID();
  const activation = new Date('2026-07-30T00:00:00.000Z');

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
    await db.insert(workspaces).values({id: workspaceId, name: 'fAI', slug: `fai-${randomUUID()}`});
    await db.insert(projects).values([
      {id: msaId, workspaceId, name: 'MSA', slug: 'msa'},
      {id: asconId, workspaceId, name: 'ASCON', slug: 'ascon'}
    ]);
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

  it('keeps bindings isolated, resolves exact active identities, deduplicates and retains a fixed bound', async () => {
    const store = createPostgresConversationStore(db);
    const msaChat = ref('msa-internal');
    const asconChat = ref('ascon-client');
    await store.reconcileBindings('telegram', [msaId, asconId], [
      {projectId: msaId, conversationClass: 'internal', provider: 'telegram', externalRef: msaChat, activatedAt: activation},
      {projectId: asconId, conversationClass: 'client', provider: 'telegram', externalRef: asconChat, activatedAt: activation}
    ]);
    const [vladimir] = await db.insert(actors).values({
      workspaceId,
      type: 'human',
      role: 'workspace_admin',
      displayName: 'Vladimir',
      authMode: 'user',
      externalSubject: 'github:user:1'
    }).returning({id: actors.id});
    if (vladimir === undefined) throw new Error('actor not created');
    const [hermes] = await db.insert(actors).values({
      workspaceId,
      type: 'agent',
      role: 'agent_operator',
      displayName: 'Hermes',
      authMode: 'agent',
      externalSubject: 'agent:hermes:v1'
    }).returning({id: actors.id});
    if (hermes === undefined) throw new Error('Hermes actor not created');
    const [outsideRoster] = await db.insert(actors).values({
      workspaceId,
      type: 'human',
      role: 'developer',
      displayName: 'Outside roster',
      authMode: 'user',
      externalSubject: 'github:user:3'
    }).returning({id: actors.id});
    if (outsideRoster === undefined) throw new Error('outside actor not created');
    await db.insert(actorExternalIdentities).values({
      actorId: outsideRoster.id,
      provider: 'telegram',
      externalSubject: ref('unknown'),
      active: true
    });
    await store.reconcileIdentities(workspaceId, 'telegram', [
      {actorExternalSubject: 'github:user:1', externalSubject: ref('vladimir')},
      {actorExternalSubject: 'agent:hermes:v1', externalSubject: null}
    ]);
    const observation = (sequence: number, externalBindingRef = msaChat) => ({
      provider: 'telegram',
      externalBindingRef,
      deliveryRef: ref(`delivery-${externalBindingRef}-${sequence}`),
      messageRef: ref(`message-${externalBindingRef}-${sequence}`),
      authorExternalSubject: sequence % 2 === 0 ? ref('vladimir') : ref('unknown'),
      authorDisplayName: sequence % 2 === 0 ? 'Provider alias' : 'Guest',
      sentAt: new Date(activation.getTime() + sequence * 1000),
      replyToMessageRef: null,
      threadRef: null,
      text: `message ${sequence}`,
      attachments: []
    } as const);

    await expect(store.ingest({...observation(1), sentAt: new Date(activation.getTime() - 1)}))
      .resolves.toBe('before_activation');
    await expect(store.ingest(observation(2))).resolves.toBe('accepted');
    await expect(store.ingest(observation(2))).resolves.toBe('duplicate');
    await expect(store.ingest(observation(3, asconChat))).resolves.toBe('accepted');
    for (let sequence = 4; sequence <= CONVERSATION_MESSAGE_LIMIT + 4; sequence += 1) {
      await store.ingest(observation(sequence));
    }

    const msaRows = await loadConversationRows(db, [msaId]);
    const asconRows = await loadConversationRows(db, [asconId]);
    expect(msaRows.messages).toHaveLength(CONVERSATION_MESSAGE_LIMIT);
    expect(asconRows.messages).toHaveLength(1);
    expect(msaRows.messages.every(({bindingId}) => bindingId === msaRows.bindings[0]?.id)).toBe(true);
    expect(asconRows.messages.every(({bindingId}) => bindingId === asconRows.bindings[0]?.id)).toBe(true);
    const resolved = await db.select({
      actorId: conversationParticipants.actorId,
      displayName: conversationParticipants.displayName
    }).from(conversationParticipants).where(eq(conversationParticipants.externalSubject, ref('vladimir')));
    expect(resolved).toEqual([{actorId: vladimir.id, displayName: 'Provider alias'}]);
    expect(await db.select({actorId: actorExternalIdentities.actorId})
      .from(actorExternalIdentities).where(eq(actorExternalIdentities.actorId, hermes.id))).toEqual([]);
    expect(await db.select({active: actorExternalIdentities.active})
      .from(actorExternalIdentities).where(eq(
        actorExternalIdentities.actorId,
        outsideRoster.id
      ))).toEqual([{active: false}]);
    expect(await db.select({actorId: conversationParticipants.actorId})
      .from(conversationParticipants).where(eq(
        conversationParticipants.externalSubject,
        ref('unknown')
      ))).toEqual([{actorId: null}, {actorId: null}]);
    await store.reconcileIdentities(workspaceId, 'telegram', [
      {actorExternalSubject: 'github:user:1', externalSubject: null},
      {actorExternalSubject: 'agent:hermes:v1', externalSubject: null}
    ]);
    await store.ingest(observation(CONVERSATION_MESSAGE_LIMIT + 6));
    expect(await db.select({actorId: conversationParticipants.actorId})
      .from(conversationParticipants).where(eq(
        conversationParticipants.externalSubject,
        ref('vladimir')
      ))).toEqual([{actorId: null}]);
    expect(await db.select({id: conversationMessages.id}).from(conversationMessages))
      .toHaveLength(CONVERSATION_MESSAGE_LIMIT + 1);

    await store.reconcileBindings('telegram', [msaId, asconId], [
      {projectId: asconId, conversationClass: 'client', provider: 'telegram', externalRef: asconChat, activatedAt: activation}
    ]);
    expect((await loadConversationRows(db, [msaId])).bindings).toEqual([]);
    await expect(store.ingest(observation(CONVERSATION_MESSAGE_LIMIT + 10)))
      .rejects.toThrow('not configured');
  }, 30_000);
});
