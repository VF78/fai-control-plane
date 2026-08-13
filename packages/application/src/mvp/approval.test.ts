import {describe, expect, it, vi} from 'vitest';
import {decideApproval} from './approval.ts';

const request = {id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'acceptance' as const,
  decision: 'approved' as const, actorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', targetReference: 'issue',
  decidedAt: '2026-08-13T00:00:00.000Z', idempotencyKey: 'command'};
const ports = (allowed = true, version = 'v1') => ({
  authority: {canDecide: vi.fn(async () => allowed)},
  targets: {resolve: vi.fn(async () => ({id: 'issue', url: 'https://example.test/issues/1', version}))},
  transaction: {record: vi.fn(async () => 'recorded' as const)}
});

describe('MVP exact-reference approval', () => {
  it('resolves provider version and commits through one transaction port', async () => {
    const target = ports();
    await expect(decideApproval({workspaceId: 'workspace', request, ...target})).resolves.toBe('recorded');
    expect(target.transaction.record).toHaveBeenCalledWith(expect.objectContaining({workspaceId: 'workspace',
      evidence: expect.objectContaining({target: expect.objectContaining({version: 'v1'})})}));
  });
  it('denies before resolving or persisting', async () => {
    const target = ports(false);
    await expect(decideApproval({workspaceId: 'workspace', request, ...target})).resolves.toBe('denied');
    expect(target.targets.resolve).not.toHaveBeenCalled(); expect(target.transaction.record).not.toHaveBeenCalled();
  });
  it('rejects a missing published target', async () => {
    const target = ports(); target.targets.resolve.mockResolvedValue(null as never);
    await expect(decideApproval({workspaceId: 'workspace', request, ...target})).resolves.toBe('invalid');
    expect(target.transaction.record).not.toHaveBeenCalled();
  });
});
