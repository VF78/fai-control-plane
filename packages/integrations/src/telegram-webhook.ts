import {createHmac, timingSafeEqual} from 'node:crypto';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';

export const MAX_TELEGRAM_WEBHOOK_BODY_BYTES = 256 * 1024;

const telegramJsonMediaTypePattern =
  /^[ \t]*application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?[ \t]*$/i;
const identityPattern = /^tgid:v1:[0-9a-f]{64}$/;

export type TelegramWebhookConfig = Readonly<{
  webhookSecretRef: OpaqueSecretRef;
  allowedUserIds: readonly number[];
  allowedPrivateChatIds: readonly number[];
}>;

export type TelegramWebhookRejectionCode =
  | 'telegram_headers_invalid'
  | 'telegram_media_type_invalid'
  | 'telegram_secret_missing'
  | 'telegram_secret_invalid'
  | 'telegram_secret_config_invalid'
  | 'telegram_secret_unavailable'
  | 'telegram_body_too_large'
  | 'telegram_body_stream_invalid'
  | 'telegram_json_invalid'
  | 'telegram_update_unsupported'
  | 'telegram_payload_invalid'
  | 'telegram_chat_unauthorized'
  | 'telegram_actor_unauthorized'
  | 'telegram_command_unsupported';

export type TelegramWebhookResult =
  | Readonly<{
      outcome: 'accepted';
      projection: Readonly<{
        provider: 'telegram';
        deliveryId: string;
        eventType: 'chat_command';
        action: 'status';
        payloadSha256: string;
        source: Readonly<{
          kind: 'telegram';
          messageId: string;
          chatId: string;
          userId: string;
        }>;
        projection: Readonly<{command: Readonly<{name: 'status'}>}>;
      }>;
    }>
  | Readonly<{outcome: 'rejected'; code: TelegramWebhookRejectionCode}>;

export type TelegramWebhookBodyReadResult =
  | Readonly<{ok: true; body: Uint8Array}>
  | Readonly<{
      ok: false;
      code: 'telegram_body_too_large' | 'telegram_body_stream_invalid';
    }>;

const snapshotObject = (value: unknown): Record<string, unknown> | null => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return null;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
};

const snapshotArray = (value: unknown, maximumLength: number): unknown[] | null => {
  try {
    if (!Array.isArray(value) || value.length > maximumLength) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1) return null;
    return value.map((item) => item);
  } catch {
    return null;
  }
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const reject = (code: TelegramWebhookRejectionCode): TelegramWebhookResult => ({
  outcome: 'rejected', code
});

const snapshotSecretRef = (value: unknown): OpaqueSecretRef | null => {
  const reference = snapshotObject(value);
  if (reference === null || !exactKeys(reference, ['provider', 'reference', 'scope'])) {
    return null;
  }
  const scope = snapshotArray(reference.scope, 8);
  if (
    typeof reference.provider !== 'string' || reference.provider.length === 0 ||
    typeof reference.reference !== 'string' || reference.reference.length === 0 ||
    scope === null || !scope.every((entry) => typeof entry === 'string' && entry.length > 0)
  ) {
    return null;
  }
  return {provider: reference.provider, reference: reference.reference, scope: scope as string[]};
};

const parseAllowlist = (value: unknown): number[] | null => {
  const entries = snapshotArray(value, 256);
  if (entries === null || entries.length === 0 || !entries.every(positiveSafeInteger)) {
    return null;
  }
  const ids = entries as number[];
  return new Set(ids).size === ids.length ? [...ids] : null;
};

export const createTelegramWebhookConfig = (input: unknown): TelegramWebhookConfig => {
  const value = snapshotObject(input);
  if (value === null || !exactKeys(value, [
    'allowedPrivateChatIds', 'allowedUserIds', 'webhookSecretRef'
  ])) {
    throw new Error('Telegram webhook configuration is invalid.');
  }
  const webhookSecretRef = snapshotSecretRef(value.webhookSecretRef);
  const allowedUserIds = parseAllowlist(value.allowedUserIds);
  const allowedPrivateChatIds = parseAllowlist(value.allowedPrivateChatIds);
  if (webhookSecretRef === null || allowedUserIds === null || allowedPrivateChatIds === null) {
    throw new Error('Telegram webhook configuration is invalid.');
  }
  return Object.freeze({
    webhookSecretRef: Object.freeze({
      provider: webhookSecretRef.provider,
      reference: webhookSecretRef.reference,
      scope: Object.freeze([...webhookSecretRef.scope])
    }),
    allowedUserIds: Object.freeze(allowedUserIds),
    allowedPrivateChatIds: Object.freeze(allowedPrivateChatIds)
  });
};

const header = (headers: Headers, name: string): string | undefined => {
  const value = headers.get(name);
  return value === null ? undefined : value;
};

