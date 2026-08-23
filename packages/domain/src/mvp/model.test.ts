import {describe, expect, it} from 'vitest';
import {isBoundedId, isHttpsUrl, isInstant, validateTrackerSnapshot, type TrackerItemFact, type TrackerSnapshot} from './model.ts';

describe('MVP primitive validation', () => {
  it.each(['project-1', 'github:item:1', 'opaque_reference'])('accepts bounded id %s', (value) => {
    expect(isBoundedId(value)).toBe(true);
  });

  it.each(['', 'line\nbreak', 'x'.repeat(257)])('rejects unsafe id', (value) => {
    expect(isBoundedId(value)).toBe(false);
  });

  it('accepts only credential-free HTTPS references', () => {
    expect(isHttpsUrl('https://example.test/path')).toBe(true);
    expect(isHttpsUrl('http://example.test/path')).toBe(false);
    expect(isHttpsUrl('https://user:pass@example.test/path')).toBe(false);
  });

  it('validates observed instants', () => {
    expect(isInstant('2026-08-13T00:00:00.000Z')).toBe(true);
    expect(isInstant('not-a-date')).toBe(false);
  });
});

const snapshot = (item: Partial<TrackerItemFact>): TrackerSnapshot => ({bindingId: 'binding', externalVersion: 'v1', cursor: null,
  observedAt: '2026-08-23T10:00:00.000Z', sourceUrl: 'https://example.test/project', items: [{itemId: 'item', projectId: 'project', issueId: '1', title: 'Task', url: 'https://example.test/issues/1', version: 'v1', statusOptionId: null, statusOptionName: null, ownerOptionId: null, estimate: 2, blocked: null, targetDate: null, parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: ['user'], assignees: [{id: 'user', login: 'octo', name: null}], observedAt: '2026-08-23T10:00:00.000Z', ...item}]});

describe('Tracker snapshot Phase A bounded facts', () => {
  it('accepts finite positive Estimate and readable assignee projection', () => expect(validateTrackerSnapshot(snapshot({}))).toBe(true));
  it('rejects a non-positive Estimate and unbounded display identity', () => {
    expect(validateTrackerSnapshot(snapshot({estimate: 0}))).toBe(false);
    expect(validateTrackerSnapshot(snapshot({assignees: [{id: 'user', login: '', name: null}]}))).toBe(false);
  });

  it('rejects a readable assignee outside the authoritative assignee IDs', () => {
    expect(validateTrackerSnapshot(snapshot({assignees: [{id: 'other-user', login: 'octo', name: null}]}))).toBe(false);
  });
});
