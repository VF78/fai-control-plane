import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  isTrustedActorContext,
  MVP_AGENT_RUN_RETRY_POLICY,
  type AgentRunRetryPolicy,
  type AgentRunRetryStopReason,
  type CanonicalCommandEnvelope,
  type CommandError
} from '@fai-control-plane/domain';

export const AGENT_RUN_RETRY_CONTINUATION_COMMAND = 'agent_run.retry_continuation.v1' as const;

export {
  evaluateAgentRunRetryAdmission,
  MVP_AGENT_RUN_RETRY_POLICY,
  type AgentRunRetryPolicy,
  type AgentRunRetryStopReason
} from '@fai-control-plane/domain';

export type RetryAgentRunContinuationCommand = CanonicalCommandEnvelope<
  typeof AGENT_RUN_RETRY_CONTINUATION_COMMAND,
  Readonly<{
    projectId: string;
    failedRunId: string;
    retryRunId: string;
    expectedExecutionVersion: number;
  }>
>;

export type AgentRunRetryContinuationValue = Readonly<{
  disposition: 'queued' | 'ask';
  projectId: string;
  failedRunId: string;
  retryRunId: string | null;
  executionVersion: number;
  attemptsUsed: number;
  elapsedMinutes: number;
  observedCostMinor: number | null;
  currency: string;
  stopReason: AgentRunRetryStopReason | null;
  attentionId: string | null;
  nextAction: string;
  policy: AgentRunRetryPolicy;
}>;

export type AgentRunRetryContinuationReceipt = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  requestHash: string;
  commandType: typeof AGENT_RUN_RETRY_CONTINUATION_COMMAND;
  result: Readonly<{ok: true; value: AgentRunRetryContinuationValue}> |
    Readonly<{ok: false; error: CommandError}>;
  createdAt: string;
}>;

export interface AgentRunRetryContinuationStore {
  execute(input: Readonly<{
    command: RetryAgentRunContinuationCommand;
    requestHash: string;
    policy: AgentRunRetryPolicy;
    authorized: boolean;
    policyError?: CommandError;
  }>): Promise<
    Readonly<{status: 'completed' | 'replayed'; receipt: AgentRunRetryContinuationReceipt}> |
    Readonly<{status: 'key_reused'; existingRequestHash: string}> |
    Readonly<{status: 'rejected'; error: CommandError}>
  >;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestamp = (value: unknown): value is string => typeof value === 'string' &&
  Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString() === value;
const exact = (value: object, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const valid = (command: RetryAgentRunContinuationCommand): boolean =>
  exact(command, ['commandId', 'workspaceId', 'correlationId', 'idempotencyKey', 'issuedAt', 'actor', 'type', 'payload']) &&
  isTrustedActorContext(command.actor) && uuid.test(command.commandId) && uuid.test(command.workspaceId) &&
  uuid.test(command.correlationId) && timestamp(command.issuedAt) &&
  command.type === AGENT_RUN_RETRY_CONTINUATION_COMMAND &&
  exact(command.payload, ['projectId', 'failedRunId', 'retryRunId', 'expectedExecutionVersion']) &&
  uuid.test(command.payload.projectId) && uuid.test(command.payload.failedRunId) &&
  uuid.test(command.payload.retryRunId) && command.payload.failedRunId !== command.payload.retryRunId &&
  Number.isSafeInteger(command.payload.expectedExecutionVersion) && command.payload.expectedExecutionVersion > 0 &&
  command.idempotencyKey === `agent-run-retry-continuation:v1:${command.payload.failedRunId}:${command.payload.retryRunId}:${command.actor.actorId}`;

const requestHash = (command: RetryAgentRunContinuationCommand): string => createHash('sha256')
  .update(canonicalJson({workspaceId: command.workspaceId, actorId: command.actor.actorId,
    idempotencyKey: command.idempotencyKey, type: command.type, payload: command.payload,
    policy: MVP_AGENT_RUN_RETRY_POLICY} as never)).digest('hex');

export const createAgentRunRetryContinuationService = (store: AgentRunRetryContinuationStore) => ({
  async execute(command: RetryAgentRunContinuationCommand) {
    if (!valid(command)) return {status: 'rejected' as const, error: {
      code: 'INVALID_COMMAND' as const, message: 'AgentRun retry continuation command is not canonical.'
    }};
    if (command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') {
      return {status: 'rejected' as const, error: {
        code: 'INVALID_ACTOR_CONTEXT' as const, message: 'A human operator must explicitly request retry continuation.'
      }};
    }
    const policy = authorize(command.actor, {actionCategory: 'write', surface: 'control_plane', environment: 'development'});
    const result = await store.execute({command, requestHash: requestHash(command),
      policy: MVP_AGENT_RUN_RETRY_POLICY, authorized: policy.ok,
      ...(!policy.ok ? {policyError: policy.error} : {})});
    return result.status === 'key_reused' ? {status: 'key_reused' as const, error: {
      code: 'IDEMPOTENCY_KEY_REUSED' as const, message: 'The retry continuation key was reused for different facts.'
    }} : result;
  }
});
