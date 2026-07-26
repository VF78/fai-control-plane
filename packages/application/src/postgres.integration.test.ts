import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  CURRENT_POLICY_VERSION,
  createActorContextIssuer,
  createTaskPacket,
  type CanonicalCommand,
  type TaskPacketContent,
  type TrustedUserActorContext
} from '@fai-control-plane/domain';
import {
  agentRuns,
  approvalRequests,
  auditEvents,
  commandReceipts,
  createDatabase,
  createPostgresUnitOfWork,
  outboxEvents,
  statusTransitions,
  taskPackets,
  trackerBindings,
  workItems
} from '@fai-control-plane/db';
import {dropDatabaseWhenDisconnected} from '../../db/src/integration-test-utils';
import {eq, inArray} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';
import {createCanonicalCommandService} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error(
    'DATABASE_URL is required for application PostgreSQL integration tests in CI.'
  );
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName =
  `fai_application_test_${randomUUID().replaceAll('-', '')}`;
const fixture = {
  workspaceId: randomUUID(),
  projectId: randomUUID(),
  actorId: randomUUID(),
  profileId: randomUUID(),
  workItemId: randomUUID(),
  eventId: randomUUID(),
  otherWorkspaceId: randomUUID(),
  otherProjectId: randomUUID(),
  otherActorId: randomUUID(),
  otherProfileId: randomUUID(),
  otherWorkItemId: randomUUID(),
  otherEventId: randomUUID()
};

let adminPool: Pool;
let testPool: Pool;
let testDb: ReturnType<typeof createDatabase>['db'];
let primaryActor: TrustedUserActorContext;
let limitedActor: TrustedUserActorContext;
let otherActor: TrustedUserActorContext;

const issueActor = (
  actorId: string,
  capabilities: Parameters<typeof createActorContextIssuer>[0]['users'][number]['capabilities']
): TrustedUserActorContext => {
  const issuer = createActorContextIssuer({
    users: [{actorId, capabilities}],
    agents: [],
    systems: []
  });
  if (!issuer.ok) throw new Error('Integration actor issuer failed.');
  const actor = issuer.value.issueUser(actorId);
  if (!actor.ok) throw new Error('Integration actor failed.');
  return actor.value;
};

const command = <T extends CanonicalCommand['type']>(
  workspaceId: string,
  actor: TrustedUserActorContext,
  type: T,
  payload: Extract<CanonicalCommand, {type: T}>['payload'],
  idempotencyKey = `application-${randomUUID()}`
): Extract<CanonicalCommand, {type: T}> => ({
  commandId: randomUUID(),
  workspaceId,
  correlationId: randomUUID(),
  idempotencyKey,
  issuedAt: new Date().toISOString(),
  actor,
  type,
  payload
}) as Extract<CanonicalCommand, {type: T}>;

const packetContent = (
  workspace: 'primary' | 'other' = 'primary',
  overrides: Partial<TaskPacketContent> = {}
): TaskPacketContent => {
  const other = workspace === 'other';
  const actorId = other ? fixture.otherActorId : fixture.actorId;
  return {
    projectId: other ? fixture.otherProjectId : fixture.projectId,
    workItemId: other ? fixture.otherWorkItemId : fixture.workItemId,
    goal: `Integration packet ${randomUUID()}`,
    acceptanceCriteria: ['Receipt is completed'],
    inScope: ['packages/application/**'],
    outOfScope: ['apps/**'],
    relevantLinks: [],
    relevantFiles: ['packages/application/src/index.ts'],
    allowedTools: ['pnpm test'],
    forbiddenSurfaces: ['production'],
    dataPolicy: {},
    timeboxMinutes: 10,
    expectedOutputSchema: {},
    reviewerActorId: actorId,
    approverActorId: actorId,
    runtimeProfile: 'test',
    authMode: 'user',
    secretsRef: null,
    createdFromEventId: other ? fixture.otherEventId : fixture.eventId,
    createdByActorId: actorId,
    ...overrides
  };
};

