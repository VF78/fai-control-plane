import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {isAbsolute} from 'node:path';
import {PgBoss, type SendOptions} from 'pg-boss';
import {
  createCanonicalCommandService,
  createIncomingEventQueueConsumer
} from '@fai-control-plane/application';
import {
  createDatabase,
  createPostgresDailyPmReportProducer,
  createPostgresHealthcheckProducer,
  createPostgresAgentRoleRequestOutbox,
  createPostgresIncomingEventProcessor,
  createPostgresPmReportCheckProducer,
  createPostgresQaIntakeProducer,
  createPostgresPmQaBotRunner,
  createPostgresQaIntakeTaskPacketConsumer,
  createPostgresUnitOfWork,
  createPostgresRecoveryScanProducer,
  DAILY_PM_REPORT_QUEUE,
  HEALTHCHECK_QUEUE,
  INCOMING_EVENT_QUEUE,
  PM_REPORT_CHECK_QUEUE,
  QA_INTAKE_QUEUE,
  RECOVERY_SCAN_QUEUE
} from '@fai-control-plane/db/runtime';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {
  createHermesApiRunsAdapter,
  hermesRunsSecretPurpose,
  hermesRunsSecretScope
} from '@fai-control-plane/integrations/runtime';
import {
  recordDurableJobEnqueue,
  startTelemetry,
  stopTelemetry,
  traceDurableJobExecution
} from '@fai-control-plane/observability';
import {configureIncomingEventQueue} from './incoming-event-queue';
import {configureHealthcheckQueue} from './healthcheck-queue';
import {configureRecoveryScanQueue} from './recovery-scan-queue';
import {configureDailyPmReportQueue} from './daily-pm-report-queue';
import {configurePmReportCheckQueue} from './pm-report-check-queue';
import {configureQaIntakeQueue} from './qa-intake-queue';
import {
  createGitHubReconciliationRuntime,
  githubReconciliationFailure
} from './github-reconciliation';
import {
  configureGitHubReconciliationQueue,
  GITHUB_RECONCILIATION_QUEUE
} from './github-reconciliation-queue';
import {
  configureControlPlaneDeadLetterQueue,
  loadQueueFailureCounts
} from './queue-dead-letter';

const databaseUrl = process.env.DATABASE_URL;
const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const githubSyncEnabled = process.env.GITHUB_SYNC_ENABLED === 'true';
const hermesApiBaseUrl = process.env.HERMES_API_BASE_URL;
const hermesApiKeyFile = process.env.HERMES_API_KEY_FILE;

type DurableQueueJob = Readonly<{id: string; retryCount: number}>;

const executeDurableJob = <Result>(
  queueName: string,
  job: DurableQueueJob,
  execute: () => Promise<Result>
): Promise<Result> => traceDurableJobExecution({
  queueName,
  jobId: job.id,
  retryCount: job.retryCount
}, execute);

const required = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
};

const createHermesFileSecretsProvider = (allowedReference: OpaqueSecretRef): SecretsProvider => ({
  async resolve(reference, purpose) {
    if (purpose !== hermesRunsSecretPurpose || reference.provider !== allowedReference.provider ||
      reference.reference !== allowedReference.reference || reference.scope.length !== allowedReference.scope.length ||
      reference.scope.some((value, index) => value !== allowedReference.scope[index])) throw new Error('Secret reference is not allowed.');
    const value = (await readFile(allowedReference.reference, 'utf8')).trimEnd();
    if (value.length === 0 || value.length > 65_536 || /[\0\r\n]/.test(value) || value.trim() !== value) {
      throw new Error('Hermes secret file is invalid.');
    }
    return {value};
  }
});

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

let ready = false;
let stopping = false;

await startTelemetry('fai-control-plane-worker');

