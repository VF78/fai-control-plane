import {expect, it} from 'vitest';
import {runtimeObservationFromEnvironment} from './runtime-monitoring';

it('builds a bounded provider-neutral observation without runtime diagnostics', () => {
  const observedAt = new Date('2026-07-30T12:00:00.000Z');
  expect(runtimeObservationFromEnvironment({
    RUNTIME_REGISTRATION_ID: '00000000-0000-4000-8000-000000000001',
    RUNTIME_OBSERVATION_COMPONENT: 'service',
    RUNTIME_OBSERVATION_STATE: 'available',
    RUNTIME_OBSERVATION_EVIDENCE: 'probe:service:200'
  }, observedAt)).toEqual({
    runtimeRegistrationId: '00000000-0000-4000-8000-000000000001',
    component: 'service',
    state: 'available',
    observedAt,
    evidenceReference: 'probe:service:200'
  });
  expect(() => runtimeObservationFromEnvironment({
    RUNTIME_REGISTRATION_ID: '00000000-0000-4000-8000-000000000001',
    RUNTIME_OBSERVATION_COMPONENT: 'vps',
    RUNTIME_OBSERVATION_STATE: 'available',
    RUNTIME_OBSERVATION_EVIDENCE: 'raw-provider-diagnostic'
  }, observedAt)).toThrow('invalid');
});
