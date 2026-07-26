import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createTaskPacket, type TaskPacketContent} from '@fai-control-plane/domain';
import {
  actors,
  agentProfiles,
  agentRuns,
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
import {eq, inArray} from 'drizzle-orm';
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

    it('leases one eligible run concurrently without exposing secret references', async () => {
      const workspaceId = randomUUID();
      const projectId = randomUUID();
      const actorId = randomUUID();
      const workItemId = randomUUID();
      const eventId = randomUUID();
      const credentialRefId = randomUUID();
      const packetSecretRefId = randomUUID();
      const eligibleProfileId = randomUUID();
      const disabledProfileId = randomUUID();
      const mismatchedProfileId = randomUUID();
      const eligibleRunId = randomUUID();
      const disabledRunId = randomUUID();
      const mismatchedRunId = randomUUID();
      const secretReference = 'file:///customer/webhook-token';

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
          runtimeId: 'local-runner',
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
          id: mismatchedProfileId,
          workspaceId,
          actorId,
          runtimeId: 'mismatched-runner',
          runtimeProfile: 'different-profile'
        }
      ]);

      const packetContent = (goal: string): TaskPacketContent => ({
        projectId,
        workItemId,
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
          runId: mismatchedRunId,
          profileId: mismatchedProfileId,
          goal: 'Mismatched profile',
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
          baseCommit: 'a'.repeat(40),
          idempotencyKey: `runner-claim-${fixture.runId}`,
          createdAt: fixture.createdAt,
          updatedAt: fixture.createdAt
        });
      }

      const service = createRunnerClaimService({
        store: createPostgresRunnerClaimStore(testDb)
      });
      const authorization = {
        workspaceId,
        runnerId: 'operator-workstation',
        projectIds: [projectId],
        repositories: [{owner: 'VF78', name: 'fai-control-plane'}]
      };
      const claims = await Promise.all([
        service.claim(authorization),
        service.claim(authorization)
      ]);
      const envelope = claims.find((claim) => claim !== null);
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      expect(envelope).toMatchObject({
        runId: eligibleRunId,
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
          mismatchedRunId
        ]));
      expect(rows.find((row) => row.id === eligibleRunId)).toMatchObject({
        status: 'running',
        runnerId: 'operator-workstation',
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
        .where(eq(auditEvents.workspaceId, workspaceId));
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
      }]);
    }, 30_000);
  }
);