const boss = new PgBoss(databaseUrl);
boss.on('error', () => {
  console.error('pg-boss error', {code: 'PG_BOSS_ERROR'});
});
const telemetryQueueSender: Readonly<{
  send(name: string, data: object | null, options?: SendOptions): Promise<string | null>;
}> = {
  async send(name, data, options) {
    const jobId = await boss.send(name, data, options);
    if (jobId !== null) recordDurableJobEnqueue({queueName: name, jobId});
    return jobId;
  }
};
const {db, pool} = createDatabase(databaseUrl);
if ((hermesApiBaseUrl === undefined) !== (hermesApiKeyFile === undefined)) {
  throw new Error('HERMES_API_BASE_URL and HERMES_API_KEY_FILE must be configured together.');
}
if (hermesApiBaseUrl !== undefined && !githubSyncEnabled) {
  throw new Error('Hermes role requests require GitHub synchronization.');
}
let agentRoleRequests: ReturnType<typeof createPostgresAgentRoleRequestOutbox> | undefined;
if (hermesApiBaseUrl !== undefined && hermesApiKeyFile !== undefined) {
  if (!isAbsolute(hermesApiKeyFile)) throw new Error('Hermes secret file path must be absolute.');
  const credentialRef: OpaqueSecretRef = {provider: 'file', reference: hermesApiKeyFile, scope: hermesRunsSecretScope};
  agentRoleRequests = createPostgresAgentRoleRequestOutbox(db, createHermesApiRunsAdapter({
    baseUrl: hermesApiBaseUrl,
    credentialRef,
    secrets: createHermesFileSecretsProvider(credentialRef)
  }));
}
const incomingEventProcessor = createPostgresIncomingEventProcessor(db);
const incomingEventConsumer = createIncomingEventQueueConsumer({
  processor: incomingEventProcessor
});
const healthcheckQueueNames = [
  INCOMING_EVENT_QUEUE,
  HEALTHCHECK_QUEUE,
  RECOVERY_SCAN_QUEUE,
  DAILY_PM_REPORT_QUEUE,
  PM_REPORT_CHECK_QUEUE,
  QA_INTAKE_QUEUE,
  ...(githubSyncEnabled ? [GITHUB_RECONCILIATION_QUEUE] : [])
];
const supersedingHealthcheckQueueNames = healthcheckQueueNames.filter(
  (queueName) => queueName !== INCOMING_EVENT_QUEUE
);
const healthcheckProducer = createPostgresHealthcheckProducer(db, {
  queueFailures: async () => {
    return loadQueueFailureCounts(
      (statement, values) => pool.query<{queue_name: string; failed_count: number}>(statement, values),
      healthcheckQueueNames,
      supersedingHealthcheckQueueNames
    );
  }
});
const recoveryScanProducer = createPostgresRecoveryScanProducer(db, telemetryQueueSender);
const dailyPmReportProducer = createPostgresDailyPmReportProducer(db);
const pmReportCheckProducer = createPostgresPmReportCheckProducer(db);
const qaIntakeProducer = createPostgresQaIntakeProducer(db);
const qaIntakeTaskPacketConsumer = createPostgresQaIntakeTaskPacketConsumer(
  db,
  createCanonicalCommandService({unitOfWork: createPostgresUnitOfWork(db)})
);
const pmQaBotRunner = createPostgresPmQaBotRunner(db);
const githubReconciliation = githubSyncEnabled
  ? createGitHubReconciliationRuntime(db, pool, agentRoleRequests)
  : undefined;
const reconcileGitHub = async (projectId?: string): Promise<void> => {
  await githubReconciliation!.reconcile(projectId);
  if (agentRoleRequests === undefined) return;
  for (let count = 0; count < 10; count += 1) {
    const result = await agentRoleRequests.publishAvailable();
    if (result !== 'published') return;
  }
};

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');

  if (request.url === '/health') {
    response.statusCode = stopping ? 503 : 200;
    response.end(
      JSON.stringify({
        status: stopping ? 'stopping' : 'ok',
        service: 'worker'
      })
    );
    return;
  }

  if (request.url === '/ready') {
    response.statusCode = ready && !stopping ? 200 : 503;
    response.end(
      JSON.stringify({
        status: ready && !stopping ? 'ready' : 'not_ready',
        service: 'worker'
      })
    );
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({status: 'not_found'}));
});

