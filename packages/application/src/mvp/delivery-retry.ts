import type {AgentDeliveryPort, MessengerDeliveryPort} from '@fai-control-plane/domain';
import type {OutboxRecord, OutboxStore} from './contracts.ts';

export type DeliveryPorts = Readonly<{
  agent: AgentDeliveryPort;
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
  agentDelivered: number;
  agentRetried: number;
}>> => {
  const now = input.ports.now();
  const records = await input.ports.outbox.claim(input.limit, now.toISOString());
  let delivered = 0;
  let retried = 0;
  let agentDelivered = 0;
  let agentRetried = 0;
  for (const record of records) {
    try {
      const reference = record.topic === 'agent-role-request'
        ? (await input.ports.agent.submit(record.payload.request)).deliveryReference
        : (await (record.payload.message.contour === 'trusted-main'
          ? input.ports.internalMessenger : input.ports.clientMessenger).send(record.payload.message)).deliveryReference;
      await input.ports.outbox.complete(record.id, reference, now.toISOString());
      delivered += 1;
      if (record.topic === 'agent-role-request') agentDelivered += 1;
    } catch {
      await input.ports.outbox.retry(record.id, retryAt(now, record.attempts), 'delivery_failed');
      retried += 1;
      if (record.topic === 'agent-role-request') agentRetried += 1;
    }
  }
  return {delivered, retried, agentDelivered, agentRetried};
};

export type {OutboxRecord};
