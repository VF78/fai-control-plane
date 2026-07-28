export type AttentionQueueItem = Readonly<{
  id: string;
  projectId: string;
  severity: 'red' | 'yellow' | 'green';
  project: string;
  object: string;
  reason: string;
  impact: string;
  freshness: Date;
  owner: string | null;
  evidence: string;
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
