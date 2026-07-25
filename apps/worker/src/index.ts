import {createServer} from 'node:http';
import {PgBoss} from 'pg-boss';
import {createIncomingEventQueueConsumer} from '@fai-control-plane/application';
import {
  createDatabase,
  createPostgresIncomingEventProcessor
} from '@fai-control-plane/db';
import {INCOMING_EVENT_QUEUE} from '@fai-control-plane/db/runtime';
import {
  startTelemetry,
  stopTelemetry
} from '@fai-control-plane/observability';

const databaseUrl = process.env.DATABASE_URL;
const port = Number.parseInt(process.env.PORT ?? '3001', 10);

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

let ready = false;
let stopping = false;

await startTelemetry('fai-control-plane-worker');

const boss = new PgBoss(databaseUrl);
boss.on('error', () => {
  console.error('pg-boss error', {code: 'PG_BOSS_ERROR'});
  ready = false;
});
const {db, pool} = createDatabase(databaseUrl);
const incomingEventConsumer = createIncomingEventQueueConsumer({
  processor: createPostgresIncomingEventProcessor(db)
});

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
await boss.createQueue(INCOMING_EVENT_QUEUE);
await boss.work(INCOMING_EVENT_QUEUE, async (job) =>
  incomingEventConsumer.consume(job.data)
);
ready = true;

async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;

  stopping = true;
  ready = false;
  console.info(`received ${signal}; shutting down`);

  server.close();
  await boss.stop({graceful: true, timeout: 30_000});
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
