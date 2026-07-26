import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {isAbsolute} from 'node:path';
import {PgBoss} from 'pg-boss';
import {createIncomingEventQueueConsumer} from '@fai-control-plane/application';
import {
  createDatabase,
  createPostgresDailyPmReportProducer,
  createPostgresHealthcheckProducer,
  createPostgresGitHubProjectStatusPublisher,
  createPostgresIncomingEventProcessor,
  createPostgresRecoveryScanProducer,
  DAILY_PM_REPORT_QUEUE,
  HEALTHCHECK_QUEUE,
  INCOMING_EVENT_QUEUE,
  RECOVERY_SCAN_QUEUE
} from '@fai-control-plane/db/runtime';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {createGitHubProjectStatusWriteAdapter} from '@fai-control-plane/integrations/runtime';
import {
  startTelemetry,
  stopTelemetry
} from '@fai-control-plane/observability';
import {configureIncomingEventQueue} from './incoming-event-queue';
import {configureHealthcheckQueue} from './healthcheck-queue';
import {configureRecoveryScanQueue} from './recovery-scan-queue';
import {configureDailyPmReportQueue} from './daily-pm-report-queue';

const databaseUrl = process.env.DATABASE_URL;
const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const writebackEnabled = process.env.GITHUB_STATUS_WRITEBACK_ENABLED === 'true';
const writebackSecretPurpose = 'github_project_status_write_private_key';
const writebackSecretScope = Object.freeze(['github:project:status:write']);

const createWritebackFileSecretsProvider = (
  allowedReference: OpaqueSecretRef
): SecretsProvider => ({
  async resolve(reference, purpose) {
    if (
      purpose !== writebackSecretPurpose ||
      reference.provider !== allowedReference.provider ||
      reference.reference !== allowedReference.reference ||
      reference.scope.length !== allowedReference.scope.length ||
      reference.scope.some((value, index) => value !== allowedReference.scope[index])
    ) {
      throw new Error('Secret reference is not allowed.');
    }
    const value = await readFile(allowedReference.reference, 'utf8');
    if (value.length === 0 || value.length > 65_536 || value.includes('\0')) {
      throw new Error('GitHub App private key file is invalid.');
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
const {db, pool} = createDatabase(databaseUrl);
const incomingEventConsumer = createIncomingEventQueueConsumer({
  processor: createPostgresIncomingEventProcessor(db)
});
const healthcheckProducer = createPostgresHealthcheckProducer(db);
const recoveryScanProducer = createPostgresRecoveryScanProducer(db, boss);
const dailyPmReportProducer = createPostgresDailyPmReportProducer(db);
let statusPublisherTimer: NodeJS.Timeout | undefined;

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
await configureIncomingEventQueue(boss, INCOMING_EVENT_QUEUE);
await configureHealthcheckQueue(boss);
await configureRecoveryScanQueue(boss);
await configureDailyPmReportQueue(boss);
await boss.work(INCOMING_EVENT_QUEUE, async ([job]) => {
  if (job === undefined) return;
  return incomingEventConsumer.consume(job.data);
});
await boss.work(HEALTHCHECK_QUEUE, async () => healthcheckProducer.run());
await boss.work(RECOVERY_SCAN_QUEUE, async () => recoveryScanProducer.run());
await boss.work(DAILY_PM_REPORT_QUEUE, async () => dailyPmReportProducer.run());
await recoveryScanProducer.run();
if (writebackEnabled) {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_FILE;
  const msaInstallationId = process.env.GITHUB_MSA_INSTALLATION_ID;
  const asconInstallationId = process.env.GITHUB_ASCON_INSTALLATION_ID;
  if (
    appId === undefined || !/^[1-9][0-9]{0,19}$/.test(appId) ||
    privateKeyPath === undefined || !isAbsolute(privateKeyPath) ||
    msaInstallationId === undefined || !/^[1-9][0-9]{0,19}$/.test(msaInstallationId) ||
    asconInstallationId === undefined || !/^[1-9][0-9]{0,19}$/.test(asconInstallationId)
  ) {
    throw new Error('GitHub status write-back configuration is invalid.');
  }
  const credentialRef: OpaqueSecretRef = {
    provider: 'file',
    reference: privateKeyPath,
    scope: writebackSecretScope
  };
  const publisher = createPostgresGitHubProjectStatusPublisher(
    db,
    createGitHubProjectStatusWriteAdapter({
      appId,
      secretsProvider: createWritebackFileSecretsProvider(credentialRef),
      installationIds: {
        'VF78/MSA': msaInstallationId,
        'VF78/ascon': asconInstallationId
      }
    }),
    credentialRef
  );
  let publishing = false;
  const publish = async (): Promise<void> => {
    if (publishing || stopping) return;
    publishing = true;
    try {
      for (let count = 0; count < 10; count += 1) {
        const result = await publisher.publishAvailable();
        if (result.status === 'idle') return;
      }
    } catch {
      console.error('github status write-back failed', {
        code: 'GITHUB_STATUS_WRITEBACK_FAILED'
      });
    } finally {
      publishing = false;
    }
  };
  await publish();
  statusPublisherTimer = setInterval(() => {
    void publish();
  }, 1_000);
}
ready = true;

async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;

  stopping = true;
  ready = false;
  if (statusPublisherTimer !== undefined) clearInterval(statusPublisherTimer);
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
