import {describe, expect, it, vi} from 'vitest';
import {deliverPending} from './delivery-retry.ts';

const outbox = () => ({
  id: 'outbox-1', projectId: 'project', topic: 'messenger-notification' as const, idempotencyKey: 'key', attempts: 0,
  payload: {message: {projectId: 'project', contour: 'trusted-main' as const, channelReference: 'channel', text: 'Done', idempotencyKey: 'key'}},
  availableAt: '2026-08-13T00:00:00.000Z'
});

describe('MVP delivery retry', () => {
  it('completes a messenger delivery with provider evidence', async () => {
    const complete = vi.fn(async () => undefined);
    const ports = {
      agent: {submit: vi.fn()}, internalMessenger: {send: vi.fn(async () => ({deliveryReference: 'sent-1'}))},
      clientMessenger: {send: vi.fn()},
      outbox: {enqueue: vi.fn(), claim: vi.fn(async () => [outbox()]), complete, retry: vi.fn()},
      now: () => new Date('2026-08-13T00:00:00.000Z')
    };
    await expect(deliverPending({limit: 10, ports})).resolves.toEqual({
      delivered: 1, retried: 0, agentDelivered: 0, agentRetried: 0
    });
    expect(complete).toHaveBeenCalledWith('outbox-1', 'sent-1', '2026-08-13T00:00:00.000Z');
  });

  it('schedules bounded backoff without a local workflow state machine', async () => {
    const retry = vi.fn(async () => undefined);
    const ports = {
      agent: {submit: vi.fn()}, internalMessenger: {send: vi.fn(async () => { throw new Error('unavailable'); })},
      clientMessenger: {send: vi.fn()},
      outbox: {enqueue: vi.fn(), claim: vi.fn(async () => [outbox()]), complete: vi.fn(), retry},
      now: () => new Date('2026-08-13T00:00:00.000Z')
    };
    await expect(deliverPending({limit: 10, ports})).resolves.toEqual({
      delivered: 0, retried: 1, agentDelivered: 0, agentRetried: 0
    });
    expect(retry).toHaveBeenCalledWith('outbox-1', '2026-08-13T00:00:01.000Z', 'delivery_failed');
  });
});
