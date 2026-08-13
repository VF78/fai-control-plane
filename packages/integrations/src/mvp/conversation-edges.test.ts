import {describe, expect, it, vi} from 'vitest';
import {dispatchClientConversationAction, dispatchConversationAction, type ClientConversationPorts} from '@fai-control-plane/application';
import {parseConversationCommand} from '@fai-control-plane/domain';
import {createBitrix24IngressAdapter, type Bitrix24Config} from './bitrix24.ts';
import {createTelegramAdapter} from './telegram.ts';

const sharedPorts = (senderReference: string): Readonly<{
  evidence: Array<Readonly<{actorId: string | null; action: string; contour: unknown}>>;
  ports: ClientConversationPorts;
}> => {
  const evidence: Array<Readonly<{actorId: string | null; action: string; contour: unknown}>> = [];
  return {evidence, ports: {
    facts: {read: vi.fn(async () => ({referenceId: 'snapshot-1'}))},
    tracker: {createIssue: vi.fn(async () => ({referenceId: 'issue-1', url: 'https://example.test/1', version: 'v1'})),
      addIssueContext: vi.fn(async () => ({referenceId: 'issue-1', url: 'https://example.test/1', version: 'v2'}))},
    sources: {add: vi.fn(async () => ({referenceId: 'source-1'}))},
    approvals: {decide: vi.fn(async () => ({referenceId: 'approval-1'}))},
    identities: {resolveActiveHuman: vi.fn(async (input: Readonly<{senderReference: string}>) =>
      input.senderReference === senderReference ? {actorId: 'human-1', role: 'operator' as const} : null)},
    receipts: {exists: vi.fn(async () => false), record: vi.fn(async () => undefined)},
    completion: {complete: vi.fn(async (value) => { evidence.push({actorId: value.actorId, action: value.action,
      contour: value.details.contour}); return 'recorded' as const; })}
  }};
};

describe('native messenger edge to bounded tool evidence', () => {
  it('maps Telegram only to trusted-main and completes one attributed facts read', async () => {
    const adapter = createTelegramAdapter({config: {projectId: 'ascon', chatId: '-1001', allowedUserIds: ['7'],
      tokenRef: {id: 'telegram', purpose: 'messenger_delivery', locator: '/token'}},
    secrets: {resolve: async () => ({value: 'token'})}, fetch: async () => new Response(JSON.stringify({ok: true,
      result: [{update_id: 42, message: {message_id: 9, date: 1_786_572_000, text: '/facts',
        chat: {id: -1001}, from: {id: 7}}}]}))});
    const message = (await adapter.poller.poll(null)).messages[0]!.message;
    const action = parseConversationCommand(message.text)!;
    const target = sharedPorts(message.senderReference);
    await expect(dispatchConversationAction({workspaceId: 'workspace', envelope: {message, action},
      ports: {...target.ports, agent: {submit: async () => ({deliveryReference: 'unused', sessionReference: 'unused'})}}}))
      .resolves.toEqual({status: 'completed', referenceId: 'snapshot-1'});
    expect(target.evidence).toEqual([{actorId: 'human-1', action: 'conversation.project_facts.read',
      contour: 'trusted-main'}]);
  });

  it('maps Bitrix24 only to client-edge and completes one attributed issue intake', async () => {
    const config: Bitrix24Config = {portalUrl: 'https://portal.example.test/', memberId: 'member', taskId: 154312,
      projectId: 'ascon', allowedAuthorIds: [101], applicationTokenRef: {id: 'app', purpose: 'verify', locator: '/app'},
      restTokenRef: {id: 'rest', purpose: 'send', locator: '/rest'}};
    const fetch = async (url: string | URL | Request) => String(url).includes('tasks.task.get')
      ? new Response(JSON.stringify({result: {item: {id: 154312, chat: {id: 77}}}}))
      : new Response(JSON.stringify({result: {messages: [{id: 500, chat_id: 77, author_id: 101,
        text: '/issue Defect | Reproduction', date: '2026-08-13T00:00:00.000Z'}]}}));
    const params = new URLSearchParams({event: 'ONTASKCOMMENTADD', 'auth[application_token]': 'verify-token',
      'auth[domain]': 'portal.example.test', 'auth[member_id]': 'member',
      'data[FIELDS_AFTER][TASK_ID]': '154312', 'data[FIELDS_AFTER][MESSAGE_ID]': '500'});
    const received = await createBitrix24IngressAdapter({config, fetch,
      secrets: {resolve: async (reference) => ({value: reference.id === 'app' ? 'verify-token' : 'rest-token'})}})
      .receive({headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new TextEncoder().encode(params.toString())});
    if (received.status !== 'accepted' || received.message.contour !== 'client-edge') throw new Error('fixture_rejected');
    const action = parseConversationCommand(received.message.text)!;
    if (action.type === 'agent.submit') throw new Error('fixture_action_invalid');
    const target = sharedPorts(received.message.senderReference);
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope: {message: received.message, action},
      ports: target.ports})).resolves.toEqual({status: 'completed', referenceId: 'issue-1'});
    expect(target.evidence).toEqual([{actorId: 'human-1', action: 'conversation.issue.create',
      contour: 'client-edge'}]);
  });
});
