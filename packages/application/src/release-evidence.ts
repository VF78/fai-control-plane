import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  deploymentEnvironments,
  isTrustedActorContext,
  validateDeploymentObservation,
  validateDeploymentReference,
  validateDeploymentReleasePackage,
  type CanonicalCommandEnvelope,
  type CommandError,
  type DeploymentEnvironment,
  type DeploymentObservation,
  type DeploymentReference,
  type DeploymentReleasePackage
} from '@fai-control-plane/domain';

export const DEPLOYMENT_REQUEST_COMMAND = 'deployment.request.v1' as const;
export const DEPLOYMENT_PRODUCTION_APPROVE_COMMAND = 'deployment.production_approve.v1' as const;
export const DEPLOYMENT_OBSERVE_RESULT_COMMAND = 'deployment.observe_result.v1' as const;

export type RequestDeploymentCommand = CanonicalCommandEnvelope<typeof DEPLOYMENT_REQUEST_COMMAND,
  Readonly<{
    deploymentId: string;
    projectId: string;
    workItemId: string | null;
    planVersionId: string;
    materializationId: string;
    environment: DeploymentEnvironment;
    reference: DeploymentReference;
    releasePackage: DeploymentReleasePackage;
    expectedProjectVersion: number;
  }>>;
export type ApproveProductionDeploymentCommand = CanonicalCommandEnvelope<
  typeof DEPLOYMENT_PRODUCTION_APPROVE_COMMAND,
  Readonly<{deploymentId: string; expectedVersion: number}>
>;
export type ObserveDeploymentResultCommand = CanonicalCommandEnvelope<
  typeof DEPLOYMENT_OBSERVE_RESULT_COMMAND,
  Readonly<{deploymentId: string; expectedVersion: number; observation: DeploymentObservation}>
>;
export type DeploymentEvidenceCommand = RequestDeploymentCommand |
  ApproveProductionDeploymentCommand | ObserveDeploymentResultCommand;
export type DeploymentEvidenceValue = Readonly<{
  deploymentId: string;
  projectId: string;
  environment: DeploymentEnvironment;
  state: 'requested' | 'approved' | 'observed';
  version: number;
  nextAction: 'approve_production' | 'await_executor' | 'record_observation' | 'review_observation';
}>;
export type DeploymentEvidenceResult = Readonly<{ok: true; value: DeploymentEvidenceValue}> |
  Readonly<{ok: false; error: CommandError}>;
