import {randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  actors,
  agentProfiles,
  agentRuns,
  auditEvents,
  canonicalEvents,
  createDatabase,
  createPostgresRecoveryScanProducer,
  incomingEvents,
  projectTrackerRepositoryScopes,
  riskSignals,
  scheduledJobs,
  secretRefs,
  taskPackets,
  workItems
} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_recovery_scan_test_${randomUUID().replaceAll('-', '')}`;
const ids = {
  workspace: randomUUID(),
  project: randomUUID(),
  secret: randomUUID(),
  expired: randomUUID(),
  exhausted: randomUUID(),
  telegramExpired: randomUUID(),
  active: randomUUID(),
  actor: randomUUID(),
  profile: randomUUID(),
  workItem: randomUUID(),
  event: randomUUID(),
  packet: randomUUID(),
  run: randomUUID(),
  repositoryScope: randomUUID()
};

describePostgres('PostgreSQL recovery scan producer', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  const now = new Date('2026-07-26T12:00:00.000Z');
  const sent: string[] = [];

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
      `INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Workspace', $2)`,
      [ids.workspace, `workspace-${randomUUID()}`]
    );
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug) VALUES ($1, $2, 'MSA', 'msa')`,
      [ids.project, ids.workspace]
    );
    await db.insert(secretRefs).values({
      id: ids.secret,
      workspaceId: ids.workspace,
      provider: 'test',
      reference: 'recovery-scan',
      scope: []
    });
    await db.insert(projectTrackerRepositoryScopes).values({
      id: ids.repositoryScope,
      projectId: ids.project,
      provider: 'github',
      repositoryOwner: 'VF78',
      repositoryName: 'MSA',
      repositoryExternalId: 'github:repository:1278325372',
      credentialRefId: ids.secret
    });
    await db.insert(actors).values({
      id: ids.actor,
      workspaceId: ids.workspace,
      type: 'human',
      role: 'workspace_admin',
      displayName: 'Recovery scan approver',
      authMode: 'user'
    });
    await db.insert(agentProfiles).values({
      id: ids.profile,
      workspaceId: ids.workspace,
      actorId: ids.actor,
      runtimeId: 'coding-runner',
      runtimeProfile: 'codex-safe'
    });
    await db.insert(workItems).values({
      id: ids.workItem,
      projectId: ids.project,
      title: 'Recover an expired runner lease',
      status: 'ready'
    });
    await db.insert(canonicalEvents).values({
      id: ids.event,
      workspaceId: ids.workspace,
      projectId: ids.project,
      eventType: 'test.seed',
      aggregateType: 'work_item',
      aggregateId: ids.workItem,
      deduplicationKey: `recovery-scan-${randomUUID()}`,
      payload: {},
      occurredAt: now
    });
    await db.insert(taskPackets).values({
      id: ids.packet,
      projectId: ids.project,
      workItemId: ids.workItem,
      workItemVersion: 1,
      goal: 'Recover an expired runner lease',
      acceptanceCriteria: [],
      inScope: [],
      outOfScope: [],
      relevantLinks: [],
      relevantFiles: [],
      allowedTools: [],
      forbiddenSurfaces: [],
      dataPolicy: {},
      timeboxMinutes: 15,
      expectedOutputSchema: {},
      reviewerActorId: ids.actor,
      approverActorId: ids.actor,
      runtimeProfile: 'codex-safe',
      authMode: 'agent',
      secretRefId: ids.secret,
      createdFromEventId: ids.event,
      contentHash: 'd'.repeat(64),
      createdByActorId: ids.actor
    });
    await db.insert(agentRuns).values({
      id: ids.run,
      taskPacketId: ids.packet,
      agentProfileId: ids.profile,
      workItemId: ids.workItem,
      repositoryScopeId: ids.repositoryScope,
      confirmedPacketHash: 'e'.repeat(64),
      baseCommit: 'a'.repeat(40),
      status: 'running',
      idempotencyKey: `recovery-scan-${ids.run}`,
      runnerId: 'expired-runner',
      leaseTokenHash: 'f'.repeat(64),
      leaseExpiresAt: new Date(now.getTime() - 1_000),
      attempt: 1,
      version: 3
    });
    await testPool.query(
      `INSERT INTO incoming_events (
         id, project_id, provider, delivery_id, event_type, verification,
         installation_id, repository_id, project_node_id,
         telegram_message_id, telegram_chat_id, telegram_user_id, payload_sha256,
         sanitized_payload, status, attempt_count, processing_token, processing_lease_expires_at
       ) VALUES
         ($1, $2, 'github', 'expired', 'issues', '{"outcome":"verified","method":"hmac-sha256"}', '1', '2', 'PVT_project', NULL, NULL, NULL, repeat('a', 64), '{}', 'processing', 1, gen_random_uuid(), $3),
         ($4, $2, 'github', 'exhausted', 'issues', '{"outcome":"verified","method":"hmac-sha256"}', '1', '2', 'PVT_project', NULL, NULL, NULL, repeat('d', 64), '{}', 'processing', 5, gen_random_uuid(), $5),
         ($6, $2, 'telegram', 'telegram-expired', 'chat_command', '{"outcome":"verified","method":"shared-token"}', NULL, NULL, NULL, 'tgid:v1:' || repeat('a', 64), 'tgid:v1:' || repeat('b', 64), 'tgid:v1:' || repeat('c', 64), repeat('b', 64), '{}', 'processing', 1, gen_random_uuid(), $7),
         ($8, $2, 'github', 'active', 'issues', '{"outcome":"verified","method":"hmac-sha256"}', '1', '2', 'PVT_project', NULL, NULL, NULL, repeat('c', 64), '{}', 'processing', 1, gen_random_uuid(), $9)`,
      [
        ids.expired,
        ids.project,
        new Date(now.getTime() - 1_000),
        ids.exhausted,
        new Date(now.getTime() - 1_000),
        ids.telegramExpired,
        new Date(now.getTime() - 1_000),
        ids.active,
        new Date(now.getTime() + 60_000)
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

  it('requeues only an expired processing lease', async () => {
    const producer = createPostgresRecoveryScanProducer(db, {
      async send(_name, data) {
        sent.push((data as {eventId: string}).eventId);
        return randomUUID();
      }
    }, {now: () => now});
    await producer.run();

    const rows = await db.select({
      id: incomingEvents.id,
      status: incomingEvents.status,
      processingToken: incomingEvents.processingToken,
      processingLeaseExpiresAt: incomingEvents.processingLeaseExpiresAt
    }).from(incomingEvents).where(and(
      eq(incomingEvents.projectId, ids.project),
      eq(incomingEvents.status, 'processing')
    ));
    expect([...sent].sort()).toEqual([ids.expired, ids.telegramExpired].sort());
    expect(rows).toEqual([expect.objectContaining({
      id: ids.active,
      status: 'processing',
      processingToken: expect.any(String),
      processingLeaseExpiresAt: new Date(now.getTime() + 60_000)
    })]);
    expect(await db.select().from(incomingEvents).where(eq(incomingEvents.id, ids.expired)))
      .toEqual([expect.objectContaining({
        status: 'pending',
        processingToken: null,
        processingLeaseExpiresAt: null
      })]);
    expect(await db.select().from(incomingEvents).where(eq(incomingEvents.id, ids.telegramExpired)))
      .toEqual([expect.objectContaining({
        status: 'pending',
        processingToken: null,
        processingLeaseExpiresAt: null
      })]);
    expect(await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.project),
      isNull(riskSignals.resolvedAt)
    ))).toEqual([expect.objectContaining({
      code: 'incoming_event_recovery_exhausted',
      ruleId: 'incoming_event_recovery_exhausted',
      ruleVersion: '1',
      signalClass: 'fact',
      evidenceReferences: [{type: 'incoming_event', id: ids.exhausted}],
      impact: 'Inbound provider events are not reaching canonical processing.',
      ownerActorId: null,
      nextAction: 'inspect_failed_incoming_events',
      observedAt: now,
      deduplicationKey: 'incoming_event_recovery_exhausted'
    })]);
    expect(await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.projectId, ids.project),
      eq(scheduledJobs.name, 'recovery_scan')
    ))).toHaveLength(1);
  });

  it('fails an expired runner lease once without requeueing it', async () => {
    const sentBefore = sent.length;
    const producer = createPostgresRecoveryScanProducer(db, {
      async send(_name, data) {
        sent.push((data as {eventId: string}).eventId);
        return randomUUID();
      }
    }, {now: () => now});

    await Promise.all([producer.run(), producer.run()]);

    expect(sent).toHaveLength(sentBefore);
    expect(await db.select({
      status: agentRuns.status,
      completedAt: agentRuns.completedAt,
      failureCode: agentRuns.failureCode,
      runnerId: agentRuns.runnerId,
      leaseTokenHash: agentRuns.leaseTokenHash,
      leaseExpiresAt: agentRuns.leaseExpiresAt,
      attempt: agentRuns.attempt,
      version: agentRuns.version
    }).from(agentRuns).where(eq(agentRuns.id, ids.run))).toEqual([{
      status: 'failed',
      completedAt: now,
      failureCode: 'runner_lease_expired',
      runnerId: null,
      leaseTokenHash: null,
      leaseExpiresAt: null,
      attempt: 1,
      version: 4
    }]);
    expect(await db.select({
      commandId: auditEvents.commandId,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      outcome: auditEvents.outcome,
      reasonCode: auditEvents.reasonCode,
      expectedVersion: auditEvents.expectedVersion,
      resultVersion: auditEvents.resultVersion,
      correlationId: auditEvents.correlationId
    }).from(auditEvents).where(eq(auditEvents.targetId, ids.run))).toEqual([{
      commandId: `runner.lease_expired:${ids.run}:attempt:1`,
      action: 'runner.lease_expired',
      targetType: 'agent_run',
      targetId: ids.run,
      outcome: 'failed',
      reasonCode: 'runner_lease_expired',
      expectedVersion: 3,
      resultVersion: 4,
      correlationId: `runner.lease_expired:${ids.run}:attempt:1`
    }]);
    expect(await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.project),
      isNull(riskSignals.resolvedAt)
    ))).toHaveLength(1);
  });
});
