import net from 'node:net';
import path from 'node:path';
import {canonicalJson, type CanonicalJson, type HermesCodexWorkOrder} from '@fai-control-plane/domain';
import type {LocalAgentRunEnvelope, LocalAgentRunOrchestrator, LocalAgentRunResult} from './agent-run-orchestrator';
import type {HermesDirectivePlanner} from './hermes-codex-runtime';

const MAX_FRAME = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const fail = (code: string): never => { throw new Error(`hermes_executor_transport_${code}`); };
const absoluteSocket = (value: string): string => path.isAbsolute(value) && path.normalize(value) === value &&
  path.resolve(value) === value && value !== path.parse(value).root ? value : fail('socket_path');

const exchange = (socketPath: string, body: string, timeoutMs: number): Promise<string> => new Promise((resolve, reject) => {
  const payload = Buffer.from(body, 'utf8');
  if (payload.byteLength === 0 || payload.byteLength > MAX_FRAME) return reject(new Error('hermes_executor_transport_frame_size'));
  const socket = net.createConnection({path: absoluteSocket(socketPath)});
  const chunks: Buffer[] = []; let observed = 0; let expected: number | undefined; let settled = false;
  const timer = setTimeout(() => socket.destroy(new Error('hermes_executor_transport_timeout')), timeoutMs);
  const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
    if (error) reject(error); };
  socket.once('connect', () => { const header = Buffer.alloc(4); header.writeUInt32BE(payload.byteLength);
    socket.write(Buffer.concat([header, payload])); });
  socket.on('data', (chunk: Buffer) => {
    observed += chunk.byteLength; if (observed > MAX_FRAME + 4) return finish(new Error('hermes_executor_transport_output_limit'));
    chunks.push(chunk); const all = Buffer.concat(chunks);
    if (expected === undefined && all.byteLength >= 4) { expected = all.readUInt32BE(0); if (expected < 1 || expected > MAX_FRAME) return finish(new Error('hermes_executor_transport_frame_size')); }
    if (expected !== undefined && all.byteLength === expected + 4) { settled = true; clearTimeout(timer); socket.destroy(); resolve(all.subarray(4).toString('utf8')); }
    else if (expected !== undefined && all.byteLength > expected + 4) finish(new Error('hermes_executor_transport_trailing_bytes'));
  });
  socket.once('error', (error) => finish(error));
  socket.once('close', () => { if (!settled) finish(new Error('hermes_executor_transport_truncated')); });
});

export interface HermesExecutorTransport extends LocalAgentRunOrchestrator {preflight(): Promise<void>}
export const createHermesExecutorTransport = (options: Readonly<{socketPath: string; expectedConfigSha256: string;
  planner: HermesDirectivePlanner; timeoutMs?: number}>): HermesExecutorTransport => ({
  async preflight() {
    const request = canonicalJson({schemaVersion: 1, operation: 'preflight',
      expectedConfigSha256: options.expectedConfigSha256});
    const parsed = JSON.parse(await exchange(options.socketPath, request, 30_000)) as Record<string, unknown>;
    if (Object.keys(parsed).length !== 2 || parsed.status !== 'ready' || parsed.schemaVersion !== 1) fail('preflight');
  },
  async run(envelope: LocalAgentRunEnvelope): Promise<LocalAgentRunResult> {
    if (!UUID.test(envelope.runId) || !SHA256.test(options.expectedConfigSha256) ||
      envelope.workOrder === undefined || envelope.workOrderHash === undefined) fail('binding');
    const workOrder = envelope.workOrder as HermesCodexWorkOrder;
    const workOrderHash = envelope.workOrderHash as string;
    const plan = await options.planner.plan({runId: envelope.runId, packetId: envelope.packetId,
      packetHash: envelope.packetHash, timeboxMinutes: envelope.timeboxMinutes,
      workOrder, workOrderHash,
      ...(envelope.signal === undefined ? {} : {signal: envelope.signal})});
    if (plan.hermesConfigHash !== options.expectedConfigSha256) fail('planner_drift');
    const request = canonicalJson({schemaVersion: 1, runId: envelope.runId, packetId: envelope.packetId,
      packetHash: envelope.packetHash, baseCommit: envelope.baseCommit, profile: envelope.profile,
      timeboxMinutes: envelope.timeboxMinutes, workOrderHash,
      workOrder, hermesVersion: plan.hermesVersion,
      hermesConfigHash: plan.hermesConfigHash, directive: plan.directive} as unknown as CanonicalJson);
    let parsed: unknown; try { parsed = JSON.parse(await exchange(options.socketPath, request, options.timeoutMs ?? 180_000)); }
    catch { return fail('executor_response'); }
    const result = parsed as LocalAgentRunResult;
    if (typeof result !== 'object' || result === null || result.receipt?.runId !== envelope.runId ||
      result.receipt?.packetId !== envelope.packetId || result.receipt?.packetHash !== envelope.packetHash ||
      result.receipt?.executionMetadata?.workOrderHash !== workOrderHash ||
      result.receipt?.executionMetadata?.directiveHash === undefined) fail('executor_identity');
    return result;
  }
});
