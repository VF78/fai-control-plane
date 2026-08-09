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
  sourceQueueNames: readonly string[],
  supersedingQueueNames: readonly string[] = []
): Promise<readonly Readonly<{queueName: string; failedCount: number}>[]> => {
  const result = await query(
    `select source.queue_name,
       case when source.queue_name = any($3::text[]) then coalesce((
         select case
           when job.name = $2 or job.state in ('failed', 'cancelled') then 1
           else 0
         end
         from pgboss.job job
         where (job.name = source.queue_name and job.state in ('completed', 'failed', 'cancelled'))
            or (job.name = $2 and job.source_name = source.queue_name)
         order by coalesce(job.completed_on, job.created_on) desc, job.created_on desc, job.id desc
         limit 1
       ), 0)::integer else (
         select count(*)::integer
         from pgboss.job job
         where (job.state = 'failed' and job.name = source.queue_name)
            or (job.name = $2 and job.source_name = source.queue_name)
       ) end as failed_count
     from unnest($1::text[]) as source(queue_name)`,
    [sourceQueueNames, CONTROL_PLANE_DEAD_LETTER_QUEUE, supersedingQueueNames]
  );
  const failures = new Map(result.rows.map((row) => [row.queue_name, row.failed_count] as const));
  return sourceQueueNames.map((queueName) => {
    const failedCount = failures.get(queueName) ?? 0;
    if (failedCount > 0) recordDeadLetterQueueVisibility(queueName);
    return {queueName, failedCount};
  });
};
