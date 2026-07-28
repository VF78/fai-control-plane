import {randomUUID} from 'node:crypto';
import type {
  CanonicalJson,
  RunnerClaimRecord,
  RunnerTransportStore
} from '@fai-control-plane/domain';
import {and, asc, eq, inArray, or, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const runtimeIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const artifactFilenamePattern = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const MAX_LEASE_MS = 2 * 60 * 1_000;
const MAX_RECEIPT_BYTES = 1_024 * 1_024;
const WORKSTATION_LOCAL_STORAGE_PROVIDER = 'workstation-local';
const RECEIPT_ARTIFACT_FILENAME = 'agent-run-receipt.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const workstationArtifactStorageKey = (
  runnerId: string,
  runId: string,
  filename: string
): string => [
  encodeURIComponent(runnerId),
  runId,
  encodeURIComponent(filename)
].join('/');

const summaryArtifactFromMetadata = (metadata: CanonicalJson):
  | {name: string; sha256: string; sizeBytes: number}
  | undefined => {
  if (!isRecord(metadata)) return undefined;
  const summaryArtifact = metadata.summaryArtifact;
  if (
    !isRecord(summaryArtifact) ||
    typeof summaryArtifact.name !== 'string' ||
    !artifactFilenamePattern.test(summaryArtifact.name) ||
    typeof summaryArtifact.sha256 !== 'string' ||
    !sha256Pattern.test(summaryArtifact.sha256) ||
    typeof summaryArtifact.sizeBytes !== 'number' ||
    !Number.isSafeInteger(summaryArtifact.sizeBytes) ||
    summaryArtifact.sizeBytes < 1 || summaryArtifact.sizeBytes > MAX_RECEIPT_BYTES
  ) return undefined;
  return {
    name: summaryArtifact.name,
    sha256: summaryArtifact.sha256,
    sizeBytes: summaryArtifact.sizeBytes
  };
};

const validAuthorization = (input: {
  workspaceId: string;
  runnerId: string;
  projectIds: readonly string[];
  repositories: readonly {owner: string; name: string}[];
  runtimeIds: readonly string[];
}): boolean =>
  uuidPattern.test(input.workspaceId) &&
  input.runnerId.length >= 1 && input.runnerId.length <= 128 &&
  input.projectIds.length >= 1 &&
  input.projectIds.every((projectId) => uuidPattern.test(projectId)) &&
  input.repositories.length >= 1 &&
  input.runtimeIds.length >= 1 &&
  input.runtimeIds.every((runtimeId) => runtimeIdPattern.test(runtimeId));

