import type {PgBoss, QueueOptions} from 'pg-boss';
import {QA_INTAKE_QUEUE, qaIntakeCron} from '@fai-control-plane/db/runtime';
import {withControlPlaneDeadLetter} from './queue-dead-letter';

export const qaIntakeQueueOptions = withControlPlaneDeadLetter({
  retryLimit: 3,
  retryDelay: 300,
  retryBackoff: true,
  retryDelayMax: 3_600,
  expireInSeconds: 300
} satisfies QueueOptions);

export const configureQaIntakeQueue = async (
  boss: Pick<PgBoss, 'createQueue' | 'updateQueue' | 'schedule'>
): Promise<void> => {
  await boss.createQueue(QA_INTAKE_QUEUE, qaIntakeQueueOptions);
  await boss.updateQueue(QA_INTAKE_QUEUE, qaIntakeQueueOptions);
  await boss.schedule(QA_INTAKE_QUEUE, qaIntakeCron, {}, {key: QA_INTAKE_QUEUE, tz: 'UTC'});
};
