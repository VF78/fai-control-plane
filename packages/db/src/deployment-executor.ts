import {createHash, randomUUID} from 'node:crypto';
import {and, asc, eq, inArray, isNotNull, isNull, lte, or, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import type {
  DeploymentExecutorCompletionResult,
  DeploymentExecutorStore
} from '@fai-control-plane/application';
import {
  canonicalJson,
  hashDeploymentReleasePackage,
  isTrustedActorContext,
  validateDeploymentObservation,
  validateDeploymentReleasePackage
} from '@fai-control-plane/domain';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_AUTHORIZATIONS = 32;
const MAX_LEASE_MS = 10 * 60 * 1_000;
const TARGET_LEASE_CONSTRAINT = 'deployment_executor_jobs_one_running_per_target';
const deploymentCapability = (environment: string) => `deploy:runner:${environment}`;
const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validAuthorization = (input: Readonly<{
  workspaceId: string; executorId: string; registrationId: string; systemActorId: string;
  projectIds: readonly string[]; environments: readonly string[];
}>) => UUID.test(input.workspaceId) && UUID.test(input.registrationId) && UUID.test(input.systemActorId) &&
  SAFE_ID.test(input.executorId) && input.projectIds.length > 0 && input.projectIds.length <= MAX_AUTHORIZATIONS &&
  new Set(input.projectIds).size === input.projectIds.length && input.projectIds.every((id) => UUID.test(id)) &&
  input.environments.length > 0 && input.environments.length <= 3 &&
  new Set(input.environments).size === input.environments.length &&
  input.environments.every((value) => ['development', 'staging', 'production'].includes(value));
const outcomeStatus = (outcome: string): 'succeeded' | 'failed' | 'rolled_back' | null =>
  outcome === 'succeeded' || outcome === 'failed' || outcome === 'rolled_back' ? outcome : null;
const isTargetLeaseConflict = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as Readonly<{code?: unknown; constraint?: unknown; cause?: unknown}>;
    if (record.code === '23505' && record.constraint === TARGET_LEASE_CONSTRAINT) return true;
    current = record.cause;
  }
  return false;
};
const canonicalObservationCommand = (input: Parameters<DeploymentExecutorStore['complete']>[0]): boolean => {
  const command = input.observationCommand;
  const observed = validateDeploymentObservation(command.payload.observation);
  if (!exact(command, ['commandId', 'workspaceId', 'correlationId', 'idempotencyKey', 'issuedAt',
    'actor', 'type', 'payload']) || !exact(command.payload, ['deploymentId', 'expectedVersion', 'observation']) ||
    !observed.ok || command.type !== 'deployment.observe_result.v1' ||
    !UUID.test(command.commandId) || !UUID.test(command.workspaceId) || !UUID.test(command.correlationId) ||
    command.workspaceId !== input.workspaceId || !isTrustedActorContext(command.actor) ||
    command.actor.kind !== 'trusted_system' || command.actor.actorType !== 'system' ||
    command.actor.actorId !== input.systemActorId || !UUID.test(command.payload.deploymentId) ||
    !Number.isSafeInteger(command.payload.expectedVersion) || command.payload.expectedVersion < 1 ||
    command.idempotencyKey !==
      `deployment-observe:v1:${command.payload.deploymentId}:${command.payload.expectedVersion}:${input.systemActorId}`) {
    return false;
  }
  try {
    if (new Date(command.issuedAt).toISOString() !== command.issuedAt) return false;
  } catch { return false; }
  return createHash('sha256').update(canonicalJson({workspaceId: command.workspaceId,
    idempotencyKey: command.idempotencyKey, actorId: command.actor.actorId,
    type: command.type, payload: command.payload} as never)).digest('hex') === input.requestHash;
};

const audit = async (tx: Parameters<Parameters<Database['transaction']>[0]>[0], input: Readonly<{
  workspaceId: string; projectId: string; actorId: string; commandId: string; action: string;
  targetId: string; expectedVersion: number; resultVersion: number; at: Date;
}>) => {
  await tx.insert(schema.auditEvents).values({
    id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId,
    actorId: input.actorId, commandId: input.commandId, actionCategory: 'write', action: input.action,
    targetType: 'deployment_executor_job', targetId: input.targetId, policyDecision: 'allow', outcome: 'succeeded',
    expectedVersion: input.expectedVersion, resultVersion: input.resultVersion,
    correlationId: input.commandId, occurredAt: input.at, metadata: {}
  });
};