const service = () =>
  createCanonicalCommandService({
    unitOfWork: createPostgresUnitOfWork(testDb),
    idGenerator: {next: randomUUID},
    clock: {now: () => new Date()}
  });

const approvalBinding = () => ({
  subjectHash: 'a'.repeat(64),
  expectedPolicyVersion: CURRENT_POLICY_VERSION,
  executionIdentity: randomUUID(),
  expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString()
});

const receiptErrorCode = (
  result: Awaited<ReturnType<ReturnType<typeof service>['execute']>>
): string | undefined =>
  result.status === 'completed' && !result.receipt.result.ok
    ? result.receipt.result.error.code
    : undefined;

describePostgres(
  databaseUrl === undefined
    ? 'application PostgreSQL integration (skipped: DATABASE_URL is absent)'
    : 'application PostgreSQL integration',
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
        migrationsFolder: fileURLToPath(
          new URL('../../db/drizzle', import.meta.url)
        )
      });

      for (const entry of [
        {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          actorId: fixture.actorId,
          profileId: fixture.profileId,
          workItemId: fixture.workItemId,
          eventId: fixture.eventId,
          label: 'Primary'
        },
        {
          workspaceId: fixture.otherWorkspaceId,
          projectId: fixture.otherProjectId,
          actorId: fixture.otherActorId,
          profileId: fixture.otherProfileId,
          workItemId: fixture.otherWorkItemId,
          eventId: fixture.otherEventId,
          label: 'Other'
        }
      ]) {
        await testPool.query(
          `INSERT INTO workspaces (id, name, slug)
           VALUES ($1, $2, $3)`,
          [
            entry.workspaceId,
            `${entry.label} workspace`,
            `${entry.label.toLowerCase()}-${randomUUID()}`
          ]
        );
        await testPool.query(
          `INSERT INTO projects (id, workspace_id, name, slug)
           VALUES ($1, $2, $3, $4)`,
          [
            entry.projectId,
            entry.workspaceId,
            `${entry.label} project`,
            `${entry.label.toLowerCase()}-project-${randomUUID()}`
          ]
        );
        await testPool.query(
          `INSERT INTO actors (
             id, workspace_id, type, role, display_name, auth_mode
           ) VALUES (
             $1, $2, 'human', 'workspace_admin', $3, 'user'
           )`,
          [entry.actorId, entry.workspaceId, `${entry.label} actor`]
        );
        await testPool.query(
          `INSERT INTO agent_profiles (
             id, workspace_id, actor_id, runtime_id, runtime_profile
           ) VALUES ($1, $2, $3, $4, 'test')`,
          [
            entry.profileId,
            entry.workspaceId,
            entry.actorId,
            `${entry.label.toLowerCase()}-runtime`
          ]
        );
        await testPool.query(
          `INSERT INTO work_items (
             id, project_id, title, status, blocked, version
           ) VALUES ($1, $2, $3, 'ready', false, 1)`,
          [entry.workItemId, entry.projectId, `${entry.label} item`]
        );
        await testPool.query(
          `INSERT INTO canonical_events (
             id, workspace_id, project_id, event_type, aggregate_type,
             aggregate_id, deduplication_key, payload, occurred_at
           ) VALUES (
             $1, $2, $3, 'test.seed', 'work_item', $4, $5, '{}', now()
           )`,
          [
            entry.eventId,
            entry.workspaceId,
            entry.projectId,
            entry.workItemId,
            `application-event-${randomUUID()}`
          ]
        );
      }

      primaryActor = issueActor(fixture.actorId, [
        'deploy:runner:development',
        'write:control_plane:development',
        'write:control_plane:production'
      ]);
      limitedActor = issueActor(fixture.actorId, [
        'write:control_plane:development'
      ]);
      otherActor = issueActor(fixture.otherActorId, [
        'write:control_plane:development'
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
    });

    it('executes and receipts a successful canonical command', async () => {
      const result = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'work_item.set_blocked',
        {
          workItemId: fixture.workItemId,
          blocked: true,
          expectedVersion: 1
        }
      ));

      expect(result).toMatchObject({
        status: 'completed',
        receipt: {
          resultVersion: 2,
          result: {ok: true}
        }
      });
    });

    it('atomically enqueues a GitHub Project status write-back for a WorkItem transition', async () => {
      const workItemId = randomUUID();
      const bindingId = randomUUID();
      await testDb.insert(workItems).values({
        id: workItemId,
        projectId: fixture.projectId,
        title: 'GitHub-bound item',
        status: 'ready',
        version: 1
      });
      await testDb.insert(trackerBindings).values({
        id: bindingId,
        projectId: fixture.projectId,
        provider: 'github',
        surface: 'issue',
        externalId: 'github:issue:9001',
        entityType: 'work_item',
        entityId: workItemId,
        externalVersion: 'github:sha256:inbound',
        lastInboundVersion: 'github:sha256:inbound',
        metadata: {
          repositoryExternalId: 'github:repository:1278325372',
          projectStatus: {
            projectExternalId: 'PVT_kwHOBIUvJs4Bbefq',
            projectItemExternalId: 'PVTI_test_9001',
            fieldExternalId: 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc',
            optionExternalId: '1f121483',
            status: 'ready'
          }
        }
      });
      const transition = command(
        fixture.workspaceId,
        primaryActor,
        'work_item.transition',
        {workItemId, status: 'in_dev', expectedVersion: 1}
      );

      await expect(service().execute(transition)).resolves.toMatchObject({
        status: 'completed', receipt: {result: {ok: true}, resultVersion: 2}
      });
      await expect(testDb.select({status: workItems.status, version: workItems.version})
        .from(workItems).where(eq(workItems.id, workItemId))).resolves.toEqual([
        {status: 'in_dev', version: 2}
      ]);
      await expect(testDb.select({fromStatus: statusTransitions.fromStatus, toStatus: statusTransitions.toStatus})
        .from(statusTransitions).where(eq(statusTransitions.workItemId, workItemId))).resolves.toEqual([
        {fromStatus: 'ready', toStatus: 'in_dev'}
      ]);
      await expect(testDb.select({lastOutboundMutationId: trackerBindings.lastOutboundMutationId})
        .from(trackerBindings).where(eq(trackerBindings.id, bindingId))).resolves.toEqual([
        {lastOutboundMutationId: transition.commandId}
      ]);
      await expect(testDb.select({payload: outboxEvents.payload, status: outboxEvents.status})
        .from(outboxEvents).where(eq(outboxEvents.idempotencyKey,
          `github-project-status:${bindingId}:${transition.commandId}`))).resolves.toMatchObject([
        {
          status: 'pending',
          payload: {
            version: 1,
            bindingId,
            workItemId,
            canonicalVersion: 2,
            status: 'in_dev',
            expected: {
              bindingExternalVersion: 'github:sha256:inbound',
              providerOptionId: '1f121483'
            },
            target: {
              repositoryExternalId: 'github:repository:1278325372',
              projectExternalId: 'PVT_kwHOBIUvJs4Bbefq',
              projectItemExternalId: 'PVTI_test_9001',
              fieldExternalId: 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc'
            },
            mutationId: transition.commandId
          }
        }
      ]);
      await expect(testDb.select().from(auditEvents)
        .where(eq(auditEvents.commandId, transition.commandId))).resolves.toHaveLength(1);
      await expect(testDb.select().from(commandReceipts)
        .where(eq(commandReceipts.commandId, transition.commandId))).resolves.toMatchObject([
        {state: 'completed'}
      ]);
    });

    it('completes duplicate packet content as an audited conflict', async () => {
      const content = packetContent();
      const first = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'task_packet.create',
        {packetId: randomUUID(), content}
      ));
      expect(first).toMatchObject({
        status: 'completed',
        receipt: {result: {ok: true}}
      });
      const duplicate = command(
        fixture.workspaceId,
        primaryActor,
        'task_packet.create',
        {packetId: randomUUID(), content}
      );
      const result = await service().execute(duplicate);

      expect(receiptErrorCode(result)).toBe('VERSION_CONFLICT');
      expect(
        await testDb
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.commandId, duplicate.commandId))
      ).toHaveLength(1);
      expect(
        await testDb
          .select()
          .from(commandReceipts)
          .where(eq(commandReceipts.commandId, duplicate.commandId))
      ).toMatchObject([{state: 'completed'}]);
    });

    it('stores the same run key independently in two workspaces', async () => {
      const primaryPacketId = randomUUID();
      const otherPacketId = randomUUID();
      const primaryContent = packetContent();
      const primaryPacket = createTaskPacket(primaryPacketId, primaryContent);
      if (!primaryPacket.ok) throw new Error('Primary packet did not initialize.');
      await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'task_packet.create',
        {packetId: primaryPacketId, content: primaryContent}
      ));
      const otherContent = packetContent('other');
      const otherPacket = createTaskPacket(otherPacketId, otherContent);
      if (!otherPacket.ok) throw new Error('Other packet did not initialize.');
      await service().execute(command(
        fixture.otherWorkspaceId,
        otherActor,
        'task_packet.create',
        {packetId: otherPacketId, content: otherContent}
      ));
      const userKey = `shared-user-key-${randomUUID()}`;
      const first = command(
        fixture.workspaceId,
        primaryActor,
        'agent_run.queue',
        {
          agentRunId: randomUUID(),
          taskPacketId: primaryPacketId,
          agentProfileId: fixture.profileId,
          confirmedPacketHash: primaryPacket.value.contentHash
        },
        userKey
      );
      const second = command(
        fixture.otherWorkspaceId,
        otherActor,
        'agent_run.queue',
        {
          agentRunId: randomUUID(),
          taskPacketId: otherPacketId,
          agentProfileId: fixture.otherProfileId,
          confirmedPacketHash: otherPacket.value.contentHash
        },
        userKey
      );

      const [firstResult, secondResult] = await Promise.all([
        service().execute(first),
        service().execute(second)
      ]);
      expect(firstResult).toMatchObject({receipt: {result: {ok: true}}});
      expect(secondResult).toMatchObject({receipt: {result: {ok: true}}});
      const runs = await testDb
        .select({
          id: agentRuns.id,
          idempotencyKey: agentRuns.idempotencyKey
        })
        .from(agentRuns)
        .where(inArray(agentRuns.id, [
          first.payload.agentRunId,
          second.payload.agentRunId
        ]));
      expect(new Set(runs.map((run) => run.idempotencyKey)).size).toBe(2);
      const receipts = await testDb
        .select({idempotencyKey: commandReceipts.idempotencyKey})
        .from(commandReceipts)
        .where(inArray(commandReceipts.commandId, [
          first.commandId,
          second.commandId
        ]));
      expect(receipts.map((receipt) => receipt.idempotencyKey)).toEqual([
        userKey,
        userKey
      ]);
    });

    it('rejects forged packet provenance before a receipt claim', async () => {
      const packetId = randomUUID();
      const forged = command(
        fixture.workspaceId,
        primaryActor,
        'task_packet.create',
        {
          packetId,
          content: packetContent('primary', {
            createdByActorId: fixture.otherActorId
          })
        }
      );
      const result = await service().execute(forged);

      expect(result).toMatchObject({
        status: 'rejected',
        error: {code: 'INVALID_COMMAND'}
      });
      expect(
        await testDb
          .select()
          .from(commandReceipts)
          .where(eq(commandReceipts.commandId, forged.commandId))
      ).toHaveLength(0);
      expect(
        await testDb
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.commandId, forged.commandId))
      ).toHaveLength(0);
      expect(
        await testDb
          .select()
          .from(taskPackets)
          .where(eq(taskPackets.id, packetId))
      ).toHaveLength(0);
    });

    it('receipts missing and cross-workspace insert references', async () => {
      const crossPacket = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'task_packet.create',
        {
          packetId: randomUUID(),
          content: packetContent('primary', {
            projectId: fixture.otherProjectId,
            workItemId: fixture.otherWorkItemId,
            createdFromEventId: fixture.otherEventId
          })
        }
      ));
      expect(receiptErrorCode(crossPacket)).toBe('NOT_FOUND');

      const validPacketId = randomUUID();
      const validContent = packetContent();
      const validPacket = createTaskPacket(validPacketId, validContent);
      if (!validPacket.ok) throw new Error('Valid packet did not initialize.');
      await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'task_packet.create',
        {packetId: validPacketId, content: validContent}
      ));
      const missingProfile = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'agent_run.queue',
        {
          agentRunId: randomUUID(),
          taskPacketId: validPacketId,
          agentProfileId: randomUUID(),
          confirmedPacketHash: validPacket.value.contentHash
        }
      ));
      expect(receiptErrorCode(missingProfile)).toBe('NOT_FOUND');

      const missingApprovalTarget = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'approval.request',
        {
          approvalId: randomUUID(),
          action: {
            actionCategory: 'deploy',
            surface: 'runner',
            environment: 'development'
          },
          target: {workItemId: fixture.otherWorkItemId},
          binding: approvalBinding()
        }
      ));
      expect(receiptErrorCode(missingApprovalTarget)).toBe('NOT_FOUND');
    });

    it('applies allow, ask, deny, and missing-capability approval semantics', async () => {
      const allowed = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'approval.request',
        {
          approvalId: randomUUID(),
          action: {
            actionCategory: 'write',
            surface: 'control_plane',
            environment: 'development'
          },
          target: {workItemId: fixture.workItemId},
          binding: approvalBinding()
        }
      ));
      expect(receiptErrorCode(allowed)).toBe('INVALID_COMMAND');

      const approvalId = randomUUID();
      const asked = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'approval.request',
        {
          approvalId,
          action: {
            actionCategory: 'deploy',
            surface: 'runner',
            environment: 'development'
          },
          target: {workItemId: fixture.workItemId},
          binding: approvalBinding()
        }
      ));
      expect(receiptErrorCode(asked)).toBe('APPROVAL_REQUIRED');
      expect(
        await testDb
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.id, approvalId))
      ).toMatchObject([{status: 'pending'}]);

      const denied = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'approval.request',
        {
          approvalId: randomUUID(),
          action: {
            actionCategory: 'write',
            surface: 'control_plane',
            environment: 'production'
          },
          target: {workItemId: fixture.workItemId},
          binding: approvalBinding()
        }
      ));
      expect(receiptErrorCode(denied)).toBe('POLICY_DENIED');

      const capabilityDenied = await service().execute(command(
        fixture.workspaceId,
        limitedActor,
        'approval.request',
        {
          approvalId: randomUUID(),
          action: {
            actionCategory: 'deploy',
            surface: 'runner',
            environment: 'development'
          },
          target: {workItemId: fixture.workItemId},
          binding: approvalBinding()
        }
      ));
      expect(receiptErrorCode(capabilityDenied)).toBe('CAPABILITY_DENIED');
    });

    it('replays matching requests and rejects key reuse', async () => {
      const key = `replay-key-${randomUUID()}`;
      const first = command(
        fixture.workspaceId,
        primaryActor,
        'access_request.request',
        {
          requestId: randomUUID(),
          targetSurface: 'repository',
          requestedScope: ['contents:read']
        },
        key
      );
      const completed = await service().execute(first);
      expect(completed).toMatchObject({status: 'completed'});
      const replayed = await service().execute({
        ...first,
        commandId: randomUUID(),
        correlationId: randomUUID(),
        issuedAt: new Date().toISOString()
      });
      expect(replayed).toMatchObject({status: 'replayed'});
      const reused = await service().execute({
        ...first,
        commandId: randomUUID(),
        payload: {
          ...first.payload,
          requestId: randomUUID()
        }
      });
      expect(reused).toMatchObject({
        status: 'key_reused',
        error: {code: 'IDEMPOTENCY_KEY_REUSED'}
      });
    });
  }
);
