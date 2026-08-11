import {containsHighConfidenceSecretContent, type CommandResult} from './index.ts';

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

export const qaRetainedArtifactKinds = ['receipt', 'summary', 'path_manifest'] as const;
export type QaRetainedArtifactFact = Readonly<{
  kind: (typeof qaRetainedArtifactKinds)[number];
  sha256: string;
}>;
export type QaCanonicalArtifactLocator = Readonly<{
  artifactId: string;
  sha256: string;
}>;
export type QaMachineReviewEvidence = Readonly<{
  outcome: QaReviewOutcome;
  checks: readonly Readonly<{name: string; status: QaCheckStatus; reference: QaRetainedArtifactFact}>[];
  artifacts: readonly Readonly<{kind: QaReviewArtifact['kind']; reference: QaRetainedArtifactFact}>[];
  failures: readonly Readonly<{summary: string; reference: QaRetainedArtifactFact}>[];
  risks: readonly Readonly<{summary: string; reference: QaRetainedArtifactFact}>[];
  evidenceReferences: readonly Readonly<{requirement: string; reference: QaRetainedArtifactFact}>[];
}>;
export type QaCanonicalReviewEvidence = Readonly<{
  outcome: QaReviewOutcome;
  checks: readonly Readonly<{name: string; status: QaCheckStatus; reference: QaCanonicalArtifactLocator}>[];
  artifacts: readonly Readonly<{kind: QaReviewArtifact['kind']; reference: QaCanonicalArtifactLocator}>[];
  failures: readonly Readonly<{summary: string; reference: QaCanonicalArtifactLocator}>[];
  risks: readonly Readonly<{summary: string; reference: QaCanonicalArtifactLocator}>[];
  evidenceReferences: readonly Readonly<{requirement: string; reference: QaCanonicalArtifactLocator}>[];
}>;

const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum = 2_048): value is string =>
  typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum;
const machineText = (value: unknown, maximum: number): value is string =>
  text(value, maximum) && !containsHighConfidenceSecretContent(value);
