import type {PgBoss, QueueOptions} from 'pg-boss';
import {recordDeadLetterQueueVisibility} from '@fai-control-plane/observability';

export const CONTROL_PLANE_DEAD_LETTER_QUEUE = 'control-plane-dead-letter';

type QueueWithDeadLetter = QueueOptions & Readonly<{
  deadLetter: typeof CONTROL_PLANE_DEAD_LETTER_QUEUE;
}>;

type QueueFailureRow = Readonly<{queue_name: string; failed_count: number}>;

export const withControlPlaneDeadLetter = <Options extends QueueOptions>(
  options: Options
): Readonly<Options & QueueWithDeadLetter> => Object.freeze({
  ...options,
  deadLetter: CONTROL_PLANE_DEAD_LETTER_QUEUE
});

export const configureControlPlaneDeadLetterQueue = async (
  boss: Pick<PgBoss, 'createQueue'>
): Promise<void> => {
  await boss.createQueue(CONTROL_PLANE_DEAD_LETTER_QUEUE);
};

export const loadQueueFailureCounts = async (
  query: (statement: string, values: unknown[]) => Promise<Readonly<{rows: readonly QueueFailureRow[]}>>,
  sourceQueueNames: readonly string[]
): Promise<readonly Readonly<{queueName: string; failedCount: number}>[]> => {
  const result = await query(
    `select coalesce(source_name, name) as queue_name, count(*)::integer as failed_count
     from pgboss.job
     where (state = 'failed' and name = any($1::text[]))
        or (name = $2 and source_name = any($1::text[]))
     group by coalesce(source_name, name)`,
    [sourceQueueNames, CONTROL_PLANE_DEAD_LETTER_QUEUE]
  );
  const failures = new Map(result.rows.map((row) => [row.queue_name, row.failed_count] as const));
  return sourceQueueNames.map((queueName) => {
    const failedCount = failures.get(queueName) ?? 0;
    if (failedCount > 0) recordDeadLetterQueueVisibility(queueName);
    return {queueName, failedCount};
  });
};
