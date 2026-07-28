import type {PgBoss, QueueOptions} from 'pg-boss';

export const GITHUB_RECONCILIATION_QUEUE = 'github-reconciliation';
export const githubReconciliationCron = '*/5 * * * *';

export const githubReconciliationQueueOptions = Object.freeze({
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 240
} satisfies QueueOptions);

const githubReconciliationQueueCreationOptions = Object.freeze({
  ...githubReconciliationQueueOptions,
  policy: 'singleton' as const
});

export const configureGitHubReconciliationQueue = async (
  boss: Pick<PgBoss, 'createQueue' | 'updateQueue' | 'schedule'>
): Promise<void> => {
  await boss.createQueue(
    GITHUB_RECONCILIATION_QUEUE,
    githubReconciliationQueueCreationOptions
  );
  await boss.updateQueue(
    GITHUB_RECONCILIATION_QUEUE,
    githubReconciliationQueueOptions
  );
  await boss.schedule(
    GITHUB_RECONCILIATION_QUEUE,
    githubReconciliationCron,
    {},
    {key: GITHUB_RECONCILIATION_QUEUE}
  );
};
