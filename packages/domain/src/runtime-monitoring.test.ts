import {describe, expect, it} from 'vitest';
import {deriveRuntimeAvailability} from './runtime-monitoring';

const asOf = new Date('2026-07-30T12:00:00.000Z');
const thresholds = {service: 300, scheduler: 900, delivery: 93_600} as const;
const observed = (component: 'service' | 'scheduler' | 'delivery', minutesAgo: number) => ({
  id: component,
  component,
  state: 'available' as const,
  observedAt: new Date(asOf.getTime() - minutesAgo * 60_000),
  evidenceReference: `probe:${component}`
});

describe('provider-neutral runtime availability', () => {
  it('keeps an idle runtime healthy from fresh component evidence', () => {
    expect(deriveRuntimeAvailability({
      enabled: true,
      thresholds,
      observations: [observed('service', 1), observed('scheduler', 2), observed('delivery', 60)],
      asOf
    })).toMatchObject({
      health: 'healthy',
      freshnessAt: new Date('2026-07-30T11:59:00.000Z'),
      components: {
        service: {state: 'healthy', evidenceReference: 'probe:service'},
        scheduler: {state: 'healthy'},
        delivery: {state: 'healthy'}
      }
    });
  });

  it('reports stale, disabled, unknown, and not-configured facts without inference', () => {
    expect(deriveRuntimeAvailability({
      enabled: true, thresholds,
      observations: [observed('service', 6), observed('scheduler', 2), observed('delivery', 60)],
      asOf
    }).health).toBe('stale');
    expect(deriveRuntimeAvailability({
      enabled: false, thresholds, observations: [], asOf
    }).health).toBe('disabled');
    expect(deriveRuntimeAvailability({
      enabled: true, thresholds, observations: [], asOf
    }).health).toBe('unknown');
    expect(deriveRuntimeAvailability({
      enabled: true,
      thresholds: {service: null, scheduler: null, delivery: null},
      observations: [],
      asOf
    }).health).toBe('not_configured');
  });
});
