import {describe, expect, it} from 'vitest';
import {trackerEstimateMaximum, type TrackerItemFact} from '@fai-control-plane/domain';
import {asconProcess, dashboardProjection, phaseAState} from './phase-a-view.ts';

const task = (statusOptionName: string | null, estimate: number | null, overrides: Partial<TrackerItemFact> = {}): TrackerItemFact => ({
  itemId: 'item', projectId: 'project', issueId: '1', title: 'Task', url: 'https://example.test/issues/1', version: 'v1',
  statusOptionId: null, statusOptionName, ownerOptionId: null, estimate, blocked: null, targetDate: null,
  parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: [], assignees: [],
  observedAt: '2026-08-23T10:00:00.000Z', ...overrides
});

describe('Phase A read projections', () => {
  it('maps exactly the approved dashboard states and declines task-count progress', () => {
    expect(['Done', 'QA', 'Acceptance', 'Ready', 'In Dev', 'Backlog', 'Unknown'].map(phaseAState))
      .toEqual(['accepted', 'review', 'review', 'in-progress', 'in-progress', 'not-started', 'not-started']);
    expect(dashboardProjection([task('Done', null)]).configured).toBe(false);
    expect(dashboardProjection([task('Done', 0)]).configured).toBe(false);
    expect(dashboardProjection([task('Done', trackerEstimateMaximum + 1)]).configured).toBe(false);
  });

  it('keeps ASCON policy read-only and terminal at Done', () => {
    expect(asconProcess.map((stage) => stage.name)).toEqual(['Backlog', 'Ready', 'In Dev', 'QA', 'Acceptance', 'Done']);
    expect(asconProcess[1]).toMatchObject({gate: 'PO Ready: требуется'});
    expect(asconProcess[4]).toMatchObject({gate: 'PO gate в Done: требуется', evidence: expect.stringContaining('staging')});
    expect(asconProcess[5]?.next).toBe('Завершение процесса');
  });

  it('uses the most advanced active approved stage for the current phase', () => {
    expect(dashboardProjection([task('Ready', 1), task('QA', 1, {itemId: 'item-2'})]).phase).toBe('QA');
    expect(dashboardProjection([task('Done', 1), task('In Dev', 1, {itemId: 'item-2'}), task('Acceptance', 1, {itemId: 'item-3'})]).phase).toBe('Acceptance');
  });
});
