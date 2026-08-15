export type ExternalReference = Readonly<{
  id: string;
  url: string;
  version: string;
}>;

export type SourceReference = Readonly<{
  id: string;
  sha256: string;
  kind: string;
  provenance: string;
  /** Explicitly selected bounded text supplied to the configured executor. */
  content: string;
}>;

export type TrackerItemFact = Readonly<{
  itemId: string;
  projectId: string;
  issueId: string;
  title: string;
  url: string;
  version: string;
  statusOptionId: string | null;
  statusOptionName: string | null;
  /** Provider-native single-select option identifying the task's execution owner. */
  ownerOptionId: string | null;
  blocked: boolean | null;
  targetDate: string | null;
  parentIssueId: string | null;
  subIssueIds: readonly string[];
  dependencyIssueIds: readonly string[];
  assigneeIds: readonly string[];
  observedAt: string;
}>;

export type TrackerSnapshot = Readonly<{
  bindingId: string;
  externalVersion: string;
  cursor: string | null;
  observedAt: string;
  sourceUrl: string;
  items: readonly TrackerItemFact[];
}>;

export const approvalKinds = [
  'plan', 'internal_operation', 'production', 'acceptance', 'client_uat'
] as const;
export type ApprovalKind = (typeof approvalKinds)[number];
export const approvalDecisions = ['approved', 'rejected'] as const;
export type ApprovalDecision = (typeof approvalDecisions)[number];

export type ApprovalEvidence = Readonly<{
  id: string;
  projectId: string;
  kind: ApprovalKind;
  decision: ApprovalDecision;
  actorId: string;
  target: ExternalReference;
  decidedAt: string;
  idempotencyKey: string;
}>;

export type OpaqueSecretRef = Readonly<{
  id: string;
  purpose: string;
  locator: string;
}>;

const singleLine = (value: unknown, maximum = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum &&
  !/[\0\r\n]/.test(value);

export const isHttpsUrl = (value: unknown): value is string => {
  if (!singleLine(value, 2_048)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
};

export const isInstant = (value: unknown): value is string =>
  singleLine(value, 64) && !Number.isNaN(Date.parse(value));

export const isBoundedId = (value: unknown): value is string => singleLine(value, 256);
export const isUuid = (value: unknown): value is string => singleLine(value, 36) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export const validateTrackerSnapshot = (value: TrackerSnapshot): boolean =>
  isBoundedId(value.bindingId) && isBoundedId(value.externalVersion) && isInstant(value.observedAt) &&
  isHttpsUrl(value.sourceUrl) && (value.cursor === null || isBoundedId(value.cursor)) &&
  value.items.length <= 1_000 && value.items.every((item) =>
    isBoundedId(item.itemId) && isBoundedId(item.projectId) && isBoundedId(item.issueId) &&
    singleLine(item.title, 512) && isHttpsUrl(item.url) && isBoundedId(item.version) &&
    (item.statusOptionId === null || isBoundedId(item.statusOptionId)) &&
    (item.statusOptionName === null || singleLine(item.statusOptionName, 512)) &&
    (item.ownerOptionId === null || isBoundedId(item.ownerOptionId)) &&
    (item.blocked === null || typeof item.blocked === 'boolean') &&
    (item.targetDate === null || /^\d{4}-\d{2}-\d{2}$/.test(item.targetDate)) &&
    (item.parentIssueId === null || isBoundedId(item.parentIssueId)) &&
    item.subIssueIds.length <= 100 && item.subIssueIds.every(isBoundedId) &&
    item.dependencyIssueIds.length <= 100 && item.dependencyIssueIds.every(isBoundedId) &&
    item.assigneeIds.length <= 20 && item.assigneeIds.every(isBoundedId) && isInstant(item.observedAt));