export const createPostgresDeploymentExecutorStore = (db: Database): DeploymentExecutorStore => ({
  async claim(input, prepare) {
    const claimedAtMs = input.claimedAt.getTime();
    const leaseMs = input.leaseExpiresAt.getTime() - claimedAtMs;
    if (!validAuthorization(input) || !SHA256.test(input.leaseTokenHash) ||
      !Number.isFinite(claimedAtMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) return null;
    try {
      return await db.transaction(async (tx) => {
      const candidates = await tx.select({
        job: schema.deploymentExecutorJobs,
        deployment: schema.deployments,
        registration: schema.deploymentExecutorRegistrations,
        actorType: schema.actors.type,
        actorAuthMode: schema.actors.authMode,
        actorDisabledAt: schema.actors.disabledAt,
        actorCapabilities: schema.actors.capabilities
      }).from(schema.deploymentExecutorJobs)
        .innerJoin(schema.deployments, and(
          eq(schema.deployments.id, schema.deploymentExecutorJobs.deploymentId),
          eq(schema.deployments.workspaceId, schema.deploymentExecutorJobs.workspaceId),
          eq(schema.deployments.projectId, schema.deploymentExecutorJobs.projectId),
          eq(schema.deployments.environment, schema.deploymentExecutorJobs.environment)
        )).innerJoin(schema.deploymentExecutorRegistrations, and(
          eq(schema.deploymentExecutorRegistrations.id, schema.deploymentExecutorJobs.registrationId),
          eq(schema.deploymentExecutorRegistrations.workspaceId, schema.deploymentExecutorJobs.workspaceId),
          eq(schema.deploymentExecutorRegistrations.projectId, schema.deploymentExecutorJobs.projectId),
          eq(schema.deploymentExecutorRegistrations.environment, schema.deploymentExecutorJobs.environment)
        )).innerJoin(schema.actors, and(
          eq(schema.actors.id, schema.deploymentExecutorJobs.systemActorId),
          eq(schema.actors.workspaceId, schema.deploymentExecutorJobs.workspaceId)
        ))
        .where(and(
          eq(schema.deploymentExecutorJobs.workspaceId, input.workspaceId),
          eq(schema.deploymentExecutorJobs.registrationId, input.registrationId),
          eq(schema.deploymentExecutorJobs.systemActorId, input.systemActorId),
          or(eq(schema.deploymentExecutorJobs.status, 'queued'), and(
            eq(schema.deploymentExecutorJobs.status, 'running'),
            lte(schema.deploymentExecutorJobs.leaseExpiresAt, input.claimedAt)
          )),
          inArray(schema.deploymentExecutorJobs.projectId, [...input.projectIds]),
          inArray(schema.deploymentExecutorJobs.environment, [...input.environments]),
          inArray(schema.deployments.environment, [...input.environments]),
          eq(schema.deploymentExecutorJobs.environment, schema.deployments.environment),
          eq(schema.deployments.lifecycleVersion, 2),
          eq(schema.deployments.status, 'approved'),
          eq(schema.deployments.version, schema.deploymentExecutorJobs.deploymentVersion),
          eq(schema.deployments.releasePackageHash, schema.deploymentExecutorJobs.releasePackageHash),
          eq(schema.deployments.deploymentExecutorRegistrationId, schema.deploymentExecutorJobs.registrationId),
          eq(schema.deployments.deploymentExecutorRegistrationVersion,
            schema.deploymentExecutorJobs.registrationVersion),
          eq(schema.deployments.referenceKind, 'commit'),
          isNotNull(schema.deployments.approvedByActorId),
          isNotNull(schema.deployments.approvedAt),
          isNotNull(schema.deployments.releasePackage),
          eq(schema.deploymentExecutorRegistrations.workspaceId, input.workspaceId),
          eq(schema.deploymentExecutorRegistrations.systemActorId, input.systemActorId),
          eq(schema.deploymentExecutorRegistrations.executorKey, input.executorId),
          eq(schema.deploymentExecutorRegistrations.enabled, true),
          eq(schema.deploymentExecutorRegistrations.version, schema.deploymentExecutorJobs.registrationVersion),
          inArray(schema.deploymentExecutorRegistrations.environment, [...input.environments]),
          eq(schema.actors.type, 'system'),
          eq(schema.actors.authMode, 'system'),
          isNull(schema.actors.disabledAt),
          sql`${schema.actors.capabilities}->>('deploy:runner:' || ${schema.deployments.environment}) = 'true'`
        )).orderBy(sql`case when ${schema.deploymentExecutorJobs.status} = 'running' then 0 else 1 end`,
          asc(schema.deploymentExecutorJobs.createdAt), asc(schema.deploymentExecutorJobs.id))
        .limit(8).for('update', {skipLocked: true});
      const candidate = candidates.find(({job, deployment, registration, actorType, actorAuthMode, actorDisabledAt,
        actorCapabilities}) => {
        const releasePackage = validateDeploymentReleasePackage(deployment.releasePackage);
        return deployment.lifecycleVersion === 2 && deployment.status === 'approved' &&
          deployment.version === job.deploymentVersion && deployment.approvedByActorId !== null &&
          deployment.approvedAt !== null && deployment.releasePackageHash !== null && releasePackage.ok &&
          hashDeploymentReleasePackage(releasePackage.value) === deployment.releasePackageHash &&
          job.releasePackageHash === deployment.releasePackageHash && deployment.referenceKind === 'commit' &&
          deployment.revision === `git-commit:${releasePackage.value.sourceCommit}` &&
          registration.projectId === deployment.projectId && registration.environment === deployment.environment &&
          deployment.deploymentExecutorRegistrationId === job.registrationId &&
          deployment.deploymentExecutorRegistrationVersion === job.registrationVersion &&
          registration.id === job.registrationId && registration.version === job.registrationVersion &&
          registration.workspaceId === input.workspaceId && registration.projectId === job.projectId &&
          job.environment === deployment.environment &&
          registration.systemActorId === input.systemActorId && registration.environment === deployment.environment &&
          registration.executorKey === input.executorId && registration.enabled &&
          actorType === 'system' && actorAuthMode === 'system' && actorDisabledAt === null &&
          actorCapabilities[deploymentCapability(deployment.environment)] === true;
      });
      if (candidate === undefined) return null;
      const [approver] = await tx.select({type: schema.actors.type}).from(schema.actors).where(and(
        eq(schema.actors.id, candidate.deployment.approvedByActorId!),
        eq(schema.actors.workspaceId, input.workspaceId)
      )).limit(1);
      if (approver?.type !== 'human') return null;
      const releasePackage = validateDeploymentReleasePackage(candidate.deployment.releasePackage);
      if (!releasePackage.ok) return null;
      const record = {
        jobId: candidate.job.id,
        deploymentId: candidate.deployment.id,
        deploymentVersion: candidate.job.deploymentVersion,
        projectId: candidate.job.projectId,
        environment: candidate.deployment.environment as 'development' | 'staging' | 'production',
        releasePackage: releasePackage.value,
        releasePackageHash: candidate.job.releasePackageHash,
        approvedByActorId: candidate.deployment.approvedByActorId!,
        approvedAt: candidate.deployment.approvedAt!,
        attempt: candidate.job.attempt + 1
      };
      const prepared = prepare(record);
      const [leased] = await tx.update(schema.deploymentExecutorJobs).set({
        status: 'running', executorId: input.executorId, leaseTokenHash: input.leaseTokenHash,
        leaseExpiresAt: input.leaseExpiresAt, heartbeatAt: input.claimedAt, startedAt: input.claimedAt,
        attempt: sql`${schema.deploymentExecutorJobs.attempt} + 1`,
        version: sql`${schema.deploymentExecutorJobs.version} + 1`, updatedAt: input.claimedAt
      }).where(and(eq(schema.deploymentExecutorJobs.id, candidate.job.id),
        eq(schema.deploymentExecutorJobs.status, candidate.job.status),
        ...(candidate.job.status === 'running'
          ? [lte(schema.deploymentExecutorJobs.leaseExpiresAt, input.claimedAt)] : []),
        eq(schema.deploymentExecutorJobs.version, candidate.job.version)))
        .returning({attempt: schema.deploymentExecutorJobs.attempt, version: schema.deploymentExecutorJobs.version});
      if (leased === undefined) return null;
      await audit(tx, {workspaceId: input.workspaceId, projectId: candidate.job.projectId,
        actorId: input.systemActorId, commandId: `deployment-executor.claim:${candidate.job.id}:attempt:${leased.attempt}`,
        action: 'deployment_executor.claim', targetId: candidate.job.id, expectedVersion: candidate.job.version,
        resultVersion: leased.version, at: input.claimedAt});
        return prepared;
      });
    } catch (error) {
      if (isTargetLeaseConflict(error)) return null;
      throw error;
    }
  },
  async heartbeat(input) {
    const atMs = input.at.getTime();
    const leaseMs = input.leaseExpiresAt.getTime() - atMs;
    if (!validAuthorization(input) || !UUID.test(input.jobId) || !SHA256.test(input.leaseTokenHash) ||
      !Number.isSafeInteger(input.attempt) || input.attempt < 1 || !Number.isFinite(atMs) ||
      leaseMs < 1 || leaseMs > MAX_LEASE_MS) return {status: 'denied'};
    return db.transaction(async (tx) => {
      const [binding] = await tx.select({job: schema.deploymentExecutorJobs,
        registrationVersion: schema.deploymentExecutorRegistrations.version,
        registrationEnabled: schema.deploymentExecutorRegistrations.enabled,
        registrationExecutorKey: schema.deploymentExecutorRegistrations.executorKey,
        registrationEnvironment: schema.deploymentExecutorRegistrations.environment,
        actorType: schema.actors.type, actorAuthMode: schema.actors.authMode,
        actorDisabledAt: schema.actors.disabledAt, actorCapabilities: schema.actors.capabilities
      }).from(schema.deploymentExecutorJobs)
        .innerJoin(schema.deploymentExecutorRegistrations, and(
          eq(schema.deploymentExecutorRegistrations.id, schema.deploymentExecutorJobs.registrationId),
          eq(schema.deploymentExecutorRegistrations.workspaceId, schema.deploymentExecutorJobs.workspaceId),
          eq(schema.deploymentExecutorRegistrations.projectId, schema.deploymentExecutorJobs.projectId),
          eq(schema.deploymentExecutorRegistrations.environment, schema.deploymentExecutorJobs.environment)
        )).innerJoin(schema.actors, and(
          eq(schema.actors.id, schema.deploymentExecutorJobs.systemActorId),
          eq(schema.actors.workspaceId, schema.deploymentExecutorJobs.workspaceId)
        ))
        .where(and(
        eq(schema.deploymentExecutorJobs.id, input.jobId), eq(schema.deploymentExecutorJobs.workspaceId, input.workspaceId),
        eq(schema.deploymentExecutorJobs.registrationId, input.registrationId),
        eq(schema.deploymentExecutorJobs.systemActorId, input.systemActorId),
        inArray(schema.deploymentExecutorJobs.projectId, [...input.projectIds]),
        inArray(schema.deploymentExecutorJobs.environment, [...input.environments])
      )).limit(1).for('update');
      if (binding === undefined) return {status: 'denied'};
      const candidate = binding.job;
      if (candidate.status !== 'running' || candidate.executorId !== input.executorId ||
        candidate.attempt !== input.attempt || candidate.leaseTokenHash !== input.leaseTokenHash ||
        candidate.leaseExpiresAt === null || candidate.leaseExpiresAt.getTime() <= atMs ||
        binding.registrationVersion !== candidate.registrationVersion || !binding.registrationEnabled ||
        binding.registrationExecutorKey !== input.executorId ||
        !input.environments.includes(binding.registrationEnvironment as never) || binding.actorType !== 'system' ||
        binding.actorAuthMode !== 'system' || binding.actorDisabledAt !== null ||
        binding.actorCapabilities[deploymentCapability(binding.registrationEnvironment)] !== true) return {status: 'denied'};
      if (candidate.leaseExpiresAt.getTime() >= input.leaseExpiresAt.getTime()) {
        return {status: 'unchanged', leaseExpiresAt: candidate.leaseExpiresAt};
      }
      const [updated] = await tx.update(schema.deploymentExecutorJobs).set({
        heartbeatAt: input.at, leaseExpiresAt: input.leaseExpiresAt,
        version: sql`${schema.deploymentExecutorJobs.version} + 1`, updatedAt: input.at
      }).where(and(eq(schema.deploymentExecutorJobs.id, candidate.id),
        eq(schema.deploymentExecutorJobs.status, 'running'),
        eq(schema.deploymentExecutorJobs.version, candidate.version)))
        .returning({version: schema.deploymentExecutorJobs.version});
      if (updated === undefined) return {status: 'denied'};
      await audit(tx, {workspaceId: input.workspaceId, projectId: candidate.projectId,
        actorId: input.systemActorId,
        commandId: `deployment-executor.heartbeat:${candidate.id}:attempt:${candidate.attempt}:version:${updated.version}`,
        action: 'deployment_executor.heartbeat', targetId: candidate.id, expectedVersion: candidate.version,
        resultVersion: updated.version, at: input.at});
      return {status: 'extended', leaseExpiresAt: input.leaseExpiresAt};
    });
  },
  async complete(input): Promise<DeploymentExecutorCompletionResult> {
    const atMs = input.at.getTime();
    if (!validAuthorization(input) || !UUID.test(input.jobId) || !SHA256.test(input.leaseTokenHash) ||
      !SHA256.test(input.completionReplayHash) || !SHA256.test(input.resultHash) || !SHA256.test(input.requestHash) ||
      !Number.isSafeInteger(input.attempt) || input.attempt < 1 || !Number.isFinite(atMs) ||
      !canonicalObservationCommand(input)) {
      return {status: 'denied'};
    }
    return db.transaction(async (tx) => {
      const [binding] = await tx.select({
        job: schema.deploymentExecutorJobs,
        deployment: schema.deployments,
        registration: schema.deploymentExecutorRegistrations,
        systemActorType: schema.actors.type,
        systemActorAuthMode: schema.actors.authMode,
        systemActorDisabledAt: schema.actors.disabledAt,
        systemActorCapabilities: schema.actors.capabilities
      }).from(schema.deploymentExecutorJobs)
        .innerJoin(schema.deployments, and(
          eq(schema.deployments.id, schema.deploymentExecutorJobs.deploymentId),
          eq(schema.deployments.workspaceId, schema.deploymentExecutorJobs.workspaceId),
          eq(schema.deployments.projectId, schema.deploymentExecutorJobs.projectId),
          eq(schema.deployments.environment, schema.deploymentExecutorJobs.environment)
        )).innerJoin(schema.deploymentExecutorRegistrations, and(
          eq(schema.deploymentExecutorRegistrations.id, schema.deploymentExecutorJobs.registrationId),
          eq(schema.deploymentExecutorRegistrations.workspaceId, schema.deploymentExecutorJobs.workspaceId),
          eq(schema.deploymentExecutorRegistrations.projectId, schema.deploymentExecutorJobs.projectId),
          eq(schema.deploymentExecutorRegistrations.environment, schema.deploymentExecutorJobs.environment)
        )).innerJoin(schema.actors, and(
          eq(schema.actors.id, schema.deploymentExecutorJobs.systemActorId),
          eq(schema.actors.workspaceId, schema.deploymentExecutorJobs.workspaceId)
        ))
        .where(and(eq(schema.deploymentExecutorJobs.id, input.jobId),
          eq(schema.deploymentExecutorJobs.workspaceId, input.workspaceId),
          eq(schema.deploymentExecutorJobs.registrationId, input.registrationId),
          eq(schema.deploymentExecutorJobs.systemActorId, input.systemActorId),
          inArray(schema.deploymentExecutorJobs.projectId, [...input.projectIds]),
          inArray(schema.deploymentExecutorJobs.environment, [...input.environments]),
          inArray(schema.deployments.environment, [...input.environments])
        )).limit(1).for('update');
      if (binding === undefined) return {status: 'denied'};
      const {job, deployment, registration} = binding;
      const observation = validateDeploymentObservation(input.observationCommand.payload.observation);
      const terminalStatus = observation.ok ? outcomeStatus(observation.value.outcome) : null;
      const observationStartedMs = observation.ok ? new Date(observation.value.startedAt).getTime() : Number.NaN;
      const observationCompletedMs = observation.ok ? new Date(observation.value.completedAt).getTime() : Number.NaN;
      const executorAuthorityCurrent = registration.version === job.registrationVersion && registration.enabled &&
        registration.systemActorId === input.systemActorId && registration.executorKey === input.executorId &&
        registration.projectId === deployment.projectId && registration.environment === deployment.environment &&
        job.environment === deployment.environment &&
        binding.systemActorType === 'system' &&
        binding.systemActorAuthMode === 'system' && binding.systemActorDisabledAt === null &&
        binding.systemActorCapabilities[deploymentCapability(deployment.environment)] === true;
      if (['succeeded', 'failed', 'rolled_back'].includes(job.status)) {
        return job.executorId === null && job.leaseTokenHash === null && job.leaseExpiresAt === null &&
          job.attempt === input.attempt && job.completedAt !== null && job.status === terminalStatus &&
          job.deploymentVersion === input.observationCommand.payload.expectedVersion &&
          deployment.id === input.observationCommand.payload.deploymentId &&
          deployment.lifecycleVersion === 2 && deployment.version === job.deploymentVersion + 1 &&
          deployment.releasePackageHash === job.releasePackageHash &&
          deployment.deploymentExecutorRegistrationId === job.registrationId &&
          deployment.deploymentExecutorRegistrationVersion === job.registrationVersion &&
          executorAuthorityCurrent && job.completionReplayHash === input.completionReplayHash &&
          job.resultHash === input.resultHash &&
          observation.ok && job.observationReference === observation.value.reference &&
          deployment.status === 'observed' && deployment.observedResult?.reference === job.observationReference &&
          deployment.observedResult.outcome === observation.value.outcome &&
          deployment.observedByActorId === input.systemActorId &&
          canonicalJson(deployment.smokeChecks as never) === canonicalJson(observation.value.smokeChecks as never) &&
          canonicalJson(deployment.rollbackEvidence as never) === canonicalJson(observation.value.rollback as never) &&
          deployment.startedAt?.toISOString() === observation.value.startedAt &&
          deployment.completedAt?.toISOString() === observation.value.completedAt
          ? {status: 'replayed', outcome: observation.value.outcome, completedAt: job.completedAt!}
          : {status: 'conflict'};
      }
      if (!observation.ok || terminalStatus === null || job.status !== 'running' ||
        job.executorId !== input.executorId || job.attempt !== input.attempt ||
        job.leaseTokenHash !== input.leaseTokenHash || job.leaseExpiresAt === null ||
        job.leaseExpiresAt.getTime() <= atMs || deployment.status !== 'approved' ||
        job.startedAt === null || observationStartedMs < job.startedAt.getTime() ||
        observationCompletedMs > atMs + 5 * 60 * 1_000 ||
        deployment.lifecycleVersion !== 2 || deployment.version !== job.deploymentVersion ||
        deployment.id !== input.observationCommand.payload.deploymentId ||
        job.deploymentVersion !== input.observationCommand.payload.expectedVersion ||
        deployment.releasePackageHash !== job.releasePackageHash ||
        deployment.deploymentExecutorRegistrationId !== job.registrationId ||
        deployment.deploymentExecutorRegistrationVersion !== job.registrationVersion ||
        !executorAuthorityCurrent ||
        input.observationCommand.actor.actorId !== input.systemActorId ||
        input.observationCommand.idempotencyKey !==
          `deployment-observe:v1:${deployment.id}:${job.deploymentVersion}:${input.systemActorId}` ||
        observation.value.reference !==
          `deployment-job:${job.id}:attempt:${job.attempt}:result:${input.resultHash}`) return {status: 'denied'};
      const releasePackage = validateDeploymentReleasePackage(deployment.releasePackage);
      if (!releasePackage.ok || hashDeploymentReleasePackage(releasePackage.value) !== job.releasePackageHash ||
        deployment.revision !== `git-commit:${releasePackage.value.sourceCommit}` || deployment.approvedByActorId === null) {
        return {status: 'denied'};
      }
      const [approver] = await tx.select({type: schema.actors.type}).from(schema.actors).where(and(
        eq(schema.actors.id, deployment.approvedByActorId), eq(schema.actors.workspaceId, input.workspaceId)
      )).limit(1);
      if (approver?.type !== 'human') return {status: 'denied'};
      const [existingReceipt] = await tx.select().from(schema.commandReceipts).where(and(
        eq(schema.commandReceipts.workspaceId, input.workspaceId),
        eq(schema.commandReceipts.idempotencyKey, input.observationCommand.idempotencyKey)
      )).limit(1).for('update');
      if (existingReceipt !== undefined) return {status: 'conflict'};
      const deploymentVersion = deployment.version + 1;
      const deploymentResult = {ok: true as const, value: {deploymentId: deployment.id,
        projectId: deployment.projectId,
        environment: deployment.environment as 'development' | 'staging' | 'production',
        state: 'observed' as const, version: deploymentVersion, nextAction: 'review_observation' as const}};
      const [deploymentUpdated] = await tx.update(schema.deployments).set({
        status: 'observed', observedByActorId: input.systemActorId, observedAt: input.at,
        observedResult: {outcome: observation.value.outcome, reference: observation.value.reference},
        smokeChecks: observation.value.smokeChecks, rollbackEvidence: observation.value.rollback,
        startedAt: new Date(observation.value.startedAt), completedAt: new Date(observation.value.completedAt),
        version: deploymentVersion, updatedAt: input.at
      }).where(and(eq(schema.deployments.id, deployment.id), eq(schema.deployments.status, 'approved'),
        eq(schema.deployments.version, job.deploymentVersion)))
        .returning({version: schema.deployments.version});
      if (deploymentUpdated === undefined) return {status: 'denied'};
      const [jobUpdated] = await tx.update(schema.deploymentExecutorJobs).set({
        status: terminalStatus, executorId: null, leaseTokenHash: null, leaseExpiresAt: null,
        completedAt: new Date(observation.value.completedAt), completionReplayHash: input.completionReplayHash,
        resultHash: input.resultHash, observationReference: observation.value.reference,
        version: sql`${schema.deploymentExecutorJobs.version} + 1`, updatedAt: input.at
      }).where(and(eq(schema.deploymentExecutorJobs.id, job.id),
        eq(schema.deploymentExecutorJobs.status, 'running'), eq(schema.deploymentExecutorJobs.version, job.version)))
        .returning({version: schema.deploymentExecutorJobs.version});
      if (jobUpdated === undefined) throw new Error('deployment_executor_completion_cas');
      await tx.insert(schema.commandReceipts).values({
        workspaceId: input.workspaceId, idempotencyKey: input.observationCommand.idempotencyKey,
        requestHash: input.requestHash, commandId: input.observationCommand.commandId,
        correlationId: input.observationCommand.correlationId, state: 'completed',
        commandType: input.observationCommand.type, aggregateType: 'deployment', aggregateId: deployment.id,
        expectedVersion: job.deploymentVersion, resultVersion: deploymentVersion,
        result: deploymentResult, completedAt: input.at
      });
      await tx.insert(schema.auditEvents).values({
        id: randomUUID(), workspaceId: input.workspaceId, projectId: deployment.projectId,
        actorId: input.systemActorId, commandId: input.observationCommand.commandId,
        actionCategory: 'write', action: input.observationCommand.type, targetType: 'deployment',
        targetId: deployment.id, policyDecision: 'allow', outcome: 'succeeded',
        expectedVersion: job.deploymentVersion, resultVersion: deploymentVersion,
        correlationId: input.observationCommand.correlationId, occurredAt: input.at, metadata: {}
      });
      await audit(tx, {workspaceId: input.workspaceId, projectId: deployment.projectId,
        actorId: input.systemActorId,
        commandId: `deployment-executor.complete:${job.id}:attempt:${job.attempt}:result:${input.resultHash}`,
        action: 'deployment_executor.complete', targetId: job.id, expectedVersion: job.version,
        resultVersion: jobUpdated.version, at: input.at});
      return {status: 'completed', outcome: observation.value.outcome,
        completedAt: new Date(observation.value.completedAt)};
    });
  }
});
