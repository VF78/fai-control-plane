import {createServer} from 'node:http';
import {createWorker} from './mvp/runtime.ts';
import {exclusiveRunner, workerActive, workerRetryIntervalMs, workerTrackerPollIntervalMs, workerReady} from './mvp/jobs.ts';

const active = workerActive(process.env.FCP_WORKER_ACTIVE);
const worker = active ? createWorker() : null;
let stopping = false;
let lastReconcileAt: string | null = null; let lastRetryAt: string | null = null; let lastErrorAt: string | null = null;
const reconcile = exclusiveRunner(async () => {
  if (stopping) return;
  try {
    await worker!.reconcile(); lastReconcileAt = new Date().toISOString();
  } catch (error) {
    lastErrorAt = new Date().toISOString();
    process.stderr.write(`${error instanceof Error ? error.message : 'worker_reconcile_failed'}\n`);
  }
});
const retry = exclusiveRunner(async () => {
  if (stopping) return;
  try {
    await worker!.retry(); lastRetryAt = new Date().toISOString();
  } catch (error) {
    lastErrorAt = new Date().toISOString();
    process.stderr.write(`${error instanceof Error ? error.message : 'worker_retry_failed'}\n`);
  }
});
if (active) await Promise.all([reconcile(), retry()]);
const reconcileInterval = active ? setInterval(() => void reconcile(), workerTrackerPollIntervalMs) : null;
const retryInterval = active ? setInterval(() => void retry(), workerRetryIntervalMs) : null;
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, {'content-type': 'application/json'}).end('{"status":"ok"}');
  } else if (request.url === '/ready') {
    const state = workerReady({lastReconcileAt,lastRetryAt,lastErrorAt});
    response.writeHead(state.ready ? 200 : 503, {'content-type': 'application/json'}).end(JSON.stringify({
      status: state.ready ? 'ready' : 'not_ready', active, checks: state.checks,
      lastReconcileAt,lastRetryAt,lastErrorAt}));
  } else response.writeHead(404).end();
});
server.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  if (reconcileInterval !== null) clearInterval(reconcileInterval);
  if (retryInterval !== null) clearInterval(retryInterval);
  server.close(); await worker?.close();
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
