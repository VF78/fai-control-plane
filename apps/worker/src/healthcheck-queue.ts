import type {PgBoss, QueueOptions} from 'pg-boss';
import {HEALTHCHECK_QUEUE, healthcheckCron} from '@fai-control-plane/db/runtime';

export const healthcheckQueueOptions = Object.freeze({
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 120
} satisfies QueueOptions);

export const configureHealthcheckQueue = async (
  boss: Pick<PgBoss, 'createQueue' | 'updateQueue' | 'schedule'>
): Promise<void> => {
  await boss.createQueue(HEALTHCHECK_QUEUE, healthcheckQueueOptions);
  await boss.updateQueue(HEALTHCHECK_QUEUE, healthcheckQueueOptions);
  await boss.schedule(HEALTHCHECK_QUEUE, healthcheckCron, {}, {key: HEALTHCHECK_QUEUE});
};
