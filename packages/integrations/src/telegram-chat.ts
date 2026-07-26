import type {ChatAdapter, OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {telegramKeyedIdentifier} from './telegram-webhook';

const identityPattern = /^tgid:v1:[0-9a-f]{64}$/;
const statusTextPattern = /^[A-Za-z0-9 .,:;()/_\-\n]{1,1024}$/;
const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export type TelegramChatAdapterConfig = Readonly<{
  botTokenRef: OpaqueSecretRef;
  identitySecretRef: OpaqueSecretRef;
  allowedPrivateChatIds: readonly number[];
  allowedUserIds: readonly number[];
}>;

const statusRequest = (input: Readonly<{
  destinationRef: string;
  template: string;
  variables: Readonly<Record<string, string>>;
  idempotencyKey: string;
}>): Readonly<{chatIdentity: string; userIdentity: string; text: string}> | null => {
  if (
    input.template !== 'telegram.status.response.v1' ||
    !/^telegram-status:[0-9a-f-]{36}$/.test(input.idempotencyKey) ||
    !identityPattern.test(input.destinationRef) ||
    Object.keys(input.variables).length !== 2 ||
    typeof input.variables.userIdentity !== 'string' ||
    typeof input.variables.text !== 'string' ||
    !identityPattern.test(input.variables.userIdentity) ||
    !statusTextPattern.test(input.variables.text)
  ) return null;
  return {
    chatIdentity: input.destinationRef,
    userIdentity: input.variables.userIdentity,
    text: input.variables.text
  };
};

const allowedIdentity = (
  secret: string,
  kind: 'chat' | 'user',
  ids: readonly number[],
  value: string
): boolean => ids.some((id) => telegramKeyedIdentifier(secret, kind, id) === value);

export const createTelegramChatAdapter = (
  config: TelegramChatAdapterConfig,
  secrets: SecretsProvider,
  request: typeof fetch = fetch
): ChatAdapter => ({
  provider: 'telegram',
  async sendNotification(input) {
    const status = statusRequest(input);
    if (status === null) throw new Error('Telegram notification is invalid.');
    const identitySecret = (await secrets.resolve(
      config.identitySecretRef,
      'telegram.identity.keying'
    )).value;
    if (
      !allowedIdentity(identitySecret, 'chat', config.allowedPrivateChatIds, status.chatIdentity) ||
      !allowedIdentity(identitySecret, 'user', config.allowedUserIds, status.userIdentity)
    ) throw new Error('Telegram notification destination is not allowed.');
    const chatId = config.allowedPrivateChatIds.find((id) =>
      telegramKeyedIdentifier(identitySecret, 'chat', id) === status.chatIdentity
    );
    if (chatId === undefined) throw new Error('Telegram notification destination is not allowed.');
    const botToken = (await secrets.resolve(config.botTokenRef, 'telegram.bot.send')).value;
    if (typeof botToken !== 'string' || botToken.length === 0 || botToken.length > 4096 || botToken.includes('\0')) {
      throw new Error('Telegram bot token is invalid.');
    }
    const response = await request(
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`,
      {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({chat_id: chatId, text: status.text}),
        signal: AbortSignal.timeout(3_000)
      }
    );
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Telegram sendMessage response is invalid.');
    }
    const messageId = payload !== null && typeof payload === 'object'
      ? (payload as {result?: {message_id?: unknown}; ok?: unknown}).result?.message_id
      : undefined;
    const ok = payload !== null && typeof payload === 'object'
      ? (payload as {ok?: unknown}).ok
      : false;
    if (!response.ok || ok !== true || !positiveSafeInteger(messageId)) {
      throw new Error('Telegram sendMessage failed.');
    }
    return {externalMessageId: `telegram:${messageId}`};
  }
});
