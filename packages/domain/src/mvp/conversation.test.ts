import {describe, expect, it} from 'vitest';
import {authorizeConversation, parseConversationEnvelope, validateConversationEnvelope, type ConversationEnvelope} from './conversation.ts';

const envelope = (contour: 'trusted-main' | 'client-edge' = 'trusted-main'): ConversationEnvelope => ({
  message: {
    projectId: 'project', contour, channelReference: 'channel', senderReference: 'sender',
    messageReference: 'message', observedAt: '2026-08-13T00:00:00.000Z', text: 'Please create an issue',
    correlationId: 'correlation', idempotencyKey: 'message-key'
  },
  action: {type: 'source.add', name: 'Observed decision', content: 'The confirmed project context'}
});

describe('MVP conversation boundary', () => {
  it('accepts a bounded internal context-source action', () => {
    expect(validateConversationEnvelope(envelope())).toBe(true);
    expect(authorizeConversation(envelope())).toBe(true);
  });

  it('accepts a conditional project-context read and rejects malformed versions', () => {
    const value = envelope('trusted-main');
    expect(validateConversationEnvelope({...value,
      action: {type: 'project_context.read', ifVersion: null}})).toBe(true);
    expect(validateConversationEnvelope({...value,
      action: {type: 'project_context.read', ifVersion: 'a'.repeat(64)}})).toBe(true);
    expect(validateConversationEnvelope({...value,
      action: {type: 'project_context.read', ifVersion: 'not-a-version'}})).toBe(false);
  });

  it('does not parse removed repository, issue or Project mutation actions', () => {
    for (const action of [{type: 'project_facts.read'}, {type: 'issue.create', title: 'Task', statement: 'Do it'},
      {type: 'process.start', task: {kind: 'existing', itemId: 'item'}},
      {type: 'project_item.stage', itemId: 'item', issueId: '42', expectedVersion: 'v1', stage: 'QA'}]) {
      expect(parseConversationEnvelope({...envelope('trusted-main'), action})).toBeNull();
    }
  });

  it('allows autonomous mode only on the authenticated internal contour', () => {
    const action = {type:'project.execution.mode' as const,mode:'autonomous' as const};
    expect(validateConversationEnvelope({...envelope('trusted-main'),action})).toBe(true);
    expect(validateConversationEnvelope({...envelope('client-edge'),action})).toBe(false);
    expect(parseConversationEnvelope({...envelope('trusted-main'),action})).toMatchObject({action});
  });

  it('rejects message bodies over the persistence-free ingress limit', () => {
    const value = envelope();
    expect(validateConversationEnvelope({...value, message: {...value.message, text: 'x'.repeat(4_001)}})).toBe(false);
  });

  it('rejects invalid commands', () => {
    const value = envelope();
    expect(validateConversationEnvelope({...value,
      action: {type: 'source.add', name: '', content: 'Details'}})).toBe(false);
    expect(validateConversationEnvelope({...value, action: {type: 'approval.decide', approvalId: 'a',
      kind: 'client_uat', targetReference: 't', decision: 'invalid' as 'approved'}})).toBe(false);
  });
});
