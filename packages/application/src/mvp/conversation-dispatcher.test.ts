import {describe, expect, it, vi} from 'vitest';
import {dispatchClientConversationAction} from './conversation-dispatcher.ts';
import type {ClientConversationEnvelope} from '@fai-control-plane/domain';

const envelope: ClientConversationEnvelope = {message: {projectId: 'project', contour: 'client-edge',
  channelReference: 'channel', senderReference: 'sender', messageReference: 'message',
  observedAt: '2026-08-13T00:00:00.000Z', text: '/issue Defect | Fails', correlationId: 'correlation',
  idempotencyKey: 'message-key'}, action: {type: 'issue.create', title: 'Defect', statement: 'Fails'}};
const ports = (identity: {actorId: string} | null = {actorId: 'human'}) => ({
  facts: {read: vi.fn(async () => ({referenceId: 'snapshot-1'}))},
  tracker: {createIssue: vi.fn(async () => ({referenceId: 'issue-1', url: 'https://example.test/1', version: 'v1'})),
    addIssueContext: vi.fn(async () => ({referenceId: 'issue-1', url: 'https://example.test/1', version: 'v2'}))},
  approvals: {decide: vi.fn(async () => ({referenceId: 'approval-1'}))},
  identities: {resolveActiveHuman: vi.fn(async () => identity)},
  receipts: {exists: vi.fn(async () => false), record: vi.fn(async () => undefined)},
  completion: {complete: vi.fn(async () => 'recorded' as const)}
});
describe('client conversation trust boundary', () => {
  it('creates one bounded issue without an agent port', async () => {
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope, ports: ports()}))
      .resolves.toEqual({status: 'completed', referenceId: 'issue-1'});
  });
  it('denies an unmapped approval sender', async () => {
    const target = ports(null); const approval: ClientConversationEnvelope = {...envelope,
      action: {type: 'approval.decide', approvalId: 'approval', kind: 'client_uat', targetReference: 'issue', decision: 'approved'}};
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope: approval, ports: target}))
      .resolves.toEqual({status: 'denied'});
    expect(target.approvals.decide).not.toHaveBeenCalled();
  });
  it('denies an unmapped sender before an issue mutation', async () => {
    const target = ports(null);
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope, ports: target}))
      .resolves.toEqual({status: 'denied'});
    expect(target.tracker.createIssue).not.toHaveBeenCalled();
  });
});
