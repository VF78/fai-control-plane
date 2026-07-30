import {beforeEach, describe, expect, it, vi} from 'vitest';

const telemetry = vi.hoisted(() => ({
  recordDurableJobEnqueue: vi.fn()
}));

vi.mock('@fai-control-plane/observability', () => telemetry);

import {createTelemetryQueueSender} from './github-webhook-runtime';

beforeEach(() => {
  telemetry.recordDurableJobEnqueue.mockClear();
});

describe('telemetry queue sender', () => {
  it('records a returned durable job identifier without forwarding payload data', async () => {
    const boss = {
      send: vi.fn(async () => 'job-1')
    };
    const sender = createTelemetryQueueSender(boss);

    await expect(sender.send(
      'incoming-event.process.v1',
      {customerText: 'must not reach telemetry'},
      {retryLimit: 5}
    )).resolves.toBe('job-1');

    expect(telemetry.recordDurableJobEnqueue).toHaveBeenCalledWith({
      queueName: 'incoming-event.process.v1',
      jobId: 'job-1'
    });
  });

  it('does not record an enqueue when no durable job was created', async () => {
    const sender = createTelemetryQueueSender({
      send: vi.fn(async () => null)
    });

    await expect(sender.send('incoming-event.process.v1', {})).resolves.toBeNull();

    expect(telemetry.recordDurableJobEnqueue).not.toHaveBeenCalled();
  });
});
