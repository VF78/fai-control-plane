import {createServer} from 'node:http';
import {createDatabase} from '@fai-control-plane/db';
import {createWorker} from './mvp/runtime.ts';
import {projectRuntimeSetupCommand} from './mvp/project-runtime-setup.ts';
import {exclusiveRunner, workerActive, workerAgentObserveIntervalMs, workerRetryIntervalMs,
  workerTrackerPollIntervalMs, workerReady} from './mvp/jobs.ts';

const active = workerActive(process.env.FCP_WORKER_ACTIVE);
const database = createDatabase();
const worker = active ? createWorker(database) : null;
let stopping = false;
let lastReconcileAt: string | null = null; let lastObserveAt: string | null = null;
let lastRetryAt: string | null = null; let lastErrorAt: string | null = null;
const reconcile = exclusiveRunner(async () => {
  if (stopping) return;
  try {
    await worker!.reconcile(); lastReconcileAt = new Date().toISOString();
  } catch (error) {
    lastErrorAt = new Date().toISOString();
    process.stderr.write(`${error instanceof Error ? error.message : 'worker_reconcile_failed'}\n`);
  }
});
const observe = exclusiveRunner(async () => {
  if (stopping) return;
  try {
    await worker!.observe(); lastObserveAt = new Date().toISOString();
  } catch (error) {
    lastErrorAt = new Date().toISOString();
    process.stderr.write(`${error instanceof Error ? error.message : 'worker_observe_failed'}\n`);
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
if (active) await Promise.all([reconcile(), observe(), retry()]);
const reconcileInterval = active ? setInterval(() => void reconcile(), workerTrackerPollIntervalMs) : null;
const observeInterval = active ? setInterval(() => void observe(), workerAgentObserveIntervalMs) : null;
const retryInterval = active ? setInterval(() => void retry(), workerRetryIntervalMs) : null;
const server = createServer((request, response) => {
  const runtimeMatch=/^\/project-runtime\/([0-9a-f-]{36})$/.exec(request.url??'');
  if(runtimeMatch!==null){if(!active){response.writeHead(503,{'content-type':'application/json'}).end('{"error":"project_runtime_unavailable"}');return;}
    const chunks:Buffer[]=[];request.on('data',(chunk)=>{if(chunks.reduce((size,value)=>size+value.length,0)<8_193)chunks.push(Buffer.from(chunk));});
    request.on('end',()=>{const webRequest=new Request(`http://worker:3001${request.url}`,{method:request.method??'GET',
      headers:{'content-type':request.headers['content-type']??'',cookie:request.headers.cookie??''},
      ...(request.method==='POST'?{body:Buffer.concat(chunks)}:{})});void projectRuntimeSetupCommand(database,webRequest,runtimeMatch[1]!).then(async(result)=>{
        response.writeHead(result.status,{'content-type':'application/json','cache-control':'no-store'}).end(await result.text());
      }).catch(()=>response.writeHead(500,{'content-type':'application/json'}).end('{"error":"request_failed"}'));});return;}
  if (request.url === '/health') {
    response.writeHead(200, {'content-type': 'application/json'}).end('{"status":"ok"}');
  } else if (request.url === '/ready') {
    const state = workerReady({lastReconcileAt,lastObserveAt,lastRetryAt,lastErrorAt});
    response.writeHead(state.ready ? 200 : 503, {'content-type': 'application/json'}).end(JSON.stringify({
      status: state.ready ? 'ready' : 'not_ready', active, checks: state.checks,
      lastReconcileAt,lastObserveAt,lastRetryAt,lastErrorAt}));
  } else response.writeHead(404).end();
});
server.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  if (reconcileInterval !== null) clearInterval(reconcileInterval);
  if (observeInterval !== null) clearInterval(observeInterval);
  if (retryInterval !== null) clearInterval(retryInterval);
  server.close(); if(worker!==null)await worker.close();else await database.end();
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
