import {describe, expect, it} from 'vitest';
import {rankAttentionQueue, type AttentionQueueItem} from './attention-queue';

const item = (
  id: string,
  severity: AttentionQueueItem['severity'],
  freshness: string
): AttentionQueueItem => ({
  id,
  projectId: 'project',
  workItemId: null,
  severity,
  project: 'MSA',
  object: 'Work item',
  reason: 'Reason',
  stage: null,
  signalClass: null,
  impact: null,
  freshness: new Date(freshness),
  owner: null,
  evidenceReferences: [],
  nextAction: null,
  sourceUrl: null,
  evidence: 'Evidence',
  action: {label: 'Review', href: null}
});

describe('rankAttentionQueue', () => {
  it('orders severity, freshness, then stable identifier deterministically', () => {
    expect(rankAttentionQueue([
      item('yellow', 'yellow', '2026-07-25T10:00:00.000Z'),
      item('red-a', 'red', '2026-07-24T10:00:00.000Z'),
      item('red-b', 'red', '2026-07-25T10:00:00.000Z'),
      item('red-c', 'red', '2026-07-25T10:00:00.000Z')
    ]).map(({id}) => id)).toEqual(['red-b', 'red-c', 'red-a', 'yellow']);
  });
});
