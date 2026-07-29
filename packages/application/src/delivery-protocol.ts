import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  isTrustedActorContext,
  validateDeliveryProtocolDefinition,
  type CanonicalCommandEnvelope,
  type CommandError,
  type DeliveryProtocol,
  type DeliveryProtocolDefinition,
  type DeliveryProtocolSimulation,
  type TrustedActorContext
} from '@fai-control-plane/domain';

type DraftPayload = Readonly<{
  protocolId: string;
  projectId: string;
  name: string;
  expectedRevision: number | null;
  definition: DeliveryProtocolDefinition;
}>;
type PublishPayload = Readonly<{
  protocolId: string;
  expectedRevision: number;
  expectedSimulationHash: string;
}>;
type ActivatePayload = Readonly<{
  protocolId: string;
  expectedRevision: number;
}>;
type RetirePayload = Readonly<{
  protocolId: string;
  expectedRevision: number;
}>;
type SimulatePayload = Readonly<{
  projectId: string;
  definition: DeliveryProtocolDefinition;
}>;

export type DraftDeliveryProtocolCommand = CanonicalCommandEnvelope<
  'delivery_protocol.draft',
  DraftPayload
>;
export type PublishDeliveryProtocolCommand = CanonicalCommandEnvelope<
  'delivery_protocol.publish',
  PublishPayload
>;
export type ActivateDeliveryProtocolCommand = CanonicalCommandEnvelope<
  'delivery_protocol.activate',
  ActivatePayload
>;
export type RetireDeliveryProtocolCommand = CanonicalCommandEnvelope<
  'delivery_protocol.retire',
  RetirePayload
>;
export type SimulateDeliveryProtocolCommand = CanonicalCommandEnvelope<
  'delivery_protocol.simulate',
  SimulatePayload
>;
export type DeliveryProtocolMutationCommand =
  | DraftDeliveryProtocolCommand
  | PublishDeliveryProtocolCommand
  | ActivateDeliveryProtocolCommand
  | RetireDeliveryProtocolCommand;

type ProtocolResult = Readonly<{
  protocol: DeliveryProtocol;
  simulation?: DeliveryProtocolSimulation;
  replacedProtocolId?: string;
}>;
export type DeliveryProtocolReceipt = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  requestHash: string;
  commandType: DeliveryProtocolMutationCommand['type'];
  result:
    | Readonly<{ok: true; value: ProtocolResult}>
    | Readonly<{ok: false; error: CommandError}>;
  createdAt: string;
}>;
export type DeliveryProtocolExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: DeliveryProtocolReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;

export interface DeliveryProtocolStore {
  execute(input: Readonly<{
    command: DeliveryProtocolMutationCommand;
    requestHash: string;
    authorized: boolean;
    policyError?: CommandError;
  }>): Promise<
    | Readonly<{status: 'completed' | 'replayed'; receipt: DeliveryProtocolReceipt}>
    | Readonly<{status: 'key_reused'; existingRequestHash: string}>
  >;
  simulate(input: Readonly<{
    workspaceId: string;
    projectId: string;
    actorId: string;
    definition: DeliveryProtocolDefinition;
  }>): Promise<DeliveryProtocolSimulation | null>;
  get(input: Readonly<{
    workspaceId: string;
    protocolId: string;
    actorId: string;
  }>): Promise<DeliveryProtocol | null>;
}

export interface DeliveryProtocolService {
  execute(command: DeliveryProtocolMutationCommand): Promise<DeliveryProtocolExecution>;
  simulate(command: SimulateDeliveryProtocolCommand): Promise<DeliveryProtocolSimulation | null>;
  get(input: Readonly<{
    workspaceId: string;
    protocolId: string;
    actor: TrustedActorContext;
  }>): Promise<DeliveryProtocol | null>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const mutationTypes = new Set([
  'delivery_protocol.draft',
  'delivery_protocol.publish',
  'delivery_protocol.activate',
  'delivery_protocol.retire'
]);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
};
const readPolicy = {
  actionCategory: 'read',
  surface: 'control_plane',
  environment: 'development'
} as const;
const writePolicy = {
  actionCategory: 'write',
  surface: 'control_plane',
  environment: 'development'
} as const;

