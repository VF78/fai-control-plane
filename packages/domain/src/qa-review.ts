import type {CommandResult} from './index.ts';

export const qaReviewOutcomes = ['passed', 'failed'] as const;
export type QaReviewOutcome = (typeof qaReviewOutcomes)[number];
export const qaCheckStatuses = ['passed', 'failed', 'not_run'] as const;
export type QaCheckStatus = (typeof qaCheckStatuses)[number];

export type QaReviewCheck = Readonly<{
  name: string;
  status: QaCheckStatus;
  reference: string;
}>;
export type QaReviewArtifact = Readonly<{
  kind: 'report' | 'log' | 'screenshot' | 'other';
  reference: string;
}>;
export type QaReviewIssue = Readonly<{
  summary: string;
  reference: string;
}>;
export type QaReviewEvidence = Readonly<{
  outcome: QaReviewOutcome;
  checks: readonly QaReviewCheck[];
  artifacts: readonly QaReviewArtifact[];
  failures: readonly QaReviewIssue[];
  risks: readonly QaReviewIssue[];
  evidenceReferences: readonly Readonly<{requirement: string; reference: string}>[];
}>;

const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum = 2_048): value is string =>
  typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum;
const failure = (message: string): CommandResult<QaReviewEvidence> => ({
  ok: false, error: {code: 'INVALID_COMMAND', message}
});

/**
 * A retained QA receipt is deliberately reference-only. It cannot carry source
 * contents, runner output, credentials, or a provider-specific identifier.
 */
export const validateQaReviewEvidence = (value: unknown): CommandResult<QaReviewEvidence> => {
  if (!isRecord(value) || !exact(value, [
    'outcome', 'checks', 'artifacts', 'failures', 'risks', 'evidenceReferences'
  ]) || !qaReviewOutcomes.includes(value.outcome as QaReviewOutcome) ||
    !Array.isArray(value.checks) || !Array.isArray(value.artifacts) ||
    !Array.isArray(value.failures) || !Array.isArray(value.risks) ||
    !Array.isArray(value.evidenceReferences) || value.checks.length === 0 ||
    value.checks.length > 50 || value.artifacts.length > 25 || value.failures.length > 25 ||
    value.risks.length > 25 || value.evidenceReferences.length > 25 ||
    Object.keys(value.checks).length !== value.checks.length ||
    Object.keys(value.artifacts).length !== value.artifacts.length ||
    Object.keys(value.failures).length !== value.failures.length ||
    Object.keys(value.risks).length !== value.risks.length ||
    Object.keys(value.evidenceReferences).length !== value.evidenceReferences.length) {
    return failure('QA review evidence is not canonical.');
  }
  const checkNames = new Set<string>();
  const checks: QaReviewCheck[] = [];
  for (const item of value.checks) {
    if (!isRecord(item) || !exact(item, ['name', 'status', 'reference']) || !text(item.name, 200) ||
      !qaCheckStatuses.includes(item.status as QaCheckStatus) || !text(item.reference) ||
      checkNames.has(item.name)) return failure('QA checks are not canonical.');
    checkNames.add(item.name); checks.push({name: item.name, status: item.status as QaCheckStatus, reference: item.reference});
  }
  const artifacts: QaReviewArtifact[] = [];
  for (const item of value.artifacts) {
    if (!isRecord(item) || !exact(item, ['kind', 'reference']) ||
      !['report', 'log', 'screenshot', 'other'].includes(item.kind as string) || !text(item.reference)) {
      return failure('QA artifacts are not canonical.');
    }
    artifacts.push({kind: item.kind as QaReviewArtifact['kind'], reference: item.reference});
  }
  const issues = (items: unknown[]): QaReviewIssue[] | null => {
    const seen = new Set<string>(); const parsed: QaReviewIssue[] = [];
    for (const item of items) {
      if (!isRecord(item) || !exact(item, ['summary', 'reference']) || !text(item.summary, 500) ||
        !text(item.reference) || seen.has(`${item.summary}\u0000${item.reference}`)) return null;
      seen.add(`${item.summary}\u0000${item.reference}`);
      parsed.push({summary: item.summary, reference: item.reference});
    }
    return parsed;
  };
  const failures = issues(value.failures); const risks = issues(value.risks);
  if (failures === null || risks === null) return failure('QA failures or risks are not canonical.');
  const evidence = value.evidenceReferences;
  const evidenceSeen = new Set<string>();
  const evidenceReferences: Array<{requirement: string; reference: string}> = [];
  for (const item of evidence) {
    if (!isRecord(item) || !exact(item, ['requirement', 'reference']) || !text(item.requirement, 500) ||
      !text(item.reference) || evidenceSeen.has(item.requirement)) return failure('QA evidence references are not canonical.');
    evidenceSeen.add(item.requirement); evidenceReferences.push({requirement: item.requirement, reference: item.reference});
  }
  const passed = value.outcome === 'passed';
  if ((passed && (checks.some((item) => item.status !== 'passed') || failures.length !== 0 || risks.length !== 0 || artifacts.length === 0)) ||
    (!passed && failures.length === 0 && risks.length === 0 && !checks.some((item) => item.status !== 'passed'))) {
    return failure(passed
      ? 'Passed QA requires artifacts, only passed checks, and no failures or risks.'
      : 'Failed QA requires a failed or unrun check, failure, or risk.');
  }
  return {ok: true, value: Object.freeze({outcome: value.outcome as QaReviewOutcome,
    checks: Object.freeze(checks), artifacts: Object.freeze(artifacts), failures: Object.freeze(failures),
    risks: Object.freeze(risks), evidenceReferences: Object.freeze(evidenceReferences)})};
};
