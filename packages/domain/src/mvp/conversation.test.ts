import {describe, expect, it} from 'vitest';
import {authorizeConversation, validateConversationEnvelope, type ConversationEnvelope} from './conversation.ts';

const envelope = (contour: 'trusted-main' | 'client-edge' = 'client-edge'): ConversationEnvelope => ({
  message: {
    projectId: 'project', contour, channelReference: 'channel', senderReference: 'sender',
    messageReference: 'message', observedAt: '2026-08-13T00:00:00.000Z', text: 'Please create an issue',
    correlationId: 'correlation', idempotencyKey: 'message-key'
  },
  action: {type: 'issue.create', title: 'Observed defect', statement: 'The check fails'}
});

describe('MVP conversation boundary', () => {
  it('accepts a bounded client issue action', () => {
    expect(validateConversationEnvelope(envelope())).toBe(true);
    expect(authorizeConversation(envelope())).toBe(true);
  });

  it('rejects message bodies over the persistence-free ingress limit', () => {
    const value = envelope();
    expect(validateConversationEnvelope({...value, message: {...value.message, text: 'x'.repeat(4_001)}})).toBe(false);
  });

  it('rejects invalid commands', () => {
    const value = envelope();
    expect(validateConversationEnvelope({...value, action: {
      type: 'issue.create', title: '', statement: 'Details'
    }})).toBe(false);
    expect(validateConversationEnvelope({...value, action: {type: 'approval.decide', approvalId: 'a',
      kind: 'client_uat', targetReference: 't', decision: 'invalid' as 'approved'}})).toBe(false);
    expect(validateConversationEnvelope({...value, action: {type: 'project_item.stage', itemId: 'item',
      issueId: '42', expectedVersion: 'v1', stage: 'Done' as 'QA'}})).toBe(false);
  });
});
