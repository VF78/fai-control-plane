import {describe, expect, it} from 'vitest';
import {validateQaReviewEvidence} from './qa-review.ts';

const passed = {
  outcome: 'passed', checks: [{name: 'smoke', status: 'passed', reference: 'check:smoke'}],
  artifacts: [{kind: 'report', reference: 'artifact:qa'}], failures: [], risks: [],
  evidenceReferences: [{requirement: 'QA result', reference: 'artifact:qa'}]
};
describe('validateQaReviewEvidence', () => {
  it('accepts reference-only successful evidence', () => expect(validateQaReviewEvidence(passed).ok).toBe(true));
  it('rejects a false pass and malformed issue', () => {
    expect(validateQaReviewEvidence({...passed, checks: [{...passed.checks[0], status: 'failed'}]}).ok).toBe(false);
    expect(validateQaReviewEvidence({...passed, outcome: 'failed', failures: [{summary: 'x'}]}).ok).toBe(false);
  });
});
