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
  createPostgresTelegramStatusPublisher,
  createPostgresTelegramStatusResponseOutbox,
  createPostgresPmReportCheckProducer,
  createPostgresQaIntakeProducer,
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
  createGitHubProjectStatusWriteAdapter,
  createTelegramChatAdapter,
  githubProjectsOAuthScope
} from '@fai-control-plane/integrations/runtime';
import {
  startTelemetry,
  stopTelemetry
} from '@fai-control-plane/observability';
import {configureIncomingEventQueue} from './incoming-event-queue';
import {configureHealthcheckQueue} from './healthcheck-queue';
import {configureRecoveryScanQueue} from './recovery-scan-queue';
import {configureDailyPmReportQueue} from './daily-pm-report-queue';
import {configurePmReportCheckQueue} from './pm-report-check-queue';
import {configureQaIntakeQueue} from './qa-intake-queue';

const databaseUrl = process.env.DATABASE_URL;
const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const writebackEnabled = process.env.GITHUB_STATUS_WRITEBACK_ENABLED === 'true';
const telegramStatusResponseEnabled = process.env.TELEGRAM_STATUS_RESPONSE_ENABLED === 'true';
const writebackSecretPurpose = 'github_project_status_write_oauth_token';
const telegramIdentitySecretScope = Object.freeze(['telegram:identity:keying']);
const telegramBotSecretScope = Object.freeze(['telegram:bot:send']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positiveIntegerPattern = /^[1-9][0-9]{0,19}$/;

const required = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
};

const requiredUuid = (name: string): string => {
  const value = required(name);
  if (!uuidPattern.test(value)) throw new Error(`Invalid UUID configuration: ${name}`);
  return value;
};

const requiredTelegramAllowlist = (name: string): number[] => {
  const entries = required(name).split(',');
  if (entries.length === 0 || entries.some((entry) => !positiveIntegerPattern.test(entry))) {
    throw new Error(`Invalid Telegram allowlist configuration: ${name}`);
  }
  const ids = entries.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`Invalid Telegram allowlist configuration: ${name}`);
  }
  return ids;
};

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
      throw new Error('GitHub Projects OAuth token file is invalid.');
    }
    return {value: value.trimEnd()};
  }
});

