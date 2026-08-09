import type {SecretsProvider} from '@fai-control-plane/domain';
import {expect, it, vi} from 'vitest';
import {createTelegramWebhookConfig} from '@fai-control-plane/integrations';
import {createTelegramWebhookHandler} from './telegram-webhook-handler';

const webhookSecret = 'telegram-webhook-secret';
const identitySecret = 'telegram-identity-secret-value-0001';
const chatId = -1_000_000_001;
const config = createTelegramWebhookConfig({
  webhookSecretRef: {provider: 'test', reference: 'webhook', scope: ['telegram:webhook:verify']},
  identitySecretRef: {provider: 'test', reference: 'identity', scope: ['telegram:identity:keying']},
  bindings: [{
    chatId,
    project: 'msa',
    conversationClass: 'internal',
    activatedAt: new Date('2026-07-30T00:00:00.000Z')
  }]
});
const secrets: SecretsProvider = {
  resolve: async (reference) => ({
    value: reference.reference === 'identity' ? identitySecret : webhookSecret
  })
};
const request = (text: string) => new Request('https://app.test/api/webhooks/telegram', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-telegram-bot-api-secret-token': webhookSecret
  },
  body: JSON.stringify({
    update_id: 1,
    message: {
      message_id: 2,
      date: 1_785_369_600,
      chat: {id: chatId, type: 'supergroup'},
      from: {id: 3, first_name: 'Vitaliy'},
      text
    }
  })
});

it('persists read-only observations and never dispatches chat commands', async () => {
  const ingest = vi.fn().mockResolvedValueOnce('accepted').mockResolvedValueOnce('duplicate');
  const handler = createTelegramWebhookHandler({
    config,
    secrets,
    conversations: {ingest, observeParticipant: vi.fn(), recordFailure: vi.fn()}
  });
  expect((await handler(request('Ready'))).status).toBe(202);
  expect((await handler(request('Ready'))).status).toBe(200);
  expect(ingest).toHaveBeenCalledTimes(2);
  expect((await handler(request('/status msa'))).status).toBe(204);
  expect(ingest).toHaveBeenCalledTimes(2);
});

it('persists a participant access observation separately from messages', async () => {
  const observeParticipant = vi.fn().mockResolvedValue('accepted');
  const ingest = vi.fn();
  const handler = createTelegramWebhookHandler({
    config,
    secrets,
    conversations: {ingest, observeParticipant, recordFailure: vi.fn()}
  });
  const response = await handler(new Request('https://app.test/api/webhooks/telegram', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-telegram-bot-api-secret-token': webhookSecret},
    body: JSON.stringify({update_id: 3, chat_member: {
      date: 1_785_369_601,
      chat: {id: chatId, type: 'supergroup'},
      new_chat_member: {status: 'member', user: {id: 4, first_name: 'Vladimir'}}
    }})
  }));
  expect(response.status).toBe(202);
  expect(observeParticipant).toHaveBeenCalledWith(expect.objectContaining({observedLevel: 'write'}));
  expect(ingest).not.toHaveBeenCalled();
});
