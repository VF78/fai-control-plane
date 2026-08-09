export const runtimeAvailabilityComponents = ['service', 'scheduler', 'delivery'] as const;
export type RuntimeAvailabilityComponent = typeof runtimeAvailabilityComponents[number];
export type RuntimeAvailabilityHealth = 'healthy' | 'stale' | 'unknown' | 'not_configured' | 'disabled';

export type RuntimeAvailabilityObservation = Readonly<{
  id: string;
  component: RuntimeAvailabilityComponent;
  state: 'available' | 'unavailable';
  observedAt: Date;
  evidenceReference: string;
}>;

export type RuntimeAvailabilityThresholds = Readonly<Record<RuntimeAvailabilityComponent, number | null>>;

export type RuntimeComponentAvailability = Readonly<{
  state: RuntimeAvailabilityHealth;
  observedAt: Date | null;
  evidenceReference: string | null;
}>;

export type RuntimeAvailabilityProjection = Readonly<{
  health: RuntimeAvailabilityHealth;
  freshnessAt: Date | null;
  components: Readonly<Record<RuntimeAvailabilityComponent, RuntimeComponentAvailability>>;
}>;

export type RuntimeRecoveryPolicy = Readonly<{
  runtimeRegistrationId: string;
  enabled: boolean;
  staleThresholdSeconds: number;
  maximumAttempts: number;
  version: number;
}>;

export type RuntimeRecoveryCandidate = Readonly<{
  runtimeRegistrationId: string;
  staleComponents: readonly RuntimeAvailabilityComponent[];
  missingComponents: readonly RuntimeAvailabilityComponent[];
  maximumAttempts: number;
}>;

/** Recovery policy only creates a human-reviewable candidate; it never chooses an action. */
export const deriveRuntimeRecoveryCandidate = (input: Readonly<{
  policy: RuntimeRecoveryPolicy | null;
  enabled: boolean;
  expectedComponents: readonly RuntimeAvailabilityComponent[];
  observations: readonly RuntimeAvailabilityObservation[];
  policyActivatedAt: Date;
  asOf: Date;
}>): RuntimeRecoveryCandidate | null => {
  if (input.policy === null || !input.policy.enabled || !input.enabled) return null;
  const cutoff = input.asOf.getTime() - input.policy.staleThresholdSeconds * 1_000;
  const missingThresholdReached = input.policyActivatedAt.getTime() <= cutoff;
  const latest = new Map<RuntimeAvailabilityComponent, RuntimeAvailabilityObservation>();
  for (const observation of input.observations) {
    const prior = latest.get(observation.component);
    if (prior === undefined || observation.observedAt > prior.observedAt) latest.set(observation.component, observation);
  }
  const missingComponents = input.expectedComponents.filter((component) =>
    latest.get(component) === undefined && missingThresholdReached);
  const staleComponents = input.expectedComponents.filter((component) => {
    const observation = latest.get(component);
    return observation !== undefined &&
      (observation.state === 'unavailable' || observation.observedAt.getTime() <= cutoff);
  });
  return staleComponents.length === 0 && missingComponents.length === 0 ? null : {
    runtimeRegistrationId: input.policy.runtimeRegistrationId,
    staleComponents,
    missingComponents,
    maximumAttempts: input.policy.maximumAttempts
  };
};

const componentProjection = (
  enabled: boolean,
  thresholdSeconds: number | null,
  observation: RuntimeAvailabilityObservation | undefined,
  asOf: Date
): RuntimeComponentAvailability => {
  if (!enabled) return {state: 'disabled', observedAt: observation?.observedAt ?? null, evidenceReference: observation?.evidenceReference ?? null};
  if (thresholdSeconds === null) return {state: 'not_configured', observedAt: observation?.observedAt ?? null, evidenceReference: observation?.evidenceReference ?? null};
  if (observation === undefined) return {state: 'unknown', observedAt: null, evidenceReference: null};
  const ageMs = asOf.getTime() - observation.observedAt.getTime();
  const fresh = ageMs >= 0 && ageMs <= thresholdSeconds * 1_000;
  return {
    state: observation.state === 'available' && fresh ? 'healthy' : 'stale',
    observedAt: observation.observedAt,
    evidenceReference: observation.evidenceReference
  };
};

export const deriveRuntimeAvailability = (input: Readonly<{
  enabled: boolean;
  thresholds: RuntimeAvailabilityThresholds;
  observations: readonly RuntimeAvailabilityObservation[];
  asOf: Date;
}>): RuntimeAvailabilityProjection => {
  const latest = new Map<RuntimeAvailabilityComponent, RuntimeAvailabilityObservation>();
  for (const observation of input.observations) {
    const prior = latest.get(observation.component);
    if (prior === undefined || observation.observedAt > prior.observedAt) latest.set(observation.component, observation);
  }
  const components = Object.fromEntries(runtimeAvailabilityComponents.map((component) => [
    component,
    componentProjection(input.enabled, input.thresholds[component], latest.get(component), input.asOf)
  ])) as Record<RuntimeAvailabilityComponent, RuntimeComponentAvailability>;
  const configured = runtimeAvailabilityComponents.filter((component) => input.thresholds[component] !== null);
  const health: RuntimeAvailabilityHealth = !input.enabled ? 'disabled'
    : configured.length === 0 ? 'not_configured'
      : configured.some((component) => components[component].state === 'stale') ? 'stale'
        : configured.some((component) => components[component].state === 'unknown') ? 'unknown'
          : 'healthy';
  return {
    health,
    freshnessAt: components.service.observedAt,
    components
  };
};
