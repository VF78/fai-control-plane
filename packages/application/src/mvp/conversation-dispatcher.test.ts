import {describe, expect, it, vi} from 'vitest';
import {dispatchConversationAction} from './conversation-dispatcher.ts';
import {validateConversationEnvelope, type InternalConversationEnvelope, type ProjectRole} from '@fai-control-plane/domain';

const envelope: InternalConversationEnvelope = {message: {projectId: 'project', contour: 'trusted-main',
  channelReference: 'channel', senderReference: 'sender', messageReference: 'message',
  observedAt: '2026-08-13T00:00:00.000Z', text: 'Configure project', correlationId: 'correlation',
  idempotencyKey: 'message-key'}, action: {type: 'source.add', name: 'Decision', content: 'Confirmed'}};
const ports = (identity: {actorId: string; role: ProjectRole} | null = {actorId: 'operator', role: 'operator'}) => ({
  approvals: {decide: vi.fn(async () => ({referenceId: 'approval-1'}))},
  sources: {add: vi.fn(async () => ({referenceId: 'source-1'}))},
  identities: {resolveActiveHuman: vi.fn(async () => identity)},
  receipts: {exists: vi.fn(async () => false), record: vi.fn(async () => undefined)},
  completion: {complete: vi.fn(async () => 'recorded' as const)},
  executionMode: {configure: vi.fn(async () => ({referenceId:'autonomous'}))}
});
describe('internal conversation trust boundary', () => {
  it('lets an authenticated operator enable autonomous mode only on the internal contour', async () => {
    const target = ports({actorId:'operator',role:'operator'});
    const internal = {...envelope,message:{...envelope.message,contour:'trusted-main' as const},
      action:{type:'project.execution.mode' as const,mode:'autonomous' as const}};
    expect(validateConversationEnvelope(internal)).toBe(true);
    await expect(dispatchConversationAction({workspaceId:'workspace',envelope:internal,ports:target}))
      .resolves.toEqual({status:'completed',referenceId:'autonomous'});
    expect(target.executionMode.configure).toHaveBeenCalledWith(expect.objectContaining({actorId:'operator',
      projectId:'project',mode:'autonomous'}));
  });
  it('denies unmapped and client identities before any command', async () => {
    for (const identity of [null, {actorId: 'client', role: 'client' as const}]) {
      const target = ports(identity);
      await expect(dispatchConversationAction({workspaceId: 'workspace', envelope, ports: target}))
        .resolves.toEqual({status: 'denied'});
      expect(target.sources.add).not.toHaveBeenCalled();
    }
  });
});
