import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {describe, expect, it, vi} from 'vitest';
import {createTelegramChatAdapter} from './telegram-chat';
import {telegramKeyedIdentifier} from './telegram-webhook';

const identityRef: OpaqueSecretRef = {
  provider: 'file', reference: '/run/secrets/telegram-identity', scope: ['telegram:identity:keying']
};
const botTokenRef: OpaqueSecretRef = {
  provider: 'file', reference: '/run/secrets/telegram-bot', scope: ['telegram:bot:send']
};
const identitySecret = 'identity-secret';
const secrets: SecretsProvider = {
  async resolve(reference) {
    return {value: reference.reference === botTokenRef.reference ? '123:bot-token' : identitySecret};
  }
};

describe('Telegram chat adapter', () => {
  it('sends one bounded plain-text status response only to the configured identities', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: true, result: {message_id: 17}
    }), {status: 200, headers: {'content-type': 'application/json'}}));
    const adapter = createTelegramChatAdapter({
      botTokenRef,
      identitySecretRef: identityRef,
      allowedPrivateChatIds: [42],
      allowedUserIds: [7]
    }, secrets, request);

    await expect(adapter.sendNotification({
      destinationRef: telegramKeyedIdentifier(identitySecret, 'chat', 42),
      template: 'telegram.status.response.v1',
      variables: {
        userIdentity: telegramKeyedIdentifier(identitySecret, 'user', 7),
        text: 'Status 2026-07-26 UTC\nBlocked: 0'
      },
      idempotencyKey: 'telegram-status:00000000-0000-4000-8000-000000000001'
    })).resolves.toEqual({externalMessageId: 'telegram:17'});
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      chat_id: 42,
      text: 'Status 2026-07-26 UTC\nBlocked: 0'
    });
  });

  it('does not send an unapproved identity', async () => {
    const request = vi.fn<typeof fetch>();
    const adapter = createTelegramChatAdapter({
      botTokenRef,
      identitySecretRef: identityRef,
      allowedPrivateChatIds: [42],
      allowedUserIds: [7]
    }, secrets, request);

    await expect(adapter.sendNotification({
      destinationRef: telegramKeyedIdentifier(identitySecret, 'chat', 42),
      template: 'telegram.status.response.v1',
      variables: {
        userIdentity: telegramKeyedIdentifier(identitySecret, 'user', 9),
        text: 'Status 2026-07-26 UTC\nBlocked: 0'
      },
      idempotencyKey: 'telegram-status:00000000-0000-4000-8000-000000000001'
    })).rejects.toThrow('destination is not allowed');
    expect(request).not.toHaveBeenCalled();
  });
});
