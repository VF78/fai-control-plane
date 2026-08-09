import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  isTrustedActorContext,
  type CanonicalCommandEnvelope,
  type CommandError,
  type ProjectExecutionProjection
} from '@fai-control-plane/domain';

type ProjectExecutionPayload = Readonly<{projectId: string; expectedVersion: number}>;
export type StartProjectExecutionCommand = CanonicalCommandEnvelope<'project_execution.start', ProjectExecutionPayload>;
export type PauseProjectExecutionCommand = CanonicalCommandEnvelope<'project_execution.pause', ProjectExecutionPayload>;
export type ResumeProjectExecutionCommand = CanonicalCommandEnvelope<'project_execution.resume', ProjectExecutionPayload>;
export type ProjectExecutionCommand = StartProjectExecutionCommand | PauseProjectExecutionCommand | ResumeProjectExecutionCommand;
export type ProjectExecutionReceipt = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  requestHash: string;
  commandType: ProjectExecutionCommand['type'];
  result: Readonly<{ok: true; value: ProjectExecutionProjection}> | Readonly<{ok: false; error: CommandError}>;
  createdAt: string;
}>;
export type ProjectExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: ProjectExecutionReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;
export interface ProjectExecutionStore {
  execute(input: Readonly<{
    command: ProjectExecutionCommand;
    requestHash: string;
    authorized: boolean;
    policyError?: CommandError;
  }>): Promise<
    Readonly<{status: 'completed' | 'replayed'; receipt: ProjectExecutionReceipt}> |
    Readonly<{status: 'key_reused'; existingRequestHash: string}>
  >;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const policyRequest = {actionCategory: 'write', surface: 'control_plane', environment: 'development'} as const;
const exactKeys = (value: object, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const valid = (command: ProjectExecutionCommand): boolean =>
  typeof command === 'object' && command !== null &&
  exactKeys(command, ['commandId', 'workspaceId', 'correlationId', 'idempotencyKey', 'issuedAt', 'actor', 'type', 'payload']) &&
  isTrustedActorContext(command.actor) && uuidPattern.test(command.commandId) &&
  uuidPattern.test(command.workspaceId) && uuidPattern.test(command.correlationId) &&
  command.idempotencyKey.length > 0 && command.idempotencyKey.length <= 256 &&
  canonicalTimestamp(command.issuedAt) &&
  ['project_execution.start', 'project_execution.pause', 'project_execution.resume'].includes(command.type) &&
  typeof command.payload === 'object' && command.payload !== null &&
  exactKeys(command.payload, ['projectId', 'expectedVersion']) &&
  uuidPattern.test(command.payload.projectId) && Number.isSafeInteger(command.payload.expectedVersion) &&
  command.payload.expectedVersion >= 0 &&
  (command.type === 'project_execution.start' ? command.payload.expectedVersion === 0 : command.payload.expectedVersion > 0);

const requestHash = (command: ProjectExecutionCommand): string => createHash('sha256').update(canonicalJson({
  workspaceId: command.workspaceId,
  idempotencyKey: command.idempotencyKey,
  actorId: command.actor.actorId,
  type: command.type,
  payload: command.payload
} as never)).digest('hex');

export const createProjectExecutionService = (store: ProjectExecutionStore) => ({
  async execute(command: ProjectExecutionCommand): Promise<ProjectExecution> {
    if (!valid(command)) return {status: 'rejected', error: {code: 'INVALID_COMMAND', message: 'Project execution command is not canonical.'}};
    if (command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') {
      return {status: 'rejected', error: {code: 'INVALID_ACTOR_CONTEXT', message: 'Project execution controls require an authenticated human.'}};
    }
    const policy = authorize(command.actor, policyRequest);
    const result = await store.execute({command, requestHash: requestHash(command), authorized: policy.ok,
      ...(!policy.ok ? {policyError: policy.error} : {})});
    return result.status === 'key_reused'
      ? {status: 'key_reused', error: {code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was already used for a different request.'}}
      : result;
  }
});
