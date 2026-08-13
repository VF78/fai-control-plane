import {createHmac, timingSafeEqual} from 'node:crypto';
import type {ConversationInboundMessage, OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {validateConversationInboundMessage} from '@fai-control-plane/domain';

type Fetch = typeof globalThis.fetch;

export const MAX_BITRIX24_EVENT_BODY_BYTES = 256 * 1024;
export const MAX_BITRIX24_REST_BODY_BYTES = 256 * 1024;
export const bitrix24ApplicationTokenPurpose = 'bitrix24.event.verify';
export const bitrix24RestTokenPurpose = 'bitrix24.rest.call';
export const bitrix24IdentitySecretPurpose = 'bitrix24.identity.keying';

export type Bitrix24MessengerConfig = Readonly<{
  portalUrl: string;
  memberId: string;
  taskId: number;
  projectRef: string;
  applicationTokenRef: OpaqueSecretRef;
  restTokenRef: OpaqueSecretRef;
  identitySecretRef: OpaqueSecretRef;
  allowedAuthorIds: readonly number[];
}>;

export type Bitrix24IngressRequest = Readonly<{
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
}>;

export type Bitrix24IngressResult =
  | Readonly<{status: 'accepted'; message: ConversationInboundMessage}>
  | Readonly<{status: 'rejected'; reason:
      'authentication_failed' | 'body_invalid' | 'body_too_large' | 'media_type_invalid' |
      'sender_denied' | 'source_mismatch' | 'source_unavailable' | 'unsupported_event'}>;

export type Bitrix24MessengerIngressPort = Readonly<{
  receive(request: Bitrix24IngressRequest): Promise<Bitrix24IngressResult>;
}>;

export type Bitrix24MessengerDeliveryPort = Readonly<{
  sendNotification(input: Readonly<{text: string}>): Promise<Readonly<{deliveryReference: string}>>;
}>;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const bounded = (value: unknown, maximum = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\0\r\n]/.test(value);
const header = (headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
const equalSecret = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const keyedReference = (secret: string, kind: string, value: string): string =>
  `b24id:v1:${createHmac('sha256', secret).update(`${kind}\0${value}`).digest('hex')}`;
const validPortal = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' &&
      parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
};
const portalHost = (value: string): string => new URL(value).hostname.toLowerCase();
const formValue = (values: Map<string, string[]>, key: string): string | null => {
  const value = values.get(key);
  return value?.length === 1 ? value[0]! : null;
};

const validateConfig = (config: Bitrix24MessengerConfig): void => {
  if (!validPortal(config.portalUrl) || !bounded(config.memberId, 128) || !positiveInteger(config.taskId) ||
    !bounded(config.projectRef) || config.allowedAuthorIds.length === 0 ||
    config.allowedAuthorIds.some((id) => !positiveInteger(id)) ||
    new Set(config.allowedAuthorIds).size !== config.allowedAuthorIds.length) {
    throw new Error('bitrix24_messenger_config_invalid');
  }
};

const parseEvent = (body: Uint8Array): Readonly<{
  applicationToken: string; domain: string; memberId: string; taskId: number; messageId: number;
}> | null => {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', {fatal: true}).decode(body);
  } catch {
    return null;
  }
  const params = new URLSearchParams(decoded);
  const values = new Map<string, string[]>();
  for (const [key, value] of params) {
    if (key.length > 128 || value.length > 8_192 || values.size > 32) return null;
    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }
  const event = formValue(values, 'event');
  const token = formValue(values, 'auth[application_token]');
  const domain = formValue(values, 'auth[domain]');
  const memberId = formValue(values, 'auth[member_id]');
  const taskId = Number(formValue(values, 'data[FIELDS_AFTER][TASK_ID]'));
  const messageId = Number(formValue(values, 'data[FIELDS_AFTER][MESSAGE_ID]'));
  const commentId = formValue(values, 'data[FIELDS_AFTER][ID]');
  if (event !== 'ONTASKCOMMENTADD' || !bounded(token, 4_096) || !bounded(domain, 253) ||
    domain !== domain.toLowerCase() || !bounded(memberId, 128) ||
    !positiveInteger(taskId) || !positiveInteger(messageId) || commentId !== '0') return null;
  return {applicationToken: token, domain, memberId, taskId, messageId};
};

const readJson = async (response: Response): Promise<Record<string, unknown> | null> => {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BITRIX24_REST_BODY_BYTES) return null;
      chunks.push(next.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return object(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body)));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
};

const call = async (
  request: Fetch, portalUrl: string, path: string, token: string, body: Record<string, unknown>
): Promise<Readonly<{ok: boolean; payload: Record<string, unknown> | null}>> => {
  try {
    const response = await request(new URL(path, portalUrl), {
      method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify({...body, auth: token}), signal: AbortSignal.timeout(5_000)
    });
    return {ok: response.ok, payload: await readJson(response)};
  } catch {
    return {ok: false, payload: null};
  }
};

const taskChatId = (payload: Record<string, unknown> | null, expectedTaskId: number): number | null => {
  const item = object(object(payload?.result)?.item);
  const chat = object(item?.chat);
  const id = item?.id;
  const chatId = chat?.id ?? item?.chatId;
  return (id === expectedTaskId || id === String(expectedTaskId)) && positiveInteger(chatId) ? chatId : null;
};

