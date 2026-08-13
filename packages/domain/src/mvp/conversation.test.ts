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

  it('denies agent delivery from the client contour', () => {
    const value = envelope('client-edge');
    expect(authorizeConversation({...value, action: {type: 'agent.submit', request: {
      role: 'developer', repository: {id: 'r', url: 'https://example.test/r'},
      projectItem: {id: 'i', projectId: 'p', issueId: 'x', url: 'https://example.test/i'},
      observedVersion: 'v', sources: [], constraints: ['bounded'], acceptanceCriteria: ['checked'],
      approval: null, correlationId: 'c', idempotencyKey: 'k'
    }}})).toBe(false);
  });

  it('rejects invalid commands', () => {
    const value = envelope();
    expect(validateConversationEnvelope({...value, action: {
      type: 'issue.create', title: '', statement: 'Details'
    }})).toBe(false);
    expect(validateConversationEnvelope({...value, action: {type: 'approval.decide', approvalId: 'a',
      kind: 'client_uat', targetReference: 't', decision: 'invalid' as 'approved'}})).toBe(false);
  });
});
