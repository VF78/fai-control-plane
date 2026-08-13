import {createHash} from 'node:crypto';
import type {InternalMessengerInbound, MessengerDeliveryPort, OpaqueSecretRef, SecretResolverPort} from '@fai-control-plane/domain';

type Fetch = typeof globalThis.fetch;
const ref = (kind: string, value: string): string => createHash('sha256').update(`${kind}\0${value}`).digest('hex');
const bounded = (value: unknown, max = 4_000): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
export type TelegramConfig = Readonly<{
  projectId: string; chatId: string; allowedUserIds: readonly string[]; tokenRef: OpaqueSecretRef;
}>;
export type TelegramPollPort = Readonly<{
  poll(afterUpdateId: number | null): Promise<Readonly<{highWaterUpdateId: number | null;
    messages: readonly Readonly<{updateId: number; message: InternalMessengerInbound}>[]}>>;
}>;

export const createTelegramAdapter = (input: Readonly<{
  config: TelegramConfig; secrets: SecretResolverPort; fetch?: Fetch;
}>): Readonly<{poller: TelegramPollPort; delivery: MessengerDeliveryPort}> => {
  if (!/^-?[1-9][0-9]*$/.test(input.config.chatId) || input.config.allowedUserIds.length === 0) {
    throw new Error('telegram_config_invalid');
  }
  const request = input.fetch ?? globalThis.fetch;
  const token = async (): Promise<string> => {
    const value = (await input.secrets.resolve(input.config.tokenRef, 'messenger_delivery')).value;
    if (!bounded(value, 256)) throw new Error('telegram_token_invalid');
    return value;
  };
  const call = async (method: string, body: object): Promise<Record<string, unknown>> => {
    const response = await request(`https://api.telegram.org/bot${await token()}/${method}`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000)});
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok || value.ok !== true) throw new Error('telegram_call_failed');
    return value;
  };
  return {
    poller: {async poll(afterUpdateId) {
      const value = await call('getUpdates', {offset: afterUpdateId === null ? undefined : afterUpdateId + 1,
        timeout: 0, allowed_updates: ['message']});
      if (!Array.isArray(value.result) || value.result.length > 100) throw new Error('telegram_response_invalid');
      const messages: {updateId: number; message: InternalMessengerInbound}[] = [];
      let highWaterUpdateId = afterUpdateId;
      for (const raw of value.result) {
        if (raw === null || typeof raw !== 'object') continue;
        const update = raw as Record<string, unknown>; const message = update.message as Record<string, unknown> | undefined;
        const from = message?.from as Record<string, unknown> | undefined; const chat = message?.chat as Record<string, unknown> | undefined;
        const updateId = update.update_id; const messageId = message?.message_id; const userId = String(from?.id ?? '');
        if (Number.isSafeInteger(updateId)) highWaterUpdateId = Math.max(highWaterUpdateId ?? -1, updateId as number);
        if (!Number.isSafeInteger(updateId) || !Number.isSafeInteger(messageId) || String(chat?.id ?? '') !== input.config.chatId ||
          !input.config.allowedUserIds.includes(userId) || !bounded(message?.text) || !Number.isSafeInteger(message?.date)) continue;
        const delivery = ref('telegram-delivery', String(updateId));
        messages.push({updateId: updateId as number, message: {projectId: input.config.projectId,
          contour: 'trusted-main', channelReference: ref('telegram-channel', input.config.chatId),
          senderReference: ref('telegram', userId), messageReference: ref('telegram-message', String(messageId)),
          observedAt: new Date((message.date as number) * 1_000).toISOString(), text: message.text as string,
          correlationId: `conversation:${delivery}`, idempotencyKey: `conversation:${delivery}`}});
      }
      return {highWaterUpdateId, messages};
    }},
    delivery: {async send(message) {
      if (message.projectId !== input.config.projectId || message.contour !== 'trusted-main' || !bounded(message.text)) {
        throw new Error('telegram_message_invalid');
      }
      const value = await call('sendMessage', {chat_id: input.config.chatId, text: message.text});
      const result = value.result as Record<string, unknown> | undefined;
      if (!Number.isSafeInteger(result?.message_id)) throw new Error('telegram_delivery_failed');
      return {deliveryReference: `telegram:${result!.message_id}`};
    }}
  };
};
