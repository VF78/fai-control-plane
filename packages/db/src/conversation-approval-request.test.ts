import {describe, expect, it} from 'vitest';
import {prepareConversationApprovalRequest} from './conversation-approval-request.ts';

const request = {
  projectRef: 'project:opaque',
  origin: {
    visibility: 'client' as const,
    channelRef: 'channel:opaque',
    actorRef: 'actor:opaque',
    messageRef: 'message:opaque',
    observedAt: '2026-08-13T00:00:00.000Z'
  },
  action: {
    type: 'external_approval.request' as const,
    reference: {
      referenceId: 'github:issue:42',
      url: 'https://github.com/VF78/ascon/issues/42',
      expectedVersion: 'github:updated-at:2026-08-13T00:00:00Z'
    }
  },
  correlationId: 'correlation-42',
  idempotencyKey: 'idempotency-42'
};

describe('conversation approval request plan', () => {
  it('binds an opaque approval to the exact external reference and version', () => {
    const first = prepareConversationApprovalRequest(request);
    const replay = prepareConversationApprovalRequest(request);
    expect(replay).toEqual(first);
    expect(first.result).toMatchObject({
      kind: 'approval',
      referenceId: expect.stringMatching(/^approval:v1:[0-9a-f]{64}$/),
      url: request.action.reference.url,
      version: expect.stringMatching(/^approval-request:v1:[0-9a-f]{64}$/)
    });
    expect(first.receiptResult.value.targetReference).toEqual(request.action.reference);
    expect(JSON.stringify(first)).not.toContain('Bounded message');
    const changed = prepareConversationApprovalRequest({
      ...request,
      action: {...request.action, reference: {
        ...request.action.reference, expectedVersion: 'github:updated-at:2026-08-13T00:01:00Z'
      }}
    });
    expect(changed.requestHash).not.toBe(prepareConversationApprovalRequest(request).requestHash);
  });
});
