import {describe, expect, it} from 'vitest';
import {decideNextAction, type StatusMap} from './ascon-next-action.ts';
import type {TrackerItemFact} from './model.ts';

const statuses: StatusMap = {backlog: 'b', ready: 'r', development: 'd', qa: 'q', acceptance: 'a', done: 'z'};
const item = (statusOptionId: string | null, assigneeIds: string[] = []): TrackerItemFact => ({
  itemId: 'item', projectId: 'project', issueId: 'issue', url: 'https://example.test/issues/1',
  title: 'Issue title', version: 'v1', statusOptionId, statusOptionName: null, blocked: null,
  targetDate: null, parentIssueId: null, subIssueIds: [], dependencyIssueIds: [],
  assigneeIds, observedAt: '2026-08-13T00:00:00.000Z'
});

describe('MVP fixed next-action decision', () => {
  it.each([
    ['b', 'agent', 'manager'],
    ['q', 'agent', 'qa'],
    ['a', 'human', null],
    ['z', 'human', null],
    ['d', 'none', null],
    ['unknown', 'none', null]
  ] as const)('maps %s to %s/%s', (status, kind, role) => {
    expect(decideNextAction(item(status), statuses)).toMatchObject({kind, role});
  });

  it('uses a human assignee instead of dispatching development', () => {
    expect(decideNextAction(item('r', ['actor']), statuses)).toMatchObject({kind: 'human'});
  });

  it('produces a stable version-bound key', () => {
    const first = decideNextAction(item('q'), statuses).idempotencyKey;
    expect(first).toBe(decideNextAction(item('q'), statuses).idempotencyKey);
    expect(first).not.toBe(decideNextAction({...item('q'), version: 'v2'}, statuses).idempotencyKey);
  });
});
