import {createHash, timingSafeEqual} from 'node:crypto';
import type {MessengerDeliveryPort, MessengerIngressPort, OpaqueSecretRef, SecretResolverPort} from '@fai-control-plane/domain';

type Fetch = typeof globalThis.fetch;
const applicationTokenPurpose = 'messenger_webhook_verify';
const restTokenPurpose = 'messenger_delivery';
const bounded = (value: unknown, maximum = 4_000): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const ref = (kind: string, value: string): string =>
  createHash('sha256').update(`${kind}\0${value}`).digest('hex');
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export type Bitrix24Config = Readonly<{
  portalUrl: string; memberId: string; taskId: number; projectId: string; allowedAuthorIds: readonly number[];
  applicationTokenRef: OpaqueSecretRef; restTokenRef: OpaqueSecretRef;
}>;

const validate = (config: Bitrix24Config): void => {
  const portal = new URL(config.portalUrl);
  if (portal.protocol !== 'https:' || portal.pathname !== '/' || portal.search !== '' || portal.hash !== '' ||
    !bounded(config.memberId, 128) || !positive(config.taskId) || config.allowedAuthorIds.length === 0) {
    throw new Error('bitrix24_config_invalid');
  }
};

const call = async (request: Fetch, portal: string, path: string, token: string, body: object): Promise<Record<string, unknown> | null> => {
  try {
    const response = await request(new URL(path, portal), {method: 'POST',
      headers: {'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify({...body, auth: token}), signal: AbortSignal.timeout(10_000)});
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 262_144) return null;
    const text = await response.text();
    return text.length <= 262_144 ? object(JSON.parse(text)) : null;
  } catch { return null; }
};

export const createBitrix24IngressAdapter = (input: Readonly<{
  config: Bitrix24Config; secrets: SecretResolverPort; fetch?: Fetch;
}>): MessengerIngressPort => {
  validate(input.config);
  const request = input.fetch ?? globalThis.fetch;
  return {async receive(inbound) {
    if (!inbound.headers['content-type']?.startsWith('application/x-www-form-urlencoded') || inbound.body.byteLength > 64_000) {
      return {status: 'rejected', reason: 'request_invalid'};
    }
    const params = new URLSearchParams(new TextDecoder().decode(inbound.body));
    const token = params.get('auth[application_token]');
    const domain = params.get('auth[domain]');
    const memberId = params.get('auth[member_id]');
    const event = params.get('event');
    const taskId = Number(params.get('data[FIELDS_AFTER][TASK_ID]'));
    const messageId = Number(params.get('data[FIELDS_AFTER][MESSAGE_ID]'));
    const expected = (await input.secrets.resolve(input.config.applicationTokenRef, applicationTokenPurpose)).value;
    if (!bounded(token) || !equal(token, expected) || event !== 'ONTASKCOMMENTADD' ||
      domain !== new URL(input.config.portalUrl).hostname || memberId !== input.config.memberId ||
      taskId !== input.config.taskId || !positive(messageId)) return {status: 'rejected', reason: 'source_denied'};
    const rest = (await input.secrets.resolve(input.config.restTokenRef, restTokenPurpose)).value;
    const task = await call(request, input.config.portalUrl, '/rest/api/tasks.task.get', rest,
      {id: taskId, select: ['id', 'chat.id']});
    const item = object(object(task?.result)?.item);
    const chatId = object(item?.chat)?.id ?? item?.chatId;
    if (!(item?.id === taskId || item?.id === String(taskId)) || !positive(chatId)) {
      return {status: 'rejected', reason: 'source_unavailable'};
    }
    const messages = await call(request, input.config.portalUrl, '/rest/im.dialog.messages.get', rest,
      {DIALOG_ID: `chat${chatId}`, FIRST_ID: messageId - 1, LIMIT: 1});
    const result = object(messages?.result);
    const source = Array.isArray(result?.messages) ? result.messages.map(object).find((candidate): candidate is Record<string, unknown> =>
      candidate?.id === messageId && candidate.chat_id === chatId) : undefined;
    if (source === undefined || source === null || !positive(source.author_id) || !bounded(source.text) ||
      !bounded(source.date, 64) || Number.isNaN(Date.parse(source.date))) {
      return {status: 'rejected', reason: 'source_unavailable'};
    }
    if (!input.config.allowedAuthorIds.includes(source.author_id)) return {status: 'rejected', reason: 'sender_denied'};
    const delivery = ref('bitrix24-delivery', `${taskId}:${messageId}`);
    return {status: 'accepted', message: {projectId: input.config.projectId, contour: 'client-edge',
      channelReference: ref('bitrix24-channel', `${taskId}:${chatId}`),
      senderReference: ref('bitrix24', String(source.author_id)),
      messageReference: ref('bitrix24-message', String(messageId)),
      observedAt: new Date(source.date).toISOString(), text: source.text,
      correlationId: `conversation:${delivery}`, idempotencyKey: `conversation:${delivery}`}};
  }};
};

export const createBitrix24DeliveryAdapter = (input: Readonly<{
  config: Bitrix24Config; secrets: SecretResolverPort; fetch?: Fetch;
}>): MessengerDeliveryPort => {
  validate(input.config);
  return {async send(message) {
    if (message.projectId !== input.config.projectId || message.contour !== 'client-edge' || !bounded(message.text)) {
      throw new Error('bitrix24_message_invalid');
    }
    const token = (await input.secrets.resolve(input.config.restTokenRef, restTokenPurpose)).value;
    const response = await call(input.fetch ?? globalThis.fetch, input.config.portalUrl,
      '/rest/api/tasks.task.chat.message.send', token, {fields: {taskId: input.config.taskId, text: message.text}});
    const result = object(response?.result); const item = object(result?.item);
    const id = item?.id ?? result?.id;
    if (!(positive(id) || bounded(id, 256))) throw new Error('bitrix24_delivery_failed');
    return {deliveryReference: `bitrix24:${id}`};
  }};
};