export type DeploymentEvidenceReceipt = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  requestHash: string;
  commandType: DeploymentEvidenceCommand['type'];
  result: DeploymentEvidenceResult;
  createdAt: string;
}>;
export type DeploymentEvidenceExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: DeploymentEvidenceReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;
export interface DeploymentEvidenceStore {
  execute(input: Readonly<{
    command: DeploymentEvidenceCommand;
    requestHash: string;
    authorized: boolean;
    policyError?: CommandError;
  }>): Promise<
    Readonly<{status: 'completed' | 'replayed'; receipt: DeploymentEvidenceReceipt}> |
    Readonly<{status: 'key_reused'; existingRequestHash: string}>
  >;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const envelope = (command: DeploymentEvidenceCommand) => typeof command === 'object' && command !== null &&
  exact(command, ['commandId', 'workspaceId', 'correlationId', 'idempotencyKey', 'issuedAt', 'actor', 'type', 'payload']) &&
  isTrustedActorContext(command.actor) && uuid.test(command.commandId) && uuid.test(command.workspaceId) &&
  uuid.test(command.correlationId) && timestamp(command.issuedAt) && typeof command.idempotencyKey === 'string' &&
  command.idempotencyKey.length > 0 && command.idempotencyKey.length <= 256;
const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
export const validateDeploymentEvidenceCommand = (command: DeploymentEvidenceCommand): boolean => {
  if (!envelope(command) || typeof command.payload !== 'object' || command.payload === null) return false;
  if (command.type === DEPLOYMENT_REQUEST_COMMAND) {
    const payload = command.payload;
    const releasePackage = validateDeploymentReleasePackage(payload.releasePackage);
    return exact(payload, ['deploymentId', 'projectId', 'workItemId', 'planVersionId',
      'materializationId', 'environment', 'reference', 'releasePackage', 'expectedProjectVersion']) &&
      uuid.test(payload.deploymentId) && uuid.test(payload.projectId) &&
      (payload.workItemId === null || uuid.test(payload.workItemId)) && uuid.test(payload.planVersionId) &&
      uuid.test(payload.materializationId) && deploymentEnvironments.includes(payload.environment) &&
      positive(payload.expectedProjectVersion) && validateDeploymentReference(payload.reference).ok &&
      releasePackage.ok && payload.reference.kind === 'commit' &&
      payload.reference.reference === `git-commit:${releasePackage.ok ? releasePackage.value.sourceCommit : ''}` &&
      command.idempotencyKey === `deployment-request:v1:${payload.deploymentId}:${payload.expectedProjectVersion}:${command.actor.actorId}`;
  }
  if (command.type === DEPLOYMENT_PRODUCTION_APPROVE_COMMAND) {
    const payload = command.payload;
    return exact(payload, ['deploymentId', 'expectedVersion']) && uuid.test(payload.deploymentId) &&
      positive(payload.expectedVersion) && command.idempotencyKey ===
      `deployment-production-approve:v1:${payload.deploymentId}:${payload.expectedVersion}:${command.actor.actorId}`;
  }
  if (command.type === DEPLOYMENT_OBSERVE_RESULT_COMMAND) {
    const payload = command.payload;
    return exact(payload, ['deploymentId', 'expectedVersion', 'observation']) && uuid.test(payload.deploymentId) &&
      positive(payload.expectedVersion) && validateDeploymentObservation(payload.observation).ok &&
      command.idempotencyKey === `deployment-observe:v1:${payload.deploymentId}:${payload.expectedVersion}:${command.actor.actorId}`;
  }
  return false;
};

export const hashDeploymentEvidenceCommand = (command: DeploymentEvidenceCommand) => createHash('sha256').update(canonicalJson({
  workspaceId: command.workspaceId,
  idempotencyKey: command.idempotencyKey,
  actorId: command.actor.actorId,
  type: command.type,
  payload: command.payload
} as never)).digest('hex');

export const createDeploymentEvidenceService = (store: DeploymentEvidenceStore) => ({
  async execute(command: DeploymentEvidenceCommand): Promise<DeploymentEvidenceExecution> {
    if (!validateDeploymentEvidenceCommand(command)) return {status: 'rejected', error: {
      code: 'INVALID_COMMAND', message: 'Deployment evidence command is not canonical.'
    }};
    const observation = command.type === DEPLOYMENT_OBSERVE_RESULT_COMMAND;
    if (observation ? command.actor.kind !== 'trusted_system' || command.actor.actorType !== 'system'
      : command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') {
      return {status: 'rejected', error: {code: 'INVALID_ACTOR_CONTEXT', message: observation
        ? 'Deployment observation requires a trusted system identity.'
        : 'Deployment request and production approval require an authenticated human manager or Product Owner.'}};
    }
    // These commands record control-plane intent/evidence only. They never authorize or execute a deployment.
    const decision = authorize(command.actor, observation
      ? {actionCategory: 'write', surface: 'runtime_observation', environment: 'development'}
      : {actionCategory: 'write', surface: 'control_plane', environment: 'development'});
    const result = await store.execute({command, requestHash: hashDeploymentEvidenceCommand(command), authorized: decision.ok,
      ...(!decision.ok ? {policyError: decision.error} : {})});
    return result.status === 'key_reused' ? {status: 'key_reused', error: {
      code: 'IDEMPOTENCY_KEY_REUSED', message: 'Deployment command key was reused for a different request.'
    }} : result;
  }
});
