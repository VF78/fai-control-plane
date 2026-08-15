import {describe, expect, it} from 'vitest';
import {operatorCapabilityMatrix} from './capability-matrix.ts';

describe('operator capability matrix', () => {
  it('keeps every safe core fact or command on a visible operator seam', () => {
    expect(operatorCapabilityMatrix.map((row) => row[0])).toEqual([
      'GitHub Project snapshot', 'Create project', 'Logout', 'Add source', 'Exact approval', 'Onboard member',
      'Change membership', 'Explicit browser agent submit', 'Messenger delivery'
    ]);
    for (const [, boundary, surface, evidence] of operatorCapabilityMatrix) {
      expect(boundary).not.toHaveLength(0); expect(surface).not.toHaveLength(0); expect(evidence).not.toHaveLength(0);
    }
  });
});
