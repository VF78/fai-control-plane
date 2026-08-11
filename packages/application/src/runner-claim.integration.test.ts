import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createTaskPacket, hashDeliveryProtocolDefinition, type TaskPacketContent} from '@fai-control-plane/domain';
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
  deliveryJourneys,
  projectExecutionDispatches,
  projectExecutions,
  projectMemberships,
  projectPlanDrafts,
  projectPlanVersions,
  projectTrackerRepositoryScopes,
  projects,
  runtimeRegistrations,
  runbooks,
  secretRefs,
  taskPackets,
  workItems,
  workspaces
} from '@fai-control-plane/db';
import {dropDatabaseWhenDisconnected} from '../../db/src/integration-test-utils';
import {resolveCurrentExecutionResponsibility} from '../../db/src/work-item-responsibility';
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

    it('skips a retired eligible agent, then claims, heartbeats, and completes the active run', async () => {
      const workspaceId = randomUUID();
      const projectId = randomUUID();
      const actorId = randomUUID();
      const activeAgentId = randomUUID();
      const retiredActorId = randomUUID();
      const workItemId = randomUUID();
      const retiredWorkItemId = randomUUID();
      const disabledWorkItemId = randomUUID();
      const disallowedWorkItemId = randomUUID();
      const eventId = randomUUID();
      const credentialRefId = randomUUID();
      const packetSecretRefId = randomUUID();
      const eligibleProfileId = randomUUID();
      const retiredProfileId = randomUUID();
      const disabledProfileId = randomUUID();
      const disallowedProfileId = randomUUID();
      const eligibleRunId = randomUUID();
      const retiredRunId = randomUUID();
      const disabledRunId = randomUUID();
      const disallowedRunId = randomUUID();
      const eligibleRegistrationId = randomUUID();
      const retiredRegistrationId = randomUUID();
      const disabledRegistrationId = randomUUID();
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
      await testDb.insert(actors).values([
        {
          id: actorId,
          workspaceId,
          type: 'human',
          role: 'workspace_admin',
          displayName: 'Runner approver',
          authMode: 'user'
        },
        {
          id: retiredActorId,
          workspaceId,
          type: 'agent',
          role: 'agent_operator',
          displayName: 'Retired coding agent',
          authMode: 'agent',
          disabledAt: new Date('2026-07-26T09:59:00.000Z')
        },
        {
          id: activeAgentId,
          workspaceId,
          type: 'agent',
          role: 'agent_operator',
          displayName: 'Active coding agent',
          authMode: 'agent'
        }
      ]);
      await testDb.insert(projectMemberships).values({id: randomUUID(), projectId,
        actorId: activeAgentId, roles: ['agent']});
      await testDb.insert(workItems).values([
        {id: workItemId, projectId, title: 'Runner claim', status: 'in_dev'},
        {
          id: retiredWorkItemId,
          projectId,
          title: 'Retired agent claim',
          status: 'ready'
        },
        {
          id: disabledWorkItemId,
          projectId,
          title: 'Disabled runner claim',
          status: 'ready'
        },
        {
          id: disallowedWorkItemId,
          projectId,
          title: 'Disallowed runner claim',
          status: 'ready'
        }
      ]);
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
      const repositoryScopeId = randomUUID();
      await testDb.insert(projectTrackerRepositoryScopes).values({
        id: repositoryScopeId,
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
          actorId: activeAgentId,
          runtimeId: 'coding-runner',
          runtimeProfile: 'codex-safe'
        },
        {
          id: retiredProfileId,
          workspaceId,
          actorId: retiredActorId,
          runtimeId: 'coding-runner',
          runtimeProfile: 'codex-safe'
        },
        {
          id: disabledProfileId,
          workspaceId,
          actorId,
          runtimeId: 'disabled-runner',
          runtimeProfile: 'codex-safe'
        },
        {
          id: disallowedProfileId,
          workspaceId,
          actorId,
          runtimeId: 'pm-qa-bot-runner',
          runtimeProfile: 'codex-safe'
        }
      ]);
      await testDb.insert(runtimeRegistrations).values([
        {
          id: eligibleRegistrationId,
          projectId,
          actorId: activeAgentId,
          agentProfileId: eligibleProfileId,
          provider: 'provider_neutral',
          runtimeKey: 'coding-runner',
          enabled: true
        },
        {
          id: retiredRegistrationId,
          projectId,
          actorId: retiredActorId,
          agentProfileId: retiredProfileId,
          provider: 'provider_neutral',
          runtimeKey: 'retired-coding-runner',
          enabled: true
        },
        {
          id: disabledRegistrationId,
          projectId,
          actorId,
          agentProfileId: disabledProfileId,
          provider: 'provider_neutral',
          runtimeKey: 'disabled-runner',
          enabled: false
        }
      ]);

      const planId = randomUUID();
      const planVersionId = randomUUID();
      const protocolId = randomUUID();
      const planDefinition = {title: 'Runner claim plan', outcomes: [], milestones: [], risks: [],
        tasks: [{key: 'claim', title: 'Runner claim', responsibility: {kind: 'agent_profile' as const,
          agentProfileId: eligibleProfileId}, outcomeKeys: [], milestoneKey: null, dependsOn: [], acceptanceEvidence: []}]};
      await testDb.insert(projectPlanDrafts).values({id: planId, workspaceId, projectId, state: 'approved',
        definition: planDefinition as never, contentHash: '1'.repeat(64), revision: 1, createdByActorId: actorId,
        approvedByActorId: actorId, approvedAt: new Date()});
      await testDb.insert(projectPlanVersions).values({id: planVersionId, workspaceId, projectId,
        planId, version: 1, sourceRevision: 1, definition: planDefinition as never, contentHash: '1'.repeat(64),
        sourceManifest: [], simulation: {} as never, approvedByActorId: actorId, approvedAt: new Date()});
      await testDb.update(workItems).set({sourcePlanVersionId: planVersionId, sourceTaskKey: 'claim',
        responsibility: {kind: 'agent_profile', agentProfileId: eligibleProfileId}, acceptanceEvidence: []})
        .where(eq(workItems.id, workItemId));
      const protocolDefinition = {schemaVersion: 1 as const, stages: [{key: 'development', name: 'Development',
        enabled: true, taskStatus: 'in_dev' as const, responsibility: {kind: 'actor' as const,
          actorId: activeAgentId, actorType: 'agent' as const, agentProfileId: eligibleProfileId},
        executionMode: 'autonomous' as const, entryCriteria: ['Ready'], requiredEvidence: ['Result'],
        allowedNextStageKey: null}]};
      await testDb.insert(runbooks).values({id: protocolId, projectId, name: 'Runner claim', version: 1,
        definition: protocolDefinition, active: true, protocolState: 'published', revision: 1,
        contentHash: hashDeliveryProtocolDefinition(protocolDefinition)});
      await testDb.insert(deliveryJourneys).values({workItemId, protocolId, protocolVersion: 1,
        stageKey: 'development'});

      const packetContent = (
        goal: string,
        packetWorkItemId: string
      ): TaskPacketContent => ({
        projectId,
        workItemId: packetWorkItemId,
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
          runId: retiredRunId,
          profileId: retiredProfileId,
          workItemId: retiredWorkItemId,
          goal: 'Retired eligible agent',
          createdAt: new Date(Date.now() - 4_000)
        },
        {
          packetId: randomUUID(),
          runId: disabledRunId,
          profileId: disabledProfileId,
          workItemId: disabledWorkItemId,
          goal: 'Disabled profile',
          createdAt: new Date(Date.now() - 3_000)
        },
        {
          packetId: randomUUID(),
          runId: disallowedRunId,
          profileId: disallowedProfileId,
          workItemId: disallowedWorkItemId,
          goal: 'Disallowed runtime',
          createdAt: new Date(Date.now() - 2_000)
        },
        {
          packetId: randomUUID(),
          runId: eligibleRunId,
          profileId: eligibleProfileId,
          workItemId,
          goal: 'Eligible profile',
          createdAt: new Date(Date.now() - 1_000)
        }
      ];
      for (const fixture of runFixtures) {
        const packet = createTaskPacket(
          fixture.packetId,
          packetContent(fixture.goal, fixture.workItemId)
        );
        if (!packet.ok) throw new Error('Runner claim packet did not initialize.');
        await testDb.insert(taskPackets).values({
          id: fixture.packetId,
          projectId,
          workItemId: fixture.workItemId,
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
          workItemId: fixture.workItemId,
          repositoryScopeId,
          confirmedPacketHash: packet.value.contentHash,
          baseCommit: 'a'.repeat(40),
          idempotencyKey: `runner-claim-${fixture.runId}`,
          createdAt: fixture.createdAt,
          updatedAt: fixture.createdAt
        });
      }
      const eligibleFixture = runFixtures.find(({runId}) => runId === eligibleRunId)!;
      const currentResponsibility = await resolveCurrentExecutionResponsibility(testDb, {
        workspaceId, projectId, workItemId});
      if (currentResponsibility === null) throw new Error('current responsibility fixture missing');
      await testDb.insert(projectExecutions).values({projectId, status: 'running', version: 1, startedAt: new Date(),
        selectedWorkItemId: workItemId, selectedPlanVersionId: planVersionId, selectedWorkItemVersion: 1,
        selectedProtocolId: protocolId, selectedProtocolVersion: 1, selectedJourneyVersion: 1,
        selectedStageKey: 'development', selectedResponsibleActorId: activeAgentId,
        selectedAgentProfileId: eligibleProfileId,
        selectedResponsibilityHash: currentResponsibility.factHash});
      await testDb.insert(projectExecutionDispatches).values({workspaceId, projectId, executionVersion: 1,
        selectionHash: '2'.repeat(64), taskPacketId: eligibleFixture.packetId, agentRunId: eligibleRunId,
        runtimeRegistrationId: eligibleRegistrationId, runtimeRegistrationVersion: 1,
        requestedByActorId: actorId});

      let now = new Date('2026-07-26T10:00:00.000Z');
      const service = createRunnerClaimService({
        store: createPostgresRunnerClaimStore(testDb, {activationEnvironment: {
          RUNNER_ENABLED: 'true', LOCAL_RUNNER_TRANSPORT_ENABLED: 'true'
        }}),
        clock: {now: () => now}
      });
      const authorization = {
        workspaceId,
        runnerId,
        projectIds: [projectId],
        repositories: [{owner: 'VF78', name: 'fai-control-plane'}],
        runtimeIds: ['coding-runner', 'disabled-runner']
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
        runtimeId: 'coding-runner',
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
        activeAgentId,
        eligibleProfileId,
        eligibleRegistrationId,
        retiredProfileId,
        retiredRegistrationId,
        disabledRegistrationId
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
          retiredRunId,
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
      expect(rows.find((row) => row.id === retiredRunId)).toMatchObject({
        status: 'queued',
        runnerId: null,
        attempt: 0,
        version: 1
      });
      expect(
        rows.find((row) => row.id === eligibleRunId)?.leaseTokenHash
      ).not.toBe(envelope?.leaseToken);
      await testDb.update(actors)
        .set({disabledAt: new Date('2026-07-26T10:00:00.500Z')})
        .where(eq(actors.id, activeAgentId));
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
        cost: {state: 'unknown' as const, reason: 'runtime_usage_not_available' as const},
        usage: {state: 'unknown' as const, reason: 'runtime_usage_not_available' as const},
        artifactStore: {
          provider: 'workstation-local',
          reference: `runs/${eligibleRunId}`,
          correlationId: `artifact-run-${eligibleRunId}`
        },
        receiptArtifact: {
          name: 'agent-run-receipt.json',
          reference: `runs/${eligibleRunId}/agent-run-receipt.json`,
          sha256: 'b'.repeat(64),
          sizeBytes: 512
        },
        pathManifest: {
          name: 'observed-path-manifest.json',
          reference: `runs/${eligibleRunId}/observed-path-manifest.json`,
          sha256: 'e'.repeat(64),
          sizeBytes: 256
        },
        summaryArtifact: {
          name: 'structured-summary.json',
          reference: `runs/${eligibleRunId}/structured-summary.json`,
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
          kind: 'path_manifest',
          storageProvider: completionPayload.artifactStore.provider,
          storageKey: completionPayload.pathManifest.reference,
          contentType: 'application/json',
          sha256: completionPayload.pathManifest.sha256,
          sizeBytes: completionPayload.pathManifest.sizeBytes
        },
        {
          kind: 'receipt',
          storageProvider: completionPayload.artifactStore.provider,
          storageKey: completionPayload.receiptArtifact.reference,
          contentType: 'application/json',
          sha256: completionPayload.receiptSha256,
          sizeBytes: completionPayload.receiptSizeBytes
        },
        {
          kind: 'summary',
          storageProvider: completionPayload.artifactStore.provider,
          storageKey: completionPayload.summaryArtifact!.reference,
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
        actorId: activeAgentId,
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
        actorId: activeAgentId,
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
        actorId: activeAgentId,
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

    it('skips the stale oldest queued run and claims the next eligible run', async () => {
      const workspaceId = randomUUID();
      const approverActorId = randomUUID();
      const agentActorId = randomUUID();
      const agentProfileId = randomUUID();
      const credentialRefId = randomUUID();
      await testDb.insert(workspaces).values({id: workspaceId, name: 'Runner scan workspace',
        slug: `runner-scan-${randomUUID()}`});
      await testDb.insert(actors).values([
        {id: approverActorId, workspaceId, type: 'human', role: 'workspace_admin',
          displayName: 'Runner scan approver', authMode: 'user'},
        {id: agentActorId, workspaceId, type: 'agent', role: 'agent_operator',
          displayName: 'Runner scan agent', authMode: 'agent'}
      ]);
      await testDb.insert(agentProfiles).values({id: agentProfileId, workspaceId, actorId: agentActorId,
        runtimeId: 'coding-runner', runtimeProfile: 'codex-safe'});
      await testDb.insert(secretRefs).values({id: credentialRefId, workspaceId, provider: 'file',
        reference: 'file:///runner-scan-credential', scope: ['repository:read']});

      const seedQueuedRun = async (input: Readonly<{createdAt: Date; stale: boolean}>) => {
        const projectId = randomUUID();
        const workItemId = randomUUID();
        const planId = randomUUID();
        const planVersionId = randomUUID();
        const protocolId = randomUUID();
        const registrationId = randomUUID();
        const repositoryScopeId = randomUUID();
        const eventId = randomUUID();
        const packetId = randomUUID();
        const runId = randomUUID();
        await testDb.insert(projects).values({id: projectId, workspaceId, name: 'Runner scan project',
          slug: `runner-scan-project-${randomUUID()}`});
        const membershipId = randomUUID();
        await testDb.insert(projectMemberships).values({id: membershipId, projectId,
          actorId: agentActorId, roles: ['agent']});
        await testDb.insert(runtimeRegistrations).values({id: registrationId, projectId,
          actorId: agentActorId, agentProfileId, provider: 'provider_neutral',
          runtimeKey: `runner-scan-${runId}`, enabled: true});
        await testDb.insert(projectTrackerRepositoryScopes).values({id: repositoryScopeId, projectId,
          provider: 'github', repositoryOwner: 'VF78', repositoryName: 'fai-control-plane',
          repositoryExternalId: `runner-scan-${runId}`, credentialRefId});
        const planDefinition = {title: 'Runner scan plan', outcomes: [], milestones: [], risks: [],
          tasks: [{key: 'claim', title: 'Runner scan', responsibility: {kind: 'agent_profile' as const,
            agentProfileId}, outcomeKeys: [], milestoneKey: null, dependsOn: [], acceptanceEvidence: []}]};
        await testDb.insert(projectPlanDrafts).values({id: planId, workspaceId, projectId,
          state: 'approved', definition: planDefinition as never, contentHash: '3'.repeat(64), revision: 1,
          createdByActorId: approverActorId, approvedByActorId: approverActorId, approvedAt: new Date()});
        await testDb.insert(projectPlanVersions).values({id: planVersionId, workspaceId, projectId,
          planId, version: 1, sourceRevision: 1, definition: planDefinition as never,
          contentHash: '3'.repeat(64), sourceManifest: [], simulation: {} as never,
          approvedByActorId: approverActorId, approvedAt: new Date()});
        await testDb.insert(workItems).values({id: workItemId, projectId, title: 'Runner scan',
          status: 'in_dev', sourcePlanVersionId: planVersionId, sourceTaskKey: 'claim',
          responsibility: {kind: 'agent_profile', agentProfileId}, acceptanceEvidence: []});
        const protocolDefinition = {schemaVersion: 1 as const, stages: [{key: 'development',
          name: 'Development', enabled: true, taskStatus: 'in_dev' as const,
          responsibility: {kind: 'actor' as const, actorId: agentActorId, actorType: 'agent' as const,
            agentProfileId}, executionMode: 'autonomous' as const, entryCriteria: ['Ready'],
          requiredEvidence: ['Result'], allowedNextStageKey: null}]};
        await testDb.insert(runbooks).values({id: protocolId, projectId, name: 'Runner scan', version: 1,
          definition: protocolDefinition, active: true, protocolState: 'published', revision: 1,
          contentHash: hashDeliveryProtocolDefinition(protocolDefinition)});
        await testDb.insert(deliveryJourneys).values({workItemId, protocolId, protocolVersion: 1,
          stageKey: 'development'});
        await testDb.insert(canonicalEvents).values({id: eventId, workspaceId, projectId,
          eventType: 'test.seed', aggregateType: 'work_item', aggregateId: workItemId,
          deduplicationKey: `runner-scan-${runId}`, payload: {}, occurredAt: input.createdAt});
        const packet = createTaskPacket(packetId, {projectId, workItemId, workItemVersion: 1,
          goal: 'Runner scan', acceptanceCriteria: ['Claim once'], inScope: ['packages/application/**'],
          outOfScope: ['deployment'], relevantLinks: [], relevantFiles: [], allowedTools: ['pnpm test'],
          forbiddenSurfaces: ['production'], dataPolicy: {classification: 'internal'}, timeboxMinutes: 15,
          expectedOutputSchema: {type: 'object'}, reviewerActorId: approverActorId,
          approverActorId, runtimeProfile: 'codex-safe', authMode: 'agent',
          secretsRef: null,
          createdFromEventId: eventId, createdByActorId: approverActorId});
        if (!packet.ok) throw new Error('Runner scan packet did not initialize.');
        await testDb.insert(taskPackets).values({id: packetId, projectId, workItemId, workItemVersion: 1,
          goal: packet.value.content.goal, acceptanceCriteria: [...packet.value.content.acceptanceCriteria],
          inScope: [...packet.value.content.inScope], outOfScope: [...packet.value.content.outOfScope],
          relevantLinks: [], relevantFiles: [], allowedTools: [...packet.value.content.allowedTools],
          forbiddenSurfaces: [...packet.value.content.forbiddenSurfaces],
          dataPolicy: packet.value.content.dataPolicy as Record<string, unknown>, timeboxMinutes: 15,
          expectedOutputSchema: packet.value.content.expectedOutputSchema as Record<string, unknown>,
          reviewerActorId: approverActorId, approverActorId, runtimeProfile: 'codex-safe', authMode: 'agent',
          createdFromEventId: eventId, contentHash: packet.value.contentHash,
          createdByActorId: approverActorId, createdAt: input.createdAt});
        await testDb.insert(agentRuns).values({id: runId, taskPacketId: packetId, agentProfileId,
          workItemId, repositoryScopeId, confirmedPacketHash: packet.value.contentHash,
          baseCommit: 'a'.repeat(40), idempotencyKey: `runner-scan-${runId}`,
          createdAt: input.createdAt, updatedAt: input.createdAt});
        const current = await resolveCurrentExecutionResponsibility(testDb, {workspaceId, projectId, workItemId});
        if (current === null) throw new Error('Runner scan responsibility did not resolve.');
        await testDb.insert(projectExecutions).values({projectId, status: 'running', version: 1,
          startedAt: input.createdAt, selectedWorkItemId: workItemId, selectedPlanVersionId: planVersionId,
          selectedWorkItemVersion: 1, selectedProtocolId: protocolId, selectedProtocolVersion: 1,
          selectedJourneyVersion: 1, selectedStageKey: 'development',
          selectedResponsibleActorId: agentActorId, selectedAgentProfileId: agentProfileId,
          selectedResponsibilityHash: current.factHash});
        await testDb.insert(projectExecutionDispatches).values({workspaceId, projectId, executionVersion: 1,
          selectionHash: '4'.repeat(64), taskPacketId: packetId, agentRunId: runId,
          runtimeRegistrationId: registrationId, runtimeRegistrationVersion: 1,
          requestedByActorId: approverActorId});
        if (input.stale) await testDb.update(projectMemberships).set({active: false, version: 2})
          .where(eq(projectMemberships.id, membershipId));
        return {projectId, runId};
      };

      const stale = await seedQueuedRun({createdAt: new Date('2026-07-26T09:59:58.000Z'), stale: true});
      const eligible = await seedQueuedRun({createdAt: new Date('2026-07-26T09:59:59.000Z'), stale: false});
      const service = createRunnerClaimService({store: createPostgresRunnerClaimStore(testDb,
        {activationEnvironment: {RUNNER_ENABLED: 'true', LOCAL_RUNNER_TRANSPORT_ENABLED: 'true'}}),
      clock: {now: () => new Date('2026-07-26T10:00:00.000Z')}});
      const claimed = await service.claim({workspaceId, runnerId: 'operator-workstation',
        projectIds: [stale.projectId, eligible.projectId], repositories: [{owner: 'VF78',
          name: 'fai-control-plane'}], runtimeIds: ['coding-runner']});
      expect(claimed).toMatchObject({runId: eligible.runId, attempt: 1});
      expect(await testDb.select({id: agentRuns.id, status: agentRuns.status, attempt: agentRuns.attempt,
        runnerId: agentRuns.runnerId}).from(agentRuns).where(inArray(agentRuns.id, [stale.runId, eligible.runId])))
        .toEqual(expect.arrayContaining([
          {id: stale.runId, status: 'queued', attempt: 0, runnerId: null},
          {id: eligible.runId, status: 'running', attempt: 1, runnerId: 'operator-workstation'}
        ]));
    }, 30_000);
  }
);
