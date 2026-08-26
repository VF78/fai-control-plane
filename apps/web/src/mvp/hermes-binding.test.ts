import {beforeEach, describe, expect, it} from 'vitest';
import {bindHermesConversation} from './hermes-binding.ts';

const common = {projectId: 'fd22736d-1879-47fe-9b8a-c51653a4b635', telegramChatId: '-5540760630',
  telegramUserIds: ['96211907', '355724486']} as const;
beforeEach(() => {});
describe('Hermes identity binding', () => {
  it('binds Telegram identity and update id server-side', () => {
    const value = bindHermesConversation({...common, profile: 'internal', source: {provider: 'telegram',
      updateId: '77', messageId: '12', userId: '96211907', chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'},
      action: {type: 'source.add', name: 'Decision', content: 'Confirmed'}});
    expect(value.message.contour).toBe('trusted-main');
    expect(value.message.idempotencyKey).toMatch(/^conversation:[a-f0-9]{64}$/);
  });
  it('allows conditional project-context reads only on the trusted internal profile', () => {
    const source = {provider: 'telegram' as const, updateId: '78', messageId: '13', userId: '96211907',
      chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'};
    const value = bindHermesConversation({...common, profile: 'internal', source,
      action: {type: 'project_context.read', ifVersion: 'a'.repeat(64)}});
    expect(value.action).toEqual({type: 'project_context.read', ifVersion: 'a'.repeat(64)});
    expect(value.message.contour).toBe('trusted-main');
  });
  it('denies removed provider mutation actions before dispatch', () => {
    const source = {provider: 'telegram' as const, updateId: '79', messageId: '14', userId: '96211907',
      chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'};
    expect(() => bindHermesConversation({...common, profile: 'internal', source,
      action: {type: 'issue.create', title: 'Request', statement: 'Details'}})).toThrow('body_invalid');
  });
  it('denies unmapped Telegram sources before dispatch', () => {
    expect(() => bindHermesConversation({...common, profile: 'internal', source: {provider: 'telegram',
      updateId: '77', messageId: '12', userId: '1', chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'},
      action: {type: 'source.add', name: 'Decision', content: 'Confirmed'}})).toThrow('identity_denied');
  });
});
