export type ProjectUatChecklistItem = Readonly<{
  key: string;
  title: string;
  requiredEvidence: readonly string[];
}>;

export type ProjectUatCheckResult = Readonly<{
  key: string;
  outcome: 'passed' | 'failed';
  evidenceReferences: readonly string[];
  artifactReferences: readonly string[];
}>;

export type ProjectAcceptanceProjection = Readonly<{
  protocol: Readonly<{
    id: string;
    planVersionId: string;
    materializationId: string;
    baselineId: string;
    contentHash: string;
    checklist: readonly ProjectUatChecklistItem[];
    requiredSmokeChecks: readonly string[];
    requiredDeploymentEnvironment: 'staging' | 'production';
    deploymentId: string | null;
    deploymentLifecycleVersion: 1 | 2 | null;
    deploymentReleasePackageHash: string | null;
    preparedByActorId: string;
    preparedAt: string;
  }>;
  version: number;
  latestResult: Readonly<{
    id: string;
    outcome: 'passed' | 'failed';
    checks: readonly ProjectUatCheckResult[];
    recordedByActorId: string;
    recordedAt: string;
  }> | null;
  signoffs: Readonly<{
    productOwner: Readonly<{actorId: string; evidenceReference: string; signedAt: string}> | null;
    clientRepresentative: Readonly<{actorId: string; evidenceReference: string; signedAt: string}> | null;
  }>;
  release: Readonly<{
    state: 'pending' | 'deployment_observed' | 'not_required';
    deploymentId: string | null;
    blocker: 'uat_release_binding_required' | 'bound_deployment_not_latest' |
      'bound_deployment_not_observed' | 'bound_deployment_evidence_invalid' | null;
    waiver: Readonly<{actorId: string; reason: string; waivedAt: string}> | null;
  }>;
  completionReady: boolean;
  blockers: readonly string[];
}>;

const boundedText = (value: unknown, maximum = 2048): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

export const validateProjectUatCheckResults = (
  checklist: readonly ProjectUatChecklistItem[],
  outcome: 'passed' | 'failed',
  checks: readonly ProjectUatCheckResult[]
): boolean => {
  if (checks.length !== checklist.length || checks.length === 0 || checks.length > 200) return false;
  const byKey = new Map(checks.map((check) => [check.key, check]));
  if (byKey.size !== checks.length) return false;
  for (const item of checklist) {
    const check = byKey.get(item.key);
    if (check === undefined || !['passed', 'failed'].includes(check.outcome) ||
      check.evidenceReferences.length < item.requiredEvidence.length || check.evidenceReferences.length > 50 ||
      check.artifactReferences.length === 0 || check.artifactReferences.length > 50 ||
      !check.evidenceReferences.every((reference) => boundedText(reference)) ||
      !check.artifactReferences.every((reference) => boundedText(reference))) return false;
  }
  return outcome === 'passed'
    ? checks.every((check) => check.outcome === 'passed')
    : checks.some((check) => check.outcome === 'failed');
};
