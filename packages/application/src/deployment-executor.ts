import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {
  canonicalJson,
  deploymentEnvironments,
  hashDeploymentReleasePackage,
  isTrustedActorContext,
  validateDeploymentObservation,
  validateDeploymentReleasePackage,
  type CanonicalJson,
  type DeploymentEnvironment,
  type DeploymentObservation,
  type DeploymentReleasePackage,
  type DeploymentRollbackEvidence,
  type DeploymentSmokeCheck,
  type TrustedActorContext
} from '@fai-control-plane/domain';
import {
  DEPLOYMENT_OBSERVE_RESULT_COMMAND,
  hashDeploymentEvidenceCommand,
  validateDeploymentEvidenceCommand,
  type ObserveDeploymentResultCommand
} from './release-evidence.ts';

export type DeploymentExecutorAuthorization = Readonly<{
  workspaceId: string;
  executorId: string;
  registrationId: string;
  projectIds: readonly string[];
  environments: readonly DeploymentEnvironment[];
  actor: TrustedActorContext;
}>;

export type DeploymentExecutorClaimRecord = Readonly<{
  jobId: string;
  deploymentId: string;
  deploymentVersion: number;
  projectId: string;
  environment: DeploymentEnvironment;
  releasePackage: DeploymentReleasePackage;
  releasePackageHash: string;
  approvedByActorId: string;
  approvedAt: Date;
  attempt: number;
}>;

type DeploymentExecutorStoreAuthorization = Readonly<{
  workspaceId: string;
  executorId: string;
  registrationId: string;
  systemActorId: string;
  projectIds: readonly string[];
  environments: readonly DeploymentEnvironment[];
}>;

export type DeploymentExecutorClaimLeaseInput = DeploymentExecutorStoreAuthorization & Readonly<{
  leaseTokenHash: string;
  claimedAt: Date;
  leaseExpiresAt: Date;
}>;
export type DeploymentExecutorHeartbeatInput = DeploymentExecutorStoreAuthorization & Readonly<{
  jobId: string;
  attempt: number;
  leaseTokenHash: string;
  at: Date;
  leaseExpiresAt: Date;
}>;
export type DeploymentExecutorCompletionInput = DeploymentExecutorStoreAuthorization & Readonly<{
  jobId: string;
  attempt: number;
  leaseTokenHash: string;
  completionReplayHash: string;
  resultHash: string;
  observationCommand: ObserveDeploymentResultCommand;
  requestHash: string;
  at: Date;
}>;
export type DeploymentExecutorHeartbeatResult = Readonly<{
  status: 'extended' | 'unchanged' | 'denied';
  leaseExpiresAt?: Date;
}>;
export type DeploymentExecutorCompletionResult = Readonly<{
  status: 'completed' | 'replayed' | 'denied' | 'conflict';
  outcome?: DeploymentObservation['outcome'];
  completedAt?: Date;
}>;

export interface DeploymentExecutorStore {
  claim<T>(input: DeploymentExecutorClaimLeaseInput,
    prepare: (record: DeploymentExecutorClaimRecord) => T): Promise<T | null>;
  heartbeat(input: DeploymentExecutorHeartbeatInput): Promise<DeploymentExecutorHeartbeatResult>;
  complete(input: DeploymentExecutorCompletionInput): Promise<DeploymentExecutorCompletionResult>;
}

