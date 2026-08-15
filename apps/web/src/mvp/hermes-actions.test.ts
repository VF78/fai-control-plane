import {describe, expect, it, vi} from 'vitest';
import {createHermesConversationActionHandler, type HermesActionDependencies} from './hermes-actions.ts';

const internalToken = 'i'.repeat(48); const clientToken = 'c'.repeat(48);
const dependencies = (): HermesActionDependencies => ({internalToken: async () => internalToken,
  clientToken: async () => clientToken, projectId: 'fd22736d-1879-47fe-9b8a-c51653a4b635',
  telegramChatId: '-5540760630', telegramUserIds: ['96211907', '355724486'], bitrixTaskId: '154312',
  clientActionsEnabled: true,
  dispatchInternal: vi.fn(async () => ({status: 'completed' as const, referenceId: 'snapshot-1'})),
  dispatchClient: vi.fn(async () => ({status: 'completed' as const, referenceId: 'issue-1'}))});
const request = (bearer: string, source: object, action: object) => new Request('https://app.f-ai.studio/api/hermes/conversation-actions', {
  method: 'POST', headers: {authorization: `Bearer ${bearer}`, 'content-type': 'application/json'},
  body: JSON.stringify({source, action})});

describe('Hermes conversation action HTTP boundary', () => {
  it('derives the internal profile from its bearer and never from model input', async () => {
    const deps = dependencies(); const handler = createHermesConversationActionHandler(deps);
    const response = await handler(request(internalToken, {provider: 'telegram', updateId: '77', messageId: '12',
      userId: '96211907', chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'},
    {type: 'project_facts.read'}));
    expect(response.status).toBe(200); expect(deps.dispatchInternal).toHaveBeenCalledOnce();
    expect(deps.dispatchClient).not.toHaveBeenCalled();
  });
  it('allows the external bearer to create an issue but denies approvals', async () => {
    const deps = dependencies(); const handler = createHermesConversationActionHandler(deps);
    const source = {provider: 'bitrix-browser', taskId: '154312', messageId: 'dom-9', authorId: 'client-2',
      observedAt: '2026-08-14T10:00:00.000Z'};
    expect((await handler(request(clientToken, source,
      {type: 'issue.create', title: 'Defect', statement: 'Steps'}))).status).toBe(200);
    expect((await handler(request(clientToken, source, {type: 'approval.decide', approvalId: 'a', kind: 'client_uat',
      targetReference: 'x', decision: 'approved'}))).status).toBe(403);
  });
  it('fails closed for unknown tokens and caller-supplied authority fields', async () => {
    const handler = createHermesConversationActionHandler(dependencies());
    const source = {provider: 'telegram', updateId: '77', messageId: '12', userId: '96211907',
      chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'};
    expect((await handler(request('x'.repeat(48), source, {type: 'project_facts.read'}))).status).toBe(401);
    const forged = new Request('https://app.f-ai.studio/api/hermes/conversation-actions', {method: 'POST',
      headers: {authorization: `Bearer ${internalToken}`, 'content-type': 'application/json'},
      body: JSON.stringify({source, action: {type: 'project_facts.read'}, actorId: 'forged'})});
    expect((await handler(forged)).status).toBe(400);
  });
  it('fails closed when profile credentials are accidentally identical', async () => {
    const deps = {...dependencies(), clientToken: async () => internalToken};
    const response = await createHermesConversationActionHandler(deps)(request(internalToken,
      {provider: 'telegram', updateId: '77', messageId: '12', userId: '96211907', chatId: '-5540760630',
        observedAt: '2026-08-14T10:00:00.000Z'}, {type: 'project_facts.read'}));
    expect(response.status).toBe(401);
    expect(deps.dispatchInternal).not.toHaveBeenCalled();
  });
  it('denies the client contour by default without making internal actions depend on its secret', async () => {
    const deps = {...dependencies(), clientActionsEnabled: false, clientToken: async () => { throw new Error('must_not_read'); }};
    const handler = createHermesConversationActionHandler(deps);
    expect((await handler(request(internalToken, {provider: 'telegram', updateId: '77', messageId: '12', userId: '96211907',
      chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'}, {type: 'project_facts.read'}))).status).toBe(200);
    const response = await handler(request(clientToken, {provider: 'bitrix-browser', taskId: '154312', messageId: 'dom-9',
      authorId: 'client-2', observedAt: '2026-08-14T10:00:00.000Z'}, {type: 'issue.create', title: 'Defect', statement: 'Steps'}));
    expect(response.status).toBe(403);
    expect(deps.dispatchClient).not.toHaveBeenCalled();
  });
});
