import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  CURRENT_POLICY_VERSION,
  DEFAULT_AGENT_INSTRUCTIONS,
  DEFAULT_AGENT_SETTINGS,
  createActorContextIssuer,
  createTaskPacket,
  hashAgentProfileConfiguration,
  type CanonicalCommand,
  type TaskPacketContent,
  type TrustedActorContext,
  type TrustedSystemActorContext,
  type TrustedUserActorContext
} from '@fai-control-plane/domain';
import {
  agentRuns,
  actors,
  agentProfiles,
  actorExternalIdentities,
  approvalRequests,
  auditEvents,
  commandReceipts,
  createDatabase,
  createPostgresUnitOfWork,
  outboxEvents,
  projectMemberships,
  runtimeRegistrations,
  statusTransitions,
  taskPackets,
  trackerBindings,
  workItems
} from '@fai-control-plane/db';
import {dropDatabaseWhenDisconnected} from '../../db/src/integration-test-utils';
import {and, eq, inArray} from 'drizzle-orm';
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
  runtimeActorId: randomUUID(),
  runtimeProfileId: randomUUID(),
  otherRuntimeActorId: randomUUID(),
  otherRuntimeProfileId: randomUUID(),
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
  actor: TrustedActorContext,
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

const issueSystemActor = (actorId: string): TrustedSystemActorContext => {
  const issuer = createActorContextIssuer({users: [], agents: [], systems: [{
    actorId, capabilities: ['write:runtime_observation:development']
  }]});
  if (!issuer.ok) throw new Error('Integration system issuer failed.');
  const actor = issuer.value.issueSystem(actorId);
  if (!actor.ok) throw new Error('Integration system actor failed.');
  return actor.value;
};

