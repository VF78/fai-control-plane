import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  isTrustedActorContext,
  validateInstructionContent,
  type CanonicalCommandEnvelope,
  type CommandError,
  type EffectiveInstructionDiff,
  type EffectiveInstructions,
  type InstructionContent,
  type TrustedActorContext
} from '@fai-control-plane/domain';

type VersionTarget =
  | Readonly<{scope: 'workspace'}>
  | Readonly<{scope: 'agent_profile'; agentProfileId: string}>;

type PublishPayload = VersionTarget & Readonly<{
  versionId: string;
  expectedVersion: number | null;
  approvedByActorId: string;
  content: InstructionContent;
}>;

type RollbackPayload = VersionTarget & Readonly<{
  versionId: string;
  expectedVersion: number;
  approvedByActorId: string;
  rollbackOfVersionId: string;
}>;

export type PublishInstructionVersionCommand = CanonicalCommandEnvelope<
  'instruction_version.publish',
  PublishPayload
>;
export type RollbackInstructionVersionCommand = CanonicalCommandEnvelope<
  'instruction_version.rollback',
  RollbackPayload
>;
export type InstructionVersionCommand =
  | PublishInstructionVersionCommand
  | RollbackInstructionVersionCommand;

export type InstructionVersionPreview = Readonly<{
  workspaceVersion: number | null;
  profileVersion: number | null;
  effective: EffectiveInstructions;
  diff: EffectiveInstructionDiff;
}>;

export type InstructionVersionReceipt = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  requestHash: string;
  commandType: InstructionVersionCommand['type'];
  result:
    | Readonly<{ok: true; value: InstructionVersionPreview & Readonly<{versionId: string}>}>
    | Readonly<{ok: false; error: CommandError}>;
  createdAt: string;
}>;

export type InstructionVersionExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: InstructionVersionReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;

export interface InstructionVersionStore {
  execute(input: Readonly<{
    command: InstructionVersionCommand;
    requestHash: string;
    authorized: boolean;
    policyError?: CommandError;
  }>): Promise<
    | Readonly<{status: 'completed' | 'replayed'; receipt: InstructionVersionReceipt}>
    | Readonly<{status: 'key_reused'; existingRequestHash: string}>
  >;
  preview(input: Readonly<{
    workspaceId: string;
    agentProfileId?: string;
  }>): Promise<InstructionVersionPreview | null>;
}

export interface InstructionVersionService {
  execute(command: InstructionVersionCommand): Promise<InstructionVersionExecution>;
  preview(input: Readonly<{
    workspaceId: string;
    actor: TrustedActorContext;
    agentProfileId?: string;
  }>): Promise<InstructionVersionPreview | null>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const writePolicy = {
  actionCategory: 'write',
  surface: 'control_plane',
  environment: 'development'
} as const;
const readPolicy = {
  actionCategory: 'read',
  surface: 'control_plane',
  environment: 'development'
} as const;

const invalid = (message: string): InstructionVersionExecution => ({
  status: 'rejected',
  error: {code: 'INVALID_COMMAND', message}
});

const commandShapeIsValid = (command: InstructionVersionCommand): boolean => {
  if (
    !isTrustedActorContext(command.actor) ||
    !uuidPattern.test(command.commandId) ||
    !uuidPattern.test(command.workspaceId) ||
    !uuidPattern.test(command.correlationId) ||
    command.idempotencyKey.length === 0 ||
    command.idempotencyKey.length > 256 ||
    new Date(command.issuedAt).toISOString() !== command.issuedAt ||
    !uuidPattern.test(command.payload.versionId) ||
    !uuidPattern.test(command.payload.approvedByActorId)
  ) return false;
  if (
    command.payload.scope === 'agent_profile' &&
    !uuidPattern.test(command.payload.agentProfileId)
  ) return false;
  if (command.type === 'instruction_version.publish') {
    return (
      command.payload.expectedVersion === null ||
      Number.isInteger(command.payload.expectedVersion) && command.payload.expectedVersion > 0
    );
  }
  return (
    Number.isInteger(command.payload.expectedVersion) &&
    command.payload.expectedVersion > 0 &&
    uuidPattern.test(command.payload.rollbackOfVersionId)
  );
};

const requestHashFor = (command: InstructionVersionCommand): string =>
  createHash('sha256').update(canonicalJson({
    workspaceId: command.workspaceId,
    actor: {
      actorId: command.actor.actorId,
      actorType: command.actor.actorType,
      capabilities: [...command.actor.capabilities].sort()
    },
    type: command.type,
    payload: command.payload
  })).digest('hex');

export const createInstructionVersionService = (
  store: InstructionVersionStore
): InstructionVersionService => ({
  async execute(command) {
    try {
      if (!commandShapeIsValid(command)) return invalid('Instruction version command is not canonical.');
    } catch {
      return invalid('Instruction version command is not canonical.');
    }
    if (command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') {
      return {
        status: 'rejected',
        error: {
          code: 'INVALID_ACTOR_CONTEXT',
          message: 'Instruction versions require an authenticated human publisher.'
        }
      };
    }
    if (command.payload.approvedByActorId !== command.actor.actorId) {
      return invalid('Instruction version approval must identify the authenticated publisher.');
    }
    if (command.type === 'instruction_version.publish') {
      const content = validateInstructionContent(command.payload.content);
      if (!content.ok) return {status: 'rejected', error: content.error};
    }
    const authorization = authorize(command.actor, writePolicy);
    const executed = await store.execute({
      command,
      requestHash: requestHashFor(command),
      authorized: authorization.ok,
      ...(!authorization.ok ? {policyError: authorization.error} : {})
    });
    if (executed.status === 'key_reused') {
      return {
        status: 'key_reused',
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency key was already used for a different request.'
        }
      };
    }
    return executed;
  },

  async preview(input) {
    if (
      !isTrustedActorContext(input.actor) ||
      !uuidPattern.test(input.workspaceId) ||
      (input.agentProfileId !== undefined && !uuidPattern.test(input.agentProfileId))
    ) return null;
    const authorization = authorize(input.actor, readPolicy);
    if (!authorization.ok) return null;
    return store.preview({
      workspaceId: input.workspaceId,
      ...(input.agentProfileId === undefined ? {} : {agentProfileId: input.agentProfileId})
    });
  }
});
