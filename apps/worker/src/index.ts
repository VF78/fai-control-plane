import {createServer} from 'node:http';
import {createWorker} from './mvp/runtime.ts';
import {exclusiveRunner, workerReady} from './mvp/jobs.ts';

const worker = createWorker();
let stopping = false;
let lastReconcileAt: string | null = null; let lastRetryAt: string | null = null; let lastErrorAt: string | null = null;
let lastAgentDeliveryAt: string | null = null; let lastAgentErrorAt: string | null = null;
const run = exclusiveRunner(async () => {
  if (stopping) return;
    try {
      await worker.reconcile(); lastReconcileAt = new Date().toISOString();
      const delivery = await worker.retry(); lastRetryAt = new Date().toISOString();
      if (delivery.agentDelivered > 0) lastAgentDeliveryAt = lastRetryAt;
      if (delivery.agentRetried > 0) lastAgentErrorAt = lastRetryAt;
    } catch (error) {
      lastErrorAt = new Date().toISOString();
      process.stderr.write(`${error instanceof Error ? error.message : 'worker_cycle_failed'}\n`);
    }
});
await run();
const interval = setInterval(() => void run(), 30_000);
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, {'content-type': 'application/json'}).end('{"status":"ok"}');
  } else if (request.url === '/ready') {
    const state = workerReady({lastReconcileAt,lastRetryAt,lastErrorAt,lastAgentDeliveryAt,lastAgentErrorAt});
    response.writeHead(state.ready ? 200 : 503, {'content-type': 'application/json'}).end(JSON.stringify({
      status: state.ready ? 'ready' : 'not_ready', checks: state.checks,
      lastReconcileAt,lastRetryAt,lastErrorAt,lastAgentDeliveryAt,lastAgentErrorAt}));
  } else response.writeHead(404).end();
});
server.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true; clearInterval(interval); server.close(); await worker.close();
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
