import type {PgBoss, QueueOptions} from 'pg-boss';
import {PM_REPORT_CHECK_QUEUE, pmReportCheckCron} from '@fai-control-plane/db/runtime';
import {withControlPlaneDeadLetter} from './queue-dead-letter';

export const pmReportCheckQueueOptions = withControlPlaneDeadLetter({
  retryLimit: 3,
  retryDelay: 300,
  retryBackoff: true,
  retryDelayMax: 3_600,
  expireInSeconds: 300
} satisfies QueueOptions);

export const configurePmReportCheckQueue = async (
  boss: Pick<PgBoss, 'createQueue' | 'updateQueue' | 'schedule'>
): Promise<void> => {
  await boss.createQueue(PM_REPORT_CHECK_QUEUE, pmReportCheckQueueOptions);
  await boss.updateQueue(PM_REPORT_CHECK_QUEUE, pmReportCheckQueueOptions);
  await boss.schedule(
    PM_REPORT_CHECK_QUEUE, pmReportCheckCron, {}, {key: PM_REPORT_CHECK_QUEUE, tz: 'UTC'}
  );
};
