import {describe, expect, it, vi} from 'vitest';

const telemetry = vi.hoisted(() => ({
  recordDeadLetterQueueVisibility: vi.fn()
}));

vi.mock('@fai-control-plane/observability', () => telemetry);

import {
  configureControlPlaneDeadLetterQueue,
  CONTROL_PLANE_DEAD_LETTER_QUEUE,
  loadQueueFailureCounts,
  withControlPlaneDeadLetter
} from './queue-dead-letter';

describe('control-plane dead-letter queue', () => {
  it('configures the shared DLQ idempotently and retains each source queue policy', async () => {
    const boss = {createQueue: vi.fn(async () => undefined)};

    await configureControlPlaneDeadLetterQueue(boss);
    await configureControlPlaneDeadLetterQueue(boss);

    expect(boss.createQueue).toHaveBeenCalledTimes(2);
    expect(boss.createQueue).toHaveBeenCalledWith(CONTROL_PLANE_DEAD_LETTER_QUEUE);
    const sourceOptions = withControlPlaneDeadLetter({retryLimit: 5, retryDelay: 5, retryBackoff: true, retryDelayMax: 60, expireInSeconds: 600});
    expect(sourceOptions).toEqual({retryLimit: 5, retryDelay: 5, retryBackoff: true, retryDelayMax: 60, expireInSeconds: 600, deadLetter: CONTROL_PLANE_DEAD_LETTER_QUEUE});
  });

  it('projects terminal and dead-lettered failures by source queue without selecting payload data', async () => {
    const query = vi.fn(async () => ({rows: [{queue_name: 'source-a', failed_count: 2}]}));
    const result = await loadQueueFailureCounts(query, ['source-a', 'source-b']);

    expect(result).toEqual([{queueName: 'source-a', failedCount: 2}, {queueName: 'source-b', failedCount: 0}]);
    const [statement, values] = query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(statement).toContain('coalesce(source_name, name)');
    expect(statement).not.toMatch(/\bdata\b|payload/i);
    expect(values).toEqual([['source-a', 'source-b'], CONTROL_PLANE_DEAD_LETTER_QUEUE]);
    expect(telemetry.recordDeadLetterQueueVisibility).toHaveBeenCalledWith('source-a');
    expect(telemetry.recordDeadLetterQueueVisibility).toHaveBeenCalledTimes(1);
  });
});
