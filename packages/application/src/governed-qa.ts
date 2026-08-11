import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  isTrustedActorContext,
  validateQaReviewEvidence,
  type CanonicalCommandEnvelope,
  type CommandError,
  type QaReviewEvidence
} from '@fai-control-plane/domain';

export const QA_TASK_PACKET_PREPARE_COMMAND = 'qa_task_packet.prepare.v1' as const;
export const QA_REVIEW_RECORD_COMMAND = 'qa_review.record.v1' as const;

type QaTarget = Readonly<{
  workItemId: string;
  expectedWorkItemVersion: number;
  expectedJourneyVersion: number;
}>;
export type PrepareQaTaskPacketCommand = CanonicalCommandEnvelope<
  typeof QA_TASK_PACKET_PREPARE_COMMAND, QaTarget
>;
export type RecordQaReviewCommand = CanonicalCommandEnvelope<typeof QA_REVIEW_RECORD_COMMAND,
  QaTarget & Readonly<{taskPacketId: string; evidence?: QaReviewEvidence}>>;
export type GovernedQaCommand = PrepareQaTaskPacketCommand | RecordQaReviewCommand;
export type GovernedQaValue = Readonly<{
  projectId: string;
  workItemId: string;
  taskPacketId: string;
  workItemStatus: string;
  workItemVersion: number;
  journeyStageKey: string;
  journeyVersion: number;
  executionStatus: 'paused' | 'blocked' | 'not_started';
  remediation: string | null;
}>;
export type GovernedQaReceipt = Readonly<{
  commandId: string; workspaceId: string; correlationId: string; idempotencyKey: string;
  requestHash: string; commandType: GovernedQaCommand['type'];
  result: Readonly<{ok: true; value: GovernedQaValue}> | Readonly<{ok: false; error: CommandError}>;
  createdAt: string;
}>;
export type GovernedQaExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: GovernedQaReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;
export interface GovernedQaStore {
  execute(input: Readonly<{
    command: GovernedQaCommand; requestHash: string; authorized: boolean; policyError?: CommandError;
  }>): Promise<
    Readonly<{status: 'completed' | 'replayed'; receipt: GovernedQaReceipt}> |
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
const target = (value: unknown): value is QaTarget => typeof value === 'object' && value !== null &&
  typeof (value as QaTarget).workItemId === 'string' && uuid.test((value as QaTarget).workItemId) &&
  Number.isSafeInteger((value as QaTarget).expectedWorkItemVersion) &&
  (value as QaTarget).expectedWorkItemVersion > 0 &&
  Number.isSafeInteger((value as QaTarget).expectedJourneyVersion) &&
  (value as QaTarget).expectedJourneyVersion > 0;
const valid = (command: GovernedQaCommand): boolean => {
  if (typeof command !== 'object' || command === null || !exact(command, [
    'commandId', 'workspaceId', 'correlationId', 'idempotencyKey', 'issuedAt', 'actor', 'type', 'payload'
  ]) || !isTrustedActorContext(command.actor) || !uuid.test(command.commandId) ||
    !uuid.test(command.workspaceId) || !uuid.test(command.correlationId) ||
    typeof command.idempotencyKey !== 'string' || command.idempotencyKey.length === 0 ||
    command.idempotencyKey.length > 256 || !timestamp(command.issuedAt) || !target(command.payload)) return false;
  if (command.type === QA_TASK_PACKET_PREPARE_COMMAND) return exact(command.payload, [
    'workItemId', 'expectedWorkItemVersion', 'expectedJourneyVersion'
  ]);
  if (command.type !== QA_REVIEW_RECORD_COMMAND || typeof command.payload.taskPacketId !== 'string' ||
    !uuid.test(command.payload.taskPacketId)) return false;
  const keys = Object.hasOwn(command.payload, 'evidence')
    ? ['workItemId', 'expectedWorkItemVersion', 'expectedJourneyVersion', 'taskPacketId', 'evidence']
    : ['workItemId', 'expectedWorkItemVersion', 'expectedJourneyVersion', 'taskPacketId'];
  return exact(command.payload, keys) && (!Object.hasOwn(command.payload, 'evidence') ||
    validateQaReviewEvidence(command.payload.evidence).ok);
};
const hash = (command: GovernedQaCommand) => createHash('sha256').update(canonicalJson({
  workspaceId: command.workspaceId, idempotencyKey: command.idempotencyKey,
  actorId: command.actor.actorId, type: command.type, payload: command.payload
} as never)).digest('hex');
const policy = {actionCategory: 'write', surface: 'control_plane', environment: 'development'} as const;

export const createGovernedQaService = (store: GovernedQaStore) => ({
  async execute(command: GovernedQaCommand): Promise<GovernedQaExecution> {
    if (!valid(command)) return {status: 'rejected', error: {
      code: 'INVALID_COMMAND', message: 'Governed QA command is not canonical.'
    }};
    if (command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') {
      return {status: 'rejected', error: {
        code: 'INVALID_ACTOR_CONTEXT', message: 'Governed QA requires an authenticated manager or Product Owner.'
      }};
    }
    const decision = authorize(command.actor, policy);
    const result = await store.execute({command, requestHash: hash(command), authorized: decision.ok,
      ...(!decision.ok ? {policyError: decision.error} : {})});
    return result.status === 'key_reused' ? {status: 'key_reused', error: {
      code: 'IDEMPOTENCY_KEY_REUSED', message: 'The QA command key was already used for a different request.'
    }} : result;
  }
});
