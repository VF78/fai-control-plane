import {beforeEach, describe, expect, it} from 'vitest';
import {bindHermesConversation} from './hermes-binding.ts';

const common = {projectId: 'fd22736d-1879-47fe-9b8a-c51653a4b635', telegramChatId: '-5540760630',
  telegramUserIds: ['96211907', '355724486'], bitrixTaskId: '154312'} as const;
beforeEach(() => {});
describe('Hermes identity binding', () => {
  it('binds Telegram identity and update id server-side', () => {
    const value = bindHermesConversation({...common, profile: 'internal', source: {provider: 'telegram',
      updateId: '77', messageId: '12', userId: '96211907', chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'},
      action: {type: 'project_facts.read'}});
    expect(value.message.contour).toBe('trusted-main');
    expect(value.message.idempotencyKey).toMatch(/^conversation:[a-f0-9]{64}$/);
  });
  it('allows only client issue actions for the fixed Bitrix task', () => {
    const source = {provider: 'bitrix-browser' as const, taskId: '154312', messageId: 'dom-9', authorId: 'client-2',
      observedAt: '2026-08-14T10:00:00.000Z'};
    expect(bindHermesConversation({...common, profile: 'bitrix-client', source,
      action: {type: 'issue.create', title: 'Request', statement: 'Details'}}).message.contour).toBe('client-edge');
    expect(() => bindHermesConversation({...common, profile: 'bitrix-client', source,
      action: {type: 'approval.decide', approvalId: 'a', kind: 'client_uat', targetReference: 'x', decision: 'approved'}}))
      .toThrow('action_denied');
  });
  it('denies unmapped Telegram sources before dispatch', () => {
    expect(() => bindHermesConversation({...common, profile: 'internal', source: {provider: 'telegram',
      updateId: '77', messageId: '12', userId: '1', chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'},
      action: {type: 'project_facts.read'}})).toThrow('identity_denied');
  });
});
