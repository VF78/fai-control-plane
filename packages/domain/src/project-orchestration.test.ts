import {describe, expect, it} from 'vitest';
import {projectExecutionStatuses, transitionProjectExecution} from './project-orchestration';

describe('project execution state machine', () => {
  it('keeps manager transitions explicit and terminal completion closed', () => {
    expect(projectExecutionStatuses).toEqual(['stopped', 'running', 'paused', 'blocked', 'completed']);
    expect(transitionProjectExecution('stopped', 'running')).toEqual({ok: true, value: 'running'});
    expect(transitionProjectExecution('blocked', 'paused')).toEqual({ok: true, value: 'paused'});
    expect(transitionProjectExecution('completed', 'running')).toMatchObject({ok: false, error: {code: 'INVALID_TRANSITION'}});
    expect(transitionProjectExecution('running', 'completed')).toMatchObject({ok: false, error: {code: 'INVALID_TRANSITION'}});
  });
});
