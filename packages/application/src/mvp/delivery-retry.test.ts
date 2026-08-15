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
      internalMessenger: {send: vi.fn(async () => ({deliveryReference: 'sent-1'}))},
      clientMessenger: {send: vi.fn()},
      outbox: {enqueue: vi.fn(), claim: vi.fn(async () => [outbox()]), complete, retry: vi.fn()},
      now: () => new Date('2026-08-13T00:00:00.000Z')
    };
    await expect(deliverPending({limit: 10, ports})).resolves.toEqual({
      delivered: 1, retried: 0
    });
    expect(complete).toHaveBeenCalledWith('outbox-1', 'sent-1', '2026-08-13T00:00:00.000Z');
  });

  it('schedules bounded backoff without a local workflow state machine', async () => {
    const retry = vi.fn(async () => undefined);
    const ports = {
      internalMessenger: {send: vi.fn(async () => { throw new Error('unavailable'); })},
      clientMessenger: {send: vi.fn()},
      outbox: {enqueue: vi.fn(), claim: vi.fn(async () => [outbox()]), complete: vi.fn(), retry},
      now: () => new Date('2026-08-13T00:00:00.000Z')
    };
    await expect(deliverPending({limit: 10, ports})).resolves.toEqual({
      delivered: 0, retried: 1
    });
    expect(retry).toHaveBeenCalledWith('outbox-1', '2026-08-13T00:00:01.000Z', 'delivery_failed');
  });

  it('keeps a legacy agent outbox record inert without any agent delivery port', async () => {
    const internalMessenger = {send: vi.fn()}; const clientMessenger = {send: vi.fn()};
    const legacy = {id: 'legacy', projectId: 'project', topic: 'agent-role-request', idempotencyKey: 'old',
      attempts: 0, availableAt: '2026-08-13T00:00:00.000Z', payload: {request: {}}};
    const ports = {internalMessenger, clientMessenger, outbox: {enqueue: vi.fn(),
      claim: vi.fn(async () => [legacy] as never), complete: vi.fn(), retry: vi.fn()},
      now: () => new Date('2026-08-13T00:00:00.000Z')};
    await expect(deliverPending({limit: 10, ports})).resolves.toEqual({delivered: 0, retried: 0});
    expect(internalMessenger.send).not.toHaveBeenCalled(); expect(clientMessenger.send).not.toHaveBeenCalled();
    expect(ports.outbox.complete).not.toHaveBeenCalled(); expect(ports.outbox.retry).not.toHaveBeenCalled();
  });
});
