import {describe, expect, it, vi} from 'vitest';
import {reconcileTracker} from './reconciliation.ts';

const statusMap = {backlog: 'b', ready: 'r', development: 'd', qa: 'q', acceptance: 'a', done: 'z'};
const snapshot = {
  bindingId: 'binding', externalVersion: 'github:updated-at:2026-08-13T00:00:00Z',
  cursor: 'cursor-2', observedAt: '2026-08-13T00:00:00.000Z',
  sourceUrl: 'https://example.test/project',
  items: [
    {itemId: 'one', projectId: 'project', issueId: 'i1', title: 'First task', url: 'https://example.test/i1',
      version: 'v1', statusOptionId: 'b', statusOptionName: 'Backlog', ownerOptionId: null, estimate: null,
      blocked: false, targetDate: '2026-08-31',
      parentIssueId: null, subIssueIds: ['i3'], dependencyIssueIds: ['i4'], assigneeIds: [], assignees: [], observedAt: '2026-08-13T00:00:00.000Z'},
    {itemId: 'two', projectId: 'project', issueId: 'i2', title: 'Second task', url: 'https://example.test/i2',
      version: 'v1', statusOptionId: 'd', statusOptionName: 'Development', ownerOptionId: null, estimate: null,
      blocked: false, targetDate: null,
      parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: [], assignees: [], observedAt: '2026-08-13T00:00:00.000Z'}
  ]
} as const;
const compose = {
  notification: async (item: typeof snapshot.items[number], _reason: string, idempotencyKey: string) => ({
    projectId: item.projectId, contour: 'trusted-main' as const, channelReference: 'internal', text: `Action required: ${item.url}`, idempotencyKey
  }),
  notificationSummary: async (count: number, sourceUrl: string, idempotencyKey: string) => ({
    projectId: 'project', contour: 'trusted-main' as const, channelReference: 'internal',
    text: `Action required: ${count} changes — ${sourceUrl}`, idempotencyKey
  })
};

