import {createHmac, timingSafeEqual} from 'node:crypto';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';

export const MAX_TELEGRAM_WEBHOOK_BODY_BYTES = 256 * 1024;
export const MAX_TELEGRAM_MESSAGE_TEXT = 4000;

const telegramJsonMediaTypePattern =
  /^[ \t]*application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?[ \t]*$/i;
const identityPattern = /^tgid:v1:[0-9a-f]{64}$/;

export type TelegramStatusProject = 'msa' | 'ascon';
export type TelegramConversationClass = 'internal' | 'client';
export type TelegramConversationBinding = Readonly<{
  chatId: number;
  project: TelegramStatusProject;
  conversationClass: TelegramConversationClass;
  activatedAt: Date;
}>;
export type TelegramWebhookConfig = Readonly<{
  webhookSecretRef: OpaqueSecretRef;
  identitySecretRef: OpaqueSecretRef;
  bindings: readonly TelegramConversationBinding[];
}>;
export type TelegramAttachmentMetadata = Readonly<{
  kind: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'sticker' | 'animation';
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
}>;

export type TelegramWebhookRejectionCode =
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
  | 'telegram_command_unsupported';

export type TelegramWebhookResult =
  | Readonly<{
      outcome: 'accepted';
      project: TelegramStatusProject;
      conversationClass: TelegramConversationClass;
      observation: Readonly<{
        provider: 'telegram';
        externalBindingRef: string;
        deliveryRef: string;
        messageRef: string;
        authorExternalSubject: string;
        authorDisplayName: string;
        sentAt: Date;
        replyToMessageRef: string | null;
        threadRef: string | null;
        text: string | null;
        attachments: readonly TelegramAttachmentMetadata[];
      }>;
    }>
  | Readonly<{outcome: 'rejected'; code: TelegramWebhookRejectionCode}>;

