import type {PgBoss, QueueOptions} from 'pg-boss';
import {RECOVERY_SCAN_QUEUE, recoveryScanCron} from '@fai-control-plane/db/runtime';

export const recoveryScanQueueOptions = Object.freeze({
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 120
} satisfies QueueOptions);

export const configureRecoveryScanQueue = async (
  boss: Pick<PgBoss, 'createQueue' | 'updateQueue' | 'schedule'>
): Promise<void> => {
  await boss.createQueue(RECOVERY_SCAN_QUEUE, recoveryScanQueueOptions);
  await boss.updateQueue(RECOVERY_SCAN_QUEUE, recoveryScanQueueOptions);
  await boss.schedule(RECOVERY_SCAN_QUEUE, recoveryScanCron, {}, {key: RECOVERY_SCAN_QUEUE});
};
