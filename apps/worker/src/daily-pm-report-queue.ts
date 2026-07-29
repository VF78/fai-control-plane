import type {PgBoss, QueueOptions} from 'pg-boss';
import {DAILY_PM_REPORT_QUEUE, dailyPmReportCron} from '@fai-control-plane/db/runtime';
import {withControlPlaneDeadLetter} from './queue-dead-letter';

export const dailyPmReportQueueOptions = withControlPlaneDeadLetter({
  retryLimit: 3,
  retryDelay: 300,
  retryBackoff: true,
  retryDelayMax: 3_600,
  expireInSeconds: 300
} satisfies QueueOptions);

export const configureDailyPmReportQueue = async (
  boss: Pick<PgBoss, 'createQueue' | 'updateQueue' | 'schedule'>
): Promise<void> => {
  await boss.createQueue(DAILY_PM_REPORT_QUEUE, dailyPmReportQueueOptions);
  await boss.updateQueue(DAILY_PM_REPORT_QUEUE, dailyPmReportQueueOptions);
  await boss.schedule(
    DAILY_PM_REPORT_QUEUE, dailyPmReportCron, {}, {key: DAILY_PM_REPORT_QUEUE, tz: 'UTC'}
  );
};
