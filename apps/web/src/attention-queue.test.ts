import {describe, expect, it} from 'vitest';
import {
  activeRiskDisposition,
  rankAttentionQueue,
  type AttentionQueueItem
} from './attention-queue';

const item = (
  id: string,
  severity: AttentionQueueItem['severity'],
  freshness: string
): AttentionQueueItem => ({
  id,
  riskSignalId: null,
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
  action: {label: 'Review', href: null},
  dispositionVersion: 0,
  disposition: null
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

  it('keeps an acknowledgement visible and re-enters an unresolved snooze at expiry', () => {
    const acknowledged: NonNullable<AttentionQueueItem['disposition']> = {
      kind: 'acknowledged',
      reason: 'investigating',
      expiresAt: new Date('2026-08-01T12:00:00.000Z'),
      reentryCondition: 'risk_unresolved_at_expiry',
      version: 1
    };
    const snoozed = {...acknowledged, kind: 'snoozed' as const};
    const before = new Date('2026-08-01T11:59:59.999Z');
    const atExpiry = new Date('2026-08-01T12:00:00.000Z');

    expect(activeRiskDisposition(acknowledged, before)?.kind)
      .toBe('acknowledged');
    expect(activeRiskDisposition(snoozed, before)?.kind).toBe('snoozed');
    expect(activeRiskDisposition(snoozed, atExpiry)).toBeNull();
  });
});
