import type {PgBoss, QueueOptions} from 'pg-boss';
import {withControlPlaneDeadLetter} from './queue-dead-letter';

export const incomingEventQueueOptions = withControlPlaneDeadLetter({
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 60,
  expireInSeconds: 600
} satisfies QueueOptions);

export const configureIncomingEventQueue = async (
  boss: Pick<PgBoss, 'createQueue' | 'updateQueue'>,
  name: string
): Promise<void> => {
  await boss.createQueue(name, incomingEventQueueOptions);
  await boss.updateQueue(name, incomingEventQueueOptions);
};
