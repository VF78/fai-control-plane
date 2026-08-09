import type {SecretsProvider} from '@fai-control-plane/domain';
import {describe, expect, it} from 'vitest';
import {
  createTelegramWebhookConfig,
  isTelegramKeyedIdentifier,
  verifyAndProjectTelegramWebhook
} from './telegram-webhook';

const webhookSecret = 'telegram-webhook-secret';
const identitySecret = 'telegram-identity-secret-value-0001';
const chatId = -1_000_800_001;
const config = createTelegramWebhookConfig({
  webhookSecretRef: {
    provider: 'test', reference: 'telegram-webhook-secret', scope: ['telegram:webhook:verify']
  },
  identitySecretRef: {
    provider: 'test', reference: 'telegram-identity-secret', scope: ['telegram:identity:keying']
  },
  bindings: [{
    chatId,
    project: 'msa',
    conversationClass: 'internal',
    activatedAt: new Date('2026-07-30T00:00:00.000Z')
  }]
});
const secrets: SecretsProvider = {
  resolve: async (reference) => ({
    value: reference.reference === 'telegram-identity-secret' ? identitySecret : webhookSecret
  })
};
const message = (overrides: Record<string, unknown> = {}) => ({
  message_id: 300_001,
  date: 1_785_369_600,
  chat: {id: chatId, type: 'supergroup', title: 'Internal'},
  from: {id: 700_001, is_bot: false, first_name: '<b>Vladimir</b>'},
  text: '<script>unsafe()</script> Ready\u0000',
  ...overrides
});
const body = (messageValue: Record<string, unknown>): Uint8Array => new TextEncoder().encode(
  JSON.stringify({update_id: 900_001, message: messageValue})
);
const verify = (messageValue: Record<string, unknown>, suppliedSecret = webhookSecret) =>
  verifyAndProjectTelegramWebhook({
    config,
    secrets,
    headers: new Headers({
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': suppliedSecret
    }),
    body: body(messageValue)
  });

describe('Telegram conversation webhook boundary', () => {
  it('projects only a configured group into bounded sanitized metadata', async () => {
    const accepted = await verify(message({
      reply_to_message: {message_id: 12},
      message_thread_id: 20,
      document: {
        file_id: 'raw-provider-file-id',
        file_name: '<b>brief.pdf</b>',
        mime_type: 'application/pdf',
        file_size: 1234
      }
    }));
    expect(accepted).toMatchObject({
      outcome: 'accepted',
      project: 'msa',
      conversationClass: 'internal',
      observation: {
        provider: 'telegram',
        authorDisplayName: 'Vladimir',
        text: 'unsafe() Ready',
        attachments: [{
          kind: 'document',
          fileName: 'brief.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1234
        }]
      }
    });
    if (accepted.outcome !== 'accepted') throw new Error('Expected accepted observation.');
    if (!('messageRef' in accepted.observation)) throw new Error('Expected message observation.');
    for (const ref of [
      accepted.observation.externalBindingRef,
      accepted.observation.deliveryRef,
      accepted.observation.messageRef,
      accepted.observation.authorExternalSubject,
      accepted.observation.replyToMessageRef!,
      accepted.observation.threadRef!
    ]) expect(isTelegramKeyedIdentifier(ref)).toBe(true);
    expect(JSON.stringify(accepted.observation)).not.toContain('raw-provider-file-id');
    expect(JSON.stringify(accepted.observation)).not.toContain('<');
  });

  it('rejects other chats and all chat commands', async () => {
    await expect(verify(message({
      chat: {id: -1_000_900_001, type: 'supergroup'}
    }))).resolves.toEqual({outcome: 'rejected', code: 'telegram_chat_unauthorized'});
    await expect(verify(message({text: '/status msa'}))).resolves.toEqual({
      outcome: 'rejected', code: 'telegram_command_unsupported'
    });
    await expect(verify(message(), `${webhookSecret}-wrong`)).resolves.toEqual({
      outcome: 'rejected', code: 'telegram_secret_invalid'
    });
  });

  it('projects membership changes as access observations without raw identifiers', async () => {
    const accepted = await verifyAndProjectTelegramWebhook({
      config,
      secrets,
      headers: new Headers({
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': webhookSecret
      }),
      body: new TextEncoder().encode(JSON.stringify({
        update_id: 900_002,
        chat_member: {
          date: 1_785_369_601,
          chat: {id: chatId, type: 'supergroup'},
          new_chat_member: {status: 'administrator', user: {id: 700_002, first_name: '<b>Vitaliy</b>'}}
        }
      }))
    });
    expect(accepted).toMatchObject({outcome: 'accepted', project: 'msa', conversationClass: 'internal', observation: {
      provider: 'telegram', displayName: 'Vitaliy', observedLevel: 'admin'
    }});
    expect(JSON.stringify(accepted)).not.toContain('700002');
    expect(JSON.stringify(accepted)).not.toContain('<');
  });

  it('rejects ambiguous project/class or chat bindings', () => {
    expect(() => createTelegramWebhookConfig({
      webhookSecretRef: config.webhookSecretRef,
      identitySecretRef: config.identitySecretRef,
      bindings: [
        {chatId: -1, project: 'msa', conversationClass: 'client', activatedAt: new Date()},
        {chatId: -2, project: 'msa', conversationClass: 'client', activatedAt: new Date()}
      ]
    })).toThrow('ambiguous');
  });
});
