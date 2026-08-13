import {describe, expect, it, vi} from 'vitest';
import {reconcileTracker} from './reconciliation.ts';

const statusMap = {backlog: 'b', ready: 'r', development: 'd', qa: 'q', acceptance: 'a', done: 'z'};
const snapshot = {
  bindingId: 'binding', externalVersion: 'github:updated-at:2026-08-13T00:00:00Z',
  cursor: 'cursor-2', observedAt: '2026-08-13T00:00:00.000Z',
  sourceUrl: 'https://example.test/project',
  items: [
    {itemId: 'one', projectId: 'project', issueId: 'i1', title: 'First task', url: 'https://example.test/i1',
      version: 'v1', statusOptionId: 'b', statusOptionName: 'Backlog', blocked: false, targetDate: '2026-08-31',
      parentIssueId: null, subIssueIds: ['i3'], dependencyIssueIds: ['i4'], assigneeIds: [], observedAt: '2026-08-13T00:00:00.000Z'},
    {itemId: 'two', projectId: 'project', issueId: 'i2', title: 'Second task', url: 'https://example.test/i2',
      version: 'v1', statusOptionId: 'd', statusOptionName: 'Development', blocked: false, targetDate: null,
      parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: [], observedAt: '2026-08-13T00:00:00.000Z'}
  ]
} as const;
const compose = {
  agentRequest: async (item: typeof snapshot.items[number], role: 'manager' | 'developer' | 'qa' | 'devops', idempotencyKey: string) => ({
    role, repository: {id: 'repo', url: 'https://example.test/repo'},
    projectItem: {id: item.itemId, projectId: item.projectId, issueId: item.issueId, url: item.url},
    observedVersion: item.version, sources: [], constraints: ['bounded'], acceptanceCriteria: ['verified'],
    approval: null, correlationId: idempotencyKey, idempotencyKey
  }),
  notification: async (item: typeof snapshot.items[number], _reason: string, idempotencyKey: string) => ({
    projectId: item.projectId, contour: 'trusted-main' as const, channelReference: 'internal', text: `Action required: ${item.url}`, idempotencyKey
  })
};

describe('MVP tracker reconciliation', () => {
  it('stores facts and queues only actionable intent', async () => {
    const replace = vi.fn(async () => undefined);
    const recordFailure = vi.fn(async () => undefined);
    const enqueue = vi.fn(async (_record: unknown) => 'enqueued' as const);
    const append = vi.fn(async () => undefined);
    await expect(reconcileTracker({
      bindingId: 'binding', workspaceId: 'workspace', projectId: 'project', cursor: null, statusMap,
      ports: {tracker: {readSnapshot: async () => snapshot}, snapshots: {replace, recordFailure}, compose,
        outbox: {enqueue, claim: async () => [], complete: async () => undefined, retry: async () => undefined},
        audit: {append}}
    })).resolves.toEqual({observedItems: 2, queuedActions: 1, cursor: 'cursor-2'});
    expect(replace).toHaveBeenCalledWith(snapshot);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({topic: 'agent-role-request'});
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({payload: {request: {
      projectItem: {id: 'one'}, observedVersion: 'v1'
    }}});
    expect(append).toHaveBeenCalledWith(expect.objectContaining({workspaceId: 'workspace'}));
  });

  it('fails closed when the adapter crosses a project binding', async () => {
    const replace = vi.fn(async () => undefined);
    await expect(reconcileTracker({
      bindingId: 'binding', workspaceId: 'workspace', projectId: 'other', cursor: null, statusMap,
      ports: {tracker: {readSnapshot: async () => snapshot}, snapshots: {replace, recordFailure: async () => undefined}, compose,
        outbox: {enqueue: async () => 'enqueued', claim: async () => [], complete: async () => undefined, retry: async () => undefined},
        audit: {append: async () => undefined}}
    })).rejects.toThrow('tracker_project_mismatch');
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not inflate counts on duplicate delivery intent', async () => {
    const result = await reconcileTracker({
      bindingId: 'binding', workspaceId: 'workspace', projectId: 'project', cursor: null, statusMap,
      ports: {tracker: {readSnapshot: async () => snapshot}, snapshots: {
        replace: async () => undefined, recordFailure: async () => undefined
      }, compose,
        outbox: {enqueue: async () => 'duplicate', claim: async () => [], complete: async () => undefined, retry: async () => undefined},
        audit: {append: async () => undefined}}
    });
    expect(result.queuedActions).toBe(0);
  });

  it('records one bounded failed attempt and rethrows the provider failure', async () => {
    const recordFailure = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    await expect(reconcileTracker({
      bindingId: 'binding', workspaceId: 'workspace', projectId: 'project', cursor: null, statusMap,
      ports: {tracker: {readSnapshot: async () => { throw new Error('github_read_failed'); }}, snapshots: {
        replace: async () => undefined, recordFailure
      }, compose, outbox: {enqueue: async () => 'enqueued', claim: async () => [],
        complete: async () => undefined, retry: async () => undefined}, audit: {append}}
    })).rejects.toThrow('github_read_failed');
    expect(recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      bindingId: 'binding', errorCode: 'github_read_failed'
    }));
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tracker.snapshot_failed', details: {errorCode: 'github_read_failed'}
    }));
  });
});
