export type AttentionQueueItem = Readonly<{
  id: string;
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
}>;

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
