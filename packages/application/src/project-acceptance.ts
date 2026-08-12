import {createHash} from 'node:crypto';
import {
  authorize, canonicalJson, isTrustedActorContext,
  type CanonicalCommandEnvelope, type CommandError, type ProjectAcceptanceProjection,
  type ProjectUatCheckResult
} from '@fai-control-plane/domain';

export const PROJECT_UAT_PREPARE_COMMAND = 'project_uat.prepare.v1' as const;
export const PROJECT_UAT_RECORD_RESULT_COMMAND = 'project_uat.record_result.v1' as const;
export const PROJECT_UAT_SIGNOFF_COMMAND = 'project_uat.signoff.v1' as const;
export const PROJECT_RELEASE_NOT_REQUIRED_COMMAND = 'project_release.not_required.v1' as const;
export const PROJECT_EXECUTION_COMPLETE_COMMAND = 'project_execution.complete.v1' as const;

export type PrepareProjectUatCommand = CanonicalCommandEnvelope<typeof PROJECT_UAT_PREPARE_COMMAND, Readonly<{
  projectId: string; protocolId: string; expectedExecutionVersion: number; requiredSmokeChecks: readonly string[];
  requiredDeploymentEnvironment: 'staging' | 'production'; deploymentId: string | null;
}>>;
export type RecordProjectUatResultCommand = CanonicalCommandEnvelope<typeof PROJECT_UAT_RECORD_RESULT_COMMAND, Readonly<{
  projectId: string; protocolId: string; resultId: string; expectedVersion: number;
  outcome: 'passed' | 'failed'; checks: readonly ProjectUatCheckResult[];
}>>;
export type SignoffProjectUatCommand = CanonicalCommandEnvelope<typeof PROJECT_UAT_SIGNOFF_COMMAND, Readonly<{
  projectId: string; protocolId: string; resultId: string; expectedVersion: number;
  kind: 'product_owner' | 'client_representative'; evidenceReference: string;
}>>;
export type WaiveProjectReleaseCommand = CanonicalCommandEnvelope<typeof PROJECT_RELEASE_NOT_REQUIRED_COMMAND, Readonly<{
  projectId: string; protocolId: string; expectedVersion: number; reason: string;
}>>;
export type CompleteProjectExecutionCommand = CanonicalCommandEnvelope<typeof PROJECT_EXECUTION_COMPLETE_COMMAND, Readonly<{
  projectId: string; protocolId: string; expectedVersion: number; expectedExecutionVersion: number;
}>>;
export type ProjectAcceptanceCommand = PrepareProjectUatCommand | RecordProjectUatResultCommand |
  SignoffProjectUatCommand | WaiveProjectReleaseCommand | CompleteProjectExecutionCommand;
