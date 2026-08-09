import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  isTrustedActorContext,
  type CanonicalCommandEnvelope,
  type CommandError
} from '@fai-control-plane/domain';

export const CONVERSATION_CHANNEL_SET_COMMAND = 'conversation_channel.set.v1' as const;
export const conversationChannelStates = ['active', 'inactive', 'not_used'] as const;
export type ConversationChannelState = (typeof conversationChannelStates)[number];

type Payload = Readonly<{
  projectId: string;
  channelId: string;
  conversationClass: 'internal' | 'client';
  desiredState: ConversationChannelState;
  provider: string | null;
  configurationRef: string | null;
  expectedVersion: number | null;
}>;
export type SetConversationChannelCommand = CanonicalCommandEnvelope<
  typeof CONVERSATION_CHANNEL_SET_COMMAND,
  Payload
>;
export type ConversationChannelValue = Readonly<{
  projectId: string;
  channelId: string;
  conversationClass: 'internal' | 'client';
  desiredState: ConversationChannelState;
  provider: string | null;
  configurationRef: string | null;
  version: number;
}>;
export type ConversationChannelReceipt = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  requestHash: string;
  commandType: typeof CONVERSATION_CHANNEL_SET_COMMAND;
  result: Readonly<{ok: true; value: ConversationChannelValue}> |
    Readonly<{ok: false; error: CommandError}>;
  createdAt: string;
}>;
export type ConversationChannelExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: ConversationChannelReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;
export interface ConversationChannelStore {
  execute(input: Readonly<{
    command: SetConversationChannelCommand;
    requestHash: string;
    authorized: boolean;
    policyError?: CommandError;
  }>): Promise<
    Readonly<{status: 'completed' | 'replayed'; receipt: ConversationChannelReceipt}> |
    Readonly<{status: 'key_reused'; existingRequestHash: string}>
  >;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const provider = /^[a-z][a-z0-9_-]{0,63}$/;
const configurationRef = /^[a-z][a-z0-9._:-]{0,127}$/;
const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const validPayload = (payload: Payload): boolean =>
  uuid.test(payload.projectId) && uuid.test(payload.channelId) &&
  (payload.conversationClass === 'internal' || payload.conversationClass === 'client') &&
  conversationChannelStates.includes(payload.desiredState) &&
  (payload.expectedVersion === null || (Number.isSafeInteger(payload.expectedVersion) && payload.expectedVersion > 0)) &&
  (payload.desiredState === 'not_used'
    ? payload.provider === null && payload.configurationRef === null
    : typeof payload.provider === 'string' && provider.test(payload.provider) &&
      typeof payload.configurationRef === 'string' && configurationRef.test(payload.configurationRef));
const valid = (command: SetConversationChannelCommand): boolean =>
  typeof command === 'object' && command !== null &&
  exact(command, ['commandId', 'workspaceId', 'correlationId', 'idempotencyKey', 'issuedAt', 'actor', 'type', 'payload']) &&
  isTrustedActorContext(command.actor) && uuid.test(command.commandId) && uuid.test(command.workspaceId) &&
  uuid.test(command.correlationId) && timestamp(command.issuedAt) &&
  command.type === CONVERSATION_CHANNEL_SET_COMMAND && typeof command.payload === 'object' &&
  command.payload !== null && exact(command.payload, [
    'projectId', 'channelId', 'conversationClass', 'desiredState', 'provider',
    'configurationRef', 'expectedVersion'
  ]) && validPayload(command.payload) &&
  command.idempotencyKey === [
    'conversation-channel-set:v1', command.payload.channelId,
    command.payload.expectedVersion ?? 0, command.payload.desiredState, command.actor.actorId
  ].join(':');

export const createConversationChannelService = (store: ConversationChannelStore) => ({
  async execute(command: SetConversationChannelCommand): Promise<ConversationChannelExecution> {
    if (!valid(command)) return {
      status: 'rejected',
      error: {code: 'INVALID_COMMAND', message: 'Conversation channel command is not canonical.'}
    };
    if (command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') return {
      status: 'rejected',
      error: {code: 'INVALID_ACTOR_CONTEXT', message: 'Conversation management requires an authenticated human.'}
    };
    // The authenticated manager POST is the human approval boundary. The canonical
    // command therefore uses the normal Control Plane write capability; the audit
    // event remains categorized as an access change.
    const policy = authorize(command.actor, {
      actionCategory: 'write', surface: 'control_plane', environment: 'development'
    });
    const requestHash = createHash('sha256').update(canonicalJson({
      workspaceId: command.workspaceId,
      idempotencyKey: command.idempotencyKey,
      actorId: command.actor.actorId,
      type: command.type,
      payload: command.payload
    } as never)).digest('hex');
    const result = await store.execute({
      command,
      requestHash,
      authorized: policy.ok,
      ...(!policy.ok ? {policyError: policy.error} : {})
    });
    return result.status === 'key_reused' ? {
      status: 'key_reused',
      error: {code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was reused.'}
    } : result;
  }
});
