import type {MessengerDeliveryPort} from '@fai-control-plane/domain';
import type {OutboxRecord, OutboxStore} from './contracts.ts';

export type DeliveryPorts = Readonly<{
  internalMessenger: MessengerDeliveryPort;
  clientMessenger: MessengerDeliveryPort;
  outbox: OutboxStore;
  now(): Date;
}>;

const retryAt = (now: Date, attempts: number): string =>
  new Date(now.getTime() + Math.min(60_000, 1_000 * (2 ** Math.min(attempts, 6)))).toISOString();

export const deliverPending = async (input: Readonly<{
  limit: number;
  ports: DeliveryPorts;
}>): Promise<Readonly<{
  delivered: number;
  retried: number;
}>> => {
  const now = input.ports.now();
  const records = await input.ports.outbox.claim(input.limit, now.toISOString());
  let delivered = 0;
  let retried = 0;
  for (const record of records) {
    try {
      // Runtime records are untrusted persistence data. The typed outbox and
      // persistence claim expose messenger delivery only.
      if (record.topic !== 'messenger-notification') continue;
      const reference = (await (record.payload.message.contour === 'trusted-main'
        ? input.ports.internalMessenger : input.ports.clientMessenger).send(record.payload.message)).deliveryReference;
      await input.ports.outbox.complete(record.id, reference, now.toISOString());
      delivered += 1;
    } catch {
      await input.ports.outbox.retry(record.id, retryAt(now, record.attempts), 'delivery_failed');
      retried += 1;
    }
  }
  return {delivered, retried};
};

export type {OutboxRecord};