export type TelegramWebhookBodyReadResult =
  | Readonly<{ok: true; body: Uint8Array}>
  | Readonly<{ok: false; code: 'telegram_body_too_large' | 'telegram_body_stream_invalid'}>;

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const safeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
const positiveInteger = (value: unknown): value is number => safeInteger(value) && value > 0;
const boundedString = (value: unknown, maximum: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : undefined;
const reject = (code: TelegramWebhookRejectionCode): TelegramWebhookResult => ({
  outcome: 'rejected', code
});

const secretRef = (value: unknown): OpaqueSecretRef | null => {
  const candidate = object(value);
  if (
    candidate === null ||
    typeof candidate.provider !== 'string' ||
    typeof candidate.reference !== 'string' ||
    !Array.isArray(candidate.scope) ||
    !candidate.scope.every((entry) => typeof entry === 'string' && entry.length > 0)
  ) return null;
  return {
    provider: candidate.provider,
    reference: candidate.reference,
    scope: candidate.scope as string[]
  };
};

export const createTelegramWebhookConfig = (input: unknown): TelegramWebhookConfig => {
  const candidate = object(input);
  const webhookSecretRef = secretRef(candidate?.webhookSecretRef);
  const identitySecretRef = secretRef(candidate?.identitySecretRef);
  if (
    candidate === null ||
    webhookSecretRef === null ||
    identitySecretRef === null ||
    !Array.isArray(candidate.bindings) ||
    candidate.bindings.length === 0 ||
    candidate.bindings.length > 4
  ) throw new Error('Telegram webhook configuration is invalid.');
  const bindings = candidate.bindings.map((value): TelegramConversationBinding => {
    const binding = object(value);
    const activatedAt = binding?.activatedAt instanceof Date
      ? binding.activatedAt
      : new Date(typeof binding?.activatedAt === 'string' ? binding.activatedAt : Number.NaN);
    if (
      binding === null ||
      !safeInteger(binding.chatId) ||
      binding.chatId === 0 ||
      (binding.project !== 'msa' && binding.project !== 'ascon') ||
      (binding.conversationClass !== 'internal' && binding.conversationClass !== 'client') ||
      Number.isNaN(activatedAt.getTime())
    ) throw new Error('Telegram webhook configuration is invalid.');
    return {
      chatId: binding.chatId,
      project: binding.project,
      conversationClass: binding.conversationClass,
      activatedAt
    };
  });
  if (
    new Set(bindings.map(({chatId}) => chatId)).size !== bindings.length ||
    new Set(bindings.map(({project, conversationClass}) => `${project}:${conversationClass}`)).size !==
      bindings.length ||
    (webhookSecretRef.provider === identitySecretRef.provider &&
      webhookSecretRef.reference === identitySecretRef.reference)
  ) throw new Error('Telegram webhook configuration is ambiguous.');
  return Object.freeze({
    webhookSecretRef,
    identitySecretRef,
    bindings: Object.freeze(bindings)
  });
};

const declaredLengthTooLarge = (value: string | undefined): boolean =>
  value !== undefined && (!/^\d+$/.test(value) || Number(value) > MAX_TELEGRAM_WEBHOOK_BODY_BYTES);

export const readTelegramWebhookBody = async (
  stream: ReadableStream<Uint8Array>,
  declaredContentLength?: string
): Promise<TelegramWebhookBodyReadResult> => {
  if (declaredLengthTooLarge(declaredContentLength)) return {ok: false, code: 'telegram_body_too_large'};
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
      if (!(next.value instanceof Uint8Array)) return {ok: false, code: 'telegram_body_stream_invalid'};
      size += next.value.byteLength;
      if (size > MAX_TELEGRAM_WEBHOOK_BODY_BYTES) return {ok: false, code: 'telegram_body_too_large'};
      chunks.push(next.value.slice());
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

export const telegramKeyedIdentifier = (secret: string, kind: string, value: number): string =>
  `tgid:v1:${createHmac('sha256', secret).update(`telegram:${kind}:${value}`).digest('hex')}`;

const sanitizedText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const sanitized = value
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .normalize('NFC')
    .trim()
    .slice(0, MAX_TELEGRAM_MESSAGE_TEXT);
  return sanitized.length === 0 ? null : sanitized;
};

const sanitizedDisplayName = (actor: Record<string, unknown>): string => {
  const joined = [actor.first_name, actor.last_name]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return sanitizedText(joined)?.slice(0, 120) ?? 'Unresolved';
};

const attachment = (
  kind: TelegramAttachmentMetadata['kind'],
  value: unknown
): TelegramAttachmentMetadata | null => {
  const item = object(value);
  if (item === null) return null;
  const fileName = sanitizedText(item.file_name)?.slice(0, 180);
  const mimeType = boundedString(item.mime_type, 120);
  const sizeBytes = positiveInteger(item.file_size) ? item.file_size : undefined;
  return {
    kind,
    ...(fileName === undefined || fileName === null ? {} : {fileName}),
    ...(mimeType === undefined ? {} : {mimeType}),
    ...(sizeBytes === undefined ? {} : {sizeBytes})
  };
};

const attachmentMetadata = (message: Record<string, unknown>): TelegramAttachmentMetadata[] => {
  const result: TelegramAttachmentMetadata[] = [];
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : undefined;
  if (photo !== undefined && object(photo) !== null) result.push({kind: 'photo'});
  for (const kind of ['document', 'video', 'audio', 'voice', 'sticker', 'animation'] as const) {
    const metadata = attachment(kind, message[kind]);
    if (metadata !== null) result.push(metadata);
  }
  return result.slice(0, 10);
};

const parseUpdate = (body: Uint8Array): Record<string, unknown> | null => {
  try {
    return object(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body)));
  } catch {
    return null;
  }
};

