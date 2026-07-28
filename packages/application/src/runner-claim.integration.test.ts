import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createTaskPacket, type TaskPacketContent} from '@fai-control-plane/domain';
import {
  actors,
  agentProfiles,
  agentRunReceipts,
  agentRuns,
  artifacts,
  auditEvents,
  canonicalEvents,
  createDatabase,
  createPostgresRunnerClaimStore,
  projectTrackerRepositoryScopes,
  projects,
  secretRefs,
  taskPackets,
  workItems,
  workspaces
} from '@fai-control-plane/db';
import {dropDatabaseWhenDisconnected} from '../../db/src/integration-test-utils';
import {asc, eq, inArray} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createRunnerClaimService} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for runner claim integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_runner_claim_test_${randomUUID().replaceAll('-', '')}`;

let adminPool: Pool;
let testPool: Pool;
let testDb: ReturnType<typeof createDatabase>['db'];

describePostgres(
  databaseUrl === undefined
    ? 'runner claim integration (skipped: DATABASE_URL is absent)'
    : 'runner claim integration',
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

    it('claims, heartbeats, and completes one eligible run without exposing secret references', async () => {
      const workspaceId = randomUUID();
      const projectId = randomUUID();
      const actorId = randomUUID();
      const workItemId = randomUUID();
      const eventId = randomUUID();
      const credentialRefId = randomUUID();
      const packetSecretRefId = randomUUID();
      const eligibleProfileId = randomUUID();
      const disabledProfileId = randomUUID();
      const disallowedProfileId = randomUUID();
      const eligibleRunId = randomUUID();
      const disabledRunId = randomUUID();
      const disallowedRunId = randomUUID();
      const secretReference = 'file:///customer/webhook-token';
      const runnerId = 'operator-workstation';

      await testDb.insert(workspaces).values({
        id: workspaceId,
        name: 'Runner claim workspace',
        slug: `runner-${randomUUID()}`
      });
      await testDb.insert(projects).values({
        id: projectId,
        workspaceId,
        name: 'Runner claim project',
        slug: `runner-project-${randomUUID()}`
      });
      await testDb.insert(actors).values({
        id: actorId,
        workspaceId,
        type: 'human',
        role: 'workspace_admin',
        displayName: 'Runner approver',
        authMode: 'user'
      });
      await testDb.insert(workItems).values({
        id: workItemId,
        projectId,
        title: 'Runner claim',
        status: 'ready'
      });
      await testDb.insert(canonicalEvents).values({
        id: eventId,
        workspaceId,
        projectId,
        eventType: 'test.seed',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        deduplicationKey: `runner-claim-${randomUUID()}`,
        payload: {},
        occurredAt: new Date()
      });
      await testDb.insert(secretRefs).values([
        {
          id: credentialRefId,
          workspaceId,
          provider: 'file',
          reference: 'file:///github-app-credential',
          scope: ['repository:read']
        },
        {
          id: packetSecretRefId,
          workspaceId,
          provider: 'file',
          reference: secretReference,
          scope: ['task:read']
        }
      ]);
      await testDb.insert(projectTrackerRepositoryScopes).values({
        projectId,
        provider: 'github',
        repositoryOwner: 'VF78',
        repositoryName: 'fai-control-plane',
        repositoryExternalId: 'repository-1',
        credentialRefId
      });
      await testDb.insert(agentProfiles).values([
        {
          id: eligibleProfileId,
          workspaceId,
          actorId,
          runtimeId: 'coding-runner',
          runtimeProfile: 'codex-safe'
        },
        {
          id: disabledProfileId,
          workspaceId,
          actorId,
          runtimeId: 'disabled-runner',
          runtimeProfile: 'codex-safe',
          enabled: false
        },
        {
          id: disallowedProfileId,
          workspaceId,
          actorId,
          runtimeId: 'pm-qa-bot-runner',
          runtimeProfile: 'codex-safe'
        }
      ]);

      const packetContent = (goal: string): TaskPacketContent => ({
        projectId,
        workItemId,
        workItemVersion: 1,
        goal,
        acceptanceCriteria: ['Only one claim succeeds'],
        inScope: ['packages/application/**'],
        outOfScope: ['deployment'],
        relevantLinks: ['https://github.com/VF78/fai-control-plane'],
        relevantFiles: ['packages/application/src/index.ts'],
        allowedTools: ['pnpm typecheck'],
        forbiddenSurfaces: ['production'],
        dataPolicy: {classification: 'internal'},
        timeboxMinutes: 15,
        expectedOutputSchema: {type: 'object'},
        reviewerActorId: actorId,
        approverActorId: actorId,
        runtimeProfile: 'codex-safe',
        authMode: 'agent',
        secretsRef: {
          provider: 'file',
          reference: secretReference,
          scope: ['task:read']
        },
        createdFromEventId: eventId,
        createdByActorId: actorId
      });
      const runFixtures = [
        {
          packetId: randomUUID(),
          runId: disabledRunId,
          profileId: disabledProfileId,
          goal: 'Disabled profile',
          createdAt: new Date(Date.now() - 3_000)
        },
        {
          packetId: randomUUID(),
          runId: disallowedRunId,
          profileId: disallowedProfileId,
          goal: 'Disallowed runtime',
          createdAt: new Date(Date.now() - 2_000)
        },
        {
          packetId: randomUUID(),
          runId: eligibleRunId,
          profileId: eligibleProfileId,
          goal: 'Eligible profile',
          createdAt: new Date(Date.now() - 1_000)
        }
      ];
      for (const fixture of runFixtures) {
        const packet = createTaskPacket(
          fixture.packetId,
          packetContent(fixture.goal)
        );
        if (!packet.ok) throw new Error('Runner claim packet did not initialize.');
        await testDb.insert(taskPackets).values({
          id: fixture.packetId,
          projectId,
          workItemId,
          workItemVersion: packet.value.content.workItemVersion,
          goal: packet.value.content.goal,
          acceptanceCriteria: [...packet.value.content.acceptanceCriteria],
          inScope: [...packet.value.content.inScope],
          outOfScope: [...packet.value.content.outOfScope],
          relevantLinks: [...packet.value.content.relevantLinks],
          relevantFiles: [...packet.value.content.relevantFiles],
          allowedTools: [...packet.value.content.allowedTools],
          forbiddenSurfaces: [...packet.value.content.forbiddenSurfaces],
          dataPolicy: packet.value.content.dataPolicy as Record<string, unknown>,
          timeboxMinutes: packet.value.content.timeboxMinutes,
          expectedOutputSchema:
            packet.value.content.expectedOutputSchema as Record<string, unknown>,
          reviewerActorId: actorId,
          approverActorId: actorId,
          runtimeProfile: packet.value.content.runtimeProfile,
          authMode: packet.value.content.authMode,
          secretRefId: packetSecretRefId,
          createdFromEventId: eventId,
          contentHash: packet.value.contentHash,
          createdByActorId: actorId,
          createdAt: fixture.createdAt
        });
        await testDb.insert(agentRuns).values({
          id: fixture.runId,
          taskPacketId: fixture.packetId,
          agentProfileId: fixture.profileId,
          confirmedPacketHash: packet.value.contentHash,
          baseCommit: 'a'.repeat(40),
          idempotencyKey: `runner-claim-${fixture.runId}`,
          createdAt: fixture.createdAt,
          updatedAt: fixture.createdAt
        });
      }

      let now = new Date('2026-07-26T10:00:00.000Z');
      const service = createRunnerClaimService({
        store: createPostgresRunnerClaimStore(testDb),
        clock: {now: () => now}
      });
      const authorization = {
        workspaceId,
        runnerId,
        projectIds: [projectId],
        repositories: [{owner: 'VF78', name: 'fai-control-plane'}],
        runtimeIds: ['coding-runner']
      };
      const claims = await Promise.all([
        service.claim(authorization),
        service.claim(authorization)
      ]);
      const envelope = claims.find((claim) => claim !== null);
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      expect(envelope).toMatchObject({
        runId: eligibleRunId,
        attempt: 1,
        repository: {owner: 'VF78', name: 'fai-control-plane'},
        baseCommit: 'a'.repeat(40),
        runtimeProfile: 'codex-safe',
        timeboxMinutes: 15
      });
      expect(await service.claim(authorization)).toBeNull();
      const serializedEnvelope = JSON.stringify(envelope);
      for (const excluded of [
        secretReference,
        packetSecretRefId,
        credentialRefId,
        workspaceId,
        projectId,
        workItemId,
        eligibleProfileId
      ]) {
        expect(serializedEnvelope).not.toContain(excluded);
      }

      const rows = await testDb
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          runnerId: agentRuns.runnerId,
          leaseTokenHash: agentRuns.leaseTokenHash,
          attempt: agentRuns.attempt,
          version: agentRuns.version
        })
        .from(agentRuns)
        .where(inArray(agentRuns.id, [
          eligibleRunId,
          disabledRunId,
          disallowedRunId
        ]));
      expect(rows.find((row) => row.id === eligibleRunId)).toMatchObject({
        status: 'running',
        runnerId,
        leaseTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        attempt: 1,
        version: 2
      });
      expect(rows.filter((row) => row.id !== eligibleRunId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({status: 'queued', attempt: 0, version: 1}),
          expect.objectContaining({status: 'queued', attempt: 0, version: 1})
        ])
      );
      expect(
        rows.find((row) => row.id === eligibleRunId)?.leaseTokenHash
      ).not.toBe(envelope?.leaseToken);
      now = new Date('2026-07-26T10:00:01.000Z');
      const heartbeat = await service.heartbeat({
        authorization,
        runId: eligibleRunId,
        attempt: 1,
        leaseToken: envelope!.leaseToken
      });
      expect(heartbeat).toEqual({leaseExpiresAt: '2026-07-26T10:02:01.000Z'});
      expect(await service.heartbeat({
        authorization,
        runId: eligibleRunId,
        attempt: 1,
        leaseToken: envelope!.leaseToken
      })).toEqual(heartbeat);
      const completionPayload = {
        runId: eligibleRunId,
        attempt: 1,
        terminal: 'done' as const,
        receiptSha256: 'b'.repeat(64),
        receiptSizeBytes: 512,
        finalStatus: 'succeeded' as const,
        runtimeId: 'codex-cli',
        runtimeProfile: 'write_scoped' as const,
        durationMs: 60_000,
        cost: {state: 'unknown' as const, reason: 'codex_cli_usage_not_available' as const},
        usage: {state: 'unknown' as const, reason: 'codex_cli_usage_not_available' as const},
        summaryArtifact: {
          name: 'codex-summary.json',
          sha256: 'c'.repeat(64),
          sizeBytes: 128
        },
        changedFiles: ['packages/application/src/index.ts'],
        checks: [{name: 'application typecheck', status: 'passed' as const}],
        riskCount: 0,
        nextAction: 'review_receipt' as const,
        branch: `fai/run/${eligibleRunId}`,
        worktreeRef: `worktrees/${eligibleRunId}`,
        artifactRef: `receipts/${eligibleRunId}/agent-run-receipt.json`
      };
      now = new Date('2026-07-26T10:00:02.000Z');
      const completion = await service.complete({
        authorization,
        payload: completionPayload,
        leaseToken: envelope!.leaseToken
      });
      expect(completion).toEqual({
        terminal: 'done',
        completedAt: '2026-07-26T10:00:02.000Z'
      });
      expect(await service.complete({
        authorization,
        payload: completionPayload,
        leaseToken: envelope!.leaseToken
      })).toEqual(completion);
      expect(await service.complete({
        authorization,
        payload: {...completionPayload, receiptSha256: 'd'.repeat(64)},
        leaseToken: envelope!.leaseToken
      })).toBeNull();
      const [completedRun] = await testDb
        .select({
          status: agentRuns.status,
          runnerId: agentRuns.runnerId,
          leaseTokenHash: agentRuns.leaseTokenHash,
          leaseExpiresAt: agentRuns.leaseExpiresAt,
          version: agentRuns.version
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, eligibleRunId));
      expect(completedRun).toEqual({
        status: 'done',
        runnerId: null,
        leaseTokenHash: null,
        leaseExpiresAt: null,
        version: 4
      });
      const [receipt] = await testDb
        .select({
          receiptSha256: agentRunReceipts.receiptSha256,
          receiptSizeBytes: agentRunReceipts.receiptSizeBytes,
          metadata: agentRunReceipts.metadata
        })
        .from(agentRunReceipts)
        .where(eq(agentRunReceipts.agentRunId, eligibleRunId));
      expect(receipt).toEqual({
        receiptSha256: completionPayload.receiptSha256,
        receiptSizeBytes: completionPayload.receiptSizeBytes,
        metadata: completionPayload
      });
      expect(await testDb
        .select({
          kind: artifacts.kind,
          storageProvider: artifacts.storageProvider,
          storageKey: artifacts.storageKey,
          contentType: artifacts.contentType,
          sha256: artifacts.sha256,
          sizeBytes: artifacts.sizeBytes
        })
        .from(artifacts)
        .where(eq(artifacts.agentRunId, eligibleRunId))
        .orderBy(asc(artifacts.kind))).toEqual([
        {
          kind: 'receipt',
          storageProvider: 'workstation-local',
          storageKey: `${runnerId}/${eligibleRunId}/agent-run-receipt.json`,
          contentType: 'application/json',
          sha256: completionPayload.receiptSha256,
          sizeBytes: completionPayload.receiptSizeBytes
        },
        {
          kind: 'summary',
          storageProvider: 'workstation-local',
          storageKey: `${runnerId}/${eligibleRunId}/codex-summary.json`,
          contentType: 'application/json',
          sha256: completionPayload.summaryArtifact!.sha256,
          sizeBytes: completionPayload.summaryArtifact!.sizeBytes
        }
      ]);
      const auditRows = await testDb
        .select({
          workspaceId: auditEvents.workspaceId,
          projectId: auditEvents.projectId,
          actorId: auditEvents.actorId,
          commandId: auditEvents.commandId,
          action: auditEvents.action,
          targetType: auditEvents.targetType,
          targetId: auditEvents.targetId,
          outcome: auditEvents.outcome,
          expectedVersion: auditEvents.expectedVersion,
          resultVersion: auditEvents.resultVersion,
          correlationId: auditEvents.correlationId,
          metadata: auditEvents.metadata
        })
        .from(auditEvents)
        .where(eq(auditEvents.workspaceId, workspaceId))
        .orderBy(asc(auditEvents.occurredAt));
      expect(auditRows).toEqual([{
        workspaceId,
        projectId,
        actorId,
        commandId: `runner.claim:${eligibleRunId}:attempt:1`,
        action: 'runner.claim',
        targetType: 'agent_run',
        targetId: eligibleRunId,
        outcome: 'succeeded',
        expectedVersion: 1,
        resultVersion: 2,
        correlationId: `runner.claim:${eligibleRunId}:attempt:1`,
        metadata: {}
      }, {
        workspaceId,
        projectId,
        actorId,
        commandId: `runner.heartbeat:${eligibleRunId}:attempt:1:version:3`,
        action: 'runner.heartbeat',
        targetType: 'agent_run',
        targetId: eligibleRunId,
        outcome: 'succeeded',
        expectedVersion: 2,
        resultVersion: 3,
        correlationId: `runner.heartbeat:${eligibleRunId}:attempt:1:version:3`,
        metadata: {}
      }, {
        workspaceId,
        projectId,
        actorId,
        commandId: `runner.complete:${eligibleRunId}:attempt:1`,
        action: 'runner.complete',
        targetType: 'agent_run',
        targetId: eligibleRunId,
        outcome: 'succeeded',
        expectedVersion: 3,
        resultVersion: 4,
        correlationId: `runner.complete:${eligibleRunId}:attempt:1`,
        metadata: {}
      }]);
    }, 30_000);
  }
);
