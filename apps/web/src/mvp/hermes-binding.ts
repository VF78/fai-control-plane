import {createHash} from 'node:crypto';
import {subjectHash} from '@fai-control-plane/db';
import {parseConversationEnvelope} from '@fai-control-plane/domain';

export type HermesProfile = 'internal';
type Source = Readonly<{provider: 'telegram'; updateId: string; messageId: string; userId: string; chatId: string;
  observedAt: string}>;

const bounded = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new Error('body_invalid');
  return value;
};
const ref = (kind: string, value: string): string => createHash('sha256').update(`${kind}\0${value}`).digest('hex');

export const bindHermesConversation = (input: Readonly<{profile: HermesProfile; source: Source; action: unknown;
  projectId: string; telegramChatId: string; telegramUserIds: readonly string[]}>) => {
  if (input.source.chatId !== input.telegramChatId || !input.telegramUserIds.includes(input.source.userId) ||
    !/^[0-9]{1,20}$/.test(input.source.updateId) || !/^[0-9]{1,20}$/.test(input.source.messageId)) {
    throw new Error('identity_denied');
  }
  const contour = 'trusted-main';
  const senderReference = subjectHash('telegram', input.source.userId);
  const channelReference = ref('telegram-channel', input.source.chatId);
  const messageReference = ref('telegram-message', input.source.messageId);
  const deliveryReference = ref('telegram-delivery', input.source.updateId);
  const envelope = parseConversationEnvelope({message: {projectId: input.projectId, contour, channelReference,
    senderReference, messageReference,
    observedAt: bounded(input.source.observedAt),
    text: 'Hermes structured conversation action', correlationId: `conversation:${deliveryReference}`,
    idempotencyKey: `conversation:${deliveryReference}`}, action: input.action});
  if (envelope === null) throw new Error('body_invalid');
  const allowed = ['project_context.read', 'project.execution.mode', 'source.add', 'approval.decide'];
  if (!allowed.includes(envelope.action.type)) throw new Error('action_denied');
  return envelope;
};
