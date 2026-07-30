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
