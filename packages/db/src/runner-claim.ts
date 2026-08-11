import {createHash, randomUUID} from 'node:crypto';
import type {
  CanonicalJson,
  RunnerClaimRecord,
  RunnerTransportStore
} from '@fai-control-plane/domain';
import {
  canonicalJson,
  CURRENT_POLICY_VERSION,
  runnerActivationEnabled,
  transitionWorkItem,
  validateDeliveryProtocolDefinition,
  validateQaCanonicalReviewEvidence,
  validateQaMachineReviewEvidence,
  type DeliveryProtocol,
  type DeliveryProtocolStage,
  type QaCanonicalArtifactLocator,
  type QaMachineReviewEvidence,
  type QaRetainedArtifactFact
} from '@fai-control-plane/domain';
import {and, asc, desc, eq, inArray, isNull, or, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import {reconcileRiskSignal} from './risk-signal';
import {resolveCurrentExecutionResponsibility} from './work-item-responsibility';

type Database = NodePgDatabase<typeof schema>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const runtimeIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const artifactReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/;
const artifactProviderPattern = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_LEASE_MS = 2 * 60 * 1_000;
const MAX_CLAIM_CANDIDATES = 32;
const MAX_RECEIPT_BYTES = 1_024 * 1_024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type RetainedArtifact = Readonly<{
  kind: 'receipt' | 'summary' | 'path_manifest';
  storageProvider: string;
  storageKey: string;
  contentType: 'application/json';
  sha256: string;
  sizeBytes: number;
}>;

type AutonomousQaCompletion = Readonly<{
  evidence: QaMachineReviewEvidence;
  qa: typeof schema.qaTaskPackets.$inferSelect;
  packet: typeof schema.taskPackets.$inferSelect;
  dispatch: typeof schema.projectExecutionDispatches.$inferSelect;
  item: typeof schema.workItems.$inferSelect;
  journey: typeof schema.deliveryJourneys.$inferSelect;
  protocol: DeliveryProtocol;
  stage: DeliveryProtocolStage;
}>;

type RetainedArtifactRow = RetainedArtifact & Readonly<{
  id: string;
  agentRunId: string;
  redacted: false;
}>;
type CanonicalMachineEvidence = Readonly<{
  outcome: 'passed' | 'failed';
  checks: readonly Readonly<{name: string; status: string; reference: QaCanonicalArtifactLocator}>[];
  artifacts: readonly Readonly<{kind: string; reference: QaCanonicalArtifactLocator}>[];
  failures: readonly Readonly<{summary: string; reference: QaCanonicalArtifactLocator}>[];
  risks: readonly Readonly<{summary: string; reference: QaCanonicalArtifactLocator}>[];
  evidenceReferences: readonly Readonly<{requirement: string; reference: QaCanonicalArtifactLocator}>[];
}>;

const canonicalMachineEvidence = (
  evidence: QaMachineReviewEvidence,
  retained: readonly RetainedArtifactRow[]
): CanonicalMachineEvidence | null => {
  const locator = (fact: QaRetainedArtifactFact): QaCanonicalArtifactLocator | null => {
    const matches = retained.filter((artifact) => artifact.kind === fact.kind &&
      artifact.sha256 === fact.sha256);
    return matches.length === 1 ? {artifactId: matches[0]!.id, sha256: matches[0]!.sha256} : null;
  };
  const checks = evidence.checks.map((entry) => ({...entry, reference: locator(entry.reference)}));
  const artifacts = evidence.artifacts.map((entry) => ({...entry, reference: locator(entry.reference)}));
  const failures = evidence.failures.map((entry) => ({...entry, reference: locator(entry.reference)}));
  const risks = evidence.risks.map((entry) => ({...entry, reference: locator(entry.reference)}));
  const evidenceReferences = evidence.evidenceReferences.map((entry) => ({
    ...entry, reference: locator(entry.reference)
  }));
  if ([...checks, ...artifacts, ...failures, ...risks, ...evidenceReferences]
    .some(({reference}) => reference === null)) return null;
  return {outcome: evidence.outcome,
    checks: checks as CanonicalMachineEvidence['checks'],
    artifacts: artifacts as CanonicalMachineEvidence['artifacts'],
    failures: failures as CanonicalMachineEvidence['failures'],
    risks: risks as CanonicalMachineEvidence['risks'],
    evidenceReferences: evidenceReferences as CanonicalMachineEvidence['evidenceReferences']};
};

const safeArtifactReference = (value: unknown): value is string =>
  typeof value === 'string' && artifactReferencePattern.test(value) &&
  !value.includes('//') && !value.split('/').some((part) => part === '.' || part === '..');

const artifactFromMetadata = (
  value: unknown,
  input: Readonly<{name: string; reference: string}>
): Readonly<{sha256: string; sizeBytes: number}> | undefined => {
  if (
    !isRecord(value) ||
    value.name !== input.name ||
    value.reference !== input.reference ||
    typeof value.sha256 !== 'string' || !sha256Pattern.test(value.sha256) ||
    typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1 || value.sizeBytes > MAX_RECEIPT_BYTES
  ) return undefined;
  return {
    sha256: value.sha256,
    sizeBytes: value.sizeBytes
  };
};

const retainedArtifactsFromMetadata = (
  metadata: CanonicalJson,
  runId: string,
  receiptSha256: string,
  receiptSizeBytes: number
): readonly RetainedArtifact[] | undefined => {
  if (!isRecord(metadata) || !isRecord(metadata.artifactStore)) return undefined;
  const store = metadata.artifactStore;
  const provider = store.provider;
  const reference = store.reference;
  if (
    typeof provider !== 'string' || !artifactProviderPattern.test(provider) ||
    !safeArtifactReference(reference) || reference !== `runs/${runId}` ||
    store.correlationId !== `artifact-run-${runId}`
  ) return undefined;
  const receipt = artifactFromMetadata(metadata.receiptArtifact, {
    name: 'agent-run-receipt.json',
    reference: `${reference}/agent-run-receipt.json`
  });
  const pathManifest = artifactFromMetadata(metadata.pathManifest, {
    name: 'observed-path-manifest.json',
    reference: `${reference}/observed-path-manifest.json`
  });
  if (
    receipt === undefined || pathManifest === undefined ||
    receipt.sha256 !== receiptSha256 || receipt.sizeBytes !== receiptSizeBytes
  ) return undefined;
  const values: RetainedArtifact[] = [
    {
      kind: 'receipt', storageProvider: provider, storageKey: `${reference}/agent-run-receipt.json`,
      contentType: 'application/json', ...receipt
    },
    {
      kind: 'path_manifest', storageProvider: provider,
      storageKey: `${reference}/observed-path-manifest.json`,
      contentType: 'application/json', ...pathManifest
    }
  ];
  if ('summaryArtifact' in metadata) {
    const summary = artifactFromMetadata(metadata.summaryArtifact, {
      name: 'structured-summary.json', reference: `${reference}/structured-summary.json`
    });
    if (summary === undefined) return undefined;
    values.push({
      kind: 'summary', storageProvider: provider, storageKey: `${reference}/structured-summary.json`,
      contentType: 'application/json', ...summary
    });
  }
  return values;
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
  db: Database,
  options: Readonly<{activationEnvironment?: Readonly<Record<string, string | undefined>>}> = {}
): RunnerTransportStore => ({
  async claim(input, prepare) {
    if (!runnerActivationEnabled(options.activationEnvironment)) return null;
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

      const candidates = await tx
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
          workItemId: schema.agentRuns.workItemId,
          actorId: schema.actors.id,
          agentProfileId: schema.agentProfiles.id,
          executionStatus: schema.projectExecutions.status,
          executionVersion: schema.projectExecutions.version,
          selectedWorkItemId: schema.projectExecutions.selectedWorkItemId,
          selectedPlanVersionId: schema.projectExecutions.selectedPlanVersionId,
          selectedWorkItemVersion: schema.projectExecutions.selectedWorkItemVersion,
          selectedProtocolId: schema.projectExecutions.selectedProtocolId,
          selectedProtocolVersion: schema.projectExecutions.selectedProtocolVersion,
          selectedJourneyVersion: schema.projectExecutions.selectedJourneyVersion,
          selectedStageKey: schema.projectExecutions.selectedStageKey,
          selectedResponsibleActorId: schema.projectExecutions.selectedResponsibleActorId,
          selectedAgentProfileId: schema.projectExecutions.selectedAgentProfileId,
          selectedResponsibilityHash: schema.projectExecutions.selectedResponsibilityHash,
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
          expectedOutputSchema: schema.taskPackets.expectedOutputSchema,
          qaTaskPacketId: schema.qaTaskPackets.taskPacketId,
          dispatchRuntimeRegistrationId: schema.projectExecutionDispatches.runtimeRegistrationId,
          dispatchRuntimeRegistrationVersion: schema.projectExecutionDispatches.runtimeRegistrationVersion,
          registrationActorId: schema.runtimeRegistrations.actorId,
          registrationProfileId: schema.runtimeRegistrations.agentProfileId,
          registrationRuntimeKey: schema.runtimeRegistrations.runtimeKey,
          registrationEnabled: schema.runtimeRegistrations.enabled,
          registrationVersion: schema.runtimeRegistrations.version,
          serviceMaxAgeSeconds: schema.runtimeRegistrations.serviceMaxAgeSeconds,
          schedulerMaxAgeSeconds: schema.runtimeRegistrations.schedulerMaxAgeSeconds,
          deliveryMaxAgeSeconds: schema.runtimeRegistrations.deliveryMaxAgeSeconds
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
            schema.projectTrackerRepositoryScopes.id,
            schema.agentRuns.repositoryScopeId
          )
        )
        .innerJoin(schema.projectExecutionDispatches,
          eq(schema.projectExecutionDispatches.agentRunId, schema.agentRuns.id))
        .innerJoin(schema.runtimeRegistrations, and(
          eq(schema.runtimeRegistrations.id, schema.projectExecutionDispatches.runtimeRegistrationId),
          eq(schema.runtimeRegistrations.version, schema.projectExecutionDispatches.runtimeRegistrationVersion)))
        .leftJoin(schema.qaTaskPackets, eq(schema.qaTaskPackets.taskPacketId, schema.taskPackets.id))
        .innerJoin(schema.projectExecutions, and(
          eq(schema.projectExecutions.projectId, schema.taskPackets.projectId),
          eq(schema.projectExecutions.version, schema.projectExecutionDispatches.executionVersion)))
        .where(
          and(
            eq(schema.agentRuns.status, 'queued'),
            eq(schema.projects.workspaceId, input.workspaceId),
            eq(schema.agentProfiles.workspaceId, input.workspaceId),
            eq(schema.actors.workspaceId, input.workspaceId),
            isNull(schema.actors.disabledAt),
            eq(schema.agentProfiles.enabled, true),
            eq(schema.runtimeRegistrations.projectId, schema.taskPackets.projectId),
            eq(schema.runtimeRegistrations.actorId, schema.actors.id),
            eq(schema.runtimeRegistrations.agentProfileId, schema.agentProfiles.id),
            eq(schema.runtimeRegistrations.enabled, true),
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
        .limit(MAX_CLAIM_CANDIDATES)
        .for('update', {of: schema.agentRuns, skipLocked: true});

      let candidate: (typeof candidates)[number] | undefined;
      for (const queued of candidates) {
        const current = await resolveCurrentExecutionResponsibility(tx, {workspaceId: input.workspaceId,
          projectId: queued.projectId, workItemId: queued.workItemId});
        let governedQaClaimable = true;
        if (queued.qaTaskPacketId !== null) {
          const policy = isRecord(queued.dataPolicy) && isRecord(queued.dataPolicy.governedQa)
            ? queued.dataPolicy.governedQa : null;
          governedQaClaimable = queued.runtimeId === 'hermes' && policy !== null &&
            policy.mode === 'autonomous' && policy.runtimeId === queued.runtimeId &&
            policy.runtimeRegistrationId === queued.dispatchRuntimeRegistrationId &&
            policy.runtimeRegistrationVersion === queued.dispatchRuntimeRegistrationVersion &&
            policy.runtimeRegistrationKey === queued.registrationRuntimeKey &&
            policy.claimTransportKind === 'hermes_authenticated_claim_v1' &&
            policy.claimTransportRunnerId === input.runnerId &&
            queued.registrationEnabled && queued.registrationActorId === queued.actorId &&
            queued.registrationProfileId === queued.agentProfileId &&
            queued.registrationVersion === queued.dispatchRuntimeRegistrationVersion;
          if (governedQaClaimable) {
            const observations = await tx.select({
              component: schema.runtimeAvailabilityObservations.component,
              state: schema.runtimeAvailabilityObservations.state,
              observedAt: schema.runtimeAvailabilityObservations.observedAt,
              ttlSeconds: schema.runtimeAvailabilityObservations.ttlSeconds
            }).from(schema.runtimeAvailabilityObservations).where(eq(
              schema.runtimeAvailabilityObservations.runtimeRegistrationId,
              queued.dispatchRuntimeRegistrationId
            )).orderBy(schema.runtimeAvailabilityObservations.component,
              desc(schema.runtimeAvailabilityObservations.observedAt),
              desc(schema.runtimeAvailabilityObservations.id));
            const latest = new Map<string, (typeof observations)[number]>();
            for (const observation of observations) if (!latest.has(observation.component)) {
              latest.set(observation.component, observation);
            }
            const thresholds = new Map<string, number | null>([
              ['service', queued.serviceMaxAgeSeconds],
              ['scheduler', queued.schedulerMaxAgeSeconds],
              ['delivery', queued.deliveryMaxAgeSeconds]
            ]);
            governedQaClaimable = ['service', 'scheduler', 'delivery'].every((component) => {
              const threshold = thresholds.get(component);
              const observation = latest.get(component);
              if (threshold === null || threshold === undefined || observation === undefined ||
                observation.state !== 'available' || observation.ttlSeconds === null) return false;
              const ageMs = input.claimedAt.getTime() - observation.observedAt.getTime();
              return ageMs >= 0 && ageMs <= Math.min(threshold, observation.ttlSeconds) * 1_000;
            });
          }
        }
        if (governedQaClaimable && current !== null && queued.executionStatus === 'running' &&
          queued.selectedWorkItemId === queued.workItemId &&
          queued.selectedPlanVersionId === current.planVersionId &&
          queued.selectedWorkItemVersion === current.workItemVersion &&
          queued.selectedProtocolId === current.protocolId &&
          queued.selectedProtocolVersion === current.protocolVersion &&
          queued.selectedJourneyVersion === current.journeyVersion &&
          queued.selectedStageKey === current.stageKey &&
          queued.selectedResponsibleActorId === current.actor.id &&
          queued.selectedAgentProfileId === queued.agentProfileId &&
          current.actor.agentProfileId === queued.agentProfileId &&
          queued.selectedResponsibilityHash === current.factHash) {
          candidate = queued;
          break;
        }
      }
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
          taskPacketId: schema.agentRuns.taskPacketId,
          projectId: schema.taskPackets.projectId,
          actorId: schema.actors.id,
          agentProfileId: schema.agentProfiles.id,
          profileRuntimeId: schema.agentProfiles.runtimeId,
          profileVersion: schema.agentProfiles.version,
          profileHash: schema.agentProfiles.configHash,
          profileEnabled: schema.agentProfiles.enabled,
          actorDisabledAt: schema.actors.disabledAt,
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
          eq(schema.projectTrackerRepositoryScopes.id, schema.agentRuns.repositoryScopeId)
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
    const retainedArtifacts = retainedArtifactsFromMetadata(
      input.metadata,
      input.runId,
      input.receiptSha256,
      input.receiptSizeBytes
    );
    if (retainedArtifacts === undefined) return {status: 'denied'};
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({
          taskPacketId: schema.agentRuns.taskPacketId,
          projectId: schema.taskPackets.projectId,
          actorId: schema.actors.id,
          agentProfileId: schema.agentProfiles.id,
          profileRuntimeId: schema.agentProfiles.runtimeId,
          profileVersion: schema.agentProfiles.version,
          profileHash: schema.agentProfiles.configHash,
          profileEnabled: schema.agentProfiles.enabled,
          actorDisabledAt: schema.actors.disabledAt,
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
          eq(schema.projectTrackerRepositoryScopes.id, schema.agentRuns.repositoryScopeId)
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
        const [receipt] = await tx.select().from(schema.agentRunReceipts).where(eq(
          schema.agentRunReceipts.agentRunId, input.runId
        )).limit(1);
        return receipt?.runnerId === input.runnerId &&
          receipt.attempt === input.attempt &&
          receipt.completionReplayHash === input.completionReplayHash &&
          receipt.terminal === input.terminal
          ? {
              status: 'replayed',
              terminal: receipt.terminal,
              completedAt: receipt.completedAt
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
      const [qaPacket] = await tx.select({taskPacketId: schema.qaTaskPackets.taskPacketId})
        .from(schema.qaTaskPackets).where(eq(schema.qaTaskPackets.taskPacketId, candidate.taskPacketId))
        .limit(1);
      let qaCompletion: AutonomousQaCompletion | null = null;
      if (qaPacket !== undefined && input.terminal === 'done') {
        const qaMetadata = isRecord(input.metadata) ? input.metadata : null;
        const evidence = qaMetadata === null ? null : validateQaMachineReviewEvidence(qaMetadata.qaResult);
        if (evidence === null || !evidence.ok || candidate.profileRuntimeId !== 'hermes' ||
          !candidate.profileEnabled || candidate.actorDisabledAt !== null ||
          qaMetadata?.runtimeId !== candidate.profileRuntimeId) return {status: 'denied'};
        const [binding] = await tx.select({
          qa: schema.qaTaskPackets,
          packet: schema.taskPackets,
          dispatch: schema.projectExecutionDispatches,
          item: schema.workItems,
          journey: schema.deliveryJourneys,
          protocol: schema.runbooks,
          execution: schema.projectExecutions,
          registration: schema.runtimeRegistrations
        }).from(schema.qaTaskPackets)
          .innerJoin(schema.taskPackets, eq(schema.taskPackets.id, schema.qaTaskPackets.taskPacketId))
          .innerJoin(schema.projectExecutionDispatches, eq(
            schema.projectExecutionDispatches.taskPacketId, schema.qaTaskPackets.taskPacketId))
          .innerJoin(schema.workItems, eq(schema.workItems.id, schema.qaTaskPackets.workItemId))
          .innerJoin(schema.deliveryJourneys, eq(
            schema.deliveryJourneys.workItemId, schema.qaTaskPackets.workItemId))
          .innerJoin(schema.runbooks, and(
            eq(schema.runbooks.id, schema.qaTaskPackets.protocolId),
            eq(schema.runbooks.version, schema.qaTaskPackets.protocolVersion)))
          .innerJoin(schema.projectExecutions, and(
            eq(schema.projectExecutions.projectId, schema.qaTaskPackets.projectId),
            eq(schema.projectExecutions.version, schema.projectExecutionDispatches.executionVersion)))
          .innerJoin(schema.runtimeRegistrations, eq(
            schema.runtimeRegistrations.id, schema.projectExecutionDispatches.runtimeRegistrationId))
          .where(and(eq(schema.qaTaskPackets.taskPacketId, candidate.taskPacketId),
            eq(schema.projectExecutionDispatches.agentRunId, input.runId)))
          .limit(1).for('update');
        if (binding === undefined) return {status: 'denied'};
        const [approver] = await tx.select({
          id: schema.actors.id,
          type: schema.actors.type,
          disabledAt: schema.actors.disabledAt
        }).from(schema.actors).where(and(
          eq(schema.actors.id, binding.packet.approverActorId),
          eq(schema.actors.workspaceId, input.workspaceId)
        )).limit(1).for('update');
        if (approver === undefined || approver.type !== 'human' || approver.disabledAt !== null) {
          return {status: 'denied'};
        }
        const protocolDefinition = validateDeliveryProtocolDefinition(binding.protocol.definition);
        const protocol = protocolDefinition.ok && binding.protocol.revision !== null &&
          binding.protocol.contentHash !== null &&
          (binding.protocol.protocolState === 'published' || binding.protocol.protocolState === 'retired')
          ? {id: binding.protocol.id, projectId: binding.protocol.projectId,
              name: binding.protocol.name, version: binding.protocol.version,
              revision: binding.protocol.revision, state: binding.protocol.protocolState,
              active: binding.protocol.active, definition: protocolDefinition.value,
              contentHash: binding.protocol.contentHash} satisfies DeliveryProtocol
          : null;
        const stage = protocol?.definition.stages.find(({key, enabled}) =>
          enabled && key === binding.qa.stageKey);
        const exactBinding = protocol !== null && stage !== undefined &&
          stage.taskStatus === 'qa' && stage.executionMode === 'autonomous' &&
          binding.qa.projectId === candidate.projectId &&
          binding.qa.planVersionId === binding.item.sourcePlanVersionId &&
          binding.qa.workItemId === binding.item.id && binding.item.status === 'qa' && !binding.item.blocked &&
          binding.qa.workItemVersion === binding.item.version &&
          binding.packet.workItemVersion === binding.item.version &&
          binding.packet.agentProfileSnapshotId === candidate.agentProfileId &&
          binding.packet.agentProfileSnapshotRuntimeId === candidate.profileRuntimeId &&
          binding.packet.agentProfileSnapshotVersion === candidate.profileVersion &&
          binding.packet.agentProfileSnapshotHash === candidate.profileHash &&
          binding.dispatch.runtimeRegistrationId === binding.registration.id &&
          binding.dispatch.runtimeRegistrationVersion === binding.registration.version &&
          binding.registration.enabled && binding.registration.actorId === candidate.actorId &&
          binding.registration.agentProfileId === candidate.agentProfileId &&
          binding.qa.protocolId === binding.journey.protocolId &&
          binding.qa.protocolVersion === binding.journey.protocolVersion &&
          binding.qa.journeyVersion === binding.journey.version &&
          binding.qa.stageKey === binding.journey.stageKey &&
          canonicalJson(binding.qa.responsibility as never) === canonicalJson(stage.responsibility as never) &&
          binding.execution.status === 'running' &&
          binding.execution.selectedWorkItemId === binding.item.id &&
          binding.execution.selectedPlanVersionId === binding.qa.planVersionId &&
          binding.execution.selectedWorkItemVersion === binding.item.version &&
          binding.execution.selectedProtocolId === binding.qa.protocolId &&
          binding.execution.selectedProtocolVersion === binding.qa.protocolVersion &&
          binding.execution.selectedJourneyVersion === binding.qa.journeyVersion &&
          binding.execution.selectedStageKey === binding.qa.stageKey &&
          binding.execution.selectedResponsibleActorId === candidate.actorId &&
          binding.execution.selectedAgentProfileId === candidate.agentProfileId;
        if (!exactBinding || protocol === null || stage === undefined) return {status: 'denied'};
        if (evidence.value.outcome === 'passed') {
          const requirements = evidence.value.evidenceReferences.map(({requirement}) => requirement);
          if (requirements.length !== stage.requiredEvidence.length ||
            new Set(requirements).size !== requirements.length ||
            stage.requiredEvidence.some((requirement) => !requirements.includes(requirement))) {
            return {status: 'denied'};
          }
        }
        qaCompletion = {evidence: evidence.value, qa: binding.qa, packet: binding.packet,
          dispatch: binding.dispatch, item: binding.item, journey: binding.journey, protocol, stage};
      } else if (qaPacket !== undefined && isRecord(input.metadata) && 'qaResult' in input.metadata) {
        return {status: 'denied'};
      }
      const retainedArtifactRows: readonly RetainedArtifactRow[] = retainedArtifacts.map((artifact) => ({
        id: randomUUID(), agentRunId: input.runId, redacted: false, ...artifact
      }));
      const canonicalQaEvidence = qaCompletion === null
        ? null : canonicalMachineEvidence(qaCompletion.evidence, retainedArtifactRows);
      const retainedQaEvidence = canonicalQaEvidence === null
        ? null : validateQaCanonicalReviewEvidence(canonicalQaEvidence);
      if (qaCompletion !== null && (retainedQaEvidence === null || !retainedQaEvidence.ok)) {
        return {status: 'denied'};
      }
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
      await tx.insert(schema.artifacts).values([...retainedArtifactRows]);
      if (qaCompletion !== null && retainedQaEvidence !== null && retainedQaEvidence.ok) {
        const machineEvidence = retainedQaEvidence.value;
        const qaCommandId = `runner.complete:${input.runId}:attempt:${input.attempt}:governed_qa`;
        await tx.insert(schema.qaReviewReceipts).values({
          taskPacketId: qaCompletion.qa.taskPacketId,
          outcome: machineEvidence.outcome,
          checks: machineEvidence.checks,
          artifacts: machineEvidence.artifacts,
          failures: machineEvidence.failures,
          risks: machineEvidence.risks,
          evidenceReferences: machineEvidence.evidenceReferences,
          recordedByActorId: candidate.actorId,
          agentRunId: input.runId,
          agentRunAttempt: input.attempt,
          agentRunReceiptSha256: input.receiptSha256,
          commandId: qaCommandId,
          createdAt: input.at
        });
        if (machineEvidence.outcome === 'passed') {
          const actionHash = createHash('sha256').update(canonicalJson({schemaVersion: 1,
            action: 'qa_review.record.v1', taskPacketId: qaCompletion.qa.taskPacketId,
            agentRunId: input.runId, attempt: input.attempt,
            receiptSha256: input.receiptSha256})).digest('hex');
          await tx.insert(schema.approvalRequests).values({
            id: randomUUID(), projectId: candidate.projectId, agentRunId: input.runId,
            actionCategory: 'write', surface: 'control_plane', environment: 'development',
            subjectHash: qaCompletion.packet.contentHash, policyVersion: CURRENT_POLICY_VERSION,
            executionIdentity: input.runId, actionHash, status: 'pending',
            requestedByActorId: candidate.actorId,
            expiresAt: new Date(input.at.getTime() + 24 * 60 * 60 * 1_000),
            createdAt: input.at, updatedAt: input.at
          });
        } else {
          const priorCandidates = qaCompletion.protocol.definition.stages.filter((candidateStage) =>
            candidateStage.enabled && candidateStage.allowedNextStageKey === qaCompletion.stage.key);
          const prior = priorCandidates.length === 1 ? priorCandidates[0]! : null;
          const moved = prior === null ? null : transitionWorkItem(qaCompletion.item, prior.taskStatus);
          let nextAction: string;
          if (prior !== null && moved !== null && moved.ok) {
            if (moved.value.status !== qaCompletion.item.status) {
              const [workUpdated] = await tx.update(schema.workItems).set({
                status: moved.value.status, version: moved.value.version, updatedAt: input.at
              }).where(and(eq(schema.workItems.id, qaCompletion.item.id),
                eq(schema.workItems.version, qaCompletion.item.version)))
                .returning({id: schema.workItems.id});
              if (workUpdated === undefined) throw new Error('autonomous_qa_failure_work_item_cas');
              await tx.insert(schema.statusTransitions).values({workItemId: qaCompletion.item.id,
                fromStatus: qaCompletion.item.status, toStatus: moved.value.status,
                actorId: candidate.actorId, reason: 'autonomous_qa_failed_returned',
                idempotencyKey: `autonomous_qa_failure:${input.runId}:${input.attempt}`});
            }
            const [journeyUpdated] = await tx.update(schema.deliveryJourneys).set({
              stageKey: prior.key, version: qaCompletion.journey.version + 1, updatedAt: input.at
            }).where(and(eq(schema.deliveryJourneys.workItemId, qaCompletion.item.id),
              eq(schema.deliveryJourneys.version, qaCompletion.journey.version)))
              .returning({workItemId: schema.deliveryJourneys.workItemId});
            if (journeyUpdated === undefined) throw new Error('autonomous_qa_failure_journey_cas');
            nextAction = `Исправьте QA findings и повторно пройдите этап «${prior.name}».`;
          } else {
            const [workUpdated] = await tx.update(schema.workItems).set({blocked: true,
              version: qaCompletion.item.version + 1, updatedAt: input.at})
              .where(and(eq(schema.workItems.id, qaCompletion.item.id),
                eq(schema.workItems.version, qaCompletion.item.version)))
              .returning({id: schema.workItems.id});
            if (workUpdated === undefined) throw new Error('autonomous_qa_failure_block_cas');
            nextAction = 'QA failure has no protocol-allowed return route; manager remediation is required.';
          }
          const [executionUpdated] = await tx.update(schema.projectExecutions).set({status: 'blocked',
            blockReason: 'qa_review_failed', selectedWorkItemId: null, selectedPlanVersionId: null,
            selectedWorkItemVersion: null, selectedProtocolId: null, selectedProtocolVersion: null,
            selectedJourneyVersion: null, selectedStageKey: null, selectedResponsibleActorId: null,
            selectedAgentProfileId: null, selectedResponsibilityHash: null, pausedAt: null,
            version: qaCompletion.dispatch.executionVersion + 1, updatedAt: input.at})
            .where(and(eq(schema.projectExecutions.projectId, candidate.projectId),
              eq(schema.projectExecutions.version, qaCompletion.dispatch.executionVersion),
              eq(schema.projectExecutions.status, 'running')))
            .returning({projectId: schema.projectExecutions.projectId});
          if (executionUpdated === undefined) throw new Error('autonomous_qa_failure_execution_cas');
          await reconcileRiskSignal(tx, {projectId: candidate.projectId,
            workItemId: qaCompletion.item.id,
            deduplicationKey: `governed_qa_failure:${qaCompletion.item.id}`,
            observedAt: input.at, condition: {code: 'governed_qa_failed',
              ruleId: 'governed_qa_failure', ruleVersion: '1', signalClass: 'fact', severity: 'red',
              summary: 'Автономный QA зафиксировал непройденные проверки или риски.',
              details: {failures: machineEvidence.failures, risks: machineEvidence.risks},
              evidenceReferences: [{type: 'qa_task_packet', id: qaCompletion.qa.taskPacketId},
                {type: 'agent_run', id: input.runId}],
              impact: 'Задача не может перейти через QA до устранения структурированных findings.',
              ownerActorId: qaCompletion.packet.approverActorId, nextAction}});
        }
        const qaAudit: typeof schema.auditEvents.$inferInsert = {id: randomUUID(), workspaceId: input.workspaceId,
          projectId: candidate.projectId, actorId: candidate.actorId, commandId: qaCommandId,
          actionCategory: 'write', action: 'qa_review.machine_record.v1', targetType: 'qa_review',
          targetId: qaCompletion.qa.taskPacketId, policyDecision: 'allow', outcome: 'succeeded',
          expectedVersion: qaCompletion.item.version,
          ...(machineEvidence.outcome === 'passed'
            ? {resultVersion: qaCompletion.item.version}
            : {}),
          correlationId: `runner.complete:${input.runId}:attempt:${input.attempt}`,
          occurredAt: input.at, metadata: {}
        };
        await tx.insert(schema.auditEvents).values(qaAudit);
      }
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