const sourceMessage = (payload: Record<string, unknown> | null, chatId: number, messageId: number) => {
  const result = object(payload?.result);
  const messages = result?.messages;
  if (!Array.isArray(messages) || messages.length > 50 || result?.chat_id !== chatId) return null;
  const message = messages.map(object).find(
    (candidate): candidate is Record<string, unknown> => candidate !== null && candidate.id === messageId
  );
  if (message === undefined || message.chat_id !== chatId || !positiveInteger(message.author_id) ||
    !bounded(message.text, 4_000) || !bounded(message.date, 64) || Number.isNaN(new Date(message.date).getTime())) return null;
  return {authorId: message.author_id, text: message.text, observedAt: new Date(message.date).toISOString()};
};

export const createBitrix24MessengerIngressAdapter = (input: Readonly<{
  config: Bitrix24MessengerConfig;
  secrets: SecretsProvider;
  fetch?: Fetch;
}>): Bitrix24MessengerIngressPort => {
  validateConfig(input.config);
  const request = input.fetch ?? globalThis.fetch;
  return {
    async receive(inbound) {
      const contentType = header(inbound.headers, 'content-type');
      if (contentType === undefined || !/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType)) {
        return {status: 'rejected', reason: 'media_type_invalid'};
      }
      if (inbound.body.byteLength > MAX_BITRIX24_EVENT_BODY_BYTES) return {status: 'rejected', reason: 'body_too_large'};
      const event = parseEvent(inbound.body);
      if (event === null) return {status: 'rejected', reason: 'body_invalid'};
      let applicationToken: string;
      let identitySecret: string;
      try {
        applicationToken = (await input.secrets.resolve(input.config.applicationTokenRef, bitrix24ApplicationTokenPurpose)).value;
        identitySecret = (await input.secrets.resolve(input.config.identitySecretRef, bitrix24IdentitySecretPurpose)).value;
      } catch {
        return {status: 'rejected', reason: 'authentication_failed'};
      }
      if (!bounded(applicationToken, 4_096) || !bounded(identitySecret, 4_096) ||
        !equalSecret(applicationToken, event.applicationToken)) return {status: 'rejected', reason: 'authentication_failed'};
      if (event.domain !== portalHost(input.config.portalUrl) ||
        event.memberId !== input.config.memberId || event.taskId !== input.config.taskId) {
        return {status: 'rejected', reason: 'source_mismatch'};
      }
      let restToken: string;
      try {
        restToken = (await input.secrets.resolve(input.config.restTokenRef, bitrix24RestTokenPurpose)).value;
      } catch {
        return {status: 'rejected', reason: 'source_unavailable'};
      }
      if (!bounded(restToken, 4_096)) return {status: 'rejected', reason: 'source_unavailable'};
      const task = await call(request, input.config.portalUrl, '/rest/api/tasks.task.get', restToken, {
        id: event.taskId, select: ['id', 'chat.id']
      });
      const chatId = task.ok ? taskChatId(task.payload, event.taskId) : null;
      if (chatId === null) return {status: 'rejected', reason: task.ok ? 'source_mismatch' : 'source_unavailable'};
      const messages = await call(request, input.config.portalUrl, '/rest/im.dialog.messages.get', restToken, {
        DIALOG_ID: `chat${chatId}`, FIRST_ID: event.messageId - 1, LIMIT: 1
      });
      const source = messages.ok ? sourceMessage(messages.payload, chatId, event.messageId) : null;
      if (source === null) return {status: 'rejected', reason: messages.ok ? 'source_mismatch' : 'source_unavailable'};
      if (!input.config.allowedAuthorIds.includes(source.authorId)) return {status: 'rejected', reason: 'sender_denied'};
      const channelRef = keyedReference(identitySecret, 'channel', `${event.taskId}:${chatId}`);
      const actorRef = keyedReference(identitySecret, 'actor', String(source.authorId));
      const messageRef = keyedReference(identitySecret, 'message', String(event.messageId));
      const deliveryRef = keyedReference(identitySecret, 'delivery', `${event.taskId}:${event.messageId}`);
      const message = validateConversationInboundMessage({
        projectRef: input.config.projectRef,
        origin: {visibility: 'client', channelRef, actorRef, messageRef, observedAt: source.observedAt},
        text: source.text, correlationId: `conversation:${deliveryRef}`, idempotencyKey: `conversation:${deliveryRef}`
      });
      return message === null ? {status: 'rejected', reason: 'body_invalid'} : {status: 'accepted', message};
    }
  };
};

export const createBitrix24MessengerDeliveryAdapter = (input: Readonly<{
  config: Bitrix24MessengerConfig;
  secrets: SecretsProvider;
  fetch?: Fetch;
}>): Bitrix24MessengerDeliveryPort => {
  validateConfig(input.config);
  const request = input.fetch ?? globalThis.fetch;
  return {
    async sendNotification(inputMessage) {
      if (!bounded(inputMessage.text, 4_000)) throw new Error('bitrix24_notification_invalid');
      const token = (await input.secrets.resolve(input.config.restTokenRef, bitrix24RestTokenPurpose)).value;
      if (!bounded(token, 4_096)) throw new Error('bitrix24_rest_token_invalid');
      const result = await call(request, input.config.portalUrl, '/rest/api/tasks.task.chat.message.send', token, {
        fields: {taskId: input.config.taskId, text: inputMessage.text}
      });
      const item = object(object(result.payload?.result)?.item);
      const messageId = item?.id ?? object(result.payload?.result)?.id;
      if (!result.ok || !positiveInteger(messageId)) throw new Error('bitrix24_notification_failed');
      return {deliveryReference: `bitrix24:${messageId}`};
    }
  };
};
