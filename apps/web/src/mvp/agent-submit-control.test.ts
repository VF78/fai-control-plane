import {describe, expect, it} from 'vitest';
import type {TrackerItemFact} from '@fai-control-plane/domain';
import {eligibleHermesTasks} from './agent-submit-control.tsx';

const task = (itemId: string, statusOptionId: string | null, ownerOptionId: string | null): TrackerItemFact => ({
  itemId, projectId: 'project', issueId: itemId, title: itemId, url: `https://example.test/issues/${itemId}`,
  version: 'v1', statusOptionId, statusOptionName: null, ownerOptionId, estimate: null, blocked: false, targetDate: null,
  parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: [], assignees: [],
  observedAt: '2026-08-15T10:00:00.000Z'
});

describe('Hermes submit task choices', () => {
  it('offers only non-Done tasks with the exact Hermes Owner option', () => {
    const tasks = [task('eligible', 'ready', 'owner-hermes'), task('done', 'done', 'owner-hermes'),
      task('unassigned', 'ready', null), task('other', 'ready', 'owner-other')];
    expect(eligibleHermesTasks(tasks, 'done', 'owner-hermes').map((item) => item.itemId)).toEqual(['eligible']);
  });

  it('offers nothing until both exact composition bindings are configured', () => {
    expect(eligibleHermesTasks([task('eligible', 'ready', 'owner-hermes')], undefined, 'owner-hermes')).toEqual([]);
  });
});
