import {describe, expect, it, vi} from 'vitest';
import {dispatchConversationAction, type ClientConversationPorts} from '@fai-control-plane/application';
import {parseConversationCommand} from '@fai-control-plane/domain';
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
});