const createTelegramFileSecretsProvider = (
  identityRef: OpaqueSecretRef,
  botTokenRef: OpaqueSecretRef
): SecretsProvider => ({
  async resolve(reference, purpose) {
    const allowed = purpose === 'telegram.identity.keying'
      ? identityRef
      : purpose === 'telegram.bot.send'
        ? botTokenRef
        : undefined;
    if (
      allowed === undefined || reference.provider !== allowed.provider ||
      reference.reference !== allowed.reference || reference.scope.length !== allowed.scope.length ||
      reference.scope.some((value, index) => value !== allowed.scope[index])
    ) throw new Error('Secret reference is not allowed.');
    const value = await readFile(allowed.reference, 'utf8');
    if (value.length === 0 || value.length > 65_536 || value.includes('\0')) {
      throw new Error('Telegram secret file is invalid.');
    }
    return {value: value.trimEnd()};
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
const incomingEventProcessor = createPostgresIncomingEventProcessor(db);
const incomingEventConsumer = createIncomingEventQueueConsumer({
  processor: incomingEventProcessor
});
const healthcheckProducer = createPostgresHealthcheckProducer(db);
const recoveryScanProducer = createPostgresRecoveryScanProducer(db, boss);
const dailyPmReportProducer = createPostgresDailyPmReportProducer(db);
const pmReportCheckProducer = createPostgresPmReportCheckProducer(db);
const qaIntakeProducer = createPostgresQaIntakeProducer(db);
let telegramStatusResponder: Readonly<{prepare(eventId: string): Promise<'prepared' | 'skipped'>}> | undefined;
let telegramStatusPublisher: Readonly<{publishAvailable(): Promise<'published' | 'failed' | 'idle'>}> | undefined;
if (telegramStatusResponseEnabled) {
  if (process.env.TELEGRAM_INGRESS_ENABLED !== 'true') {
    throw new Error('Telegram ingress must be enabled for status responses.');
  }
  const identityFile = required('TELEGRAM_IDENTITY_SECRET_FILE');
  const botTokenFile = required('TELEGRAM_BOT_TOKEN_FILE');
  if (!isAbsolute(identityFile) || !isAbsolute(botTokenFile)) {
    throw new Error('Telegram secret file paths must be absolute.');
  }
  const identityRef: OpaqueSecretRef = {
    provider: 'file', reference: identityFile, scope: telegramIdentitySecretScope
  };
  const botTokenRef: OpaqueSecretRef = {
    provider: 'file', reference: botTokenFile, scope: telegramBotSecretScope
  };
  const adapter = createTelegramChatAdapter({
    identitySecretRef: identityRef,
    botTokenRef,
    allowedUserIds: requiredTelegramAllowlist('TELEGRAM_ALLOWED_USER_IDS'),
    allowedPrivateChatIds: requiredTelegramAllowlist('TELEGRAM_ALLOWED_PRIVATE_CHAT_IDS')
  }, createTelegramFileSecretsProvider(identityRef, botTokenRef));
  const telegramStatusProject = {
    workspaceId: requiredUuid('FCP_WORKSPACE_ID'),
    projectId: requiredUuid('TELEGRAM_PROJECT_ID')
  };
  telegramStatusResponder = createPostgresTelegramStatusResponseOutbox(db, telegramStatusProject);
  telegramStatusPublisher = createPostgresTelegramStatusPublisher(
    db,
    adapter,
    telegramStatusProject.projectId
  );
}
let statusPublisherTimer: NodeJS.Timeout | undefined;
let telegramStatusPublisherTimer: NodeJS.Timeout | undefined;
let publishTelegramStatusResponses: (() => Promise<void>) | undefined;

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
await configurePmReportCheckQueue(boss);
await configureQaIntakeQueue(boss);
await boss.work(INCOMING_EVENT_QUEUE, async ([job]) => {
  if (job === undefined) return;
  const result = await incomingEventConsumer.consume(job.data);
  if (telegramStatusResponder !== undefined && publishTelegramStatusResponses !== undefined) {
    await telegramStatusResponder.prepare(result.eventId);
    await publishTelegramStatusResponses();
  }
  return result;
});
await boss.work(HEALTHCHECK_QUEUE, async () => healthcheckProducer.run());
await boss.work(RECOVERY_SCAN_QUEUE, async () => recoveryScanProducer.run());
await boss.work(DAILY_PM_REPORT_QUEUE, async () => dailyPmReportProducer.run());
await boss.work(PM_REPORT_CHECK_QUEUE, async () => pmReportCheckProducer.run());
await boss.work(QA_INTAKE_QUEUE, async () => qaIntakeProducer.run());
await recoveryScanProducer.run();
if (telegramStatusPublisher !== undefined) {
  let publishing = false;
  publishTelegramStatusResponses = async (): Promise<void> => {
    if (publishing || stopping) return;
    publishing = true;
    try {
      for (let count = 0; count < 10; count += 1) {
        const result = await telegramStatusPublisher!.publishAvailable();
        if (result === 'idle') return;
      }
    } catch {
      console.error('telegram status response publish failed', {
        code: 'TELEGRAM_STATUS_RESPONSE_PUBLISH_FAILED'
      });
    } finally {
      publishing = false;
    }
  };
  await publishTelegramStatusResponses();
  telegramStatusPublisherTimer = setInterval(() => {
    void publishTelegramStatusResponses!();
  }, 1_000);
}
if (writebackEnabled) {
  const tokenPath = process.env.GITHUB_PROJECTS_OAUTH_TOKEN_FILE;
  if (tokenPath === undefined || !isAbsolute(tokenPath)) {
    throw new Error('GitHub status write-back configuration is invalid.');
  }
  const credentialRef: OpaqueSecretRef = {
    provider: 'file',
    reference: tokenPath,
    scope: githubProjectsOAuthScope
  };
  const publisher = createPostgresGitHubProjectStatusPublisher(
    db,
    createGitHubProjectStatusWriteAdapter({
      secretsProvider: createWritebackFileSecretsProvider(credentialRef)
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
  if (telegramStatusPublisherTimer !== undefined) clearInterval(telegramStatusPublisherTimer);
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
