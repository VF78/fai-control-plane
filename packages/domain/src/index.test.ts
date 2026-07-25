import {describe, expect, it} from 'vitest';
import {actionCategories, workItemStatuses} from './index';

describe('foundation domain constants', () => {
  it('keeps the six approved work item statuses', () => {
    expect(workItemStatuses).toEqual([
      'backlog',
      'ready',
      'in_dev',
      'qa',
      'acceptance',
      'done'
    ]);
  });

  it('includes every required sensitive action category', () => {
    expect(actionCategories).toContain('deploy');
    expect(actionCategories).toContain('external_message');
    expect(actionCategories).toContain('customer_data_touch');
  });
});
