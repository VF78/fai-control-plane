import {describe, expect, it, vi} from 'vitest';
import {
  configureIncomingEventQueue,
  incomingEventQueueOptions
} from './incoming-event-queue';
import {CONTROL_PLANE_DEAD_LETTER_QUEUE} from './queue-dead-letter';

describe('incoming event queue policy', () => {
  it('keeps retries bounded and updates an existing queue', async () => {
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined)
    };

    await configureIncomingEventQueue(boss, 'incoming-event.process.v1');

    expect(incomingEventQueueOptions).toEqual({
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 600,
      deadLetter: CONTROL_PLANE_DEAD_LETTER_QUEUE
    });
    expect(boss.createQueue).toHaveBeenCalledWith(
      'incoming-event.process.v1',
      incomingEventQueueOptions
    );
    expect(boss.updateQueue).toHaveBeenCalledWith(
      'incoming-event.process.v1',
      incomingEventQueueOptions
    );
  });
});
