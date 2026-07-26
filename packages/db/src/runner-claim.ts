import {randomUUID} from 'node:crypto';
import type {
  CanonicalJson,
  RunnerClaimRecord,
  RunnerClaimStore
} from '@fai-control-plane/domain';
import {and, asc, eq, inArray, or, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const MAX_LEASE_MS = 2 * 60 * 1_000;

export const createPostgresRunnerClaimStore = (
  db: Database
): RunnerClaimStore => ({
  async claim(input, prepare) {
    const claimedAtMs = input.claimedAt.getTime();
    const leaseMs = input.leaseExpiresAt.getTime() - claimedAtMs;
    if (
      !uuidPattern.test(input.workspaceId) ||
      input.runnerId.length < 1 ||
      input.runnerId.length > 128 ||
      input.projectIds.length < 1 ||
      input.projectIds.some((projectId) => !uuidPattern.test(projectId)) ||
      input.repositories.length < 1 ||
      !sha256Pattern.test(input.leaseTokenHash) ||
      !Number.isFinite(claimedAtMs) ||
      leaseMs < 1 ||
      leaseMs > MAX_LEASE_MS
    ) {
      throw new Error('Invalid runner claim authorization or lease.');
    }

    return db.transaction(async (tx) => {
      const repositoryAuthorization = or(
        ...input.repositories.map((repository) =>
          and(
            eq(
              schema.projectTrackerRepositoryScopes.repositoryOwner,
              repository.owner
            ),
            eq(
              schema.projectTrackerRepositoryScopes.repositoryName,
              repository.name
            )
          )
        )
      );
      if (repositoryAuthorization === undefined) {
        throw new Error('Runner repository authorization is empty.');
      }

      const [candidate] = await tx
        .select({
          runId: schema.agentRuns.id,
          packetId: schema.taskPackets.id,
          packetHash: schema.taskPackets.contentHash,
          repositoryOwner:
            schema.projectTrackerRepositoryScopes.repositoryOwner,
          repositoryName:
            schema.projectTrackerRepositoryScopes.repositoryName,
          baseCommit: schema.agentRuns.baseCommit,
          runtimeProfile: schema.taskPackets.runtimeProfile,
          projectId: schema.taskPackets.projectId,
          actorId: schema.actors.id,
          version: schema.agentRuns.version,
          timeboxMinutes: schema.taskPackets.timeboxMinutes,
          goal: schema.taskPackets.goal,
          acceptanceCriteria: schema.taskPackets.acceptanceCriteria,
          inScope: schema.taskPackets.inScope,
          outOfScope: schema.taskPackets.outOfScope,
          relevantLinks: schema.taskPackets.relevantLinks,
          relevantFiles: schema.taskPackets.relevantFiles,
          allowedTools: schema.taskPackets.allowedTools,
          forbiddenSurfaces: schema.taskPackets.forbiddenSurfaces,
          dataPolicy: schema.taskPackets.dataPolicy,
          expectedOutputSchema: schema.taskPackets.expectedOutputSchema
        })
        .from(schema.agentRuns)
        .innerJoin(
          schema.taskPackets,
          eq(schema.taskPackets.id, schema.agentRuns.taskPacketId)
        )
        .innerJoin(
          schema.projects,
          eq(schema.projects.id, schema.taskPackets.projectId)
        )
        .innerJoin(
          schema.agentProfiles,
          eq(schema.agentProfiles.id, schema.agentRuns.agentProfileId)
        )
        .innerJoin(
          schema.actors,
          eq(schema.actors.id, schema.agentProfiles.actorId)
        )
        .innerJoin(
          schema.projectTrackerRepositoryScopes,
          eq(
            schema.projectTrackerRepositoryScopes.projectId,
            schema.taskPackets.projectId
          )
        )
        .where(
          and(
            eq(schema.agentRuns.status, 'queued'),
            eq(schema.projects.workspaceId, input.workspaceId),
            eq(schema.agentProfiles.workspaceId, input.workspaceId),
            eq(schema.actors.workspaceId, input.workspaceId),
            eq(schema.agentProfiles.enabled, true),
            eq(
              schema.agentProfiles.runtimeProfile,
              schema.taskPackets.runtimeProfile
            ),
            inArray(schema.taskPackets.projectId, [...input.projectIds]),
            repositoryAuthorization
          )
        )
        .orderBy(asc(schema.agentRuns.createdAt), asc(schema.agentRuns.id))
        .limit(1)
        .for('update', {of: schema.agentRuns, skipLocked: true});

      if (candidate === undefined) return null;
      const record: RunnerClaimRecord = {
        runId: candidate.runId,
        packetId: candidate.packetId,
        packetHash: candidate.packetHash,
        repository: {
          owner: candidate.repositoryOwner,
          name: candidate.repositoryName
        },
        baseCommit: candidate.baseCommit,
        runtimeProfile: candidate.runtimeProfile,
        timeboxMinutes: candidate.timeboxMinutes,
        promptFields: {
          goal: candidate.goal,
          acceptanceCriteria: candidate.acceptanceCriteria,
          inScope: candidate.inScope,
          outOfScope: candidate.outOfScope,
          relevantLinks: candidate.relevantLinks,
          relevantFiles: candidate.relevantFiles,
          allowedTools: candidate.allowedTools,
          forbiddenSurfaces: candidate.forbiddenSurfaces,
          dataPolicy: candidate.dataPolicy as CanonicalJson,
          expectedOutputSchema:
            candidate.expectedOutputSchema as CanonicalJson
        }
      };
      const prepared = prepare(record);
      const [leased] = await tx
        .update(schema.agentRuns)
        .set({
          status: 'running',
          startedAt: input.claimedAt,
          heartbeatAt: input.claimedAt,
          runnerId: input.runnerId,
          leaseTokenHash: input.leaseTokenHash,
          leaseExpiresAt: input.leaseExpiresAt,
          attempt: sql`${schema.agentRuns.attempt} + 1`,
          version: sql`${schema.agentRuns.version} + 1`,
          updatedAt: input.claimedAt
        })
        .where(
          and(
            eq(schema.agentRuns.id, candidate.runId),
            eq(schema.agentRuns.status, 'queued')
          )
        )
        .returning({
          id: schema.agentRuns.id,
          attempt: schema.agentRuns.attempt,
          version: schema.agentRuns.version
        });
      if (leased === undefined) return null;
      const auditIdentity =
        `runner.claim:${candidate.runId}:attempt:${leased.attempt}`;
      await tx.insert(schema.auditEvents).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        projectId: candidate.projectId,
        actorId: candidate.actorId,
        commandId: auditIdentity,
        actionCategory: 'write',
        action: 'runner.claim',
        targetType: 'agent_run',
        targetId: candidate.runId,
        outcome: 'succeeded',
        expectedVersion: candidate.version,
        resultVersion: leased.version,
        correlationId: auditIdentity,
        occurredAt: input.claimedAt,
        metadata: {}
      });
      return prepared;
    });
  }
});