const packetContent = (
  workspace: 'primary' | 'other' = 'primary',
  overrides: Partial<TaskPacketContent> = {}
): TaskPacketContent => {
  const other = workspace === 'other';
  const actorId = other ? fixture.otherActorId : fixture.actorId;
  return {
    projectId: other ? fixture.otherProjectId : fixture.projectId,
    workItemId: other ? fixture.otherWorkItemId : fixture.workItemId,
    workItemVersion: other ? 1 : 2,
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
          runtimeActorId: fixture.runtimeActorId,
          runtimeProfileId: fixture.runtimeProfileId,
          workItemId: fixture.workItemId,
          eventId: fixture.eventId,
          label: 'Primary'
        },
        {
          workspaceId: fixture.otherWorkspaceId,
          projectId: fixture.otherProjectId,
          actorId: fixture.otherActorId,
          profileId: fixture.otherProfileId,
          runtimeActorId: fixture.otherRuntimeActorId,
          runtimeProfileId: fixture.otherRuntimeProfileId,
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
        const credentialRefId = randomUUID();
        await testPool.query(
          `INSERT INTO secret_refs (
             id, workspace_id, provider, reference
           ) VALUES ($1, $2, 'test', $3)`,
          [
            credentialRefId,
            entry.workspaceId,
            `test://repository/${entry.projectId}`
          ]
        );
        await testPool.query(
          `INSERT INTO project_tracker_repository_scopes (
             id, project_id, provider, repository_owner, repository_name,
             repository_external_id, credential_ref_id
           ) VALUES ($1, $2, 'test', $3, $4, $5, $6)`,
          [
            randomUUID(),
            entry.projectId,
            'fixture',
            `${entry.label.toLowerCase()}-repository`,
            `test:repository:${entry.projectId}`,
            credentialRefId
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
           ) VALUES ($1, $2, $3, 'codex-cli', 'test')`,
          [
            entry.profileId,
            entry.workspaceId,
            entry.actorId
          ]
        );
        await testPool.query(
          `INSERT INTO actors (
             id, workspace_id, type, role, display_name, auth_mode
           ) VALUES (
             $1, $2, 'agent', 'agent_operator', $3, 'agent'
           )`,
          [entry.runtimeActorId, entry.workspaceId, `${entry.label} runtime agent`]
        );
        await testPool.query(
          `INSERT INTO agent_profiles (
             id, workspace_id, actor_id, runtime_id, runtime_profile
           ) VALUES ($1, $2, $3, 'codex-cli', 'test')`,
          [
            entry.runtimeProfileId,
            entry.workspaceId,
            entry.runtimeActorId
          ]
        );
        await testPool.query(
          `INSERT INTO project_memberships (
             id, project_id, actor_id, roles, active
           ) VALUES ($1, $2, $3, array['agent']::project_membership_role[], true)`,
          [randomUUID(), entry.projectId, entry.runtimeActorId]
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
          confirmedPacketHash: primaryPacket.value.contentHash,
          baseCommit: 'a'.repeat(40)
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
          confirmedPacketHash: otherPacket.value.contentHash,
          baseCommit: 'b'.repeat(40)
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

    it('enforces one active task/repository attempt across packets and retries as a new run', async () => {
      const workItemId = randomUUID();
      await testDb.insert(workItems).values({
        id: workItemId,
        projectId: fixture.projectId,
        title: 'Attempt guard item',
        status: 'ready',
        version: 1
      });
      const firstPacketId = randomUUID();
      const secondPacketId = randomUUID();
      const firstContent = packetContent('primary', {
        workItemId,
        workItemVersion: 1,
        goal: 'First immutable packet'
      });
      const secondContent = packetContent('primary', {
        workItemId,
        workItemVersion: 1,
        goal: 'Second immutable packet'
      });
      const firstPacket = createTaskPacket(firstPacketId, firstContent);
      const secondPacket = createTaskPacket(secondPacketId, secondContent);
      if (!firstPacket.ok || !secondPacket.ok) {
        throw new Error('Attempt guard packets did not initialize.');
      }
      await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'task_packet.create',
        {packetId: firstPacketId, content: firstContent}
      ));
      await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'task_packet.create',
        {packetId: secondPacketId, content: secondContent}
      ));
      const firstRunId = randomUUID();
      const secondRunId = randomUUID();
      const firstQueue = command(
        fixture.workspaceId,
        primaryActor,
        'agent_run.queue',
        {
          agentRunId: firstRunId,
          taskPacketId: firstPacketId,
          agentProfileId: fixture.profileId,
          confirmedPacketHash: firstPacket.value.contentHash,
          baseCommit: 'c'.repeat(40)
        }
      );
      const secondQueue = command(
        fixture.workspaceId,
        primaryActor,
        'agent_run.queue',
        {
          agentRunId: secondRunId,
          taskPacketId: secondPacketId,
          agentProfileId: fixture.profileId,
          confirmedPacketHash: secondPacket.value.contentHash,
          baseCommit: 'd'.repeat(40)
        }
      );

      const queued = await Promise.all([
        service().execute(firstQueue),
        service().execute(secondQueue)
      ]);
      expect(queued.filter((result) =>
        result.status === 'completed' && result.receipt.result.ok
      )).toHaveLength(1);
      expect(queued.filter((result) =>
        receiptErrorCode(result) === 'VERSION_CONFLICT'
      )).toHaveLength(1);
      const [active] = await testDb
        .select({
          id: agentRuns.id,
          taskPacketId: agentRuns.taskPacketId,
          agentProfileId: agentRuns.agentProfileId,
          confirmedPacketHash: agentRuns.confirmedPacketHash,
          baseCommit: agentRuns.baseCommit
        })
        .from(agentRuns)
        .where(eq(agentRuns.workItemId, workItemId));
      if (active === undefined) throw new Error('Active attempt was not persisted.');

      await expect(service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'agent_run.transition',
        {agentRunId: active.id, status: 'failed', expectedVersion: 1}
      ))).resolves.toMatchObject({receipt: {result: {ok: true}}});
      const retryRunId = randomUUID();
      const retry = command(
        fixture.workspaceId,
        primaryActor,
        'agent_run.retry',
        {agentRunId: retryRunId, retryOfAgentRunId: active.id}
      );
      await expect(service().execute(retry)).resolves.toMatchObject({
        receipt: {result: {ok: true}, resultVersion: 1}
      });

      await expect(testDb.select({
        id: agentRuns.id,
        status: agentRuns.status,
        taskPacketId: agentRuns.taskPacketId,
        agentProfileId: agentRuns.agentProfileId,
        confirmedPacketHash: agentRuns.confirmedPacketHash,
        baseCommit: agentRuns.baseCommit,
        retryOfAgentRunId: agentRuns.retryOfAgentRunId
      }).from(agentRuns).where(inArray(agentRuns.id, [active.id, retryRunId])))
        .resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: active.id,
            status: 'failed',
            retryOfAgentRunId: null
          }),
          {
            id: retryRunId,
            status: 'queued',
            taskPacketId: active.taskPacketId,
            agentProfileId: active.agentProfileId,
            confirmedPacketHash: active.confirmedPacketHash,
            baseCommit: active.baseCommit,
            retryOfAgentRunId: active.id
          }
        ]));
      await expect(testDb.select({action: auditEvents.action})
        .from(auditEvents).where(eq(auditEvents.commandId, retry.commandId)))
        .resolves.toEqual([{action: 'agent_run.retry'}]);
      await expect(testDb.select({state: commandReceipts.state})
        .from(commandReceipts).where(eq(commandReceipts.commandId, retry.commandId)))
        .resolves.toEqual([{state: 'completed'}]);
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
          confirmedPacketHash: validPacket.value.contentHash,
          baseCommit: 'a'.repeat(40)
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
        'project_membership.set',
        {
          membershipId: randomUUID(),
          projectId: fixture.projectId,
          subjectActorId: fixture.actorId,
          roles: ['contributor'],
          active: true,
          expectedVersion: null
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
          membershipId: randomUUID()
        }
      });
      expect(reused).toMatchObject({
        status: 'key_reused',
        error: {code: 'IDEMPOTENCY_KEY_REUSED'}
      });
    });

    it('persists scoped membership and external identity commands', async () => {
      const membershipId = randomUUID();
      const identityId = randomUUID();
      const membership = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'project_membership.set',
        {
          membershipId,
          projectId: fixture.projectId,
          subjectActorId: fixture.actorId,
          roles: ['workspace_owner'],
          active: true,
          expectedVersion: null
        }
      ));
      expect(membership).toMatchObject({
        receipt: {result: {ok: true, value: {version: 1}}}
      });

      await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'actor_external_identity.bind',
        {
          identityId,
          subjectActorId: fixture.actorId,
          provider: 'github',
          externalSubject: 'github:user:123',
          active: true,
          expectedVersion: null
        }
      ));
      expect(await testDb.select().from(projectMemberships)
        .where(eq(projectMemberships.id, membershipId)))
        .toMatchObject([{roles: ['workspace_owner'], version: 1}]);
      expect(await testDb.select().from(actorExternalIdentities)
        .where(eq(actorExternalIdentities.id, identityId)))
        .toMatchObject([{provider: 'github', externalSubject: 'github:user:123'}]);
      const crossWorkspace = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'project_membership.set',
        {
          membershipId: randomUUID(),
          projectId: fixture.otherProjectId,
          subjectActorId: fixture.actorId,
          roles: ['project_owner'],
          active: true,
          expectedVersion: null
        }
      ));
      expect(receiptErrorCode(crossWorkspace)).toBe('NOT_FOUND');
      expect(await testDb.select().from(auditEvents)
        .where(eq(auditEvents.targetId, identityId))).toHaveLength(1);
    });

    it('persists isolated runtime registration create, update, disable, CAS, replay, and audit', async () => {
      const registrationId = randomUUID();
      const create = command(
        fixture.workspaceId,
        primaryActor,
        'runtime_registration.create',
        {
          registrationId,
          projectId: fixture.projectId,
          subjectActorId: fixture.runtimeActorId,
          agentProfileId: fixture.runtimeProfileId,
          provider: 'codex',
          runtimeKey: 'workstation:primary',
          enabled: true
        },
        `runtime-registration-${randomUUID()}`
      );

      await expect(service().execute(create)).resolves.toMatchObject({
        status: 'completed',
        receipt: {result: {ok: true, value: {enabled: true, version: 1}}}
      });
      await expect(service().execute(create)).resolves.toMatchObject({
        status: 'replayed',
        receipt: {result: {ok: true, value: {version: 1}}}
      });
      await expect(service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'runtime_registration.update',
        {
          registrationId,
          provider: 'codex',
          runtimeKey: 'workstation:secondary',
          enabled: true,
          expectedVersion: 1
        }
      ))).resolves.toMatchObject({
        receipt: {result: {ok: true, value: {enabled: true, version: 2}}}
      });
      const staleDisable = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'runtime_registration.disable',
        {registrationId, expectedVersion: 1}
      ));
      expect(receiptErrorCode(staleDisable)).toBe('VERSION_CONFLICT');
      await expect(service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'runtime_registration.disable',
        {registrationId, expectedVersion: 2}
      ))).resolves.toMatchObject({
        receipt: {result: {ok: true, value: {enabled: false, version: 3}}}
      });
      await expect(testDb.select().from(runtimeRegistrations)
        .where(eq(runtimeRegistrations.id, registrationId))).resolves.toMatchObject([{
        projectId: fixture.projectId,
        actorId: fixture.runtimeActorId,
        agentProfileId: fixture.runtimeProfileId,
        provider: 'codex',
        runtimeKey: 'workstation:secondary',
        enabled: false,
        version: 3
      }]);

      const crossWorkspace = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'runtime_registration.create',
        {
          registrationId: randomUUID(),
          projectId: fixture.projectId,
          subjectActorId: fixture.otherRuntimeActorId,
          agentProfileId: fixture.otherRuntimeProfileId,
          provider: 'hermes',
          runtimeKey: 'other:runtime',
          enabled: true
        }
      ));
      expect(receiptErrorCode(crossWorkspace)).toBe('NOT_FOUND');

      const nonAgent = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'runtime_registration.create',
        {
          registrationId: randomUUID(),
          projectId: fixture.projectId,
          subjectActorId: fixture.actorId,
          agentProfileId: fixture.profileId,
          provider: 'codex',
          runtimeKey: 'human:profile',
          enabled: true
        }
      ));
      expect(receiptErrorCode(nonAgent)).toBe('NOT_FOUND');
      expect(await testDb.select().from(auditEvents)
        .where(eq(auditEvents.targetId, registrationId))).toHaveLength(4);
    });

    it('atomically replaces two persisted runtime registrations with one receipt and audit', async () => {
      const targetActorId = randomUUID();
      const targetProfileId = randomUUID();
      await testPool.query(
        `INSERT INTO actors (
           id, workspace_id, type, role, display_name, auth_mode
         ) VALUES ($1, $2, 'agent', 'agent_operator', 'Replacement target', 'agent')`,
        [targetActorId, fixture.workspaceId]
      );
      await testPool.query(
        `INSERT INTO agent_profiles (
           id, workspace_id, actor_id, runtime_id, runtime_profile
         ) VALUES ($1, $2, $3, 'replacement-target', 'test')`,
        [targetProfileId, fixture.workspaceId, targetActorId]
      );
      await testPool.query(
        `INSERT INTO project_memberships (
           id, project_id, actor_id, roles, active
         ) VALUES ($1, $2, $3, array['agent']::project_membership_role[], true)`,
        [randomUUID(), fixture.projectId, targetActorId]
      );
      const sourceRegistrationId = randomUUID();
      const targetRegistrationId = randomUUID();
      for (const input of [
        {
          registrationId: sourceRegistrationId,
          subjectActorId: fixture.runtimeActorId,
          agentProfileId: fixture.runtimeProfileId,
          runtimeKey: 'replacement-source',
          enabled: true
        },
        {
          registrationId: targetRegistrationId,
          subjectActorId: targetActorId,
          agentProfileId: targetProfileId,
          runtimeKey: 'replacement-target',
          enabled: false
        }
      ]) {
        await expect(service().execute(command(
          fixture.workspaceId,
          primaryActor,
          'runtime_registration.create',
          {
            ...input,
            projectId: fixture.projectId,
            provider: 'provider_neutral'
          }
        ))).resolves.toMatchObject({receipt: {result: {ok: true}}});
      }
      const replacement = command(
        fixture.workspaceId,
        primaryActor,
        'runtime_registration.replace',
        {
          projectId: fixture.projectId,
          sourceRegistrationId,
          sourceExpectedVersion: 1,
          targetRegistrationId,
          targetExpectedVersion: 1
        }
      );

      await expect(service().execute(replacement)).resolves.toMatchObject({
        status: 'completed',
        receipt: {
          result: {
            ok: true,
            value: {
              source: {id: sourceRegistrationId, enabled: false, version: 2},
              target: {id: targetRegistrationId, enabled: true, version: 2}
            }
          }
        }
      });
      await expect(service().execute(replacement)).resolves.toMatchObject({
        status: 'replayed'
      });
      await expect(testDb.select({
        id: runtimeRegistrations.id,
        provider: runtimeRegistrations.provider,
        runtimeKey: runtimeRegistrations.runtimeKey,
        enabled: runtimeRegistrations.enabled,
        version: runtimeRegistrations.version
      }).from(runtimeRegistrations).where(inArray(runtimeRegistrations.id, [
        sourceRegistrationId,
        targetRegistrationId
      ]))).resolves.toEqual(expect.arrayContaining([
        {
          id: sourceRegistrationId,
          provider: 'provider_neutral',
          runtimeKey: 'replacement-source',
          enabled: false,
          version: 2
        },
        {
          id: targetRegistrationId,
          provider: 'provider_neutral',
          runtimeKey: 'replacement-target',
          enabled: true,
          version: 2
        }
      ]));
      await expect(testDb.select({
        action: auditEvents.action,
        outcome: auditEvents.outcome
      }).from(auditEvents).where(eq(auditEvents.commandId, replacement.commandId)))
        .resolves.toEqual([{
          action: 'runtime_registration.replace',
          outcome: 'succeeded'
        }]);
    });

    it('atomically recovers only an exact expired run lease and preserves its history', async () => {
      const registrationId = randomUUID();
      await expect(service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'runtime_registration.create',
        {
          registrationId,
          projectId: fixture.projectId,
          subjectActorId: fixture.runtimeActorId,
          agentProfileId: fixture.runtimeProfileId,
          provider: 'provider_neutral',
          runtimeKey: 'operator-recovery',
          enabled: true
        }
      ))).resolves.toMatchObject({receipt: {result: {ok: true}}});

      const createRunningRun = async (leaseExpiresAt: Date): Promise<string> => {
        const workItemId = randomUUID();
        await testDb.insert(workItems).values({
          id: workItemId,
          projectId: fixture.projectId,
          title: 'Operator recovery integration',
          status: 'ready',
          version: 1
        });
        const packetId = randomUUID();
        const content = packetContent('primary', {
          workItemId,
          workItemVersion: 1
        });
        const packet = createTaskPacket(packetId, content);
        if (!packet.ok) throw new Error('Recovery packet did not initialize.');
        await service().execute(command(
          fixture.workspaceId,
          primaryActor,
          'task_packet.create',
          {packetId, content}
        ));
        const runId = randomUUID();
        await service().execute(command(
          fixture.workspaceId,
          primaryActor,
          'agent_run.queue',
          {
            agentRunId: runId,
            taskPacketId: packetId,
            agentProfileId: fixture.runtimeProfileId,
            confirmedPacketHash: packet.value.contentHash,
            baseCommit: 'e'.repeat(40)
          }
        ));
        await testDb.update(agentRuns).set({
          status: 'running',
          runnerId: 'integration-runner',
          leaseTokenHash: 'f'.repeat(64),
          leaseExpiresAt,
          heartbeatAt: new Date(leaseExpiresAt.getTime() - 30_000),
          startedAt: new Date(leaseExpiresAt.getTime() - 60_000),
          attempt: 1
        }).where(eq(agentRuns.id, runId));
        return runId;
      };
      const recoveryPayload = (runId: string) => ({
        agentRunId: runId,
        status: 'failed' as const,
        expectedVersion: 1,
        failureCode: 'operator_recovered_expired_lease' as const,
        registrationId,
        expectedRegistrationVersion: 1,
        expectedProjectId: fixture.projectId,
        expectedActorId: fixture.runtimeActorId,
        expectedAgentProfileId: fixture.runtimeProfileId
      });

      const expiredRunId = await createRunningRun(
        new Date(Date.now() - 60_000)
      );
      await expect(service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'agent_run.transition',
        recoveryPayload(expiredRunId)
      ))).resolves.toMatchObject({
        receipt: {
          result: {
            ok: true,
            value: {
              status: 'failed',
              failureCode: 'operator_recovered_expired_lease',
              version: 2
            }
          }
        }
      });
      await expect(testDb.select({
        status: agentRuns.status,
        failureCode: agentRuns.failureCode,
        completedAt: agentRuns.completedAt,
        runnerId: agentRuns.runnerId,
        leaseTokenHash: agentRuns.leaseTokenHash,
        leaseExpiresAt: agentRuns.leaseExpiresAt,
        version: agentRuns.version
      }).from(agentRuns).where(eq(agentRuns.id, expiredRunId)))
        .resolves.toMatchObject([{
          status: 'failed',
          failureCode: 'operator_recovered_expired_lease',
          completedAt: expect.any(Date),
          runnerId: null,
          leaseTokenHash: null,
          leaseExpiresAt: null,
          version: 2
        }]);

      const liveRunId = await createRunningRun(
        new Date(Date.now() + 60_000)
      );
      const liveRecovery = await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'agent_run.transition',
        recoveryPayload(liveRunId)
      ));
      expect(receiptErrorCode(liveRecovery)).toBe('VERSION_CONFLICT');
      await expect(testDb.select({
        status: agentRuns.status,
        failureCode: agentRuns.failureCode,
        leaseExpiresAt: agentRuns.leaseExpiresAt,
        version: agentRuns.version
      }).from(agentRuns).where(eq(agentRuns.id, liveRunId)))
        .resolves.toMatchObject([{
          status: 'running',
          failureCode: null,
          leaseExpiresAt: expect.any(Date),
          version: 1
        }]);
      await expect(testDb.select({
        action: auditEvents.action,
        outcome: auditEvents.outcome,
        reasonCode: auditEvents.reasonCode
      }).from(auditEvents).where(eq(auditEvents.targetId, expiredRunId)))
        .resolves.toEqual(expect.arrayContaining([{
          action: 'agent_run.transition',
          outcome: 'succeeded',
          reasonCode: null
        }]));
    });

    it('soft-retires only the bound agent and preserves dependent records', async () => {
      const agentId = randomUUID();
      const profileId = randomUUID();
      const registrationId = randomUUID();
      const identityId = randomUUID();
      await testDb.insert(actors).values({
        id: agentId,
        workspaceId: fixture.workspaceId,
        type: 'agent',
        role: 'agent_operator',
        displayName: 'Retirement fixture',
        authMode: 'agent'
      });
      await testDb.insert(agentProfiles).values({
        id: profileId,
        workspaceId: fixture.workspaceId,
        actorId: agentId,
        runtimeId: 'codex',
        runtimeProfile: 'test',
        allowedTools: [],
        forbiddenSurfaces: [],
        instructions: 'Test',
        settings: {},
        configHash: 'a'.repeat(64)
      });
      await testDb.insert(runtimeRegistrations).values({
        id: registrationId,
        projectId: fixture.projectId,
        actorId: agentId,
        agentProfileId: profileId,
        provider: 'codex',
        runtimeKey: 'retirement-fixture'
      });
      await testDb.insert(projectMemberships).values({
        id: randomUUID(),
        projectId: fixture.projectId,
        actorId: agentId,
        roles: ['agent'],
        active: true
      });
      await testDb.insert(actorExternalIdentities).values({
        id: identityId,
        actorId: agentId,
        provider: 'test',
        externalSubject: `agent:${agentId}`,
        active: true
      });
      const retire = command(
        fixture.workspaceId,
        primaryActor,
        'actor.retire',
        {agentId}
      );

      await expect(service().execute(retire)).resolves.toMatchObject({
        status: 'completed',
        receipt: {result: {ok: true, value: {id: agentId}}}
      });
      await expect(service().execute(retire)).resolves.toMatchObject({status: 'replayed'});
      expect(receiptErrorCode(await service().execute(command(
        fixture.workspaceId,
        primaryActor,
        'actor.retire',
        {agentId}
      )))).toBe('VERSION_CONFLICT');
      await expect(testDb.select({disabledAt: actors.disabledAt}).from(actors)
        .where(eq(actors.id, agentId))).resolves.toMatchObject([{disabledAt: expect.any(Date)}]);
      await expect(testDb.select({id: agentProfiles.id, enabled: agentProfiles.enabled}).from(agentProfiles)
        .where(eq(agentProfiles.id, profileId))).resolves.toEqual([{id: profileId, enabled: false}]);
      await expect(testDb.select({id: runtimeRegistrations.id, enabled: runtimeRegistrations.enabled}).from(runtimeRegistrations)
        .where(eq(runtimeRegistrations.id, registrationId))).resolves.toEqual([{id: registrationId, enabled: false}]);
      await expect(testDb.select({active: projectMemberships.active}).from(projectMemberships)
        .where(and(eq(projectMemberships.projectId, fixture.projectId), eq(projectMemberships.actorId, agentId))))
        .resolves.toEqual([{active: false}]);
      await expect(testDb.select({id: actorExternalIdentities.id}).from(actorExternalIdentities)
        .where(eq(actorExternalIdentities.id, identityId))).resolves.toEqual([{id: identityId}]);
      await expect(testDb.select({id: auditEvents.id}).from(auditEvents).where(and(
        eq(auditEvents.targetId, agentId),
        eq(auditEvents.action, 'actor.retire'),
        eq(auditEvents.outcome, 'succeeded')
      ))).resolves.toHaveLength(1);
    });

    it('atomically onboards humans and agents, replays, rejects duplicates, and rolls back a late failure', async () => {
      const onboardPayload = (name: string, overrides: Record<string, unknown> = {}) => ({
        actorId: randomUUID(), membershipId: randomUUID(), projectId: fixture.projectId,
        actorType: 'agent' as const, displayName: name, actorRole: 'agent_operator' as const,
        membershipRoles: ['agent' as const],
        agentProfile: {
          profileId: randomUUID(), registrationId: randomUUID(), runtimeId: 'codex',
          runtimeProfile: 'read_safe', runtimeKey: name.toLowerCase().replaceAll(' ', '-'),
          configHash: hashAgentProfileConfiguration({
            runtimeId: 'codex', runtimeProfile: 'read_safe', allowedTools: [], forbiddenSurfaces: [],
            instructions: DEFAULT_AGENT_INSTRUCTIONS, settings: DEFAULT_AGENT_SETTINGS,
            enabled: true, version: 1
          })
        },
        ...overrides
      });
      const payload = onboardPayload(`Onboard ${randomUUID()}`);
      const humanActorId = randomUUID();
      const humanMembershipId = randomUUID();
      await expect(service().execute(command(fixture.workspaceId, primaryActor, 'actor.onboard', {
        actorId: humanActorId, membershipId: humanMembershipId, projectId: fixture.projectId,
        actorType: 'human', displayName: `Human ${randomUUID()}`, actorRole: 'developer',
        membershipRoles: ['contributor'], agentProfile: null
      }))).resolves.toMatchObject({status: 'completed', receipt: {result: {ok: true, value: {profileId: null, registrationId: null}}}});
      await expect(testDb.select({id: actors.id, type: actors.type}).from(actors).where(eq(actors.id, humanActorId)))
        .resolves.toEqual([{id: humanActorId, type: 'human'}]);
      await expect(testDb.select({id: projectMemberships.id}).from(projectMemberships).where(eq(projectMemberships.id, humanMembershipId)))
        .resolves.toEqual([{id: humanMembershipId}]);
      await expect(testDb.select({id: agentProfiles.id}).from(agentProfiles).where(eq(agentProfiles.actorId, humanActorId)))
        .resolves.toEqual([]);
      const first = command(fixture.workspaceId, primaryActor, 'actor.onboard', payload, `onboard-${randomUUID()}`);
      await expect(service().execute(first)).resolves.toMatchObject({status: 'completed', receipt: {result: {ok: true}}});
      await expect(service().execute(first)).resolves.toMatchObject({status: 'replayed'});
      await expect(testDb.select({id: actors.id}).from(actors).where(eq(actors.id, payload.actorId))).resolves.toHaveLength(1);
      await expect(testDb.select({id: projectMemberships.id}).from(projectMemberships).where(eq(projectMemberships.id, payload.membershipId))).resolves.toHaveLength(1);
      await expect(testDb.select({
        id: agentProfiles.id, instructions: agentProfiles.instructions,
        version: agentProfiles.version, configHash: agentProfiles.configHash
      }).from(agentProfiles).where(eq(agentProfiles.id, payload.agentProfile.profileId))).resolves.toEqual([{
        id: payload.agentProfile.profileId,
        instructions: DEFAULT_AGENT_INSTRUCTIONS,
        version: 1,
        configHash: hashAgentProfileConfiguration({
          runtimeId: 'codex', runtimeProfile: 'read_safe', allowedTools: [], forbiddenSurfaces: [],
          instructions: DEFAULT_AGENT_INSTRUCTIONS, settings: DEFAULT_AGENT_SETTINGS,
          enabled: true, version: 1
        })
      }]);
      await expect(testDb.select({id: runtimeRegistrations.id}).from(runtimeRegistrations).where(eq(runtimeRegistrations.id, payload.agentProfile.registrationId))).resolves.toHaveLength(1);

      const duplicate = onboardPayload(payload.displayName);
      expect(receiptErrorCode(await service().execute(command(
        fixture.workspaceId, primaryActor, 'actor.onboard', duplicate
      )))).toBe('VERSION_CONFLICT');

      const rollbackActorId = randomUUID();
      const rollbackMembershipId = randomUUID();
      const rollback = onboardPayload(`Rollback ${randomUUID()}`, {
        actorId: rollbackActorId,
        membershipId: rollbackMembershipId,
        agentProfile: {...onboardPayload('unused').agentProfile, profileId: fixture.profileId}
      });
      await expect(service().execute(command(fixture.workspaceId, primaryActor, 'actor.onboard', rollback)))
        .rejects.toThrow();
      await expect(testDb.select({id: actors.id}).from(actors).where(eq(actors.id, rollbackActorId))).resolves.toEqual([]);
      await expect(testDb.select({id: projectMemberships.id}).from(projectMemberships).where(eq(projectMemberships.id, rollbackMembershipId))).resolves.toEqual([]);
    });
  }
);
