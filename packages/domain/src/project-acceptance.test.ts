import {describe, expect, it} from 'vitest';
import {validateProjectUatCheckResults} from './project-acceptance';

const checklist = [{key: 'outcome:result', title: 'Result', requiredEvidence: ['decision', 'report']}];
const check = {key: 'outcome:result', outcome: 'passed' as const,
  evidenceReferences: ['evidence:decision', 'evidence:report'], artifactReferences: ['artifact:report']};

describe('project UAT result validation', () => {
  it('requires exact checklist coverage, evidence, artifacts, and coherent aggregate outcome', () => {
    expect(validateProjectUatCheckResults(checklist, 'passed', [check])).toBe(true);
    expect(validateProjectUatCheckResults(checklist, 'passed', [{...check, evidenceReferences: ['one']}])).toBe(false);
    expect(validateProjectUatCheckResults(checklist, 'passed', [{...check, artifactReferences: []}])).toBe(false);
    expect(validateProjectUatCheckResults(checklist, 'failed', [check])).toBe(false);
    expect(validateProjectUatCheckResults(checklist, 'failed', [{...check, outcome: 'failed'}])).toBe(true);
  });
});
