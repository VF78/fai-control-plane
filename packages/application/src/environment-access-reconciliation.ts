import type {AccessLevel, OpaqueSecretRef, ProjectEnvironmentKind} from '@fai-control-plane/domain';

export type EnvironmentAccessBinding = Readonly<{
  grantId: string;
  grantVersion: number;
  projectId: string;
  actorId: string;
  environment: Readonly<{
    id: string;
    kind: ProjectEnvironmentKind;
    provider: string;
    endpoint: string;
    port: number;
    adapterKey: string;
    enabled: boolean;
    reconcilerActorId: string;
  }>;
  desiredLevel: 'none' | 'write';
  expiresAt: string | null;
  adapterCredentialRef: OpaqueSecretRef;
  principalCredentialRef: OpaqueSecretRef | null;
}>;

export type EnvironmentAccessEffect = 'apply' | 'revoke';
export type EnvironmentAccessObservation = Readonly<{
  level: AccessLevel;
  externalResourceRef: string;
  observedAt: string;
}>;

/** Semantic host boundary: implementations cannot receive a shell command or private key value. */
export interface EnvironmentAccessAdapter {
  readonly adapterKey: string;
  readonly provider: string;
  apply(input: EnvironmentAccessBinding): Promise<void>;
  revoke(input: EnvironmentAccessBinding): Promise<void>;
  observe(input: EnvironmentAccessBinding): Promise<EnvironmentAccessObservation>;
}

export type EnvironmentAccessReconciliationResult =
  | Readonly<{state: 'disabled' | 'unsupported' | 'unavailable'; remediation: string}>
  | Readonly<{state: 'observed'; effect: EnvironmentAccessEffect; observation: EnvironmentAccessObservation}>;

export const reconcileEnvironmentAccess = async (input: Readonly<{
  binding: EnvironmentAccessBinding;
  adapters: readonly EnvironmentAccessAdapter[];
  now: Date;
  recordObservation(value: Readonly<{
    actorId: string;
    grantId: string; expectedVersion: number; provider: string;
    externalResourceRef: string; confirmedLevel: AccessLevel; observedAt: string;
  }>): Promise<void>;
}>): Promise<EnvironmentAccessReconciliationResult> => {
  const {binding} = input;
  const expired = binding.expiresAt !== null && new Date(binding.expiresAt).getTime() <= input.now.getTime();
  const effect: EnvironmentAccessEffect = binding.desiredLevel === 'write' && !expired ? 'apply' : 'revoke';
  if (!binding.environment.enabled && effect === 'apply') return {
    state: 'disabled', remediation: 'Environment is disabled; new SSH access cannot be applied.'
  };
  const adapter = input.adapters.find((candidate) =>
    candidate.adapterKey === binding.environment.adapterKey &&
    candidate.provider === binding.environment.provider);
  if (adapter === undefined) return {
    state: 'unsupported', remediation: 'Configured environment access adapter is unavailable.'
  };
  if (effect === 'apply' && binding.principalCredentialRef === null) return {
    state: 'unavailable', remediation: 'Host-owned SSH principal reference is missing.'
  };
  try {
    await adapter[effect](binding);
    const observation = await adapter.observe(binding);
    const expected = effect === 'apply' ? 'write' : 'none';
    if (observation.level !== expected) return {
      state: 'unavailable', remediation: 'Host observation does not match the requested access effect.'
    };
    await input.recordObservation({
      actorId: binding.environment.reconcilerActorId,
      grantId: binding.grantId, expectedVersion: binding.grantVersion,
      provider: adapter.provider, externalResourceRef: observation.externalResourceRef,
      confirmedLevel: observation.level, observedAt: observation.observedAt
    });
    return {state: 'observed', effect, observation};
  } catch {
    return {
      state: 'unavailable',
      remediation: 'Environment access reconciliation failed; desired access was not marked as observed.'
    };
  }
};