const declaredLengthTooLarge = (value: string | undefined): boolean =>
  value !== undefined && (!/^\d+$/.test(value) || Number(value) > MAX_TELEGRAM_WEBHOOK_BODY_BYTES);

export const readTelegramWebhookBody = async (
  stream: ReadableStream<Uint8Array>,
  declaredContentLength?: string
): Promise<TelegramWebhookBodyReadResult> => {
  if (declaredLengthTooLarge(declaredContentLength)) {
    return {ok: false, code: 'telegram_body_too_large'};
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return {ok: false, code: 'telegram_body_stream_invalid'};
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        return {ok: false, code: 'telegram_body_stream_invalid'};
      }
      size += next.value.byteLength;
      if (size > MAX_TELEGRAM_WEBHOOK_BODY_BYTES) {
        return {ok: false, code: 'telegram_body_too_large'};
      }
      const copy = new Uint8Array(next.value.byteLength);
      copy.set(next.value);
      chunks.push(copy);
    }
  } catch {
    return {ok: false, code: 'telegram_body_stream_invalid'};
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {ok: true, body};
};

const keyedId = (secret: string, kind: string, value: number): string =>
  `tgid:v1:${createHmac('sha256', secret)
    .update(`telegram:${kind}:${value}`)
    .digest('hex')}`;

const parsesUpdate = (body: Uint8Array): Record<string, unknown> | null => {
  try {
    return snapshotObject(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body)));
  } catch {
    return null;
  }
};

const projectUpdate = (
  config: TelegramWebhookConfig,
  secret: string,
  body: Uint8Array
): TelegramWebhookResult => {
  const update = parsesUpdate(body);
  if (update === null) return reject('telegram_json_invalid');
  if (!exactKeys(update, ['message', 'update_id'])) return reject('telegram_update_unsupported');
  if (!positiveSafeInteger(update.update_id)) return reject('telegram_payload_invalid');
  const message = snapshotObject(update.message);
  if (message === null) return reject('telegram_payload_invalid');
  const messageId = message.message_id;
  const text = message.text;
  const chat = snapshotObject(message.chat);
  const actor = snapshotObject(message.from);
  if (
    !positiveSafeInteger(messageId) || typeof text !== 'string' ||
    chat === null || actor === null ||
    !positiveSafeInteger(chat.id) || chat.type !== 'private' ||
    !positiveSafeInteger(actor.id)
  ) {
    return reject('telegram_payload_invalid');
  }
  if (!config.allowedPrivateChatIds.includes(chat.id)) return reject('telegram_chat_unauthorized');
  if (!config.allowedUserIds.includes(actor.id)) return reject('telegram_actor_unauthorized');
  if (text !== '/status') return reject('telegram_command_unsupported');

  return {
    outcome: 'accepted',
    projection: {
      provider: 'telegram',
      deliveryId: keyedId(secret, 'update', update.update_id),
      eventType: 'chat_command',
      action: 'status',
      payloadSha256: createHmac('sha256', secret)
        .update('telegram:payload:v1\0')
        .update(body)
        .digest('hex'),
      source: {
        kind: 'telegram',
        messageId: keyedId(secret, 'message', messageId),
        chatId: keyedId(secret, 'chat', chat.id),
        userId: keyedId(secret, 'user', actor.id)
      },
      projection: {command: {name: 'status'}}
    }
  };
};

export const verifyAndProjectTelegramWebhook = async (input: Readonly<{
  config: TelegramWebhookConfig;
  secrets: SecretsProvider;
  headers: Headers;
  body: Uint8Array;
}>): Promise<TelegramWebhookResult> => {
  const contentType = header(input.headers, 'content-type');
  const suppliedSecret = header(input.headers, 'x-telegram-bot-api-secret-token');
  if (contentType === undefined || !telegramJsonMediaTypePattern.test(contentType)) {
    return reject('telegram_media_type_invalid');
  }
  if (suppliedSecret === undefined || suppliedSecret.length === 0 || suppliedSecret.length > 256) {
    return reject('telegram_secret_missing');
  }
  if (!(input.body instanceof Uint8Array) || input.body.byteLength > MAX_TELEGRAM_WEBHOOK_BODY_BYTES) {
    return reject('telegram_body_too_large');
  }
  let expectedSecret: string;
  try {
    expectedSecret = (await input.secrets.resolve(
      input.config.webhookSecretRef,
      'telegram.webhook.verify'
    )).value;
  } catch {
    return reject('telegram_secret_unavailable');
  }
  if (
    typeof expectedSecret !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(expectedSecret)
  ) {
    return reject('telegram_secret_config_invalid');
  }
  const expected = Buffer.from(expectedSecret, 'utf8');
  const supplied = Buffer.from(suppliedSecret, 'utf8');
  if (
    expected.length === 0 || expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    return reject('telegram_secret_invalid');
  }
  return projectUpdate(input.config, expectedSecret, input.body);
};

export const isTelegramKeyedIdentifier = (value: string): boolean => identityPattern.test(value);