export type ProjectAcceptanceReceipt = Readonly<{
  commandId: string; workspaceId: string; correlationId: string; idempotencyKey: string;
  requestHash: string; commandType: ProjectAcceptanceCommand['type'];
  result: Readonly<{ok: true; value: ProjectAcceptanceProjection}> | Readonly<{ok: false; error: CommandError}>;
  createdAt: string;
}>;
export type ProjectAcceptanceExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: ProjectAcceptanceReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;
export interface ProjectAcceptanceStore {
  execute(input: Readonly<{command: ProjectAcceptanceCommand; requestHash: string; authorized: boolean;
    policyError?: CommandError}>): Promise<Readonly<{status: 'completed' | 'replayed'; receipt: ProjectAcceptanceReceipt}> |
      Readonly<{status: 'key_reused'; existingRequestHash: string}>>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = /^[a-z][a-z0-9._:-]{0,127}$/;
const exact = (value: object, keys: readonly string[]) => Object.keys(value).length === keys.length &&
  keys.every((item) => Object.hasOwn(value, item));
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const bounded = (value: unknown, maximum: number): value is string => typeof value === 'string' &&
  value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const references = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 50 &&
  value.every((item) => bounded(item, 2048));
const checksValid = (checks: unknown): checks is readonly ProjectUatCheckResult[] => Array.isArray(checks) &&
  checks.length > 0 && checks.length <= 200 && checks.every((check) => typeof check === 'object' && check !== null &&
    exact(check, ['key', 'outcome', 'evidenceReferences', 'artifactReferences']) &&
    key.test((check as ProjectUatCheckResult).key) && ['passed', 'failed'].includes((check as ProjectUatCheckResult).outcome) &&
    references((check as ProjectUatCheckResult).evidenceReferences) && references((check as ProjectUatCheckResult).artifactReferences));
const baseValid = (command: ProjectAcceptanceCommand) => typeof command === 'object' && command !== null &&
  exact(command, ['commandId', 'workspaceId', 'correlationId', 'idempotencyKey', 'issuedAt', 'actor', 'type', 'payload']) &&
  isTrustedActorContext(command.actor) && uuid.test(command.commandId) && uuid.test(command.workspaceId) &&
  uuid.test(command.correlationId) && timestamp(command.issuedAt) && typeof command.payload === 'object' &&
  command.payload !== null && uuid.test(command.payload.projectId) && uuid.test(command.payload.protocolId);

const valid = (command: ProjectAcceptanceCommand): boolean => {
  if (!baseValid(command)) return false;
  const actorId = command.actor.actorId;
  switch (command.type) {
    case PROJECT_UAT_PREPARE_COMMAND: {
      const payload = (command as PrepareProjectUatCommand).payload;
      return exact(payload, ['projectId', 'protocolId', 'expectedExecutionVersion', 'requiredSmokeChecks',
        'requiredDeploymentEnvironment', 'deploymentId']) &&
        (payload.deploymentId === null || uuid.test(payload.deploymentId)) &&
        Number.isSafeInteger(payload.expectedExecutionVersion) && payload.expectedExecutionVersion > 0 &&
        ['staging', 'production'].includes(payload.requiredDeploymentEnvironment) &&
        Array.isArray(payload.requiredSmokeChecks) && payload.requiredSmokeChecks.length > 0 &&
        payload.requiredSmokeChecks.length <= 50 && new Set(payload.requiredSmokeChecks).size === payload.requiredSmokeChecks.length &&
        payload.requiredSmokeChecks.every((item) => bounded(item, 120)) &&
        command.idempotencyKey ===
          `project-uat-prepare:v1:${payload.projectId}:${payload.expectedExecutionVersion}:${payload.protocolId}:${actorId}`;
    }
    case PROJECT_UAT_RECORD_RESULT_COMMAND: {
      const payload = (command as RecordProjectUatResultCommand).payload;
      return exact(payload, ['projectId', 'protocolId', 'resultId', 'expectedVersion', 'outcome', 'checks']) &&
        uuid.test(payload.resultId) && Number.isSafeInteger(payload.expectedVersion) && payload.expectedVersion > 0 &&
        ['passed', 'failed'].includes(payload.outcome) && checksValid(payload.checks) &&
        command.idempotencyKey === `project-uat-result:v1:${payload.protocolId}:${payload.expectedVersion}:${actorId}`;
    }
    case PROJECT_UAT_SIGNOFF_COMMAND: {
      const payload = (command as SignoffProjectUatCommand).payload;
      return exact(payload, ['projectId', 'protocolId', 'resultId', 'expectedVersion', 'kind', 'evidenceReference']) &&
        uuid.test(payload.resultId) && Number.isSafeInteger(payload.expectedVersion) && payload.expectedVersion > 0 &&
        ['product_owner', 'client_representative'].includes(payload.kind) && bounded(payload.evidenceReference, 2048) &&
        command.idempotencyKey === `project-uat-signoff:v1:${payload.kind}:${payload.resultId}:${payload.expectedVersion}:${actorId}`;
    }
    case PROJECT_RELEASE_NOT_REQUIRED_COMMAND: {
      const payload = (command as WaiveProjectReleaseCommand).payload;
      return exact(payload, ['projectId', 'protocolId', 'expectedVersion', 'reason']) &&
        Number.isSafeInteger(payload.expectedVersion) && payload.expectedVersion > 0 && bounded(payload.reason, 500) &&
        command.idempotencyKey === `project-release-not-required:v1:${payload.protocolId}:${payload.expectedVersion}:${actorId}`;
    }
    case PROJECT_EXECUTION_COMPLETE_COMMAND: {
      const payload = (command as CompleteProjectExecutionCommand).payload;
      return exact(payload, ['projectId', 'protocolId', 'expectedVersion', 'expectedExecutionVersion']) &&
        Number.isSafeInteger(payload.expectedVersion) && payload.expectedVersion > 0 &&
        Number.isSafeInteger(payload.expectedExecutionVersion) && payload.expectedExecutionVersion > 0 &&
        command.idempotencyKey === `project-execution-complete:v1:${payload.projectId}:${payload.expectedExecutionVersion}:${payload.expectedVersion}:${actorId}`;
    }
  }
};

export const createProjectAcceptanceService = (store: ProjectAcceptanceStore) => ({
  async execute(command: ProjectAcceptanceCommand): Promise<ProjectAcceptanceExecution> {
    if (!valid(command)) return {status: 'rejected', error: {code: 'INVALID_COMMAND',
      message: 'Project acceptance command is not canonical.'}};
    if (command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') return {status: 'rejected',
      error: {code: 'INVALID_ACTOR_CONTEXT', message: 'Project acceptance requires an authenticated human.'}};
    const policy = authorize(command.actor, {actionCategory: 'write', surface: 'control_plane', environment: 'development'});
    const requestHash = createHash('sha256').update(canonicalJson({workspaceId: command.workspaceId,
      idempotencyKey: command.idempotencyKey, actorId: command.actor.actorId, type: command.type,
      payload: command.payload} as never)).digest('hex');
    const result = await store.execute({command, requestHash, authorized: policy.ok,
      ...(!policy.ok ? {policyError: policy.error} : {})});
    return result.status === 'key_reused' ? {status: 'key_reused', error: {code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'Idempotency key was already used for a different request.'}} : result;
  }
});
