import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {
  CURRENT_POLICY_VERSION,
  createApprovalBinding,
  createTaskPacket,
  type AgentRun,
  type ApprovalRequiredCommandOutcome,
  type CanonicalCommandTransaction,
  type CommandReceiptClaim,
  type NonApprovalCommandOutcome,
  type TaskPacketContent
} from '@fai-control-plane/domain';
import {eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';
import {createDatabase, createPostgresUnitOfWork} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  approvalRequests,
  agentRuns,
  auditEvents,
  commandReceipts,
  taskPackets,
  workItems
} from './schema';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_db_test_${randomUUID().replaceAll('-', '')}`;
const fixture = {
  workspaceId: randomUUID(),
  projectId: randomUUID(),
  actorId: randomUUID(),
  profileId: randomUUID(),
  workItemId: randomUUID(),
  eventId: randomUUID(),
  packetId: randomUUID(),
  runId: randomUUID(),
  approvalId: randomUUID(),
  accessRequestId: randomUUID(),
  otherWorkspaceId: randomUUID(),
  otherProjectId: randomUUID(),
  otherActorId: randomUUID(),
  otherProfileId: randomUUID(),
  otherWorkItemId: randomUUID(),
  otherEventId: randomUUID(),
  otherPacketId: randomUUID(),
  otherRunId: randomUUID(),
  otherSecretRefId: randomUUID()
};

let adminPool: Pool;
let testPool: Pool;
let testDb: ReturnType<typeof createDatabase>['db'];

const claim = (
  idempotencyKey: string,
  requestHash = `hash:${idempotencyKey}`
): CommandReceiptClaim => ({
  commandId: randomUUID(),
  workspaceId: fixture.workspaceId,
  correlationId: randomUUID(),
  idempotencyKey,
  requestHash,
  commandType: 'approval.request',
  createdAt: new Date().toISOString()
});

const approvalOutcome = (
  receiptClaim: CommandReceiptClaim,
  approvalId = randomUUID()
): ApprovalRequiredCommandOutcome => {
  const action = {actionCategory: 'deploy', surface: 'runner', environment: 'production'} as const;
  const target = {workItemId: fixture.workItemId} as const;
  const now = new Date();
  const binding = createApprovalBinding(action, target, {
    subjectHash: 'a'.repeat(64),
    expectedPolicyVersion: CURRENT_POLICY_VERSION,
    executionIdentity: randomUUID(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString()
  }, fixture.actorId, now);
  if (!binding.ok) throw new Error('Approval binding fixture did not initialize.');
  const approval = {
    id: approvalId,
    projectId: fixture.projectId,
    ...target,
    ...action,
    requestedByActorId: fixture.actorId,
    binding: binding.value,
    status: 'pending' as const,
    version: 1
  };
  return {
    kind: 'approval_required',
    approval: {
      aggregateType: 'approval',
      aggregateId: approvalId,
      expectedPersistedVersion: null,
      aggregate: approval
    },
    audit: {
      id: randomUUID(),
      workspaceId: fixture.workspaceId,
      commandId: receiptClaim.commandId,
      correlationId: receiptClaim.correlationId,
      actorId: fixture.actorId,
      actionCategory: 'deploy',
      action: 'approval.request',
      targetType: 'approval',
      targetId: approvalId,
      policyDecision: 'ask',
      outcome: 'approval_required',
      reasonCode: 'APPROVAL_REQUIRED',
      resultVersion: 1,
      occurredAt: new Date().toISOString()
    },
    receipt: {
      ...receiptClaim,
      aggregateType: 'approval',
      aggregateId: approvalId,
      resultVersion: 1,
      result: {
        ok: false,
        error: {
          code: 'APPROVAL_REQUIRED',
          message: 'Approval is required.',
          approval: {
            id: approval.id,
            status: approval.status,
            version: approval.version,
            binding: approval.binding
          }
        }
      }
    }
  };
};

const taskPacketContent = (
  overrides: Partial<TaskPacketContent> = {}
): TaskPacketContent => ({
  projectId: fixture.projectId,
  workItemId: fixture.workItemId,
  workItemVersion: 2,
  goal: 'Persist an immutable task packet.',
  acceptanceCriteria: ['Persistence is atomic'],
  inScope: ['packages/db/**'],
  outOfScope: ['apps/**'],
  relevantLinks: [],
  relevantFiles: ['packages/db/src/persistence.ts'],
  allowedTools: ['pnpm test'],
  forbiddenSurfaces: ['production'],
  dataPolicy: {},
  timeboxMinutes: 15,
  expectedOutputSchema: {},
  reviewerActorId: fixture.actorId,
  approverActorId: fixture.actorId,
  runtimeProfile: 'test',
  authMode: 'user',
  secretsRef: null,
  createdFromEventId: fixture.eventId,
  createdByActorId: fixture.actorId,
  ...overrides
});

const completeApproval = async (
  transaction: CanonicalCommandTransaction,
  receiptClaim: CommandReceiptClaim,
  claimToken: import('@fai-control-plane/domain').ReceiptClaimToken,
  onClaimed?: () => void
) => {
  onClaimed?.();
  const persisted = await transaction.persistApprovalRequired({
    claimToken,
    outcome: approvalOutcome(receiptClaim)
  });
  if (persisted.status !== 'completed') throw persisted;
  return persisted.command;
};

const workItemOutcome = (
  receiptClaim: CommandReceiptClaim,
  input: {
    id?: string;
    projectId?: string;
    actorId?: string;
    expectedVersion?: number;
    version?: number;
  } = {}
): NonApprovalCommandOutcome => {
  const id = input.id ?? fixture.workItemId;
  const expectedVersion = input.expectedVersion ?? 2;
  const version = input.version ?? expectedVersion + 1;
  return {
    kind: 'non_approval',
    mutation: {
      aggregateType: 'work_item',
      aggregateId: id,
      expectedPersistedVersion: expectedVersion,
      aggregate: {
        id,
        projectId: input.projectId ?? fixture.projectId,
        status: 'ready',
        blocked: true,
        version
      }
    },
    audit: {
      id: randomUUID(),
      workspaceId: receiptClaim.workspaceId,
      commandId: receiptClaim.commandId,
      correlationId: receiptClaim.correlationId,
      actorId: input.actorId ?? fixture.actorId,
      actionCategory: 'write',
      action: 'work_item.set_blocked',
      targetType: 'work_item',
      targetId: id,
      expectedVersion,
      resultVersion: version,
      occurredAt: new Date().toISOString()
    }
  };
};

const completeNoMutation = async <T>(
  transaction: CanonicalCommandTransaction,
  receiptClaim: CommandReceiptClaim,
  claimToken: import('@fai-control-plane/domain').ReceiptClaimToken,
  value: T,
  input: {outcome?: 'succeeded' | 'failed' | 'rejected'; reasonCode?: 'NOT_FOUND' | 'POLICY_DENIED'} = {}
) => {
  const completion = await transaction.completeAuditedReceipt({
    claimToken,
    audit: {
      id: randomUUID(),
      workspaceId: receiptClaim.workspaceId,
      commandId: receiptClaim.commandId,
      correlationId: receiptClaim.correlationId,
      actorId: fixture.actorId,
      actionCategory: 'write',
      action: 'work_item.set_blocked',
      targetType: 'work_item',
      targetId: fixture.workItemId,
      outcome: input.outcome ?? 'succeeded',
      ...(input.reasonCode === undefined ? {} : {reasonCode: input.reasonCode}),
      occurredAt: new Date().toISOString()
    },
    receipt: {
      ...receiptClaim,
      aggregateType: 'work_item',
      aggregateId: fixture.workItemId,
      result: input.reasonCode === undefined
        ? {ok: true, value: null}
        : {ok: false, error: {code: input.reasonCode, message: 'Command did not mutate.'}}
    }
  });
  return {kind: 'no_mutation' as const, value, completion};
};

const agentRunOutcome = (
  receiptClaim: CommandReceiptClaim,
  aggregate: AgentRun,
  actorId = fixture.actorId
): NonApprovalCommandOutcome => ({
  kind: 'non_approval',
  mutation: {
    aggregateType: 'agent_run',
    aggregateId: aggregate.id,
    expectedPersistedVersion: null,
    aggregate
  },
  audit: {
    id: randomUUID(),
    workspaceId: receiptClaim.workspaceId,
    commandId: receiptClaim.commandId,
    correlationId: receiptClaim.correlationId,
    actorId,
    actionCategory: 'write',
    action: 'agent_run.queue',
    targetType: 'agent_run',
    targetId: aggregate.id,
    resultVersion: 1,
    occurredAt: new Date().toISOString()
  }
});

const completeNonApproval = async (
  transaction: CanonicalCommandTransaction,
  receiptClaim: CommandReceiptClaim,
  claimToken: import('@fai-control-plane/domain').ReceiptClaimToken,
  outcome: NonApprovalCommandOutcome
) => {
  const persisted = await transaction.persistAuditedMutation({
    claimToken,
    outcome
  });
  if (persisted.status !== 'persisted') throw persisted;
  const mutation = outcome.mutation;
  const resultVersion =
    mutation.aggregateType === 'task_packet' ? 1 : mutation.aggregate.version;
  const completed = await transaction.completeReceipt({
    claimToken,
    mutation: persisted.mutation,
    receipt: {
      ...receiptClaim,
      aggregateType: mutation.aggregateType,
      aggregateId: mutation.aggregateId,
      ...(mutation.expectedPersistedVersion === null
        ? {}
        : {expectedVersion: mutation.expectedPersistedVersion}),
      resultVersion,
      result: {ok: true, value: null}
    }
  });
  return {kind: 'non_approval' as const, value: null, mutation: completed};
};

const expectImmutableRejection = async (
  operation: Promise<unknown>,
  tableName: string
): Promise<void> => {
  try {
    await operation;
    throw new Error('Expected immutable write to fail.');
  } catch (error) {
    const cause = (error as {cause?: {code?: string; message?: string}}).cause;
    expect(cause?.code).toBe('55000');
    expect(cause?.message).toContain(`${tableName} is immutable`);
  }
};

const applySqlMigration = async (
  pool: Pool,
  migrationName: string
): Promise<void> => {
  const sqlText = await readFile(
    fileURLToPath(new URL(`../drizzle/${migrationName}`, import.meta.url)),
    'utf8'
  );
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    if (statement.trim().length > 0) await pool.query(statement);
  }
};

describePostgres(
  databaseUrl === undefined
    ? 'PostgreSQL persistence integration (skipped: DATABASE_URL is absent)'
    : 'PostgreSQL persistence integration',
  () => {
    beforeAll(async () => {
      const sourceUrl = new URL(databaseUrl!);
      adminPool = new Pool({connectionString: sourceUrl.toString()});
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);

      sourceUrl.pathname = `/${databaseName}`;
      const created = createDatabase(sourceUrl.toString());
      testPool = created.pool;
      testDb = created.db;
      await migrate(testDb, {
        migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))
      });

      await testPool.query(
        `INSERT INTO workspaces (id, name, slug)
         VALUES ($1, 'Integration workspace', $2)`,
        [fixture.workspaceId, `workspace-${randomUUID()}`]
      );
      await testPool.query(
        `INSERT INTO projects (id, workspace_id, name, slug)
         VALUES ($1, $2, 'Integration project', $3)`,
        [fixture.projectId, fixture.workspaceId, `project-${randomUUID()}`]
      );
      await testPool.query(
        `INSERT INTO actors (
           id, workspace_id, type, role, display_name, auth_mode
         ) VALUES ($1, $2, 'human', 'workspace_admin', 'Test actor', 'user')`,
        [fixture.actorId, fixture.workspaceId]
      );
      await testPool.query(
        `INSERT INTO agent_profiles (
           id, workspace_id, actor_id, runtime_id, runtime_profile
         ) VALUES ($1, $2, $3, 'test-runtime', 'test')`,
        [fixture.profileId, fixture.workspaceId, fixture.actorId]
      );
      await testPool.query(
        `INSERT INTO work_items (
           id, project_id, title, status, blocked, version
         ) VALUES ($1, $2, 'Integration item', 'ready', false, 2)`,
        [fixture.workItemId, fixture.projectId]
      );
      await testPool.query(
        `INSERT INTO canonical_events (
           id, workspace_id, project_id, event_type, aggregate_type,
           aggregate_id, deduplication_key, payload, occurred_at
         ) VALUES (
           $1, $2, $3, 'test.seed', 'work_item', $4, $5, '{}', now()
         )`,
        [
          fixture.eventId,
          fixture.workspaceId,
          fixture.projectId,
          fixture.workItemId,
          `event-${randomUUID()}`
        ]
      );
      await testPool.query(
        `INSERT INTO task_packets (
           id, project_id, work_item_id, work_item_version, goal, data_policy,
           timebox_minutes, expected_output_schema, reviewer_actor_id,
           approver_actor_id, runtime_profile, auth_mode,
           created_from_event_id, content_hash, created_by_actor_id
         ) VALUES (
           $1, $2, $3, 2, 'Verify persistence', '{}', 15, '{}', $4, $4,
           'test', 'user', $5, $6, $4
         )`,
        [
          fixture.packetId,
          fixture.projectId,
          fixture.workItemId,
          fixture.actorId,
          fixture.eventId,
          'a'.repeat(64)
        ]
      );
      await testPool.query(
        `INSERT INTO workspaces (id, name, slug)
         VALUES ($1, 'Other workspace', $2)`,
        [fixture.otherWorkspaceId, `other-workspace-${randomUUID()}`]
      );
      await testPool.query(
        `INSERT INTO projects (id, workspace_id, name, slug)
         VALUES ($1, $2, 'Other project', $3)`,
        [
          fixture.otherProjectId,
          fixture.otherWorkspaceId,
          `other-project-${randomUUID()}`
        ]
      );
      await testPool.query(
        `INSERT INTO actors (
           id, workspace_id, type, role, display_name, auth_mode
         ) VALUES ($1, $2, 'human', 'workspace_admin', 'Other actor', 'user')`,
        [fixture.otherActorId, fixture.otherWorkspaceId]
      );
      await testPool.query(
        `INSERT INTO agent_profiles (
           id, workspace_id, actor_id, runtime_id, runtime_profile
         ) VALUES ($1, $2, $3, 'other-runtime', 'test')`,
        [fixture.otherProfileId, fixture.otherWorkspaceId, fixture.otherActorId]
      );
      await testPool.query(
        `INSERT INTO work_items (
           id, project_id, title, status, blocked, version
         ) VALUES ($1, $2, 'Other item', 'ready', false, 2)`,
        [fixture.otherWorkItemId, fixture.otherProjectId]
      );
      await testPool.query(
        `INSERT INTO canonical_events (
           id, workspace_id, project_id, event_type, aggregate_type,
           aggregate_id, deduplication_key, payload, occurred_at
         ) VALUES (
           $1, $2, $3, 'test.seed', 'work_item', $4, $5, '{}', now()
         )`,
        [
          fixture.otherEventId,
          fixture.otherWorkspaceId,
          fixture.otherProjectId,
          fixture.otherWorkItemId,
          `other-event-${randomUUID()}`
        ]
      );
      await testPool.query(
        `INSERT INTO secret_refs (
           id, workspace_id, provider, reference, scope
         ) VALUES ($1, $2, 'vault', 'other-only', ARRAY['repository:read'])`,
        [fixture.otherSecretRefId, fixture.otherWorkspaceId]
      );
      await testPool.query(
        `INSERT INTO task_packets (
           id, project_id, work_item_id, work_item_version, goal, data_policy,
           timebox_minutes, expected_output_schema, reviewer_actor_id,
           approver_actor_id, runtime_profile, auth_mode,
           created_from_event_id, content_hash, created_by_actor_id
         ) VALUES (
           $1, $2, $3, 2, 'Other packet', '{}', 15, '{}', $4, $4,
           'test', 'user', $5, $6, $4
         )`,
        [
          fixture.otherPacketId,
          fixture.otherProjectId,
          fixture.otherWorkItemId,
          fixture.otherActorId,
          fixture.otherEventId,
          'b'.repeat(64)
        ]
      );
      await testPool.query(
        `INSERT INTO agent_runs (
           id, task_packet_id, agent_profile_id, confirmed_packet_hash, base_commit, status,
           idempotency_key, version
         ) VALUES ($1, $2, $3, $4, $5, 'queued', $6, 1)`,
        [
          fixture.otherRunId,
          fixture.otherPacketId,
          fixture.otherProfileId,
          'b'.repeat(64),
          'b'.repeat(40),
          `other-run-${randomUUID()}`
        ]
      );
      await testPool.query(
        `INSERT INTO agent_runs (
           id, task_packet_id, agent_profile_id, confirmed_packet_hash, base_commit, status,
           idempotency_key, version
         ) VALUES ($1, $2, $3, $4, $5, 'queued', $6, 1)`,
        [
          fixture.runId,
          fixture.packetId,
          fixture.profileId,
          'a'.repeat(64),
          'a'.repeat(40),
          `run-${randomUUID()}`
        ]
      );
      const approvalBindingNow = new Date();
      const seededApprovalBinding = createApprovalBinding({
        actionCategory: 'deploy',
        surface: 'runner',
        environment: 'production'
      }, {workItemId: fixture.workItemId}, {
        subjectHash: createHash('sha256').update(fixture.packetId).digest('hex'),
        expectedPolicyVersion: CURRENT_POLICY_VERSION,
        executionIdentity: fixture.runId,
        expiresAt: new Date(approvalBindingNow.getTime() + 60 * 60 * 1_000).toISOString()
      }, fixture.actorId, approvalBindingNow);
      if (!seededApprovalBinding.ok) throw new Error('Seeded approval binding did not initialize.');
      await testPool.query(
        `INSERT INTO approval_requests (
           id, project_id, work_item_id, action_category, surface, environment,
           subject_hash, policy_version, execution_identity, action_hash, expires_at,
           status, requested_by_actor_id, version
         ) VALUES (
           $1, $2, $3, 'deploy', 'runner', 'production', $4, $5, $6, $7, $8,
           'pending', $9, 1
         )`,
        [
          fixture.approvalId,
          fixture.projectId,
          fixture.workItemId,
          seededApprovalBinding.value.subjectHash,
          seededApprovalBinding.value.policyVersion,
          seededApprovalBinding.value.executionIdentity,
          seededApprovalBinding.value.actionHash,
          seededApprovalBinding.value.expiresAt,
          fixture.actorId
        ]
      );
      await testPool.query(
        `INSERT INTO access_requests (
           id, workspace_id, requester_actor_id, target_surface, requested_scope, status, version
         ) VALUES ($1, $2, $3, 'repository', ARRAY['contents:read'], 'pending', 1)`,
        [fixture.accessRequestId, fixture.workspaceId, fixture.actorId]
      );
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
    });

    it('allows exactly one concurrent claimant and replays the completion', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = claim(`concurrent-${randomUUID()}`);
      let claimantCount = 0;

      const results = await Promise.allSettled([
        unitOfWork.executeCommand(receiptClaim, (transaction, claimToken) =>
          completeApproval(transaction, receiptClaim, claimToken, () => {
            claimantCount += 1;
          })
        ),
        unitOfWork.executeCommand(receiptClaim, (transaction, claimToken) =>
          completeApproval(transaction, receiptClaim, claimToken, () => {
            claimantCount += 1;
          })
        )
      ]);

      expect(claimantCount).toBe(1);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
      expect(results.map((result) => result.status === 'fulfilled' && result.value.status).sort())
        .toEqual(['completed', 'replayed']);
    });

    it('reports reuse of a completed key with a different request hash', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const first = claim(`reused-${randomUUID()}`, 'hash:first');
      await unitOfWork.executeCommand(first, (transaction, claimToken) =>
        completeApproval(transaction, first, claimToken)
      );

      const reused = {...claim(first.idempotencyKey, 'hash:second')};
      const result = await unitOfWork.executeCommand(reused, async () => {
        throw new Error('A reused idempotency key must not run the callback.');
      });

      expect(result).toEqual({
        status: 'key_reused',
        existingRequestHash: 'hash:first'
      });
    });

    it('derives all aggregate reads from the claimed workspace', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = claim(`scoped-loaders-${randomUUID()}`);
      const result = await unitOfWork.executeCommand(
        receiptClaim,
        async (transaction, claimToken) => {
          const value = await Promise.all([
            transaction.loadWorkItem(claimToken, fixture.workItemId),
            transaction.loadWorkItem(claimToken, fixture.otherWorkItemId),
            transaction.loadWorkItem(claimToken, 'not-a-uuid'),
            transaction.loadAgentRun(claimToken, fixture.runId),
            transaction.loadAgentRun(claimToken, fixture.otherRunId),
            transaction.loadAgentRun(claimToken, randomUUID()),
            transaction.loadAgentRun(claimToken, 'not-a-uuid'),
            transaction.loadApproval(claimToken, fixture.approvalId),
            transaction.loadApproval(claimToken, randomUUID()),
            transaction.loadAccessRequest(claimToken, fixture.accessRequestId),
            transaction.loadAccessRequest(claimToken, 'not-a-uuid')
          ]);
          return completeNoMutation(transaction, receiptClaim, claimToken, value);
        }
      );

      expect(result.status).toBe('completed');
      if (result.status !== 'completed' || result.command.kind !== 'no_mutation') return;
      const [
        item,
        otherItem,
        invalidItem,
        run,
        otherRun,
        missingRun,
        invalidRun,
        approval,
        missingApproval,
        access,
        invalidAccess
      ] = result.command.value;
      expect(item).toMatchObject({id: fixture.workItemId, projectId: fixture.projectId});
      expect(otherItem).toBeNull();
      expect(invalidItem).toBeNull();
      expect(run).toEqual({
        aggregate: {
          id: fixture.runId,
          taskPacketId: fixture.packetId,
          agentProfileId: fixture.profileId,
          baseCommit: 'a'.repeat(40),
          status: 'queued',
          idempotencyKey: expect.any(String),
          version: 1
        },
        projectId: fixture.projectId
      });
      expect(otherRun).toBeNull();
      expect(missingRun).toBeNull();
      expect(invalidRun).toBeNull();
      expect(approval).toMatchObject({id: fixture.approvalId, workItemId: fixture.workItemId});
      expect(missingApproval).toBeNull();
      expect(access).toMatchObject({id: fixture.accessRequestId, workspaceId: fixture.workspaceId});
      expect(invalidAccess).toBeNull();
    });

    it('records and completes no-op outcomes without mutating an aggregate', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = {
        ...claim(`no-op-${randomUUID()}`),
        commandType: 'work_item.set_blocked' as const
      };
      const result = await unitOfWork.executeCommand(
        receiptClaim,
        (transaction, claimToken) => completeNoMutation(
          transaction,
          receiptClaim,
          claimToken,
          'already blocked'
        )
      );

      expect(result).toMatchObject({status: 'completed', command: {kind: 'no_mutation'}});
      const [audit] = await testDb
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.commandId, receiptClaim.commandId));
      const [receipt] = await testDb
        .select()
        .from(commandReceipts)
        .where(eq(commandReceipts.commandId, receiptClaim.commandId));
      expect(audit).toMatchObject({outcome: 'succeeded', targetId: fixture.workItemId});
      expect(receipt).toMatchObject({state: 'completed', aggregateId: fixture.workItemId});
      expect(receipt?.result).toEqual({ok: true, value: null});
    });

    it('returns an explicit conflict for stale compare-and-swap updates', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = {
        ...claim(`stale-${randomUUID()}`),
        commandType: 'work_item.transition' as const
      };
      const outcome: NonApprovalCommandOutcome = {
        kind: 'non_approval',
        mutation: {
          aggregateType: 'work_item',
          aggregateId: fixture.workItemId,
          expectedPersistedVersion: 1,
          aggregate: {
            id: fixture.workItemId,
            projectId: fixture.projectId,
            status: 'in_dev',
            blocked: false,
            version: 2
          }
        },
        audit: {
          id: randomUUID(),
          workspaceId: fixture.workspaceId,
          commandId: receiptClaim.commandId,
          correlationId: receiptClaim.correlationId,
          actorId: fixture.actorId,
          actionCategory: 'write',
          action: 'work_item.transition',
          targetType: 'work_item',
          targetId: fixture.workItemId,
          expectedVersion: 1,
          resultVersion: 2,
          occurredAt: new Date().toISOString()
        }
      };

      const conflict = await unitOfWork
        .executeCommand(receiptClaim, async (transaction, claimToken) => {
          throw await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome
          });
        })
        .catch((error: unknown) => error);

      expect(conflict).toEqual({
        status: 'version_conflict',
        expectedPersistedVersion: 1,
        persistedVersion: 2
      });
    });

    it('rejects cross-workspace aggregate and actor access', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const aggregateClaim = {
        ...claim(`cross-workspace-item-${randomUUID()}`),
        commandType: 'work_item.set_blocked' as const
      };
      const aggregateResult = await unitOfWork
        .executeCommand(aggregateClaim, async (transaction, claimToken) => {
          throw await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome: workItemOutcome(aggregateClaim, {
              id: fixture.otherWorkItemId,
              projectId: fixture.otherProjectId
            })
          });
        })
        .catch((error: unknown) => error);
      expect(aggregateResult).toEqual({status: 'not_found'});

      const actorClaim = {
        ...claim(`cross-workspace-actor-${randomUUID()}`),
        commandType: 'work_item.set_blocked' as const
      };
      await expect(
        unitOfWork.executeCommand(actorClaim, async (transaction, claimToken) => {
          const result = await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome: workItemOutcome(actorClaim, {
              actorId: fixture.otherActorId
            })
          });
          throw result;
        })
      ).rejects.toThrow('Actor does not belong to claim workspace');
    });

    it('reports a cross-workspace task packet secret reference as not found', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = {
        ...claim(`cross-workspace-secret-${randomUUID()}`),
        commandType: 'task_packet.create' as const
      };
      const packetId = randomUUID();
      const packetResult = createTaskPacket(
        packetId,
        taskPacketContent({
          secretsRef: {
            provider: 'vault',
            reference: 'other-only',
            scope: ['repository:read']
          }
        })
      );
      expect(packetResult.ok).toBe(true);
      if (!packetResult.ok) return;
      const outcome: NonApprovalCommandOutcome = {
        kind: 'non_approval',
        mutation: {
          aggregateType: 'task_packet',
          aggregateId: packetId,
          expectedPersistedVersion: null,
          aggregate: packetResult.value
        },
        audit: {
          id: randomUUID(),
          workspaceId: fixture.workspaceId,
          commandId: receiptClaim.commandId,
          correlationId: receiptClaim.correlationId,
          actorId: fixture.actorId,
          actionCategory: 'write',
          action: 'task_packet.create',
          targetType: 'task_packet',
          targetId: packetId,
          resultVersion: 1,
          occurredAt: new Date().toISOString()
        }
      };

      const result = await unitOfWork
        .executeCommand(receiptClaim, async (transaction, claimToken) => {
          const result = await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome
          });
          throw result;
        })
        .catch((error: unknown) => error);
      expect(result).toEqual({status: 'not_found'});
    });

    it('reports duplicate task packet content as a version conflict', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const content = taskPacketContent({
        goal: `Duplicate content ${randomUUID()}`
      });
      const firstId = randomUUID();
      const secondId = randomUUID();
      const firstPacket = createTaskPacket(firstId, content);
      const secondPacket = createTaskPacket(secondId, content);
      expect(firstPacket.ok && secondPacket.ok).toBe(true);
      if (!firstPacket.ok || !secondPacket.ok) return;

      const firstClaim = {
        ...claim(`packet-content-first-${randomUUID()}`),
        commandType: 'task_packet.create' as const
      };
      const firstOutcome: NonApprovalCommandOutcome = {
        kind: 'non_approval',
        mutation: {
          aggregateType: 'task_packet',
          aggregateId: firstId,
          expectedPersistedVersion: null,
          aggregate: firstPacket.value
        },
        audit: {
          id: randomUUID(),
          workspaceId: firstClaim.workspaceId,
          commandId: firstClaim.commandId,
          correlationId: firstClaim.correlationId,
          actorId: fixture.actorId,
          actionCategory: 'write',
          action: 'task_packet.create',
          targetType: 'task_packet',
          targetId: firstId,
          resultVersion: 1,
          occurredAt: new Date().toISOString()
        }
      };
      await unitOfWork.executeCommand(firstClaim, (transaction, claimToken) =>
        completeNonApproval(
          transaction,
          firstClaim,
          claimToken,
          firstOutcome
        )
      );

      const secondClaim = {
        ...claim(`packet-content-second-${randomUUID()}`),
        commandType: 'task_packet.create' as const
      };
      const secondOutcome: NonApprovalCommandOutcome = {
        kind: 'non_approval',
        mutation: {
          aggregateType: 'task_packet',
          aggregateId: secondId,
          expectedPersistedVersion: null,
          aggregate: secondPacket.value
        },
        audit: {
          ...firstOutcome.audit,
          id: randomUUID(),
          commandId: secondClaim.commandId,
          correlationId: secondClaim.correlationId,
          targetId: secondId
        }
      };
      const conflict = await unitOfWork
        .executeCommand(secondClaim, async (transaction, claimToken) => {
          throw await transaction.persistAuditedMutation({
            claimToken,
            outcome: secondOutcome
          });
        })
        .catch((cause: unknown) => cause);

      expect(conflict).toEqual({
        status: 'version_conflict',
        expectedPersistedVersion: null,
        persistedVersion: null
      });
      expect(
        await testDb
          .select({id: taskPackets.id})
          .from(taskPackets)
          .where(eq(taskPackets.contentHash, firstPacket.value.contentHash))
      ).toHaveLength(1);
    });

    it('namespaces AgentRun idempotency keys by workspace', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const userKey = `shared-run-key-${randomUUID()}`;
      const firstRun: AgentRun = {
        id: randomUUID(),
        taskPacketId: fixture.packetId,
        agentProfileId: fixture.profileId,
        confirmedPacketHash: 'a'.repeat(64),
        baseCommit: 'a'.repeat(40),
        status: 'queued',
        idempotencyKey: userKey,
        version: 1
      };
      const secondRun: AgentRun = {
        id: randomUUID(),
        taskPacketId: fixture.otherPacketId,
        agentProfileId: fixture.otherProfileId,
        confirmedPacketHash: 'b'.repeat(64),
        baseCommit: 'b'.repeat(40),
        status: 'queued',
        idempotencyKey: userKey,
        version: 1
      };
      const firstClaim = {
        ...claim(`workspace-run-first-${randomUUID()}`),
        commandType: 'agent_run.queue' as const
      };
      const secondClaim = {
        ...claim(`workspace-run-second-${randomUUID()}`),
        workspaceId: fixture.otherWorkspaceId,
        commandType: 'agent_run.queue' as const
      };

      await unitOfWork.executeCommand(firstClaim, (transaction, claimToken) =>
        completeNonApproval(
          transaction,
          firstClaim,
          claimToken,
          agentRunOutcome(firstClaim, firstRun)
        )
      );
      await unitOfWork.executeCommand(secondClaim, (transaction, claimToken) =>
        completeNonApproval(
          transaction,
          secondClaim,
          claimToken,
          agentRunOutcome(secondClaim, secondRun, fixture.otherActorId)
        )
      );

      const rows = await testDb
        .select({
          id: agentRuns.id,
          idempotencyKey: agentRuns.idempotencyKey
        })
        .from(agentRuns);
      const inserted = rows.filter((row) =>
        row.id === firstRun.id || row.id === secondRun.id
      );
      expect(inserted).toHaveLength(2);
      expect(new Set(inserted.map((row) => row.idempotencyKey)).size).toBe(2);
      expect(inserted.every((row) =>
        row.idempotencyKey.startsWith('workspace-sha256:')
      )).toBe(true);
    });

    it('reports invalid approval and access insert ownership as not found', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const approvalClaim = claim(
        `cross-workspace-approval-insert-${randomUUID()}`
      );
      const invalidApproval = approvalOutcome(
        approvalClaim,
        randomUUID()
      );
      const original = invalidApproval.approval.aggregate;
      const crossWorkspaceBinding = createApprovalBinding({
        actionCategory: original.actionCategory,
        surface: original.surface,
        environment: original.environment
      }, {workItemId: fixture.otherWorkItemId}, {
        subjectHash: original.binding.subjectHash,
        expectedPolicyVersion: original.binding.policyVersion,
        executionIdentity: original.binding.executionIdentity,
        expiresAt: original.binding.expiresAt
      }, original.requestedByActorId, new Date());
      if (!crossWorkspaceBinding.ok) throw new Error('Cross-workspace approval binding did not initialize.');
      const crossWorkspaceApproval: ApprovalRequiredCommandOutcome = {
        ...invalidApproval,
        approval: {
          ...invalidApproval.approval,
          aggregate: {
            id: invalidApproval.approval.aggregate.id,
            projectId: fixture.otherProjectId,
            workItemId: fixture.otherWorkItemId,
            actionCategory:
              invalidApproval.approval.aggregate.actionCategory,
            surface: invalidApproval.approval.aggregate.surface,
            environment: invalidApproval.approval.aggregate.environment,
            requestedByActorId:
              invalidApproval.approval.aggregate.requestedByActorId,
            binding: crossWorkspaceBinding.value,
            status: invalidApproval.approval.aggregate.status,
            version: invalidApproval.approval.aggregate.version
          }
        }
      };
      const approvalResult = await unitOfWork
        .executeCommand(approvalClaim, async (transaction, claimToken) => {
          throw await transaction.persistApprovalRequired({
            claimToken,
            outcome: crossWorkspaceApproval
          });
        })
        .catch((cause: unknown) => cause);
      expect(approvalResult).toEqual({status: 'not_found'});

      const accessClaim = {
        ...claim(`missing-access-actor-${randomUUID()}`),
        commandType: 'access_request.request' as const
      };
      const requestId = randomUUID();
      const accessOutcome: NonApprovalCommandOutcome = {
        kind: 'non_approval',
        mutation: {
          aggregateType: 'access_request',
          aggregateId: requestId,
          expectedPersistedVersion: null,
          aggregate: {
            id: requestId,
            workspaceId: fixture.workspaceId,
            requesterActorId: randomUUID(),
            targetSurface: 'repository',
            requestedScope: ['contents:read'],
            status: 'pending',
            version: 1
          }
        },
        audit: {
          id: randomUUID(),
          workspaceId: fixture.workspaceId,
          commandId: accessClaim.commandId,
          correlationId: accessClaim.correlationId,
          actorId: fixture.actorId,
          actionCategory: 'write',
          action: 'access_request.request',
          targetType: 'access_request',
          targetId: requestId,
          resultVersion: 1,
          occurredAt: new Date().toISOString()
        }
      };
      const accessResult = await unitOfWork
        .executeCommand(accessClaim, async (transaction, claimToken) => {
          throw await transaction.persistAuditedMutation({
            claimToken,
            outcome: accessOutcome
          });
        })
        .catch((cause: unknown) => cause);
      expect(accessResult).toEqual({status: 'not_found'});
    });

    it('rejects a deserialized TaskPacket update mode before audit or SQL', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = {
        ...claim(`task-packet-update-mode-${randomUUID()}`),
        commandType: 'task_packet.create' as const
      };
      const packetId = randomUUID();
      const packetResult = createTaskPacket(packetId, taskPacketContent());
      expect(packetResult.ok).toBe(true);
      if (!packetResult.ok) return;
      const auditId = randomUUID();
      const malformedOutcome = {
        kind: 'non_approval',
        mutation: {
          aggregateType: 'task_packet',
          aggregateId: packetId,
          expectedPersistedVersion: 1,
          aggregate: packetResult.value
        },
        audit: {
          id: auditId,
          workspaceId: fixture.workspaceId,
          commandId: receiptClaim.commandId,
          correlationId: receiptClaim.correlationId,
          actorId: fixture.actorId,
          actionCategory: 'write',
          action: 'task_packet.create',
          targetType: 'task_packet',
          targetId: packetId,
          expectedVersion: 1,
          resultVersion: 2,
          occurredAt: new Date().toISOString()
        }
      } as unknown as NonApprovalCommandOutcome;

      await expect(
        unitOfWork.executeCommand(receiptClaim, async (transaction, claimToken) => {
          const result = await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome: malformedOutcome
          });
          throw result;
        })
      ).rejects.toThrow('TaskPacket mutations must use insert mode');
      expect(
        await testDb
          .select()
          .from(taskPackets)
          .where(eq(taskPackets.id, packetId))
      ).toHaveLength(0);
      expect(
        await testDb
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.id, auditId))
      ).toHaveLength(0);
    });

    it('rejects a cross-workspace Approval with both target fields', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = claim(`approval-dual-target-${randomUUID()}`);
      const approvalId = randomUUID();
      const validOutcome = approvalOutcome(receiptClaim, approvalId);
      const malformedOutcome = {
        ...validOutcome,
        approval: {
          ...validOutcome.approval,
          aggregate: {
            ...validOutcome.approval.aggregate,
            workItemId: fixture.workItemId,
            agentRunId: fixture.otherRunId
          }
        }
      } as unknown as ApprovalRequiredCommandOutcome;

      await expect(
        unitOfWork.executeCommand(receiptClaim, async (transaction, claimToken) => {
          const result = await transaction.persistApprovalRequired({
            claimToken: claimToken,
            outcome: malformedOutcome
          });
          throw result;
        })
      ).rejects.toThrow('Approval must target exactly one WorkItem or AgentRun');

      await expect(
        testPool.query(
          `INSERT INTO approval_requests (
             id, project_id, work_item_id, agent_run_id, action_category,
             surface, environment, subject_hash, policy_version,
             execution_identity, action_hash, expires_at, status,
             requested_by_actor_id, version
           ) VALUES (
             $1, $2, $3, $4, 'deploy', 'runner', 'production', $5, $6, $4,
             $7, now() + interval '1 hour', 'pending', $8, 1
           )`,
          [
            randomUUID(),
            fixture.projectId,
            fixture.workItemId,
            fixture.otherRunId,
            'a'.repeat(64),
            CURRENT_POLICY_VERSION,
            'b'.repeat(64),
            fixture.actorId
          ]
        )
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'approval_requests_exactly_one_target'
      });
    });

    it('rejects version jumps and aggregate ID mismatches before mutation SQL', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const jumpClaim = {
        ...claim(`version-jump-${randomUUID()}`),
        commandType: 'work_item.set_blocked' as const
      };
      await expect(
        unitOfWork.executeCommand(jumpClaim, async (transaction, claimToken) => {
          const result = await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome: workItemOutcome(jumpClaim, {expectedVersion: 2, version: 7})
          });
          throw result;
        })
      ).rejects.toThrow('expected version plus one');

      const mismatchClaim = {
        ...claim(`id-mismatch-${randomUUID()}`),
        commandType: 'work_item.set_blocked' as const
      };
      const mismatch = workItemOutcome(mismatchClaim);
      const mismatchedOutcome = {
        ...mismatch,
        mutation: {...mismatch.mutation, aggregateId: randomUUID()}
      } as NonApprovalCommandOutcome;
      await expect(
        unitOfWork.executeCommand(mismatchClaim, async (transaction, claimToken) => {
          const result = await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome: mismatchedOutcome
          });
          throw result;
        })
      ).rejects.toThrow('must equal the aggregate identifier');
    });

    it('reports a missing in-workspace agent profile as not found', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = {
        ...claim(`required-profile-${randomUUID()}`),
        commandType: 'agent_run.queue' as const
      };
      const aggregate: AgentRun = {
        id: randomUUID(),
        taskPacketId: fixture.packetId,
        agentProfileId: randomUUID(),
        confirmedPacketHash: 'a'.repeat(64),
        baseCommit: 'a'.repeat(40),
        status: 'queued',
        idempotencyKey: `run-${randomUUID()}`,
        version: 1
      };
      const result = await unitOfWork
        .executeCommand(receiptClaim, async (transaction, claimToken) => {
          const result = await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome: agentRunOutcome(receiptClaim, aggregate)
          });
          throw result;
        })
        .catch((error: unknown) => error);
      expect(result).toEqual({status: 'not_found'});
      expect(
        await testDb
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, aggregate.id))
      ).toHaveLength(0);
      await expect(
        testPool.query(
          `INSERT INTO agent_runs (
             id, task_packet_id, confirmed_packet_hash, status, idempotency_key, version
           ) VALUES ($1, $2, $3, 'queued', $4, 1)`,
          [randomUUID(), fixture.packetId, 'a'.repeat(64), `missing-profile-${randomUUID()}`]
        )
      ).rejects.toMatchObject({code: '23502'});
    });

    it('rejects audit and receipt facts that do not match the claim or CAS', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const auditClaim = {
        ...claim(`audit-mismatch-${randomUUID()}`),
        commandType: 'work_item.set_blocked' as const
      };
      const invalidAudit = workItemOutcome(auditClaim);
      const invalidAuditOutcome = {
        ...invalidAudit,
        audit: {...invalidAudit.audit, correlationId: randomUUID()}
      } as NonApprovalCommandOutcome;
      await expect(
        unitOfWork.executeCommand(auditClaim, async (transaction, claimToken) => {
          const result = await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome: invalidAuditOutcome
          });
          throw result;
        })
      ).rejects.toThrow('Audit correlation does not match claim');

      const receiptClaim = {
        ...claim(`receipt-mismatch-${randomUUID()}`),
        commandType: 'work_item.set_blocked' as const
      };
      await expect(
        unitOfWork.executeCommand(receiptClaim, async (transaction, claimToken) => {
          const outcome = workItemOutcome(receiptClaim);
          const persisted = await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome
          });
          if (persisted.status !== 'persisted') throw persisted;
          return transaction.completeReceipt({
            claimToken: claimToken,
            mutation: persisted.mutation,
            receipt: {
              ...receiptClaim,
              aggregateType: 'work_item',
              aggregateId: fixture.workItemId,
              expectedVersion: 2,
              resultVersion: 99,
              result: {ok: true, value: null}
            }
          }) as never;
        })
      ).rejects.toThrow('Receipt version facts do not match persisted CAS');
    });

    it('rolls aggregate, audit, and receipt writes back together', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = {
        ...claim(`rollback-${randomUUID()}`),
        commandType: 'work_item.set_blocked' as const
      };
      const auditId = randomUUID();
      const outcome: NonApprovalCommandOutcome = {
        kind: 'non_approval',
        mutation: {
          aggregateType: 'work_item',
          aggregateId: fixture.workItemId,
          expectedPersistedVersion: 2,
          aggregate: {
            id: fixture.workItemId,
            projectId: fixture.projectId,
            status: 'ready',
            blocked: true,
            version: 3
          }
        },
        audit: {
          id: auditId,
          workspaceId: fixture.workspaceId,
          commandId: receiptClaim.commandId,
          correlationId: receiptClaim.correlationId,
          actorId: fixture.actorId,
          actionCategory: 'write',
          action: 'work_item.set_blocked',
          targetType: 'work_item',
          targetId: fixture.workItemId,
          expectedVersion: 2,
          resultVersion: 3,
          occurredAt: new Date().toISOString()
        }
      };

      await expect(
        unitOfWork.executeCommand(receiptClaim, async (transaction, claimToken) => {
          const persisted = await transaction.persistAuditedMutation({
            claimToken: claimToken,
            outcome
          });
          if (persisted.status !== 'persisted') throw persisted;
          throw new Error('force rollback');
        })
      ).rejects.toThrow('force rollback');

      const [item] = await testDb
        .select({blocked: workItems.blocked, version: workItems.version})
        .from(workItems)
        .where(eq(workItems.id, fixture.workItemId));
      expect(item).toEqual({blocked: false, version: 2});
      expect(
        await testDb
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.id, auditId))
      ).toHaveLength(0);
      expect(
        await testDb
          .select()
          .from(commandReceipts)
          .where(eq(commandReceipts.idempotencyKey, receiptClaim.idempotencyKey))
      ).toHaveLength(0);
    });

    it('rolls approval-required insert, audit, and completed receipt back together', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = claim(`approval-rollback-${randomUUID()}`);
      const approvalId = randomUUID();
      const outcome = approvalOutcome(receiptClaim, approvalId);

      await expect(
        unitOfWork.executeCommand(receiptClaim, async (transaction, claimToken) => {
          const persisted = await transaction.persistApprovalRequired({
            claimToken: claimToken,
            outcome
          });
          if (persisted.status !== 'completed') throw persisted;
          throw new Error('force approval rollback');
        })
      ).rejects.toThrow('force approval rollback');

      expect(
        await testDb
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.id, approvalId))
      ).toHaveLength(0);
      expect(
        await testDb
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.commandId, receiptClaim.commandId))
      ).toHaveLength(0);
      expect(
        await testDb
          .select()
          .from(commandReceipts)
          .where(eq(commandReceipts.commandId, receiptClaim.commandId))
      ).toHaveLength(0);
    });

    it('rejects task packet updates and deletes while allowing inserts', async () => {
      await expectImmutableRejection(
        testDb
          .update(taskPackets)
          .set({goal: 'Changed'})
          .where(eq(taskPackets.id, fixture.packetId)),
        'task_packets'
      );
      await expectImmutableRejection(
        testDb.delete(taskPackets).where(eq(taskPackets.id, fixture.packetId)),
        'task_packets'
      );
    });

    it('rejects audit event updates and deletes', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = claim(`immutable-audit-${randomUUID()}`);
      await unitOfWork.executeCommand(receiptClaim, (transaction, claimToken) =>
        completeApproval(transaction, receiptClaim, claimToken)
      );
      const [audit] = await testDb
        .select({id: auditEvents.id})
        .from(auditEvents)
        .where(eq(auditEvents.commandId, receiptClaim.commandId));
      expect(audit).toBeDefined();

      await expectImmutableRejection(
        testDb
          .update(auditEvents)
          .set({action: 'changed'})
          .where(eq(auditEvents.id, audit!.id)),
        'audit_events'
      );
      await expectImmutableRejection(
        testDb.delete(auditEvents).where(eq(auditEvents.id, audit!.id)),
        'audit_events'
      );
    });

    it('atomically persists approval, ask audit, and completed receipt', async () => {
      const unitOfWork = createPostgresUnitOfWork(testDb);
      const receiptClaim = claim(`approval-atomic-${randomUUID()}`);
      const approvalId = randomUUID();

      await unitOfWork.executeCommand(receiptClaim, async (transaction, claimToken) => {
        const persisted = await transaction.persistApprovalRequired({
          claimToken: claimToken,
          outcome: approvalOutcome(receiptClaim, approvalId)
        });
        if (persisted.status !== 'completed') throw persisted;
        return persisted.command;
      });

      const [approval] = await testDb
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalId));
      const [audit] = await testDb
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.commandId, receiptClaim.commandId));
      const [receipt] = await testDb
        .select()
        .from(commandReceipts)
        .where(eq(commandReceipts.commandId, receiptClaim.commandId));

      expect(approval).toMatchObject({status: 'pending', version: 1});
      expect(audit).toMatchObject({
        policyDecision: 'ask',
        outcome: 'approval_required',
        reasonCode: 'APPROVAL_REQUIRED'
      });
      expect(receipt).toMatchObject({
        state: 'completed',
        requestHash: receiptClaim.requestHash
      });
      expect(receipt?.result).not.toBeNull();
      expect(receipt?.completedAt).toBeInstanceOf(Date);
    });

    it('preserves existing rows while upgrading the foundation migrations', async () => {
      const legacyDatabase = `fai_db_legacy_${randomUUID().replaceAll('-', '')}`;
      const sourceUrl = new URL(databaseUrl!);
      await adminPool.query(`CREATE DATABASE "${legacyDatabase}"`);
      sourceUrl.pathname = `/${legacyDatabase}`;
      const legacyPool = new Pool({connectionString: sourceUrl.toString()});
      const ids = {
        workspace: randomUUID(),
        project: randomUUID(),
        actor: randomUUID(),
        workItem: randomUUID(),
        approval: randomUUID(),
        access: randomUUID(),
        audit: randomUUID(),
        receipt: randomUUID()
      };

      try {
        await applySqlMigration(legacyPool, '0000_foundation.sql');
        await applySqlMigration(legacyPool, '0001_inbound_event_data_safety.sql');
        await legacyPool.query(
          `INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Legacy', $2)`,
          [ids.workspace, `legacy-${randomUUID()}`]
        );
        await legacyPool.query(
          `INSERT INTO projects (id, workspace_id, name, slug)
           VALUES ($1, $2, 'Legacy project', $3)`,
          [ids.project, ids.workspace, `legacy-project-${randomUUID()}`]
        );
        await legacyPool.query(
          `INSERT INTO actors (
             id, workspace_id, type, role, display_name, auth_mode
           ) VALUES ($1, $2, 'human', 'workspace_admin', 'Legacy actor', 'user')`,
          [ids.actor, ids.workspace]
        );
        await legacyPool.query(
          `INSERT INTO work_items (id, project_id, title, status, version)
           VALUES ($1, $2, 'Legacy item', 'ready', 1)`,
          [ids.workItem, ids.project]
        );
        await legacyPool.query(
          `INSERT INTO approval_requests (
             id, project_id, work_item_id, action_category, surface, environment,
             status, requested_by_actor_id
           ) VALUES (
             $1, $2, $3, 'deploy', 'runner', 'production', 'pending', $4
           )`,
          [ids.approval, ids.project, ids.workItem, ids.actor]
        );
        await legacyPool.query(
          `INSERT INTO access_requests (
             id, workspace_id, requester_actor_id, target_surface, status
           ) VALUES ($1, $2, $3, 'repository', 'pending')`,
          [ids.access, ids.workspace, ids.actor]
        );
        await legacyPool.query(
          `INSERT INTO audit_events (
             id, workspace_id, actor_id, action_category, action, target_type,
             target_id, correlation_id
           ) VALUES ($1, $2, $3, 'write', 'legacy.action', 'approval', $4, $5)`,
          [ids.audit, ids.workspace, ids.actor, ids.approval, randomUUID()]
        );
        await legacyPool.query(
          `INSERT INTO command_receipts (
             id, workspace_id, idempotency_key, command_type, aggregate_type,
             aggregate_id, result
           ) VALUES ($1, $2, $3, 'approval.request', 'approval', $4, $5)`,
          [
            ids.receipt,
            ids.workspace,
            `legacy-key-${randomUUID()}`,
            ids.approval,
            JSON.stringify({ok: true, value: null})
          ]
        );

        await applySqlMigration(legacyPool, '0002_canonical_persistence.sql');
        await applySqlMigration(legacyPool, '0003_audit_command_uniqueness.sql');
        await applySqlMigration(legacyPool, '0004_approval_target_xor.sql');

        const approval = await legacyPool.query(
          'SELECT version FROM approval_requests WHERE id = $1',
          [ids.approval]
        );
        const access = await legacyPool.query(
          'SELECT version FROM access_requests WHERE id = $1',
          [ids.access]
        );
        const receipt = await legacyPool.query(
          `SELECT state, request_hash, completed_at
           FROM command_receipts WHERE id = $1`,
          [ids.receipt]
        );
        const audit = await legacyPool.query(
          `SELECT command_id, occurred_at FROM audit_events WHERE id = $1`,
          [ids.audit]
        );
        expect(approval.rows[0]).toEqual({version: 1});
        expect(access.rows[0]).toEqual({version: 1});
        expect(receipt.rows[0]).toMatchObject({
          state: 'completed',
          request_hash: `legacy:${ids.receipt}`
        });
        expect(receipt.rows[0]?.completed_at).toBeInstanceOf(Date);
        expect(audit.rows[0]).toMatchObject({
          command_id: `legacy:${ids.audit}`
        });
        expect(audit.rows[0]?.occurred_at).toBeInstanceOf(Date);
      } finally {
        await legacyPool.end();
        await dropDatabaseWhenDisconnected(adminPool, legacyDatabase);
      }
    }, 30_000);
  }
);
