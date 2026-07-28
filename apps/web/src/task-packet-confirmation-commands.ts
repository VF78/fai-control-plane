import {requireOperatorSession} from './operator-auth-runtime';
import {buildAgentRunQueuePolicyPreview} from './operator-data';
import {getTaskPacketConfirmationRuntime} from './task-packet-confirmation-runtime';

const MAX_BODY_BYTES = 4 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const noStore = {'Cache-Control': 'no-store'} as const;

type Runtime = Awaited<ReturnType<typeof getTaskPacketConfirmationRuntime>>;

export type TaskPacketConfirmationCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<Runtime>;
  isQueueEnabled(): boolean;
}>;

const dependencies: TaskPacketConfirmationCommandDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getTaskPacketConfirmationRuntime,
  isQueueEnabled: () =>
    process.env.RUNNER_ENABLED === 'true' &&
    process.env.LOCAL_RUNNER_TRANSPORT_ENABLED === 'true'
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const readBoundedJson = async (request: Request): Promise<unknown> => {
  const contentType = request.headers.get('content-type')?.toLowerCase();
  const contentLength = request.headers.get('content-length');
  if (
    contentType !== 'application/json' ||
    (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) ||
    request.body === null
  ) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
};

const parse = (value: unknown) => isRecord(value) &&
  exactKeys(value, ['_csrf', 'confirmedPacketHash', 'agentProfileId', 'actionHash']) &&
  typeof value._csrf === 'string' && value._csrf.length > 0 && value._csrf.length <= 128 &&
  typeof value.confirmedPacketHash === 'string' && SHA256_PATTERN.test(value.confirmedPacketHash) &&
  typeof value.agentProfileId === 'string' && UUID_PATTERN.test(value.agentProfileId) &&
  typeof value.actionHash === 'string' && SHA256_PATTERN.test(value.actionHash)
  ? {
    csrfToken: value._csrf,
    confirmedPacketHash: value.confirmedPacketHash,
    agentProfileId: value.agentProfileId,
    actionHash: value.actionHash
  }
  : null;

export async function confirmTaskPacketCommand(
  request: Request,
  packetId: string,
  overrides: TaskPacketConfirmationCommandDependencies = dependencies
): Promise<Response> {
  const body = await readBoundedJson(request);
  const input = parse(body);
  const authorization = await overrides.requireSession(request, {csrfToken: input?.csrfToken ?? null});
  if (!authorization.ok) return authorization.response;
  if (!UUID_PATTERN.test(packetId) || input === null) {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  if (!overrides.isQueueEnabled()) {
    return Response.json({status: 'runner_disabled'}, {status: 503, headers: noStore});
  }
  try {
    const runtime = await overrides.getRuntime();
    const packet = await runtime.load(
      authorization.runtime.config.workspaceId,
      packetId,
      input.agentProfileId
    );
    if (packet === null) return new Response(null, {status: 404, headers: noStore});
    if (packet.contentHash !== input.confirmedPacketHash) {
      return Response.json({status: 'packet_changed'}, {status: 409, headers: noStore});
    }
    const preview = buildAgentRunQueuePolicyPreview({
      ...packet,
      approverActorId: authorization.session.actorId
    });
    if (preview.actionHash !== input.actionHash) {
      return Response.json({status: 'action_changed'}, {status: 409, headers: noStore});
    }
    const result = await runtime.queue({
      ...packet,
      workspaceId: authorization.runtime.config.workspaceId,
      actorId: authorization.session.actorId
    });
    if (result.status === 'queued') return Response.json(result, {status: 201, headers: noStore});
    if (result.status === 'conflict') return Response.json({status: 'packet_changed'}, {status: 409, headers: noStore});
    return new Response(null, {status: result.status === 'forbidden' ? 403 : 503, headers: noStore});
  } catch {
    return new Response(null, {status: 503, headers: noStore});
  }
}
