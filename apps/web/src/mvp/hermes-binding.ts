import {createHash} from 'node:crypto';
import {subjectHash} from '@fai-control-plane/db';
import {parseConversationEnvelope} from '@fai-control-plane/domain';
import type {ReceiptBoundRoleRun} from '@fai-control-plane/application';

export type HermesProfile = 'internal' | 'bitrix-client';
type Source = Readonly<{provider: 'telegram'; updateId: string; messageId: string; userId: string; chatId: string;
  observedAt: string}> | Readonly<{provider: 'bitrix-browser'; taskId: string; messageId: string; authorId: string;
  observedAt: string}> | Readonly<{provider: 'agent-role-run'; sessionId: string}>;

const bounded = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new Error('body_invalid');
  return value;
};
const ref = (kind: string, value: string): string => createHash('sha256').update(`${kind}\0${value}`).digest('hex');

export const bindHermesConversation = (input: Readonly<{profile: HermesProfile; source: Source; action: unknown;
  projectId: string; telegramChatId: string; telegramUserIds: readonly string[]; bitrixTaskId: string;
  roleRun?: ReceiptBoundRoleRun}>) => {
  let contour: 'trusted-main' | 'client-edge'; let senderReference: string; let channelReference: string;
  let messageReference: string; let deliveryReference: string;
  if (input.profile === 'internal' && input.source.provider === 'agent-role-run') {
    if (input.roleRun === undefined || input.source.sessionId !== input.roleRun.sessionId ||
      input.roleRun.projectId !== input.projectId) throw new Error('identity_denied');
    contour = 'trusted-main'; senderReference = ref('agent-role-run-actor', input.roleRun.actorId);
    channelReference = ref('agent-role-run-channel', input.roleRun.projectId);
    messageReference = ref('agent-role-run-message', input.roleRun.sessionId);
    deliveryReference = ref('agent-role-run-delivery', `${input.roleRun.sessionId}\0${JSON.stringify(input.action)}`);
  } else if (input.profile === 'internal') {
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
  const roleRun = input.source.provider === 'agent-role-run' ? input.roleRun : undefined;
  const envelope = parseConversationEnvelope({message: {projectId: input.projectId, contour, channelReference,
    senderReference, messageReference,
    observedAt: roleRun?.occurredAt ?? bounded('observedAt' in input.source ? input.source.observedAt : ''),
    text: 'Hermes structured conversation action', correlationId: roleRun?.sessionId ?? `conversation:${deliveryReference}`,
    idempotencyKey: `conversation:${deliveryReference}`}, action: input.action});
  if (envelope === null) throw new Error('body_invalid');
  const allowed = input.profile === 'internal'
    ? ['project_facts.read', 'project_context.read', 'issue.create', 'issue.update', 'issue.clarify', 'project_item.stage', 'source.add', 'approval.decide']
    : ['issue.create', 'issue.clarify'];
  if (!allowed.includes(envelope.action.type)) throw new Error('action_denied');
  return envelope;
};
