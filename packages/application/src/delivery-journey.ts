import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  isTrustedActorContext,
  type CanonicalCommandEnvelope,
  type CommandError,
  type DeliveryEvidenceReference,
  type DeliveryJourneyProjection,
  type TrustedActorContext
} from '@fai-control-plane/domain';

type StartPayload = Readonly<{
  workItemId: string;
  protocolId: string;
  expectedWorkItemVersion: number;
  deadlineAt: string | null;
}>;
type AdvancePayload = Readonly<{
  workItemId: string;
  expectedWorkItemVersion: number;
  expectedJourneyVersion: number;
  evidenceReferences: readonly DeliveryEvidenceReference[];
}>;
export type StartDeliveryJourneyCommand =
  CanonicalCommandEnvelope<'delivery_journey.start', StartPayload>;
export type AdvanceDeliveryJourneyCommand =
  CanonicalCommandEnvelope<'delivery_journey.advance', AdvancePayload>;
export type DeliveryJourneyCommand = StartDeliveryJourneyCommand | AdvanceDeliveryJourneyCommand;
export type DeliveryJourneyReceipt = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  requestHash: string;
  commandType: DeliveryJourneyCommand['type'];
  result: Readonly<{ok: true; value: DeliveryJourneyProjection}> |
    Readonly<{ok: false; error: CommandError}>;
  createdAt: string;
}>;
export type DeliveryJourneyExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: DeliveryJourneyReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;
export interface DeliveryJourneyStore {
  execute(input: Readonly<{
    command: DeliveryJourneyCommand;
    requestHash: string;
    authorized: boolean;
    policyError?: CommandError;
  }>): Promise<
    Readonly<{status: 'completed' | 'replayed'; receipt: DeliveryJourneyReceipt}> |
    Readonly<{status: 'key_reused'; existingRequestHash: string}>
  >;
  read(input: Readonly<{
    workspaceId: string; workItemId: string; actorId: string; at: string;
  }>): Promise<DeliveryJourneyProjection | null>;
}
export interface DeliveryJourneyService {
  execute(command: DeliveryJourneyCommand): Promise<DeliveryJourneyExecution>;
  read(input: Readonly<{
    workspaceId: string;
    workItemId: string;
    actor: TrustedActorContext;
    at?: string;
  }>): Promise<DeliveryJourneyProjection | null>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const writePolicy = {actionCategory: 'write', surface: 'control_plane', environment: 'development'} as const;
const readPolicy = {actionCategory: 'read', surface: 'control_plane', environment: 'development'} as const;
const exactKeys = (value: object, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const shapeIsValid = (command: DeliveryJourneyCommand): boolean => {
  if (typeof command !== 'object' || command === null ||
    !exactKeys(command, ['commandId', 'workspaceId', 'correlationId', 'idempotencyKey',
      'issuedAt', 'actor', 'type', 'payload']) ||
    !isTrustedActorContext(command.actor) || !uuidPattern.test(command.commandId) ||
    !uuidPattern.test(command.workspaceId) || !uuidPattern.test(command.correlationId) ||
    command.idempotencyKey.length === 0 || command.idempotencyKey.length > 256 ||
    !canonicalTimestamp(command.issuedAt) || typeof command.payload !== 'object' ||
    command.payload === null) return false;
  if (command.type === 'delivery_journey.start') {
    return exactKeys(command.payload,
      ['workItemId', 'protocolId', 'expectedWorkItemVersion', 'deadlineAt']) &&
      uuidPattern.test(command.payload.workItemId) && uuidPattern.test(command.payload.protocolId) &&
      Number.isInteger(command.payload.expectedWorkItemVersion) &&
      command.payload.expectedWorkItemVersion > 0 &&
      (command.payload.deadlineAt === null || canonicalTimestamp(command.payload.deadlineAt));
  }
  return command.type === 'delivery_journey.advance' &&
    exactKeys(command.payload, ['workItemId', 'expectedWorkItemVersion',
      'expectedJourneyVersion', 'evidenceReferences']) &&
    uuidPattern.test(command.payload.workItemId) &&
    Number.isInteger(command.payload.expectedWorkItemVersion) &&
    command.payload.expectedWorkItemVersion > 0 &&
    Number.isInteger(command.payload.expectedJourneyVersion) &&
    command.payload.expectedJourneyVersion > 0 &&
    Array.isArray(command.payload.evidenceReferences);
};
const hashFor = (command: DeliveryJourneyCommand) => createHash('sha256')
  .update(canonicalJson({
    commandId: command.commandId,
    workspaceId: command.workspaceId,
    correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey,
    issuedAt: command.issuedAt,
    actorId: command.actor.actorId,
    type: command.type,
    payload: command.payload
  } as never)).digest('hex');

export const createDeliveryJourneyService = (
  store: DeliveryJourneyStore,
  clock: Readonly<{now(): Date}> = {now: () => new Date()}
): DeliveryJourneyService => ({
  async execute(command) {
    if (!shapeIsValid(command)) {
      return {status: 'rejected', error: {code: 'INVALID_COMMAND', message: 'Delivery journey command is not canonical.'}};
    }
    if (command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') {
      return {status: 'rejected', error: {
        code: 'INVALID_ACTOR_CONTEXT',
        message: 'Delivery journey changes require an authenticated human.'
      }};
    }
    const policy = authorize(command.actor, writePolicy);
    const result = await store.execute({
      command,
      requestHash: hashFor(command),
      authorized: policy.ok,
      ...(!policy.ok ? {policyError: policy.error} : {})
    });
    return result.status === 'key_reused'
      ? {status: 'key_reused', error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency key was already used for a different request.'
        }}
      : result;
  },
  async read(input) {
    if (!isTrustedActorContext(input.actor) || !uuidPattern.test(input.workspaceId) ||
      !uuidPattern.test(input.workItemId) || !authorize(input.actor, readPolicy).ok) return null;
    let at: string;
    try {
      at = (input.at === undefined ? clock.now() : new Date(input.at)).toISOString();
    } catch {
      return null;
    }
    return store.read({
      workspaceId: input.workspaceId,
      workItemId: input.workItemId,
      actorId: input.actor.actorId,
      at
    });
  }
});
