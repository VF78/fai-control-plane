import {describe, expect, it} from 'vitest';
import {hermesRunnerObservationTtlsFromEnvironment} from './hermes-runner';

const configured = {
  FAI_HERMES_RUNNER_SERVICE_TTL_SECONDS: '300',
  FAI_HERMES_RUNNER_SCHEDULER_TTL_SECONDS: '900',
  FAI_HERMES_RUNNER_DELIVERY_TTL_SECONDS: '93600'
};

describe('Hermes runner observation TTL configuration', () => {
  it('keeps each component bound to its own declared TTL', () => {
    expect(hermesRunnerObservationTtlsFromEnvironment(configured)).toEqual({
      service: 300,
      scheduler: 900,
      delivery: 93_600
    });
  });

  it.each([
    ['service', 'FAI_HERMES_RUNNER_SERVICE_TTL_SECONDS', '29'],
    ['scheduler', 'FAI_HERMES_RUNNER_SCHEDULER_TTL_SECONDS', '604801'],
    ['delivery', 'FAI_HERMES_RUNNER_DELIVERY_TTL_SECONDS', 'not-an-integer']
  ] as const)('rejects an invalid %s TTL', (component, variable, value) => {
    expect(() => hermesRunnerObservationTtlsFromEnvironment({...configured, [variable]: value}))
      .toThrow(`hermes_runner_invalid_${component}_ttl`);
  });

  it('does not accept the removed singular TTL binding', () => {
    expect(() => hermesRunnerObservationTtlsFromEnvironment({
      FAI_HERMES_RUNNER_OBSERVATION_TTL_SECONDS: '120'
    })).toThrow('hermes_runner_missing_fai_hermes_runner_service_ttl_seconds');
  });
});
