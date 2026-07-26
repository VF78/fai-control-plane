import type {SecretsProvider} from '@fai-control-plane/domain';
import {describe, expect, it} from 'vitest';
import {
  createTelegramWebhookConfig,
  isTelegramKeyedIdentifier,
  verifyAndProjectTelegramWebhook
} from './telegram-webhook';

const secret = 'telegram-webhook-secret';
const config = createTelegramWebhookConfig({
  webhookSecretRef: {
    provider: 'test',
    reference: 'telegram-webhook-secret',
    scope: ['telegram:webhook:verify']
  },
  allowedUserIds: [700_001],
  allowedPrivateChatIds: [800_001]
});
const secrets: SecretsProvider = {resolve: async () => ({value: secret})};

const body = (overrides: Record<string, unknown> = {}): Uint8Array => new TextEncoder().encode(
  JSON.stringify({
    update_id: 900_001,
    message: {
      message_id: 300_001,
      date: 1_784_000_000,
      chat: {
        id: 800_001,
        type: 'private',
        first_name: 'Private Name',
        username: 'private_handle'
      },
      from: {
        id: 700_001,
        is_bot: false,
        first_name: 'Actor Name',
        username: 'actor_handle'
      },
      text: '/status'
    },
    ...overrides
  })
);

const verify = (
  rawBody: Uint8Array,
  suppliedSecret = secret,
  provider: SecretsProvider = secrets
) =>
  verifyAndProjectTelegramWebhook({
    config,
    secrets: provider,
    headers: new Headers({
      'content-type': 'application/json; charset=utf-8',
      'x-telegram-bot-api-secret-token': suppliedSecret
    }),
    body: rawBody
  });

describe('Telegram /status webhook boundary', () => {
  it('requires the exact secret and allowlisted private actor, then emits one idempotent sanitized intent', async () => {
    const rawBody = body();
    const [first, duplicate] = await Promise.all([verify(rawBody), verify(rawBody)]);

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      outcome: 'accepted',
      projection: {
        provider: 'telegram',
        eventType: 'chat_command',
        action: 'status',
        projection: {command: {name: 'status'}}
      }
    });
    if (first.outcome !== 'accepted') throw new Error('Expected accepted Telegram update.');
    expect(isTelegramKeyedIdentifier(first.projection.deliveryId)).toBe(true);
    expect(isTelegramKeyedIdentifier(first.projection.source.messageId)).toBe(true);
    expect(isTelegramKeyedIdentifier(first.projection.source.chatId)).toBe(true);
    expect(isTelegramKeyedIdentifier(first.projection.source.userId)).toBe(true);
    expect(JSON.stringify(first.projection)).not.toMatch(
      /900001|300001|800001|700001|Private Name|Actor Name|private_handle|actor_handle|\/status/
    );
    const alternate = await verify(
      rawBody,
      'alternate_webhook_secret',
      {resolve: async () => ({value: 'alternate_webhook_secret'})}
    );
    expect(alternate).toMatchObject({outcome: 'accepted'});
    if (alternate.outcome !== 'accepted') throw new Error('Expected alternate accepted update.');
    expect(alternate.projection.payloadSha256).not.toBe(first.projection.payloadSha256);

    await expect(verify(rawBody, `${secret}-suffix`)).resolves.toEqual({
      outcome: 'rejected', code: 'telegram_secret_invalid'
    });
    await expect(verify(rawBody, secret, {
      resolve: async () => ({value: 'invalid secret!'})
    })).resolves.toEqual({
      outcome: 'rejected', code: 'telegram_secret_config_invalid'
    });
    await expect(verify(body({message: {...JSON.parse(new TextDecoder().decode(rawBody)).message,
      chat: {id: 999_999, type: 'private'}, from: {id: 700_001}, text: '/status'}}))).resolves.toEqual({
      outcome: 'rejected', code: 'telegram_chat_unauthorized'
    });
    await expect(verify(body({message: {...JSON.parse(new TextDecoder().decode(rawBody)).message,
      chat: {id: 800_001, type: 'private'}, from: {id: 700_001}, text: '/run'}}))).resolves.toEqual({
      outcome: 'rejected', code: 'telegram_command_unsupported'
    });
    await expect(verify(body({edited_message: {message_id: 1}, update_id: 900_001}))).resolves.toEqual({
      outcome: 'rejected', code: 'telegram_update_unsupported'
    });
  });
});
