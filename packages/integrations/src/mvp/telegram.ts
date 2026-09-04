import type {MessengerDeliveryPort, OpaqueSecretRef, SecretResolverPort} from '@fai-control-plane/domain';

type Fetch = typeof globalThis.fetch;
const bounded = (value: unknown, max = 4_000): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
export type TelegramConfig = Readonly<{
  projectId: string; chatId: string; tokenRef: OpaqueSecretRef; contour?:'trusted-main'|'client-edge';
}>;
export const createTelegramDeliveryAdapter = (input: Readonly<{
  config: TelegramConfig; secrets: SecretResolverPort; fetch?: Fetch;
}>): MessengerDeliveryPort => {
  if (!/^-?[1-9][0-9]*$/.test(input.config.chatId)) {
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
  return {async send(message) {
      if (message.projectId !== input.config.projectId || message.contour !== (input.config.contour??'trusted-main') || !bounded(message.text)) {
        throw new Error('telegram_message_invalid');
      }
      const value = await call('sendMessage', {chat_id: input.config.chatId, text: message.text});
      const result = value.result as Record<string, unknown> | undefined;
      if (!Number.isSafeInteger(result?.message_id)) throw new Error('telegram_delivery_failed');
      return {deliveryReference: `telegram:${result!.message_id}`};
    }};
};
