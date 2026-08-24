import {createHash, randomBytes, sign} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {chmodSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {dirname} from 'node:path';

const socketPath = process.env.FCP_EXECUTOR_BROKER_SOCKET ?? '';
const privateKeyFile = process.env.FCP_EXECUTOR_ATTESTATION_PRIVATE_KEY_FILE ?? '';
const workdir = '/opt/data/work/project';
const codexHome = '/opt/data/codex-home';
const codex = '/usr/local/bin/codex';
const models = new Set(['gpt-5.6-terra', 'gpt-5.6-sol']);
const efforts = new Set(['medium', 'high']);
const bounded = (value, maximum) => typeof value === 'string' && value.length > 0 &&
  value.length <= maximum && !value.includes('\0');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const safe = (value) => String(value).replace(/[\0\r\n]/g, ' ').slice(0, 240) || 'Executor invocation failed';
const response = (status, code, message) => ({status, code, message: safe(message)});

if (!socketPath.startsWith('/') || !privateKeyFile.startsWith('/')) throw new Error('executor_broker_configuration_invalid');
const privateKey = readFileSync(privateKeyFile, 'utf8');
if (privateKey.length < 100 || privateKey.length > 8_192) throw new Error('executor_attestation_key_invalid');

const execute = (payload) => new Promise((resolve) => {
  const receiptReference = payload?.receiptReference;
  const executorId = payload?.executorId;
  const model = payload?.model;
  const effort = payload?.effort;
  const prompt = payload?.prompt;
  if (typeof receiptReference !== 'string' || !/^browser:[a-f0-9]{64}$/.test(receiptReference) ||
    executorId !== 'codex-cli' || !models.has(model) || !efforts.has(effort) || !bounded(prompt, 32_000)) {
    resolve(response('blocked', 'route_invalid', 'Executor route is outside the project policy'));
    return;
  }
  const invocationId = randomBytes(32).toString('hex');
  const outputFile = `/tmp/fai-executor-${invocationId}.txt`;
  const args = ['exec', '--strict-config', '--ignore-user-config', '--model', model,
    '--config', `model_reasoning_effort="${effort}"`, '--sandbox', 'workspace-write',
    '--color', 'never', '--output-last-message', outputFile, '--cd', workdir, prompt];
  const child = spawn(codex, args, {cwd: workdir, env: {
    HOME: '/opt/data', CODEX_HOME: codexHome, PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0'
  }, stdio: ['ignore', 'ignore', 'pipe']});
  let settled = false; let timer;
  const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); rmSync(outputFile, {force: true}); resolve(value); } };
  child.stderr.on('data', () => undefined);
  child.on('error', (error) => finish(response('retry', 'executor_unavailable', error.message)));
  child.on('close', (code) => {
    if (code !== 0) { finish(response('blocked', 'executor_failed', `Codex exited ${code ?? 'unknown'}`)); return; }
    let output;
    try { output = readFileSync(outputFile, 'utf8'); } catch { finish(response('blocked', 'result_missing', 'Codex result is missing')); return; }
    if (!bounded(output, 65_536)) { finish(response('blocked', 'result_invalid', 'Codex result is outside bounds')); return; }
    const completedAt = new Date().toISOString();
    const unsigned = {contract: 'fai.executor-invocation-receipt.v1', invocationId, receiptReference,
      executorId, model, effort, outputSha256: createHash('sha256').update(output).digest('hex'), completedAt};
    const canonical = [unsigned.contract, unsigned.invocationId, unsigned.receiptReference, unsigned.executorId,
      unsigned.model, unsigned.effort, unsigned.outputSha256, unsigned.completedAt].join('\n');
    const signature = sign(null, Buffer.from(canonical), privateKey).toString('base64');
    finish({status: 'completed', output, executorReceipt: {...unsigned, signature}});
  });
  timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    finish(response('blocked', 'executor_timeout', 'Codex invocation exceeded 45 minutes')); }, 45 * 60_000);
});

mkdirSync(dirname(socketPath), {recursive: true, mode: 0o700});
rmSync(socketPath, {force: true});
const server = createServer((request, reply) => {
  if (request.method !== 'POST' || request.url !== '/') { reply.writeHead(405).end(); return; }
  const chunks = []; let size = 0;
  request.on('data', (chunk) => { size += chunk.length; if (size <= 40_000) chunks.push(chunk); });
  request.on('end', async () => {
    try {
      if (size === 0 || size > 40_000) throw new Error('request_invalid');
      const envelope = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const result = envelope?.operation === 'execute' ? await execute(object(envelope.payload))
        : response('blocked', 'operation_denied', 'Executor operation is not allowed');
      reply.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'}).end(JSON.stringify(result));
    } catch { reply.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify(response('blocked', 'request_invalid', 'Executor request is invalid'))); }
  });
});
server.listen(socketPath, () => chmodSync(socketPath, 0o660));