const projectUpdate = (
  config: TelegramWebhookConfig,
  identitySecret: string,
  body: Uint8Array
): TelegramWebhookResult => {
  const update = parseUpdate(body);
  if (update === null) return reject('telegram_json_invalid');
  if (!positiveInteger(update.update_id)) return reject('telegram_payload_invalid');
  const message = object(update.message);
  if (message === null) return reject('telegram_update_unsupported');
  const chat = object(message.chat);
  const actor = object(message.from);
  if (
    !positiveInteger(message.message_id) ||
    !positiveInteger(message.date) ||
    chat === null ||
    actor === null ||
    !safeInteger(chat.id) ||
    chat.id === 0 ||
    (chat.type !== 'group' && chat.type !== 'supergroup') ||
    !positiveInteger(actor.id)
  ) return reject('telegram_payload_invalid');
  const binding = config.bindings.find(({chatId}) => chatId === chat.id);
  if (binding === undefined) return reject('telegram_chat_unauthorized');

  const text = sanitizedText(message.text ?? message.caption);
  if (text?.startsWith('/') === true) return reject('telegram_command_unsupported');
  const attachments = attachmentMetadata(message);
  if (text === null && attachments.length === 0) return reject('telegram_update_unsupported');
  const reply = object(message.reply_to_message);
  const replyId = positiveInteger(reply?.message_id) ? reply.message_id : null;
  const threadId = positiveInteger(message.message_thread_id) ? message.message_thread_id : null;
  return {
    outcome: 'accepted',
    project: binding.project,
    conversationClass: binding.conversationClass,
    observation: {
      provider: 'telegram',
      externalBindingRef: telegramKeyedIdentifier(identitySecret, 'chat', chat.id),
      deliveryRef: telegramKeyedIdentifier(identitySecret, 'update', update.update_id),
      messageRef: telegramKeyedIdentifier(identitySecret, 'message', message.message_id),
      authorExternalSubject: telegramKeyedIdentifier(identitySecret, 'user', actor.id),
      authorDisplayName: sanitizedDisplayName(actor),
      sentAt: new Date(message.date * 1000),
      replyToMessageRef: replyId === null ? null : telegramKeyedIdentifier(identitySecret, 'message', replyId),
      threadRef: threadId === null ? null : telegramKeyedIdentifier(identitySecret, 'thread', threadId),
      text,
      attachments
    }
  };
};

export const verifyAndProjectTelegramWebhook = async (input: Readonly<{
  config: TelegramWebhookConfig;
  secrets: SecretsProvider;
  headers: Headers;
  body: Uint8Array;
}>): Promise<TelegramWebhookResult> => {
  const contentType = input.headers.get('content-type') ?? undefined;
  const suppliedSecret = input.headers.get('x-telegram-bot-api-secret-token') ?? undefined;
  if (contentType === undefined || !telegramJsonMediaTypePattern.test(contentType)) {
    return reject('telegram_media_type_invalid');
  }
  if (suppliedSecret === undefined || suppliedSecret.length === 0 || suppliedSecret.length > 256) {
    return reject('telegram_secret_missing');
  }
  if (input.body.byteLength > MAX_TELEGRAM_WEBHOOK_BODY_BYTES) return reject('telegram_body_too_large');
  let expectedSecret: string;
  let identitySecret: string;
  try {
    expectedSecret = (await input.secrets.resolve(
      input.config.webhookSecretRef, 'telegram.webhook.verify'
    )).value;
    identitySecret = (await input.secrets.resolve(
      input.config.identitySecretRef, 'telegram.identity.keying'
    )).value;
  } catch {
    return reject('telegram_secret_unavailable');
  }
  if (
    !/^[A-Za-z0-9_-]{1,256}$/.test(expectedSecret) ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(identitySecret)
  ) return reject('telegram_secret_config_invalid');
  const expected = Buffer.from(expectedSecret);
  const supplied = Buffer.from(suppliedSecret);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return reject('telegram_secret_invalid');
  }
  return projectUpdate(input.config, identitySecret, input.body);
};

export const isTelegramKeyedIdentifier = (value: string): boolean => identityPattern.test(value);
