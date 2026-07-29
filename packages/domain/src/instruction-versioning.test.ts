import {describe, expect, it} from 'vitest';
import {
  diffEffectiveInstructions,
  effectiveInstructions,
  validateInstructionContent
} from './instruction-versioning';

describe('instruction versioning', () => {
  it('deterministically combines baseline and profile override and produces a reviewable diff', () => {
    const baseline = {
      instructions: 'Common',
      settings: {limits: {steps: 10, timeout: 30}, format: 'json'}
    } as const;
    const before = effectiveInstructions(baseline);
    const after = effectiveInstructions(baseline, {
      instructions: 'Profile',
      settings: {limits: {steps: 20}}
    });
    expect(after).toEqual({
      instructions: 'Common\n\nProfile',
      settings: {format: 'json', limits: {steps: 20, timeout: 30}},
      hash: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(effectiveInstructions(
      {instructions: 'Common', settings: {format: 'json', limits: {timeout: 30, steps: 10}}},
      {instructions: 'Profile', settings: {limits: {steps: 20}}}
    ).hash).toBe(after.hash);
    expect(diffEffectiveInstructions(before, after)).toMatchObject({
      previousHash: before.hash,
      currentHash: after.hash,
      instructions: {changed: true, before: 'Common', after: 'Common\n\nProfile'},
      settings: [{path: '/limits/steps', before: 10, after: 20}]
    });
  });

  it('rejects secret-like instruction and setting values', () => {
    expect(validateInstructionContent({
      instructions: 'Use token=ghp_abcdefghijklmnopqrstuvwxyz',
      settings: {}
    })).toMatchObject({ok: false, error: {code: 'SECRET_VALUE_FORBIDDEN'}});
    expect(validateInstructionContent({
      instructions: 'Safe',
      settings: {apiKey: 'not-even-a-real-secret'}
    })).toMatchObject({ok: false, error: {code: 'SECRET_VALUE_FORBIDDEN'}});
  });
});