const repositoryAuthorizationFor = (
  repositories: readonly {owner: string; name: string}[]
) => or(
  ...repositories.map((repository) =>
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

export const createPostgresRunnerClaimStore = (
  db: Database
): RunnerTransportStore => ({
  async claim(input, prepare) {
    const claimedAtMs = input.claimedAt.getTime();
    const leaseMs = input.leaseExpiresAt.getTime() - claimedAtMs;
    if (
      !validAuthorization(input) ||
      !sha256Pattern.test(input.leaseTokenHash) ||
      !Number.isFinite(claimedAtMs) ||
      leaseMs < 1 ||
      leaseMs > MAX_LEASE_MS
    ) {
      throw new Error('Invalid runner claim authorization or lease.');
    }

    return db.transaction(async (tx) => {
      const repositoryAuthorization = repositoryAuthorizationFor(
        input.repositories
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
          runtimeId: schema.agentProfiles.runtimeId,
          attempt: schema.agentRuns.attempt,
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
            inArray(schema.agentProfiles.runtimeId, [...input.runtimeIds]),
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
        attempt: candidate.attempt + 1,
        packetId: candidate.packetId,
        packetHash: candidate.packetHash,
        repository: {
          owner: candidate.repositoryOwner,
          name: candidate.repositoryName
        },
        baseCommit: candidate.baseCommit,
        runtimeId: candidate.runtimeId,
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
            eq(schema.agentRuns.status, 'queued'),
            eq(schema.agentRuns.attempt, candidate.attempt)
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
  },
  async heartbeat(input) {
    const atMs = input.at.getTime();
    const leaseMs = input.leaseExpiresAt.getTime() - atMs;
    if (
      !validAuthorization(input) ||
      !uuidPattern.test(input.runId) ||
      !sha256Pattern.test(input.leaseTokenHash) ||
      !Number.isSafeInteger(input.attempt) || input.attempt < 1 ||
      !Number.isFinite(atMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS
    ) return {status: 'denied'};
    const repositoryAuthorization = repositoryAuthorizationFor(input.repositories);
    if (repositoryAuthorization === undefined) return {status: 'denied'};
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({
          projectId: schema.taskPackets.projectId,
          actorId: schema.actors.id,
          status: schema.agentRuns.status,
          runnerId: schema.agentRuns.runnerId,
          leaseTokenHash: schema.agentRuns.leaseTokenHash,
          leaseExpiresAt: schema.agentRuns.leaseExpiresAt,
          attempt: schema.agentRuns.attempt,
          version: schema.agentRuns.version
        })
        .from(schema.agentRuns)
        .innerJoin(schema.taskPackets, eq(schema.taskPackets.id, schema.agentRuns.taskPacketId))
        .innerJoin(schema.projects, eq(schema.projects.id, schema.taskPackets.projectId))
        .innerJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.agentRuns.agentProfileId))
        .innerJoin(schema.actors, eq(schema.actors.id, schema.agentProfiles.actorId))
        .innerJoin(
          schema.projectTrackerRepositoryScopes,
          eq(schema.projectTrackerRepositoryScopes.projectId, schema.taskPackets.projectId)
        )
        .where(and(
          eq(schema.agentRuns.id, input.runId),
          eq(schema.projects.workspaceId, input.workspaceId),
          eq(schema.agentProfiles.workspaceId, input.workspaceId),
          eq(schema.actors.workspaceId, input.workspaceId),
          inArray(schema.taskPackets.projectId, [...input.projectIds]),
          repositoryAuthorization
        ))
        .limit(1)
        .for('update', {of: schema.agentRuns});
      if (
        candidate === undefined ||
        candidate.status !== 'running' ||
        candidate.runnerId !== input.runnerId ||
        candidate.attempt !== input.attempt ||
        candidate.leaseTokenHash !== input.leaseTokenHash ||
        candidate.leaseExpiresAt === null ||
        candidate.leaseExpiresAt.getTime() <= atMs
      ) return {status: 'denied'};
      if (candidate.leaseExpiresAt.getTime() >= input.leaseExpiresAt.getTime()) {
        return {status: 'unchanged', leaseExpiresAt: candidate.leaseExpiresAt};
      }
      const [updated] = await tx
        .update(schema.agentRuns)
        .set({
          heartbeatAt: input.at,
          leaseExpiresAt: input.leaseExpiresAt,
          version: sql`${schema.agentRuns.version} + 1`,
          updatedAt: input.at
        })
        .where(and(
          eq(schema.agentRuns.id, input.runId),
          eq(schema.agentRuns.status, 'running'),
          eq(schema.agentRuns.version, candidate.version)
        ))
        .returning({version: schema.agentRuns.version});
      if (updated === undefined) return {status: 'denied'};
      const auditIdentity =
        `runner.heartbeat:${input.runId}:attempt:${input.attempt}:version:${updated.version}`;
      await tx.insert(schema.auditEvents).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        projectId: candidate.projectId,
        actorId: candidate.actorId,
        commandId: auditIdentity,
        actionCategory: 'write',
        action: 'runner.heartbeat',
        targetType: 'agent_run',
        targetId: input.runId,
        outcome: 'succeeded',
        expectedVersion: candidate.version,
        resultVersion: updated.version,
        correlationId: auditIdentity,
        occurredAt: input.at,
        metadata: {}
      });
      return {status: 'extended', leaseExpiresAt: input.leaseExpiresAt};
    });
  },
  async complete(input) {
    const atMs = input.at.getTime();
    if (
      !validAuthorization(input) ||
      !uuidPattern.test(input.runId) ||
      !sha256Pattern.test(input.leaseTokenHash) ||
      !sha256Pattern.test(input.completionReplayHash) ||
      !sha256Pattern.test(input.receiptSha256) ||
      !Number.isSafeInteger(input.attempt) || input.attempt < 1 ||
      !Number.isSafeInteger(input.receiptSizeBytes) ||
      input.receiptSizeBytes < 1 || input.receiptSizeBytes > MAX_RECEIPT_BYTES ||
      !Number.isFinite(atMs)
    ) return {status: 'denied'};
    const repositoryAuthorization = repositoryAuthorizationFor(input.repositories);
    if (repositoryAuthorization === undefined) return {status: 'denied'};
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({
          projectId: schema.taskPackets.projectId,
          actorId: schema.actors.id,
          status: schema.agentRuns.status,
          runnerId: schema.agentRuns.runnerId,
          leaseTokenHash: schema.agentRuns.leaseTokenHash,
          leaseExpiresAt: schema.agentRuns.leaseExpiresAt,
          attempt: schema.agentRuns.attempt,
          version: schema.agentRuns.version,
          receiptRunnerId: schema.agentRunReceipts.runnerId,
          receiptAttempt: schema.agentRunReceipts.attempt,
          receiptTerminal: schema.agentRunReceipts.terminal,
          receiptReplayHash: schema.agentRunReceipts.completionReplayHash,
          receiptCompletedAt: schema.agentRunReceipts.completedAt
        })
        .from(schema.agentRuns)
        .innerJoin(schema.taskPackets, eq(schema.taskPackets.id, schema.agentRuns.taskPacketId))
        .innerJoin(schema.projects, eq(schema.projects.id, schema.taskPackets.projectId))
        .innerJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.agentRuns.agentProfileId))
        .innerJoin(schema.actors, eq(schema.actors.id, schema.agentProfiles.actorId))
        .innerJoin(
          schema.projectTrackerRepositoryScopes,
          eq(schema.projectTrackerRepositoryScopes.projectId, schema.taskPackets.projectId)
        )
        .leftJoin(
          schema.agentRunReceipts,
          eq(schema.agentRunReceipts.agentRunId, schema.agentRuns.id)
        )
        .where(and(
          eq(schema.agentRuns.id, input.runId),
          eq(schema.projects.workspaceId, input.workspaceId),
          eq(schema.agentProfiles.workspaceId, input.workspaceId),
          eq(schema.actors.workspaceId, input.workspaceId),
          inArray(schema.taskPackets.projectId, [...input.projectIds]),
          repositoryAuthorization
        ))
        .limit(1)
        .for('update', {of: schema.agentRuns});
      if (candidate === undefined) return {status: 'denied'};
      if (candidate.status === 'done' || candidate.status === 'failed') {
        return candidate.receiptRunnerId === input.runnerId &&
          candidate.receiptAttempt === input.attempt &&
          candidate.receiptReplayHash === input.completionReplayHash &&
          candidate.receiptTerminal === input.terminal &&
          candidate.receiptCompletedAt !== null
          ? {
              status: 'replayed',
              terminal: candidate.receiptTerminal,
              completedAt: candidate.receiptCompletedAt
            }
          : {status: 'conflict'};
      }
      if (
        candidate.status !== 'running' ||
        candidate.runnerId !== input.runnerId ||
        candidate.attempt !== input.attempt ||
        candidate.leaseTokenHash !== input.leaseTokenHash ||
        candidate.leaseExpiresAt === null ||
        candidate.leaseExpiresAt.getTime() <= atMs
      ) return {status: 'denied'};
      const [updated] = await tx
        .update(schema.agentRuns)
        .set({
          status: input.terminal,
          completedAt: input.at,
          failureCode: input.terminal === 'failed' ? 'runner_failed' : null,
          runnerId: null,
          leaseTokenHash: null,
          leaseExpiresAt: null,
          version: sql`${schema.agentRuns.version} + 1`,
          updatedAt: input.at
        })
        .where(and(
          eq(schema.agentRuns.id, input.runId),
          eq(schema.agentRuns.status, 'running'),
          eq(schema.agentRuns.version, candidate.version)
        ))
        .returning({version: schema.agentRuns.version});
      if (updated === undefined) return {status: 'denied'};
      await tx.insert(schema.agentRunReceipts).values({
        agentRunId: input.runId,
        runnerId: input.runnerId,
        attempt: input.attempt,
        terminal: input.terminal,
        receiptSha256: input.receiptSha256,
        receiptSizeBytes: input.receiptSizeBytes,
        completionReplayHash: input.completionReplayHash,
        metadata: input.metadata as Record<string, unknown>,
        completedAt: input.at
      });
      const summaryArtifact = summaryArtifactFromMetadata(input.metadata);
      await tx.insert(schema.artifacts).values([
        {
          id: randomUUID(),
          agentRunId: input.runId,
          kind: 'receipt',
          storageProvider: WORKSTATION_LOCAL_STORAGE_PROVIDER,
          storageKey: workstationArtifactStorageKey(
            input.runnerId,
            input.runId,
            RECEIPT_ARTIFACT_FILENAME
          ),
          contentType: 'application/json',
          sha256: input.receiptSha256,
          sizeBytes: input.receiptSizeBytes
        },
        ...(summaryArtifact === undefined ? [] : [{
          id: randomUUID(),
          agentRunId: input.runId,
          kind: 'summary',
          storageProvider: WORKSTATION_LOCAL_STORAGE_PROVIDER,
          storageKey: workstationArtifactStorageKey(
            input.runnerId,
            input.runId,
            summaryArtifact.name
          ),
          contentType: 'application/json',
          sha256: summaryArtifact.sha256,
          sizeBytes: summaryArtifact.sizeBytes
        }])
      ]);
      const auditIdentity = `runner.complete:${input.runId}:attempt:${input.attempt}`;
      await tx.insert(schema.auditEvents).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        projectId: candidate.projectId,
        actorId: candidate.actorId,
        commandId: auditIdentity,
        actionCategory: 'write',
        action: 'runner.complete',
        targetType: 'agent_run',
        targetId: input.runId,
        outcome: 'succeeded',
        expectedVersion: candidate.version,
        resultVersion: updated.version,
        correlationId: auditIdentity,
        occurredAt: input.at,
        metadata: {}
      });
      return {status: 'completed', terminal: input.terminal, completedAt: input.at};
    });
  }
});
