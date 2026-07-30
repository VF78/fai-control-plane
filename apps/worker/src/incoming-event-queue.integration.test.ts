import {randomUUID} from 'node:crypto';
import {PgBoss} from 'pg-boss';
import {afterEach, describe, expect, it} from 'vitest';
import {
  configureIncomingEventQueue,
  incomingEventQueueOptions
} from './incoming-event-queue';
import {
  configureControlPlaneDeadLetterQueue,
  CONTROL_PLANE_DEAD_LETTER_QUEUE
} from './queue-dead-letter';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for worker queue integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

const waitFor = async <T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs = 30_000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!matches(latest)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for pg-boss retry.');
    await new Promise((resolve) => setTimeout(resolve, 50));
    latest = await read();
  }
  return latest;
};

describePostgres('incoming event pg-boss retry policy', () => {
  const queueName = `incoming-event-retry-${randomUUID()}`;
  let boss: PgBoss;
  let deadLetterJobId: string | undefined;

  afterEach(async () => {
    if (boss === undefined) return;
    await boss.offWork(queueName, {wait: true});
    if (await boss.getQueue(queueName)) {
      await boss.deleteAllJobs(queueName);
      await boss.deleteQueue(queueName);
    }
    if (deadLetterJobId !== undefined) await boss.deleteJob(CONTROL_PLANE_DEAD_LETTER_QUEUE, deadLetterJobId);
    await boss.stop({graceful: false});
  });

  it('persists bounded retry settings and completes on the second attempt', async () => {
    boss = new PgBoss({connectionString: databaseUrl!});
    boss.on('error', () => undefined);
    await boss.start();
    await configureControlPlaneDeadLetterQueue(boss);
    await configureIncomingEventQueue(boss, queueName);
    await expect(boss.getQueue(queueName)).resolves.toMatchObject(
      incomingEventQueueOptions
    );

    let attempts = 0;
    await boss.work<{eventId: string}>(queueName, async ([job]) => {
      if (job === undefined) return;
      attempts += 1;
      if (attempts === 1) throw new Error('expected retry');
      return {eventId: job.data.eventId};
    });
    const eventId = randomUUID();
    const jobId = await boss.send(queueName, {eventId});
    expect(jobId).not.toBeNull();

    const completed = await waitFor(
      () => boss.getJobById<{eventId: string}>(queueName, jobId!),
      (job) => job?.state === 'completed'
    );
    expect(attempts).toBe(2);
    expect(completed).toMatchObject({
      state: 'completed',
      retryLimit: 5,
      retryCount: 1,
      output: {eventId}
    });
  }, 30_000);

  it('moves a terminal source failure to the shared DLQ and exposes only source counts', async () => {
    boss = new PgBoss({connectionString: databaseUrl!});
    boss.on('error', () => undefined);
    await boss.start();
    await configureControlPlaneDeadLetterQueue(boss);
    await configureIncomingEventQueue(boss, queueName);

    let attempts = 0;
    await boss.work<{eventId: string; privateValue: string}>(queueName, async () => {
      attempts += 1;
      throw new Error('terminal test failure');
    });
    const privateValue = 'must-not-appear-in-visibility';
    const jobId = await boss.send(
      queueName,
      {eventId: randomUUID(), privateValue},
      {retryLimit: 1, retryDelay: 1, retryBackoff: false}
    );
    expect(jobId).not.toBeNull();

    const deadLettered = await waitFor(
      () => boss.findJobs(CONTROL_PLANE_DEAD_LETTER_QUEUE).then((jobs) => jobs.map((job) => ({
        id: job.id, sourceName: job.sourceName, sourceId: job.sourceId, sourceRetryCount: job.sourceRetryCount
      }))),
      (jobs) => jobs.some((job) => job.sourceId === jobId)
    );
    const job = deadLettered.find((item) => item.sourceId === jobId);
    deadLetterJobId = job?.id;
    expect(attempts).toBe(2);
    expect(job).toMatchObject({sourceName: queueName, sourceId: jobId, sourceRetryCount: 1});
    expect(JSON.stringify(job)).not.toContain(privateValue);
  }, 30_000);
});