export type DeploymentExecutorClaimEnvelope = Readonly<{
  schemaVersion: 1;
  jobId: string;
  deploymentId: string;
  deploymentVersion: number;
  projectId: string;
  environment: DeploymentEnvironment;
  releasePackage: DeploymentReleasePackage;
  releasePackageHash: string;
  approvedByActorId: string;
  approvedAt: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
}>;
export type DeploymentExecutorHeartbeatPayload = Readonly<{jobId: string; attempt: number}>;
export type DeploymentExecutorCompletionPayload = Readonly<{
  jobId: string;
  deploymentId: string;
  deploymentVersion: number;
  attempt: number;
  result: Readonly<{
    outcome: DeploymentObservation['outcome'];
    startedAt: string;
    completedAt: string;
    smokeChecks: readonly DeploymentSmokeCheck[];
    rollback: DeploymentRollbackEvidence;
  }>;
}>;
export type DeploymentExecutorHeartbeatResponse = Readonly<{leaseExpiresAt: string}>;
export type DeploymentExecutorCompletionResponse = Readonly<{
  outcome: DeploymentObservation['outcome'];
  completedAt: string;
}>;
export interface DeploymentExecutorService {
  claim(authorization: DeploymentExecutorAuthorization): Promise<DeploymentExecutorClaimEnvelope | null>;
  heartbeat(input: Readonly<{authorization: DeploymentExecutorAuthorization;
    payload: DeploymentExecutorHeartbeatPayload; leaseToken: string}>): Promise<DeploymentExecutorHeartbeatResponse | null>;
  complete(input: Readonly<{authorization: DeploymentExecutorAuthorization;
    payload: DeploymentExecutorCompletionPayload; leaseToken: string}>): Promise<DeploymentExecutorCompletionResponse | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_AUTHORIZATIONS = 32;
const LEASE_DURATION_MS = 2 * 60 * 1_000;
const deploymentCapability = (environment: DeploymentEnvironment) => `deploy:runner:${environment}` as const;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

const validAuthorization = (value: DeploymentExecutorAuthorization): boolean =>
  UUID.test(value.workspaceId) && UUID.test(value.registrationId) && SAFE_ID.test(value.executorId) &&
  isTrustedActorContext(value.actor) && value.actor.kind === 'trusted_system' && value.actor.actorType === 'system' &&
  value.projectIds.length > 0 && value.projectIds.length <= MAX_AUTHORIZATIONS &&
  new Set(value.projectIds).size === value.projectIds.length && value.projectIds.every((id) => UUID.test(id)) &&
  value.environments.length > 0 && value.environments.length <= deploymentEnvironments.length &&
  new Set(value.environments).size === value.environments.length &&
  value.environments.every((environment) => deploymentEnvironments.includes(environment) &&
    value.actor.capabilities.includes(deploymentCapability(environment)));

export const parseDeploymentExecutorHeartbeatPayload = (
  value: unknown
): DeploymentExecutorHeartbeatPayload | null => record(value) && exact(value, ['jobId', 'attempt']) &&
  typeof value.jobId === 'string' && UUID.test(value.jobId) && positive(value.attempt)
  ? {jobId: value.jobId, attempt: value.attempt as number} : null;

export const parseDeploymentExecutorCompletionPayload = (
  value: unknown
): DeploymentExecutorCompletionPayload | null => {
  if (!record(value) || !exact(value, ['jobId', 'deploymentId', 'deploymentVersion', 'attempt', 'result']) ||
    typeof value.jobId !== 'string' || !UUID.test(value.jobId) || typeof value.deploymentId !== 'string' ||
    !UUID.test(value.deploymentId) || !positive(value.deploymentVersion) || !positive(value.attempt) ||
    !record(value.result) || !exact(value.result, ['outcome', 'startedAt', 'completedAt', 'smokeChecks', 'rollback'])) return null;
  const candidate = validateDeploymentObservation({
    ...value.result,
    reference: `deployment-job:${value.jobId}:payload-validation`
  });
  if (!candidate.ok) return null;
  return {
    jobId: value.jobId,
    deploymentId: value.deploymentId,
    deploymentVersion: value.deploymentVersion as number,
    attempt: value.attempt as number,
    result: {
      outcome: candidate.value.outcome,
      startedAt: candidate.value.startedAt,
      completedAt: candidate.value.completedAt,
      smokeChecks: candidate.value.smokeChecks,
      rollback: candidate.value.rollback
    }
  };
};

export const createDeploymentExecutorService = (input: Readonly<{
  store: DeploymentExecutorStore;
  now?: () => Date;
  nextId?: () => string;
  tokenGenerator?: () => string;
}>): DeploymentExecutorService => {
  const now = input.now ?? (() => new Date());
  const nextId = input.nextId ?? randomUUID;
  const tokenGenerator = input.tokenGenerator ?? (() => randomBytes(32).toString('base64url'));
  const storeAuthorization = (authorization: DeploymentExecutorAuthorization): DeploymentExecutorStoreAuthorization => ({
    workspaceId: authorization.workspaceId,
    executorId: authorization.executorId,
    registrationId: authorization.registrationId,
    systemActorId: authorization.actor.actorId,
    projectIds: authorization.projectIds,
    environments: authorization.environments
  });
  return {
    async claim(authorization) {
      if (!validAuthorization(authorization)) return null;
      const claimedAt = now();
      const leaseExpiresAt = new Date(claimedAt.getTime() + LEASE_DURATION_MS);
      const leaseToken = tokenGenerator();
      if (!Number.isFinite(claimedAt.getTime()) || !LEASE_TOKEN.test(leaseToken)) {
        throw new Error('Deployment executor lease generation failed.');
      }
      const leaseTokenHash = createHash('sha256').update(leaseToken).digest('hex');
      return input.store.claim({...storeAuthorization(authorization), claimedAt, leaseExpiresAt, leaseTokenHash},
        (recordValue): DeploymentExecutorClaimEnvelope => {
          const releasePackage = validateDeploymentReleasePackage(recordValue.releasePackage);
          if (!UUID.test(recordValue.jobId) || !UUID.test(recordValue.deploymentId) ||
            !UUID.test(recordValue.projectId) || !authorization.projectIds.includes(recordValue.projectId) ||
            !authorization.environments.includes(recordValue.environment) || !positive(recordValue.deploymentVersion) ||
            !positive(recordValue.attempt) || !SHA256.test(recordValue.releasePackageHash) || !releasePackage.ok ||
            hashDeploymentReleasePackage(releasePackage.ok ? releasePackage.value : recordValue.releasePackage) !==
              recordValue.releasePackageHash ||
            !UUID.test(recordValue.approvedByActorId) || !Number.isFinite(recordValue.approvedAt.getTime())) {
            throw new Error('Deployment executor claim record is invalid.');
          }
          return {schemaVersion: 1, ...recordValue, releasePackage: releasePackage.value,
            approvedAt: recordValue.approvedAt.toISOString(), leaseToken, leaseExpiresAt: leaseExpiresAt.toISOString()};
        });
    },
    async heartbeat(request) {
      if (!validAuthorization(request.authorization) || !LEASE_TOKEN.test(request.leaseToken)) return null;
      const payload = parseDeploymentExecutorHeartbeatPayload(request.payload);
      const at = now();
      if (payload === null || !Number.isFinite(at.getTime())) return null;
      const result = await input.store.heartbeat({...storeAuthorization(request.authorization), ...payload,
        leaseTokenHash: createHash('sha256').update(request.leaseToken).digest('hex'), at,
        leaseExpiresAt: new Date(at.getTime() + LEASE_DURATION_MS)});
      return result.status === 'extended' || result.status === 'unchanged'
        ? {leaseExpiresAt: result.leaseExpiresAt!.toISOString()} : null;
    },
    async complete(request) {
      if (!validAuthorization(request.authorization) || !LEASE_TOKEN.test(request.leaseToken)) return null;
      const payload = parseDeploymentExecutorCompletionPayload(request.payload);
      const at = now();
      if (payload === null || !Number.isFinite(at.getTime())) return null;
      const resultJson = canonicalJson(payload.result as unknown as CanonicalJson);
      const resultHash = createHash('sha256').update(resultJson).digest('hex');
      const observation = validateDeploymentObservation({...payload.result,
        reference: `deployment-job:${payload.jobId}:attempt:${payload.attempt}:result:${resultHash}`});
      if (!observation.ok) return null;
      const command: ObserveDeploymentResultCommand = {
        commandId: nextId(), workspaceId: request.authorization.workspaceId, correlationId: nextId(),
        idempotencyKey: `deployment-observe:v1:${payload.deploymentId}:${payload.deploymentVersion}:${request.authorization.actor.actorId}`,
        issuedAt: at.toISOString(), actor: request.authorization.actor,
        type: DEPLOYMENT_OBSERVE_RESULT_COMMAND,
        payload: {deploymentId: payload.deploymentId, expectedVersion: payload.deploymentVersion,
          observation: observation.value}
      };
      if (!validateDeploymentEvidenceCommand(command)) return null;
      const completionReplayHash = createHash('sha256').update(request.leaseToken).update('\0')
        .update(canonicalJson(payload as unknown as CanonicalJson)).digest('hex');
      const result = await input.store.complete({...storeAuthorization(request.authorization), jobId: payload.jobId,
        attempt: payload.attempt, leaseTokenHash: createHash('sha256').update(request.leaseToken).digest('hex'),
        completionReplayHash, resultHash, observationCommand: command,
        requestHash: hashDeploymentEvidenceCommand(command), at});
      return result.status === 'completed' || result.status === 'replayed'
        ? {outcome: result.outcome!, completedAt: result.completedAt!.toISOString()} : null;
    }
  };
};
