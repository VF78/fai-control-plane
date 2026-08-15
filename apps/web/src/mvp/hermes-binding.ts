import {createHash} from 'node:crypto';
import {subjectHash} from '@fai-control-plane/db';
import {parseConversationEnvelope} from '@fai-control-plane/domain';

export type HermesProfile = 'internal' | 'bitrix-client';
type Source = Readonly<{provider: 'telegram'; updateId: string; messageId: string; userId: string; chatId: string;
  observedAt: string}> | Readonly<{provider: 'bitrix-browser'; taskId: string; messageId: string; authorId: string;
  observedAt: string}>;

const bounded = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new Error('body_invalid');
  return value;
};
const ref = (kind: string, value: string): string => createHash('sha256').update(`${kind}\0${value}`).digest('hex');

export const bindHermesConversation = (input: Readonly<{profile: HermesProfile; source: Source; action: unknown;
  projectId: string; telegramChatId: string; telegramUserIds: readonly string[]; bitrixTaskId: string}>) => {
  let contour: 'trusted-main' | 'client-edge'; let senderReference: string; let channelReference: string;
  let messageReference: string; let deliveryReference: string;
  if (input.profile === 'internal') {
    if (input.source.provider !== 'telegram' || input.source.chatId !== input.telegramChatId ||
      !input.telegramUserIds.includes(input.source.userId) || !/^[0-9]{1,20}$/.test(input.source.updateId) ||
      !/^[0-9]{1,20}$/.test(input.source.messageId)) throw new Error('identity_denied');
    contour = 'trusted-main'; senderReference = subjectHash('telegram', input.source.userId);
    channelReference = ref('telegram-channel', input.source.chatId);
    messageReference = ref('telegram-message', input.source.messageId);
    deliveryReference = ref('telegram-delivery', input.source.updateId);
  } else {
    if (input.source.provider !== 'bitrix-browser' || input.source.taskId !== input.bitrixTaskId) throw new Error('identity_denied');
    contour = 'client-edge'; senderReference = subjectHash('bitrix24', bounded(input.source.authorId));
    channelReference = ref('bitrix-task', input.source.taskId);
    messageReference = ref('bitrix-message', `${input.source.taskId}:${bounded(input.source.messageId)}`);
    deliveryReference = ref('bitrix-delivery', `${input.source.taskId}:${input.source.messageId}`);
  }
  const envelope = parseConversationEnvelope({message: {projectId: input.projectId, contour, channelReference,
    senderReference, messageReference, observedAt: bounded(input.source.observedAt),
    text: 'Hermes structured conversation action', correlationId: `conversation:${deliveryReference}`,
    idempotencyKey: `conversation:${deliveryReference}`}, action: input.action});
  if (envelope === null) throw new Error('body_invalid');
  const allowed = input.profile === 'internal'
    ? ['project_facts.read', 'issue.create', 'issue.clarify', 'source.add', 'approval.decide', 'agent.submit']
    : ['issue.create', 'issue.clarify'];
  if (!allowed.includes(envelope.action.type)) throw new Error('action_denied');
  return envelope;
};
