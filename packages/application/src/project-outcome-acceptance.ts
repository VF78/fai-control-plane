import {createHash} from 'node:crypto';
import {authorize, canonicalJson, isTrustedActorContext, type CanonicalCommandEnvelope, type CommandError} from '@fai-control-plane/domain';

export const PROJECT_OUTCOME_ACCEPTANCE_COMMAND = 'project_scope_outcome.accept.v1' as const;

type Payload = Readonly<{
  projectId: string;
  baselineId: string;
  outcomeId: string;
  expectedExecutionVersion: number;
}>;
export type AcceptProjectOutcomeCommand = CanonicalCommandEnvelope<typeof PROJECT_OUTCOME_ACCEPTANCE_COMMAND, Payload>;
export type ProjectOutcomeAcceptanceValue = Readonly<{
  projectId: string;
  outcomeId: string;
  acceptedWeight: number;
  totalWeight: number;
  executionStatus: 'paused' | 'blocked';
  executionVersion: number;
}>;
export type ProjectOutcomeAcceptanceReceipt = Readonly<{
  commandId: string; workspaceId: string; correlationId: string; idempotencyKey: string;
  requestHash: string; commandType: typeof PROJECT_OUTCOME_ACCEPTANCE_COMMAND;
  result: Readonly<{ok: true; value: ProjectOutcomeAcceptanceValue}> | Readonly<{ok: false; error: CommandError}>;
  createdAt: string;
}>;
export type ProjectOutcomeAcceptanceExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: ProjectOutcomeAcceptanceReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;
export interface ProjectOutcomeAcceptanceStore {
  execute(input: Readonly<{command: AcceptProjectOutcomeCommand; requestHash: string; authorized: boolean; policyError?: CommandError}>): Promise<
    Readonly<{status: 'completed' | 'replayed'; receipt: ProjectOutcomeAcceptanceReceipt}> |
    Readonly<{status: 'key_reused'; existingRequestHash: string}>
  >;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exact = (value: object, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const valid = (command: AcceptProjectOutcomeCommand): boolean => typeof command === 'object' && command !== null &&
  exact(command, ['commandId', 'workspaceId', 'correlationId', 'idempotencyKey', 'issuedAt', 'actor', 'type', 'payload']) &&
  isTrustedActorContext(command.actor) && uuid.test(command.commandId) && uuid.test(command.workspaceId) &&
  uuid.test(command.correlationId) && timestamp(command.issuedAt) && command.type === PROJECT_OUTCOME_ACCEPTANCE_COMMAND &&
  typeof command.payload === 'object' && command.payload !== null &&
  exact(command.payload, ['projectId', 'baselineId', 'outcomeId', 'expectedExecutionVersion']) &&
  uuid.test(command.payload.projectId) && uuid.test(command.payload.baselineId) && uuid.test(command.payload.outcomeId) &&
  Number.isSafeInteger(command.payload.expectedExecutionVersion) && command.payload.expectedExecutionVersion > 0 &&
  command.idempotencyKey === `project-outcome-accept:v1:${command.payload.outcomeId}:${command.payload.expectedExecutionVersion}:${command.actor.actorId}`;

export const createProjectOutcomeAcceptanceService = (store: ProjectOutcomeAcceptanceStore) => ({
  async execute(command: AcceptProjectOutcomeCommand): Promise<ProjectOutcomeAcceptanceExecution> {
    if (!valid(command)) return {status: 'rejected', error: {code: 'INVALID_COMMAND', message: 'Project outcome acceptance command is not canonical.'}};
    if (command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') return {status: 'rejected', error: {code: 'INVALID_ACTOR_CONTEXT', message: 'Outcome acceptance requires an authenticated Product Owner.'}};
    const policy = authorize(command.actor, {actionCategory: 'write', surface: 'control_plane', environment: 'development'});
    const result = await store.execute({command, requestHash: createHash('sha256').update(canonicalJson({workspaceId: command.workspaceId, idempotencyKey: command.idempotencyKey, actorId: command.actor.actorId, type: command.type, payload: command.payload} as never)).digest('hex'), authorized: policy.ok, ...(!policy.ok ? {policyError: policy.error} : {})});
    return result.status === 'key_reused' ? {status: 'key_reused', error: {code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was already used for a different request.'}} : result;
  }
});