const invalid = (message: string): DeliveryProtocolExecution => ({
  status: 'rejected',
  error: {code: 'INVALID_COMMAND', message}
});
const envelopeIsValid = (command: Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  issuedAt: string;
  actor: TrustedActorContext;
}>): boolean => {
  if (
    !isTrustedActorContext(command.actor) ||
    !uuidPattern.test(command.commandId) ||
    !uuidPattern.test(command.workspaceId) ||
    !uuidPattern.test(command.correlationId) ||
    command.idempotencyKey.length === 0 ||
    command.idempotencyKey.length > 256
  ) return false;
  try {
    return new Date(command.issuedAt).toISOString() === command.issuedAt;
  } catch {
    return false;
  }
};
const mutationShapeIsValid = (command: DeliveryProtocolMutationCommand): boolean => {
  if (
    !isObject(command) ||
    !exactKeys(command, [
      'commandId',
      'workspaceId',
      'correlationId',
      'idempotencyKey',
      'issuedAt',
      'actor',
      'type',
      'payload'
    ]) ||
    !isObject(command.payload) ||
    !envelopeIsValid(command) ||
    !mutationTypes.has(command.type)
  ) return false;
  if (!uuidPattern.test(command.payload.protocolId)) return false;
  if (command.type === 'delivery_protocol.draft') {
    return (
      exactKeys(command.payload, [
        'protocolId', 'projectId', 'name', 'expectedRevision', 'definition'
      ]) &&
      uuidPattern.test(command.payload.projectId) &&
      command.payload.name.trim() === command.payload.name &&
      command.payload.name.length > 0 &&
      command.payload.name.length <= 120 &&
      (command.payload.expectedRevision === null ||
        Number.isInteger(command.payload.expectedRevision) &&
        command.payload.expectedRevision > 0)
    );
  }
  return (
    exactKeys(
      command.payload,
      command.type === 'delivery_protocol.publish'
        ? ['protocolId', 'expectedRevision', 'expectedSimulationHash']
        : ['protocolId', 'expectedRevision']
    ) &&
    Number.isInteger(command.payload.expectedRevision) &&
    command.payload.expectedRevision > 0 &&
    (command.type !== 'delivery_protocol.publish' ||
      sha256Pattern.test(command.payload.expectedSimulationHash))
  );
};
const requestHashFor = (command: DeliveryProtocolMutationCommand): string =>
  createHash('sha256').update(canonicalJson({
    commandId: command.commandId,
    workspaceId: command.workspaceId,
    correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey,
    issuedAt: command.issuedAt,
    actorId: command.actor.actorId,
    type: command.type,
    payload: command.payload
  } as never)).digest('hex');

export const createDeliveryProtocolService = (
  store: DeliveryProtocolStore
): DeliveryProtocolService => ({
  async execute(command) {
    if (!mutationShapeIsValid(command)) {
      return invalid('Delivery protocol command is not canonical.');
    }
    if (command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') {
      return {
        status: 'rejected',
        error: {
          code: 'INVALID_ACTOR_CONTEXT',
          message: 'Delivery protocol changes require an authenticated human.'
        }
      };
    }
    if (command.type === 'delivery_protocol.draft') {
      const definition = validateDeliveryProtocolDefinition(command.payload.definition);
      if (!definition.ok) return {status: 'rejected', error: definition.error};
    }
    const authorization = authorize(command.actor, writePolicy);
    const result = await store.execute({
      command,
      requestHash: requestHashFor(command),
      authorized: authorization.ok,
      ...(!authorization.ok ? {policyError: authorization.error} : {})
    });
    if (result.status === 'key_reused') {
      return {
        status: 'key_reused',
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency key was already used for a different request.'
        }
      };
    }
    return result;
  },

  async simulate(command) {
    if (
      !isObject(command) ||
      !exactKeys(command, [
        'commandId',
        'workspaceId',
        'correlationId',
        'idempotencyKey',
        'issuedAt',
        'actor',
        'type',
        'payload'
      ]) ||
      !isObject(command.payload) ||
      !exactKeys(command.payload, ['projectId', 'definition']) ||
      !envelopeIsValid(command) ||
      command.type !== 'delivery_protocol.simulate' ||
      !uuidPattern.test(command.payload.projectId)
    ) return null;
    const definition = validateDeliveryProtocolDefinition(command.payload.definition);
    if (!definition.ok) return null;
    const authorization = authorize(command.actor, readPolicy);
    if (!authorization.ok) return null;
    return store.simulate({
      workspaceId: command.workspaceId,
      projectId: command.payload.projectId,
      actorId: command.actor.actorId,
      definition: definition.value
    });
  },

  async get(input) {
    if (
      !isTrustedActorContext(input.actor) ||
      !uuidPattern.test(input.workspaceId) ||
      !uuidPattern.test(input.protocolId) ||
      !authorize(input.actor, readPolicy).ok
    ) return null;
    return store.get({
      workspaceId: input.workspaceId,
      protocolId: input.protocolId,
      actorId: input.actor.actorId
    });
  }
});
