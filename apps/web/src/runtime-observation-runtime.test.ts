import {describe, expect, it} from 'vitest';
import {
  runtimeRegistrationIsAllowed,
  runtimeObservationFactHash,
  systemActorIsEligible
} from './runtime-observation-runtime';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const eligible = {
  id: actorId,
  workspaceId,
  type: 'system',
  authMode: 'system',
  disabledAt: null,
  capabilities: {'write:runtime_observation:development': true}
};

describe('runtime observation authority binding', () => {
  it('rejects missing, wrong-type, inactive, cross-workspace, and unprivileged actors', () => {
    expect(systemActorIsEligible(undefined, workspaceId, actorId)).toBe(false);
    expect(systemActorIsEligible({...eligible, type: 'human'}, workspaceId, actorId)).toBe(false);
    expect(systemActorIsEligible({...eligible, authMode: 'user'}, workspaceId, actorId)).toBe(false);
    expect(systemActorIsEligible({...eligible, disabledAt: new Date()}, workspaceId, actorId)).toBe(false);
    expect(systemActorIsEligible({...eligible, workspaceId: '00000000-0000-4000-8000-000000000003'}, workspaceId, actorId)).toBe(false);
    expect(systemActorIsEligible({...eligible, capabilities: {}}, workspaceId, actorId)).toBe(false);
    expect(systemActorIsEligible(eligible, workspaceId, actorId)).toBe(true);
  });

  it('rejects a submitted registration outside the runtime allowlist', () => {
    const allowed = new Set(['00000000-0000-4000-8000-000000000004']);
    expect(runtimeRegistrationIsAllowed(allowed, '00000000-0000-4000-8000-000000000004')).toBe(true);
    expect(runtimeRegistrationIsAllowed(allowed, '00000000-0000-4000-8000-000000000005')).toBe(false);
  });

  it('hashes semantically identical observation objects independent of key order', () => {
    const first = {
      registrationId: '00000000-0000-4000-8000-000000000004',
      component: 'service' as const,
      state: 'available' as const,
      observedAt: '2026-08-09T10:00:00.000Z',
      ttlSeconds: 300,
      evidenceReference: 'probe:service:ok'
    };
    const reordered = {
      evidenceReference: first.evidenceReference,
      ttlSeconds: first.ttlSeconds,
      observedAt: first.observedAt,
      state: first.state,
      component: first.component,
      registrationId: first.registrationId
    };
    expect(runtimeObservationFactHash(first)).toBe(runtimeObservationFactHash(reordered));
  });
});
