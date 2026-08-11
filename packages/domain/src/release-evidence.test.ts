import {describe, expect, it} from 'vitest';
import {validateDeploymentObservation, validateDeploymentReference} from './release-evidence.ts';

const observation = () => ({
  outcome: 'succeeded', reference: 'evidence:deployment-result:42',
  startedAt: '2026-08-11T10:00:00.000Z', completedAt: '2026-08-11T10:05:00.000Z',
  smokeChecks: [{name: 'health', status: 'passed', reference: 'evidence:smoke:health:42'}],
  rollback: {outcome: 'not_required', reference: null}
});

describe('release evidence', () => {
  it('accepts only exact reference-only desired facts', () => {
    expect(validateDeploymentReference({kind: 'commit', reference: 'git-commit:0123456789abcdef'}).ok).toBe(true);
    expect(validateDeploymentReference({kind: 'commit', reference: 'bearer redacted', provider: 'github'}))
      .toMatchObject({ok: false});
  });

  it('requires coherent result, smoke, and rollback evidence', () => {
    expect(validateDeploymentObservation(observation()).ok).toBe(true);
    expect(validateDeploymentObservation({...observation(), smokeChecks: [{name: 'health', status: 'failed', reference: 'evidence:smoke:42'}]}))
      .toMatchObject({ok: false});
    expect(validateDeploymentObservation({...observation(), outcome: 'rolled_back', rollback: {outcome: 'not_required', reference: null}}))
      .toMatchObject({ok: false});
  });
});
