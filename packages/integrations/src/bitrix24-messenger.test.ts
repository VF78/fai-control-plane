import type {
  ConversationRuntimeDeliveryPort,
  OpaqueSecretRef,
  SecretsProvider
} from '@fai-control-plane/domain';
import {
  bindConversationIngress,
  createClientEdgeConversationProcess,
  type ConversationCapabilityPorts
} from '@fai-control-plane/application';
import {describe, expect, it, vi} from 'vitest';
import {
  createBitrix24MessengerDeliveryAdapter,
  createBitrix24MessengerIngressAdapter,
  type Bitrix24MessengerConfig
} from './bitrix24-messenger';

const applicationTokenRef: OpaqueSecretRef = {provider: 'file', reference: '/run/secrets/b24-app', scope: ['bitrix24:event:verify']};
const restTokenRef: OpaqueSecretRef = {provider: 'file', reference: '/run/secrets/b24-rest', scope: ['bitrix24:rest:call']};
const identitySecretRef: OpaqueSecretRef = {provider: 'file', reference: '/run/secrets/b24-identity', scope: ['bitrix24:identity:keying']};
const config: Bitrix24MessengerConfig = {
  portalUrl: 'https://ascon.bitrix24.ru/', memberId: 'member-42', taskId: 154312,
  projectRef: 'project:ascon', applicationTokenRef, restTokenRef, identitySecretRef,
  allowedAuthorIds: [27]
};
const secrets: SecretsProvider = {async resolve(reference) {
  if (reference.reference === applicationTokenRef.reference) return {value: 'application-token'};
  if (reference.reference === restTokenRef.reference) return {value: 'rest-token'};
  return {value: 'identity-secret'};
}};
const eventBody = (overrides: Record<string, string> = {}): Uint8Array => new TextEncoder().encode(new URLSearchParams({
  event: 'ONTASKCOMMENTADD',
  'auth[application_token]': 'application-token',
  'auth[domain]': 'ascon.bitrix24.ru',
  'auth[member_id]': 'member-42',
  'data[FIELDS_AFTER][TASK_ID]': '154312',
  'data[FIELDS_AFTER][MESSAGE_ID]': '731',
  'data[FIELDS_AFTER][ID]': '0',
  ...overrides
}).toString());
const request = (body = eventBody()) => ({headers: {'content-type': 'application/x-www-form-urlencoded'}, body});

describe('Bitrix24 messenger adapter', () => {
  it('delivers one verified event to client-edge and produces one bounded issue action', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({result: {item: {id: 154312, chat: {id: 88}}}})))
      .mockResolvedValueOnce(new Response(JSON.stringify({result: {chat_id: 88, messages: [{
        id: 731, chat_id: 88, author_id: 27, date: '2026-08-13T12:00:00+03:00', text: 'Client intake'
      }]}})));
    const ingress = createBitrix24MessengerIngressAdapter({config, secrets, fetch});
    const createIssueIntake = vi.fn(async () => ({
      kind: 'issue' as const,
      referenceId: 'github:issue:4242',
      url: 'https://github.com/VF78/ascon/issues/42',
      version: 'github:updated-at:2026-08-13T09:01:00Z'
    }));
    const capabilities: ConversationCapabilityPorts = {
      readClientProjectFacts: vi.fn(), createIssueIntake,
      clarifyIssueIntake: vi.fn(), addSourceContext: vi.fn(),
      requestExternalApproval: vi.fn()
    };
    const deliver = vi.fn<ConversationRuntimeDeliveryPort['deliver']>(async () => ({
      deliveryReference: 'run:42', sessionReference: 'conversation:42'
    }));
    const process = createClientEdgeConversationProcess({delivery: {deliver}, capabilities});
    const binding = bindConversationIngress({ingress, process});

    await expect(binding.handle(request())).resolves.toMatchObject({
      status: 'delivered', acknowledgement: {deliveryReference: 'run:42'}
    });
    const delivered = deliver.mock.calls[0]?.[0];
    expect(delivered).toMatchObject({
      projectRef: 'project:ascon', text: 'Client intake',
      origin: {visibility: 'client', observedAt: '2026-08-13T09:00:00.000Z'}
    });
    if (delivered === undefined) throw new Error('expected delivered message');
    const actionResult = await process.dispatchAction({
      projectRef: delivered.projectRef,
      origin: delivered.origin,
      action: {
        type: 'issue_intake.create', title: 'Client defect', statement: 'Bounded defect statement',
        source: {referenceId: delivered.origin.messageRef, url: 'https://ascon.bitrix24.ru/client-message/731'}
      },
      correlationId: delivered.correlationId,
      idempotencyKey: delivered.idempotencyKey
    });
    expect(actionResult).toMatchObject({status: 'completed', evidence: {
      capability: 'issue_intake.create', result: {kind: 'issue', referenceId: 'github:issue:4242'}
    }});
    expect(createIssueIntake).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      id: 154312, select: ['id', 'chat.id'], auth: 'rest-token'
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      DIALOG_ID: 'chat88', FIRST_ID: 730, LIMIT: 1, auth: 'rest-token'
    });
    const deliveryFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({result: {item: {id: 911}}}))
    );
    const delivery = createBitrix24MessengerDeliveryAdapter({
      config, secrets, fetch: deliveryFetch
    });
    await expect(delivery.sendNotification({text: 'A bounded client-visible update'}))
      .resolves.toEqual({deliveryReference: 'bitrix24:911'});
    expect(JSON.parse(String(deliveryFetch.mock.calls[0]?.[1]?.body))).toEqual({
      fields: {taskId: 154312, text: 'A bounded client-visible update'}, auth: 'rest-token'
    });
    expect(String(deliveryFetch.mock.calls[0]?.[0]))
      .toBe('https://ascon.bitrix24.ru/rest/api/tasks.task.chat.message.send');
  });

  it('fails closed for unauthenticated, mis-scoped or mismatched events', async () => {
    for (const [body, reason] of [
      [eventBody({'auth[application_token]': 'wrong'}), 'authentication_failed'],
      [eventBody({'auth[domain]': 'other.bitrix24.ru'}), 'source_mismatch'],
      [eventBody({'data[FIELDS_AFTER][TASK_ID]': '154313'}), 'source_mismatch'],
      [eventBody({'data[FIELDS_AFTER][ID]': '9'}), 'body_invalid']
    ] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const adapter = createBitrix24MessengerIngressAdapter({config, secrets, fetch});
      await expect(adapter.receive(request(body))).resolves.toEqual({status: 'rejected', reason});
      expect(fetch).not.toHaveBeenCalled();
    }
    const mismatchedFetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({result: {item: {id: 154312, chatId: 88}}})))
      .mockResolvedValueOnce(new Response(JSON.stringify({result: {chat_id: 88, messages: [{
        id: 732, chat_id: 88, author_id: 27, date: '2026-08-13T12:00:00+03:00', text: 'Different'
      }]}})));
    const mismatched = createBitrix24MessengerIngressAdapter({
      config, secrets, fetch: mismatchedFetch
    });
    await expect(mismatched.receive(request())).resolves.toEqual({
      status: 'rejected', reason: 'source_mismatch'
    });
  });
});