server.listen(port, '0.0.0.0');
await boss.start();
await configureControlPlaneDeadLetterQueue(boss);
await configureIncomingEventQueue(boss, INCOMING_EVENT_QUEUE);
await configureHealthcheckQueue(boss);
await configureRecoveryScanQueue(boss);
await configureDailyPmReportQueue(boss);
await configurePmReportCheckQueue(boss);
await configureQaIntakeQueue(boss);
if (githubReconciliation !== undefined) {
  await configureGitHubReconciliationQueue(boss);
}
await boss.work(INCOMING_EVENT_QUEUE, {includeMetadata: true}, async ([job]) => {
  if (job === undefined) return;
  return executeDurableJob(INCOMING_EVENT_QUEUE, job, async () => {
    const result = await incomingEventConsumer.consume(job.data);
    if (githubReconciliation !== undefined) {
      const event = await pool.query<{provider: string; project_id: string | null}>(
        `select provider, project_id from incoming_events where id = $1`,
        [result.eventId]
      );
      const observed = event.rows[0];
      if (observed?.provider === 'github' && observed.project_id !== null) {
        await reconcileGitHub(observed.project_id);
      }
    }
    return result;
  });
});
await boss.work(HEALTHCHECK_QUEUE, {includeMetadata: true}, async ([job]) => {
  if (job === undefined) return;
  return executeDurableJob(HEALTHCHECK_QUEUE, job, () => healthcheckProducer.run());
});
await boss.work(RECOVERY_SCAN_QUEUE, {includeMetadata: true}, async ([job]) => {
  if (job === undefined) return;
  return executeDurableJob(RECOVERY_SCAN_QUEUE, job, () => recoveryScanProducer.run());
});
await boss.work(DAILY_PM_REPORT_QUEUE, {includeMetadata: true}, async ([job]) => {
  if (job === undefined) return;
  return executeDurableJob(DAILY_PM_REPORT_QUEUE, job, () => dailyPmReportProducer.run());
});
await boss.work(PM_REPORT_CHECK_QUEUE, {includeMetadata: true}, async ([job]) => {
  if (job === undefined) return;
  return executeDurableJob(PM_REPORT_CHECK_QUEUE, job, () => pmReportCheckProducer.run());
});
await boss.work(QA_INTAKE_QUEUE, {includeMetadata: true}, async ([job]) => {
  if (job === undefined) return;
  return executeDurableJob(QA_INTAKE_QUEUE, job, async () => {
    const eventIds = await qaIntakeProducer.run();
    return Promise.all(eventIds.map(async (eventId) => {
      const packetResult = await qaIntakeTaskPacketConsumer.consume(eventId);
      if (packetResult.status !== 'created' && packetResult.status !== 'replayed') {
        return {packetResult};
      }
      const botResult = await pmQaBotRunner.run(eventId);
      return {packetResult, botResult};
    }));
  });
});
if (githubReconciliation !== undefined) {
  await boss.work(GITHUB_RECONCILIATION_QUEUE, {includeMetadata: true}, async ([job]) => {
    if (job === undefined) return;
    return executeDurableJob(GITHUB_RECONCILIATION_QUEUE, job, async () => {
      try {
        await reconcileGitHub();
      } catch (error) {
        const failure = githubReconciliationFailure(error);
        console.error('github reconciliation failed', failure);
        throw error;
      }
    });
  });
}
await recoveryScanProducer.run();
await dailyPmReportProducer.run();
if (githubReconciliation !== undefined) {
  try {
    await reconcileGitHub();
  } catch (error) {
    const failure = githubReconciliationFailure(error);
    console.error('github reconciliation startup failed', failure);
  }
}
ready = true;

async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;

  stopping = true;
  ready = false;
  console.info(`received ${signal}; shutting down`);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  await boss.stop({graceful: true, timeout: 20_000});
  await pool.end();
  await stopTelemetry();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch(() => {
        console.error('worker shutdown failed', {code: 'WORKER_SHUTDOWN_FAILED'});
        process.exit(1);
      });
  });
}