describe('MVP tracker reconciliation', () => {
  it('stores tracker facts without turning backlog or development state into execution', async () => {
    const replace = vi.fn(async () => undefined);
    const recordFailure = vi.fn(async () => undefined);
    const enqueue = vi.fn(async (_record: unknown) => 'enqueued' as const);
    const append = vi.fn(async () => undefined);
    await expect(reconcileTracker({
      bindingId: 'binding', workspaceId: 'workspace', projectId: 'project', cursor: null, statusMap,
      ports: {tracker: {readSnapshot: async () => snapshot}, snapshots: {readLatest: async () => null, replace, recordFailure}, compose,
        outbox: {enqueue, claim: async () => [], complete: async () => undefined, retry: async () => undefined},
        audit: {append}}
    })).resolves.toEqual({observedItems: 2, queuedActions: 0, cursor: 'cursor-2'});
    expect(replace).toHaveBeenCalledWith(snapshot);
    expect(enqueue).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(expect.objectContaining({workspaceId: 'workspace'}));
  });

  it.each(['b', 'r', 'q'] as const)('never queues an agent request for automatic status %s', async (status) => {
    const enqueue = vi.fn(async () => 'enqueued' as const);
    const automatic = {...snapshot, items: [{...snapshot.items[0], statusOptionId: status}]};
    await reconcileTracker({bindingId: 'binding', workspaceId: 'workspace', projectId: 'project', cursor: null,
      statusMap, ports: {tracker: {readSnapshot: async () => automatic}, snapshots: {
        readLatest: async () => null, replace: async () => undefined, recordFailure: async () => undefined
      }, compose, outbox: {enqueue, claim: async () => [], complete: async () => undefined,
        retry: async () => undefined}, audit: {append: async () => undefined}}});
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not notify historical acceptance items during the initial baseline read', async () => {
    const enqueue = vi.fn(async () => 'enqueued' as const);
    const historical = {...snapshot, items: [{...snapshot.items[0], statusOptionId: 'a'}]};
    await reconcileTracker({bindingId: 'binding', workspaceId: 'workspace', projectId: 'project', cursor: null,
      statusMap, ports: {tracker: {readSnapshot: async () => historical}, snapshots: {
        readLatest: async () => null, replace: async () => undefined, recordFailure: async () => undefined
      }, compose, outbox: {enqueue, claim: async () => [], complete: async () => undefined,
        retry: async () => undefined}, audit: {append: async () => undefined}}});
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('fails closed when the adapter crosses a project binding', async () => {
    const replace = vi.fn(async () => undefined);
    await expect(reconcileTracker({
      bindingId: 'binding', workspaceId: 'workspace', projectId: 'other', cursor: null, statusMap,
      ports: {tracker: {readSnapshot: async () => snapshot}, snapshots: {readLatest: async () => null, replace, recordFailure: async () => undefined}, compose,
        outbox: {enqueue: async () => 'enqueued', claim: async () => [], complete: async () => undefined, retry: async () => undefined},
        audit: {append: async () => undefined}}
    })).rejects.toThrow('tracker_project_mismatch');
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not inflate counts on duplicate delivery intent', async () => {
    const result = await reconcileTracker({
      bindingId: 'binding', workspaceId: 'workspace', projectId: 'project', cursor: null, statusMap,
      ports: {tracker: {readSnapshot: async () => snapshot}, snapshots: {
        readLatest: async () => ({...snapshot, cursor: 'cursor-1', items: snapshot.items.map((item) =>
          item.itemId === 'two' ? {...item, version: 'v0'} : item)}),
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
        readLatest: async () => null, replace: async () => undefined, recordFailure
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

  it('treats a null-to-versioned cursor transition as a baseline', async () => {
    const enqueue = vi.fn(async () => 'enqueued' as const);
    const previous = {...snapshot, cursor: null, items: [{...snapshot.items[0], statusOptionId: 'a'}]};
    const transitioned = {...snapshot, items: [{...snapshot.items[0], statusOptionId: 'a', version: 'v2'}]};
    await reconcileTracker({bindingId: 'binding', workspaceId: 'workspace', projectId: 'project', cursor: null,
      statusMap, ports: {tracker: {readSnapshot: async () => transitioned}, snapshots: {
        readLatest: async () => previous, replace: async () => undefined, recordFailure: async () => undefined
      }, compose, outbox: {enqueue, claim: async () => [], complete: async () => undefined,
        retry: async () => undefined}, audit: {append: async () => undefined}}});
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('notifies only later version-different human items', async () => {
    const enqueue = vi.fn(async () => 'enqueued' as const);
    const previous = {...snapshot, cursor: 'cursor-1', items: snapshot.items.map((item) => ({...item,
      statusOptionId: 'a' as const}))};
    const current = {...snapshot, items: previous.items.map((item) => item.itemId === 'two'
      ? {...item, version: 'v2'} : item)};
    await reconcileTracker({bindingId: 'binding', workspaceId: 'workspace', projectId: 'project', cursor: 'cursor-1',
      statusMap, ports: {tracker: {readSnapshot: async () => current}, snapshots: {
        readLatest: async () => previous, replace: async () => undefined, recordFailure: async () => undefined
      }, compose, outbox: {enqueue, claim: async () => [], complete: async () => undefined,
        retry: async () => undefined}, audit: {append: async () => undefined}}});
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({payload: {message: expect.objectContaining({
      text: 'Action required: https://example.test/i2'
    })}}));
  });

  it('aggregates multiple genuine changes into exactly one deterministic notification', async () => {
    const enqueue = vi.fn(async () => 'enqueued' as const);
    const append = vi.fn(async () => undefined);
    const items = Array.from({length: 12}, (_, index) => ({...snapshot.items[0], itemId: `item-${index}`,
      issueId: `${index}`, version: 'v2', statusOptionId: 'a' as const}));
    const current = {...snapshot, items};
    const previous = {...current, cursor: 'cursor-1', items: items.map((item) => ({...item, version: 'v1'}))};
    await reconcileTracker({bindingId: 'binding', workspaceId: 'workspace', projectId: 'project', cursor: 'cursor-1',
      statusMap, ports: {tracker: {readSnapshot: async () => current}, snapshots: {
        readLatest: async () => previous, replace: async () => undefined, recordFailure: async () => undefined
      }, compose, outbox: {enqueue, claim: async () => [], complete: async () => undefined,
        retry: async () => undefined}, audit: {append}}});
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^tracker-notification-summary:sha256:[a-f0-9]{64}$/),
      payload: {message: expect.objectContaining({
        text: 'Action required: 12 changes — https://example.test/project'
      })}
    }));
    expect(append).toHaveBeenCalledWith(expect.objectContaining({details: expect.objectContaining({
      notificationCandidateCount: 12, aggregatedNotificationCount: 12, queuedActions: 1
    })}));
  });

  it('does not advance the snapshot baseline when durable notification intent fails', async () => {
    const replace = vi.fn(async () => undefined);
    const previous = {...snapshot, cursor: 'cursor-1', items: [{...snapshot.items[0]!,
      version: 'v1', statusOptionId: 'a' as const}]};
    const current = {...snapshot, items: [{...previous.items[0]!, version: 'v2'}]};
    await expect(reconcileTracker({bindingId: 'binding', workspaceId: 'workspace', projectId: 'project',
      cursor: 'cursor-1', statusMap, ports: {tracker: {readSnapshot: async () => current}, snapshots: {
        readLatest: async () => previous, replace, recordFailure: async () => undefined
      }, compose, outbox: {enqueue: async () => { throw new Error('outbox_unavailable'); }, claim: async () => [],
        complete: async () => undefined, retry: async () => undefined}, audit: {append: async () => undefined}}}))
      .rejects.toThrow('outbox_unavailable');
    expect(replace).not.toHaveBeenCalled();
  });
});
