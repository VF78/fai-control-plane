import {describe, expect, it} from 'vitest';
import {runnerActivationEnabled} from './runner-activation-policy';

describe('runner activation gate', () => {
  it.each([
    [undefined, undefined, false],
    ['false', 'false', false],
    ['true', 'false', false],
    ['false', 'true', false],
    ['true', 'true', true]
  ] as const)('requires queue=%s and transport=%s', (runner, transport, expected) => {
    expect(runnerActivationEnabled({RUNNER_ENABLED: runner,
      LOCAL_RUNNER_TRANSPORT_ENABLED: transport})).toBe(expected);
  });
});
