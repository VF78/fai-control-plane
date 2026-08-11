import {describe, expect, it} from 'vitest';
import {validateQaCanonicalReviewEvidence, validateQaMachineReviewEvidence,
  validateQaReviewEvidence} from './qa-review.ts';

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

const sha256 = 'a'.repeat(64);
const artifactId = '12345678-1234-4123-8123-123456789abc';
const representativeSecret = ['github', 'pat', 'A'.repeat(24)].join('_');
const machinePassed = {
  outcome: 'passed', checks: [{name: 'smoke', status: 'passed', reference: {kind: 'receipt', sha256}}],
  artifacts: [{kind: 'report', reference: {kind: 'receipt', sha256}}], failures: [], risks: [],
  evidenceReferences: [{requirement: 'QA result', reference: {kind: 'receipt', sha256}}]
};
describe('machine QA evidence validators', () => {
  it('accepts only retained artifact facts at the machine boundary', () => {
    expect(validateQaMachineReviewEvidence(machinePassed).ok).toBe(true);
    expect(validateQaMachineReviewEvidence({...machinePassed,
      artifacts: [{kind: 'report', reference: 'https://provider.test/secret'}]}).ok).toBe(false);
    expect(validateQaMachineReviewEvidence({...machinePassed,
      checks: [{name: 'smoke', status: 'passed', reference: {kind: 'receipt', sha256, locator: 'secret'}}]}).ok)
      .toBe(false);
  });

  it.each([
    ['check name', {...machinePassed, checks: [{...machinePassed.checks[0],
      name: `smoke ${representativeSecret}`}] }],
    ['required evidence', {...machinePassed, evidenceReferences: [{...machinePassed.evidenceReferences[0],
      requirement: `QA result ${representativeSecret}`}] }],
    ['failure summary', {...machinePassed, outcome: 'failed', artifacts: [],
      checks: [{...machinePassed.checks[0], status: 'failed'}],
      failures: [{summary: `failure ${representativeSecret}`, reference: {kind: 'receipt', sha256}}],
      evidenceReferences: []}],
    ['risk summary', {...machinePassed, outcome: 'failed', artifacts: [],
      checks: [{...machinePassed.checks[0], status: 'failed'}], failures: [],
      risks: [{summary: `risk ${representativeSecret}`, reference: {kind: 'receipt', sha256}}],
      evidenceReferences: []}]
  ])('rejects a high-confidence secret in machine-authored %s', (_label, evidence) => {
    expect(validateQaMachineReviewEvidence(evidence)).toMatchObject({ok: false});
  });

  it('accepts only canonical server-owned artifact id/hash locators in persisted receipts', () => {
    const locator = {artifactId, sha256};
    expect(validateQaCanonicalReviewEvidence({...machinePassed,
      checks: [{name: 'smoke', status: 'passed', reference: locator}],
      artifacts: [{kind: 'report', reference: locator}],
      evidenceReferences: [{requirement: 'QA result', reference: locator}]}).ok).toBe(true);
    expect(validateQaCanonicalReviewEvidence({...machinePassed,
      checks: [{name: 'smoke', status: 'passed', reference: {artifactId: 'external://artifact', sha256}}],
      artifacts: [{kind: 'report', reference: locator}],
      evidenceReferences: [{requirement: 'QA result', reference: locator}]}).ok).toBe(false);
    expect(validateQaCanonicalReviewEvidence({...machinePassed,
      checks: [{name: `smoke ${representativeSecret}`, status: 'passed', reference: locator}],
      artifacts: [{kind: 'report', reference: locator}],
      evidenceReferences: [{requirement: 'QA result', reference: locator}]}).ok).toBe(false);
  });
});
