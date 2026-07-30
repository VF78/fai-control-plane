export type AttentionQueueItem = Readonly<{
  id: string;
  /** Canonical RiskSignal identity; absent for compatibility-only operational rows. */
  riskSignalId: string | null;
  projectId: string;
  /** Canonical WorkItem identity when the signal is task-scoped. */
  workItemId: string | null;
  severity: 'red' | 'yellow' | 'green';
  project: string;
  object: string;
  reason: string;
  /** Persisted delivery stage when the signal is linked to a journey. */
  stage: string | null;
  /** Risk signal provenance; legacy operational sources do not record it. */
  signalClass: 'fact' | 'inference' | null;
  impact: string | null;
  freshness: Date;
  owner: string | null;
  evidenceReferences: readonly Readonly<{type: string; id: string}>[];
  nextAction: string | null;
  /** A provider source is supplemental; operator navigation is always internal. */
  sourceUrl: string | null;
  /** Compatibility summary for the legacy operator surface. */
  evidence: string;
  /** Compatibility-only provider action for the legacy operator surface. */
  action: Readonly<{label: string; href: string | null}>;
  /** Latest immutable disposition event version, including after expiry. */
  dispositionVersion: number;
  disposition: Readonly<{
    kind: 'acknowledged' | 'snoozed';
    reason: 'investigating' | 'awaiting_evidence' | 'planned_maintenance' | 'external_dependency';
    expiresAt: Date;
    reentryCondition: 'risk_unresolved_at_expiry';
    version: number;
  }> | null;
}>;

export const activeRiskDisposition = (
  disposition: AttentionQueueItem['disposition'],
  asOf: Date
): AttentionQueueItem['disposition'] =>
  disposition !== null && disposition.expiresAt.getTime() > asOf.getTime()
    ? disposition
    : null;

const severityRank: Record<AttentionQueueItem['severity'], number> = {
  red: 0,
  yellow: 1,
  green: 2
};

export const rankAttentionQueue = (
  items: readonly AttentionQueueItem[]
): AttentionQueueItem[] => [...items].sort((left, right) => {
  const severity = severityRank[left.severity] - severityRank[right.severity];
  if (severity !== 0) return severity;
  const freshness = right.freshness.getTime() - left.freshness.getTime();
  if (freshness !== 0) return freshness;
  return left.id.localeCompare(right.id);
});