const failure = (message: string): CommandResult<QaReviewEvidence> => ({
  ok: false, error: {code: 'INVALID_COMMAND', message}
});
const machineFailure = (message: string): CommandResult<QaMachineReviewEvidence> => ({
  ok: false, error: {code: 'INVALID_COMMAND', message}
});
const retainedArtifactFact = (value: unknown): QaRetainedArtifactFact | null => {
  if (!isRecord(value) || !exact(value, ['kind', 'sha256']) ||
    !qaRetainedArtifactKinds.includes(value.kind as QaRetainedArtifactFact['kind']) ||
    typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  return {kind: value.kind as QaRetainedArtifactFact['kind'], sha256: value.sha256};
};
const canonicalArtifactLocator = (value: unknown): QaCanonicalArtifactLocator | null => {
  if (!isRecord(value) || !exact(value, ['artifactId', 'sha256']) ||
    typeof value.artifactId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.artifactId) ||
    typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  return {artifactId: value.artifactId, sha256: value.sha256};
};

/** Machine QA can cite only bounded retained artifact facts; arbitrary locators are rejected. */
export const validateQaMachineReviewEvidence = (
  value: unknown
): CommandResult<QaMachineReviewEvidence> => {
  if (!isRecord(value) || !exact(value, [
    'outcome', 'checks', 'artifacts', 'failures', 'risks', 'evidenceReferences'
  ]) || !qaReviewOutcomes.includes(value.outcome as QaReviewOutcome) ||
    !Array.isArray(value.checks) || !Array.isArray(value.artifacts) ||
    !Array.isArray(value.failures) || !Array.isArray(value.risks) ||
    !Array.isArray(value.evidenceReferences) || value.checks.length === 0 ||
    Object.keys(value.checks).length !== value.checks.length ||
    Object.keys(value.artifacts).length !== value.artifacts.length ||
    Object.keys(value.failures).length !== value.failures.length ||
    Object.keys(value.risks).length !== value.risks.length ||
    Object.keys(value.evidenceReferences).length !== value.evidenceReferences.length ||
    value.checks.length > 50 || value.artifacts.length > 25 || value.failures.length > 25 ||
    value.risks.length > 25 || value.evidenceReferences.length > 25) {
    return machineFailure('Machine QA evidence is not canonical.');
  }
  const checkNames = new Set<string>();
  const checks: QaMachineReviewEvidence['checks'][number][] = [];
  for (const item of value.checks) {
    const reference = isRecord(item) ? retainedArtifactFact(item.reference) : null;
    if (!isRecord(item) || !exact(item, ['name', 'status', 'reference']) || !machineText(item.name, 200) ||
      !qaCheckStatuses.includes(item.status as QaCheckStatus) || reference === null || checkNames.has(item.name)) {
      return machineFailure('Machine QA checks are not canonical.');
    }
    checkNames.add(item.name); checks.push({name: item.name, status: item.status as QaCheckStatus, reference});
  }
  const artifacts: QaMachineReviewEvidence['artifacts'][number][] = [];
  for (const item of value.artifacts) {
    const reference = isRecord(item) ? retainedArtifactFact(item.reference) : null;
    if (!isRecord(item) || !exact(item, ['kind', 'reference']) ||
      !['report', 'log', 'screenshot', 'other'].includes(item.kind as string) || reference === null) {
      return machineFailure('Machine QA artifacts are not canonical.');
    }
    artifacts.push({kind: item.kind as QaReviewArtifact['kind'], reference});
  }
  const issues = (items: unknown[]): Array<{summary: string; reference: QaRetainedArtifactFact}> | null => {
    const seen = new Set<string>(); const parsed: Array<{summary: string; reference: QaRetainedArtifactFact}> = [];
    for (const item of items) {
      const reference = isRecord(item) ? retainedArtifactFact(item.reference) : null;
      if (!isRecord(item) || !exact(item, ['summary', 'reference']) || !machineText(item.summary, 500) ||
        reference === null || seen.has(`${item.summary}\u0000${reference.kind}\u0000${reference.sha256}`)) return null;
      seen.add(`${item.summary}\u0000${reference.kind}\u0000${reference.sha256}`);
      parsed.push({summary: item.summary, reference});
    }
    return parsed;
  };
  const failures = issues(value.failures); const risks = issues(value.risks);
  if (failures === null || risks === null) return machineFailure('Machine QA failures or risks are not canonical.');
  const evidenceSeen = new Set<string>();
  const evidenceReferences: QaMachineReviewEvidence['evidenceReferences'][number][] = [];
  for (const item of value.evidenceReferences) {
    const reference = isRecord(item) ? retainedArtifactFact(item.reference) : null;
    if (!isRecord(item) || !exact(item, ['requirement', 'reference']) || !machineText(item.requirement, 500) ||
      reference === null || evidenceSeen.has(item.requirement)) {
      return machineFailure('Machine QA evidence references are not canonical.');
    }
    evidenceSeen.add(item.requirement); evidenceReferences.push({requirement: item.requirement, reference});
  }
  const passed = value.outcome === 'passed';
  if ((passed && (checks.some((item) => item.status !== 'passed') || failures.length !== 0 ||
      risks.length !== 0 || artifacts.length === 0)) ||
    (!passed && failures.length === 0 && risks.length === 0 && !checks.some((item) => item.status !== 'passed'))) {
    return machineFailure(passed
      ? 'Passed machine QA requires artifacts, only passed checks, and no failures or risks.'
      : 'Failed machine QA requires a failed or unrun check, failure, or risk.');
  }
  return {ok: true, value: Object.freeze({outcome: value.outcome as QaReviewOutcome,
    checks: Object.freeze(checks), artifacts: Object.freeze(artifacts),
    failures: Object.freeze(failures), risks: Object.freeze(risks),
    evidenceReferences: Object.freeze(evidenceReferences)})};
};

/** Validates the server-owned artifact-id/hash form retained in a governed QA receipt. */
export const validateQaCanonicalReviewEvidence = (
  value: unknown
): CommandResult<QaCanonicalReviewEvidence> => {
  if (!isRecord(value) || !exact(value, [
    'outcome', 'checks', 'artifacts', 'failures', 'risks', 'evidenceReferences'
  ]) || !qaReviewOutcomes.includes(value.outcome as QaReviewOutcome) ||
    !Array.isArray(value.checks) || !Array.isArray(value.artifacts) ||
    !Array.isArray(value.failures) || !Array.isArray(value.risks) ||
    !Array.isArray(value.evidenceReferences) || value.checks.length === 0 ||
    Object.keys(value.checks).length !== value.checks.length ||
    Object.keys(value.artifacts).length !== value.artifacts.length ||
    Object.keys(value.failures).length !== value.failures.length ||
    Object.keys(value.risks).length !== value.risks.length ||
    Object.keys(value.evidenceReferences).length !== value.evidenceReferences.length ||
    value.checks.length > 50 || value.artifacts.length > 25 || value.failures.length > 25 ||
    value.risks.length > 25 || value.evidenceReferences.length > 25) {
    return {ok: false, error: {code: 'INVALID_COMMAND', message: 'Retained machine QA receipt is not canonical.'}};
  }
  const checks: QaCanonicalReviewEvidence['checks'][number][] = [];
  const checkNames = new Set<string>();
  for (const item of value.checks) {
    const reference = isRecord(item) ? canonicalArtifactLocator(item.reference) : null;
    if (!isRecord(item) || !exact(item, ['name', 'status', 'reference']) || !machineText(item.name, 200) ||
      !qaCheckStatuses.includes(item.status as QaCheckStatus) || reference === null || checkNames.has(item.name)) {
      return {ok: false, error: {code: 'INVALID_COMMAND', message: 'Retained machine QA checks are not canonical.'}};
    }
    checkNames.add(item.name); checks.push({name: item.name, status: item.status as QaCheckStatus, reference});
  }
  const artifacts: QaCanonicalReviewEvidence['artifacts'][number][] = [];
  for (const item of value.artifacts) {
    const reference = isRecord(item) ? canonicalArtifactLocator(item.reference) : null;
    if (!isRecord(item) || !exact(item, ['kind', 'reference']) ||
      !['report', 'log', 'screenshot', 'other'].includes(item.kind as string) || reference === null) {
      return {ok: false, error: {code: 'INVALID_COMMAND', message: 'Retained machine QA artifacts are not canonical.'}};
    }
    artifacts.push({kind: item.kind as QaReviewArtifact['kind'], reference});
  }
  const issues = (items: unknown[]): Array<{summary: string; reference: QaCanonicalArtifactLocator}> | null => {
    const parsed: Array<{summary: string; reference: QaCanonicalArtifactLocator}> = []; const seen = new Set<string>();
    for (const item of items) {
      const reference = isRecord(item) ? canonicalArtifactLocator(item.reference) : null;
      if (!isRecord(item) || !exact(item, ['summary', 'reference']) || !machineText(item.summary, 500) ||
        reference === null || seen.has(`${item.summary}\u0000${reference.artifactId}\u0000${reference.sha256}`)) return null;
      seen.add(`${item.summary}\u0000${reference.artifactId}\u0000${reference.sha256}`);
      parsed.push({summary: item.summary, reference});
    }
    return parsed;
  };
  const failures = issues(value.failures); const risks = issues(value.risks);
  if (failures === null || risks === null) {
    return {ok: false, error: {code: 'INVALID_COMMAND', message: 'Retained machine QA issues are not canonical.'}};
  }
  const evidenceReferences: QaCanonicalReviewEvidence['evidenceReferences'][number][] = [];
  const evidenceSeen = new Set<string>();
  for (const item of value.evidenceReferences) {
    const reference = isRecord(item) ? canonicalArtifactLocator(item.reference) : null;
    if (!isRecord(item) || !exact(item, ['requirement', 'reference']) || !machineText(item.requirement, 500) ||
      reference === null || evidenceSeen.has(item.requirement)) {
      return {ok: false, error: {code: 'INVALID_COMMAND', message: 'Retained machine QA evidence is not canonical.'}};
    }
    evidenceSeen.add(item.requirement); evidenceReferences.push({requirement: item.requirement, reference});
  }
  const passed = value.outcome === 'passed';
  if ((passed && (checks.some(({status}) => status !== 'passed') || failures.length > 0 || risks.length > 0 ||
      artifacts.length === 0)) || (!passed && failures.length === 0 && risks.length === 0 &&
      !checks.some(({status}) => status !== 'passed'))) {
    return {ok: false, error: {code: 'INVALID_COMMAND', message: 'Retained machine QA outcome conflicts with its findings.'}};
  }
  return {ok: true, value: {outcome: value.outcome as QaReviewOutcome, checks, artifacts,
    failures, risks, evidenceReferences}};
};

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
