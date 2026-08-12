import {createHash} from 'node:crypto';
import {
  containsHighConfidenceSecretContent,
  type CommandResult
} from './index.ts';

export const deploymentEnvironments = ['development', 'staging', 'production'] as const;
export type DeploymentEnvironment = (typeof deploymentEnvironments)[number];
export const deploymentReferenceKinds = ['artifact', 'commit', 'reference'] as const;
export type DeploymentReferenceKind = (typeof deploymentReferenceKinds)[number];
export const deploymentObservationOutcomes = ['succeeded', 'failed', 'rolled_back'] as const;
export type DeploymentObservationOutcome = (typeof deploymentObservationOutcomes)[number];
export const deploymentSmokeCheckStatuses = ['passed', 'failed', 'not_run'] as const;
export type DeploymentSmokeCheckStatus = (typeof deploymentSmokeCheckStatuses)[number];
export const deploymentRollbackOutcomes = ['not_required', 'completed', 'failed'] as const;
export type DeploymentRollbackOutcome = (typeof deploymentRollbackOutcomes)[number];

export type DeploymentReference = Readonly<{
  kind: DeploymentReferenceKind;
  reference: string;
}>;
export type DeploymentSmokeCheck = Readonly<{
  name: string;
  status: DeploymentSmokeCheckStatus;
  reference: string;
}>;
export type DeploymentRollbackEvidence = Readonly<{
  outcome: DeploymentRollbackOutcome;
  reference: string | null;
}>;
export type DeploymentReleasePackage = Readonly<{
  schemaVersion: 1;
  sourceCommit: string;
  artifactReference: string;
  artifactSha256: string;
}>;
export type DeploymentObservation = Readonly<{
  outcome: DeploymentObservationOutcome;
  reference: string;
  startedAt: string;
  completedAt: string;
  smokeChecks: readonly DeploymentSmokeCheck[];
  rollback: DeploymentRollbackEvidence;
}>;

const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const reference = (value: unknown, maximum = 2_048): value is string =>
  typeof value === 'string' && value.trim() === value && value.length > 0 &&
  value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value) &&
  !containsHighConfidenceSecretContent(value);
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const invalid = <T>(message: string): CommandResult<T> => ({
  ok: false,
  error: {code: 'INVALID_COMMAND', message}
});

export const validateDeploymentReleasePackage = (
  value: unknown
): CommandResult<DeploymentReleasePackage> => {
  if (!record(value) || !exact(value, [
    'schemaVersion', 'sourceCommit', 'artifactReference', 'artifactSha256'
  ]) || value.schemaVersion !== 1 || typeof value.sourceCommit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.sourceCommit) ||
    !reference(value.artifactReference, 512) || typeof value.artifactSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.artifactSha256)) {
    return invalid('Deployment release package is not an immutable canonical binding.');
  }
  return {ok: true, value: Object.freeze({
    schemaVersion: 1,
    sourceCommit: value.sourceCommit,
    artifactReference: value.artifactReference,
    artifactSha256: value.artifactSha256
  })};
};

export const hashDeploymentReleasePackage = (value: DeploymentReleasePackage): string =>
  createHash('sha256').update(JSON.stringify({schemaVersion: value.schemaVersion,
    sourceCommit: value.sourceCommit, artifactReference: value.artifactReference,
    artifactSha256: value.artifactSha256})).digest('hex');

/** Reference-only desired release fact; it cannot carry source, credentials, or provider fields. */
export const validateDeploymentReference = (
  value: unknown
): CommandResult<DeploymentReference> => {
  if (!record(value) || !exact(value, ['kind', 'reference']) ||
    !deploymentReferenceKinds.includes(value.kind as DeploymentReferenceKind) ||
    !reference(value.reference, 512)) {
    return invalid('Deployment reference is not canonical or contains secret-like content.');
  }
  return {ok: true, value: Object.freeze({
    kind: value.kind as DeploymentReferenceKind,
    reference: value.reference
  })};
};

/** Structured observed facts. No logs, source content, secret values, or provider identifiers are retained. */
export const validateDeploymentObservation = (
  value: unknown
): CommandResult<DeploymentObservation> => {
  if (!record(value) || !exact(value, [
    'outcome', 'reference', 'startedAt', 'completedAt', 'smokeChecks', 'rollback'
  ]) || !deploymentObservationOutcomes.includes(value.outcome as DeploymentObservationOutcome) ||
    !reference(value.reference) || !timestamp(value.startedAt) || !timestamp(value.completedAt) ||
    new Date(value.completedAt).getTime() < new Date(value.startedAt).getTime() ||
    !Array.isArray(value.smokeChecks) || value.smokeChecks.length === 0 ||
    value.smokeChecks.length > 50 || Object.keys(value.smokeChecks).length !== value.smokeChecks.length ||
    !record(value.rollback) || !exact(value.rollback, ['outcome', 'reference']) ||
    !deploymentRollbackOutcomes.includes(value.rollback.outcome as DeploymentRollbackOutcome)) {
    return invalid('Deployment observation is not canonical.');
  }
  const names = new Set<string>();
  const smokeChecks: DeploymentSmokeCheck[] = [];
  for (const check of value.smokeChecks) {
    if (!record(check) || !exact(check, ['name', 'status', 'reference']) ||
      !reference(check.name, 200) || !reference(check.reference) ||
      !deploymentSmokeCheckStatuses.includes(check.status as DeploymentSmokeCheckStatus) ||
      names.has(check.name)) return invalid('Smoke-check evidence is not canonical.');
    names.add(check.name);
    smokeChecks.push(Object.freeze({name: check.name,
      status: check.status as DeploymentSmokeCheckStatus, reference: check.reference}));
  }
  const rollbackOutcome = value.rollback.outcome as DeploymentRollbackOutcome;
  const rollbackReference = value.rollback.reference;
  if ((rollbackOutcome === 'not_required' && rollbackReference !== null) ||
    (rollbackOutcome !== 'not_required' && !reference(rollbackReference))) {
    return invalid('Rollback evidence is inconsistent.');
  }
  const outcome = value.outcome as DeploymentObservationOutcome;
  if ((outcome === 'succeeded' && (smokeChecks.some((check) => check.status !== 'passed') ||
      rollbackOutcome !== 'not_required')) ||
    (outcome === 'failed' && smokeChecks.every((check) => check.status === 'passed') &&
      rollbackOutcome === 'not_required') ||
    (outcome === 'rolled_back' && rollbackOutcome !== 'completed')) {
    return invalid('Deployment result, smoke checks, and rollback evidence disagree.');
  }
  return {ok: true, value: Object.freeze({
    outcome,
    reference: value.reference,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    smokeChecks: Object.freeze(smokeChecks),
    rollback: Object.freeze({outcome: rollbackOutcome, reference: rollbackReference as string | null})
  })};
};
