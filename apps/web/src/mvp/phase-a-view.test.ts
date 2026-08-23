import {describe, expect, it} from 'vitest';
import type {TrackerItemFact} from '@fai-control-plane/domain';
import {asconProcess, dashboardProjection, executorFact, phaseAState} from './phase-a-view.ts';

const task = (statusOptionName: string | null, overrides: Partial<TrackerItemFact> = {}): TrackerItemFact => ({
  itemId: 'item', projectId: 'project', issueId: '1', title: 'Task', url: 'https://example.test/issues/1', version: 'v1',
  statusOptionId: null, statusOptionName, ownerOptionId: null, blocked: null, targetDate: null,
  parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: [], assignees: [],
  observedAt: '2026-08-23T10:00:00.000Z', ...overrides
});

describe('Phase A read projections', () => {
  it('maps statuses and always counts tasks for dashboard progress', () => {
    expect(['Done', 'QA', 'Acceptance', 'Ready', 'In Dev', 'Backlog', 'Unknown'].map(phaseAState))
      .toEqual(['accepted', 'review', 'review', 'in-progress', 'in-progress', 'not-started', 'not-started']);
    expect(dashboardProjection([task('Done'), task('QA', {itemId: 'item-2'}), task('Backlog', {itemId: 'item-3'})]))
      .toMatchObject({total: 3, states: {accepted: 1, review: 1, 'in-progress': 0, 'not-started': 1}});
  });

  it('keeps ASCON policy read-only and terminal at Done', () => {
    expect(asconProcess.map((stage) => stage.name)).toEqual(['Backlog', 'Ready', 'In Dev', 'QA', 'Acceptance', 'Done']);
    expect(asconProcess[1]).toMatchObject({gate: 'PO Ready: требуется'});
    expect(asconProcess[4]).toMatchObject({gate: 'PO gate в Done: требуется', evidence: expect.stringContaining('staging')});
    expect(asconProcess[5]?.next).toBe('Завершение процесса');
  });

  it('uses the most advanced active approved stage for the current phase', () => {
    expect(dashboardProjection([task('Ready'), task('QA', {itemId: 'item-2'})]).phase).toBe('QA');
    expect(dashboardProjection([task('Done'), task('In Dev', {itemId: 'item-2'}), task('Acceptance', {itemId: 'item-3'})]).phase).toBe('Acceptance');
    expect(dashboardProjection([task('Done')])).toMatchObject({phase: 'Done', blocked: 0});
  });

  it('projects one executor fact without hiding a conflicting provider fact', () => {
    expect(executorFact(task('Ready', {assignees: [{id: 'U', login: 'octo', name: 'Octo'}]}), 'hermes')).toBe('Octo');
    expect(executorFact(task('Ready', {ownerOptionId: 'hermes'}), 'hermes')).toBe('Hermes');
    expect(executorFact(task('Ready', {ownerOptionId: 'hermes', assignees: [{id: 'U', login: 'octo', name: null}]}), 'hermes')).toBe('Конфликт: Hermes + octo');
    expect(executorFact(task('Ready'), 'hermes')).toBe('Не назначен');
  });
});
