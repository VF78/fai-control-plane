import {randomUUID} from 'node:crypto';
import {AGENT_RUN_RETRY_CONTINUATION_COMMAND} from '@fai-control-plane/application';
import {requireOperatorSession} from './operator-auth-runtime';
import {getDeliveryRuntime} from './delivery-runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'} as const;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const boundedBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json' || request.body === null) return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2_048)) {
    await request.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > 2_048) { await reader.cancel().catch(() => undefined); return null; }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; } finally { reader.releaseLock(); }
};

export type RetryContinuationDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime: typeof getDeliveryRuntime;
  nextId(): string;
  now(): Date;
}>;
const dependencies: RetryContinuationDependencies = {
  requireSession: requireOperatorSession, getRuntime: getDeliveryRuntime,
  nextId: randomUUID, now: () => new Date()
};

export async function agentRunRetryContinuationCommand(
  request: Request,
  overrides: RetryContinuationDependencies = dependencies
): Promise<Response> {
  const body = await boundedBody(request);
  const csrfToken = body !== null && typeof body._csrf === 'string' ? body._csrf : null;
  const auth = await overrides.requireSession(request, {csrfToken});
  if (!auth.ok) return auth.response;
  if (body === null || !exact(body, ['_csrf', 'projectId', 'failedRunId', 'retryRunId',
    'expectedExecutionVersion']) ||
    typeof body._csrf !== 'string' || typeof body.projectId !== 'string' || !UUID.test(body.projectId) ||
    typeof body.failedRunId !== 'string' || !UUID.test(body.failedRunId) ||
    typeof body.retryRunId !== 'string' || !UUID.test(body.retryRunId) || body.failedRunId === body.retryRunId ||
    !Number.isSafeInteger(body.expectedExecutionVersion) || (body.expectedExecutionVersion as number) < 1) {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  try {
    const runtime = await overrides.getRuntime();
    const actor = await runtime.actor(auth.runtime.config.workspaceId, auth.session.actorId);
    if (!actor.ok) return Response.json({status: 'forbidden'}, {status: 403, headers: noStore});
    const result = await runtime.agentRunRetryContinuation.execute({
      commandId: overrides.nextId(), workspaceId: auth.runtime.config.workspaceId,
      correlationId: overrides.nextId(),
      idempotencyKey: `agent-run-retry-continuation:v1:${body.failedRunId}:${body.retryRunId}:${actor.value.actorId}`,
      issuedAt: overrides.now().toISOString(), actor: actor.value,
      type: AGENT_RUN_RETRY_CONTINUATION_COMMAND,
      payload: {projectId: body.projectId, failedRunId: body.failedRunId,
        retryRunId: body.retryRunId, expectedExecutionVersion: body.expectedExecutionVersion as number}
    });
    if (!('receipt' in result)) {
      const status = result.error.code === 'CAPABILITY_DENIED' || result.error.code === 'POLICY_DENIED' ? 403
        : result.error.code === 'NOT_FOUND' ? 404
          : result.error.code === 'VERSION_CONFLICT' || result.error.code === 'INVALID_TRANSITION' ||
            result.error.code === 'IDEMPOTENCY_KEY_REUSED' ? 409 : 422;
      return Response.json({status: result.error.code.toLowerCase(), message: result.error.message},
        {status, headers: noStore});
    }
    if (!result.receipt.result.ok) {
      const {error} = result.receipt.result;
      const status = error.code === 'CAPABILITY_DENIED' || error.code === 'POLICY_DENIED' ? 403
        : error.code === 'NOT_FOUND' ? 404 : error.code === 'VERSION_CONFLICT' ||
          error.code === 'INVALID_TRANSITION' ? 409 : 422;
      return Response.json({status: error.code.toLowerCase(), message: error.message}, {status, headers: noStore});
    }
    return Response.json({receipt: {commandId: result.receipt.commandId,
      commandType: result.receipt.commandType}, retry: result.receipt.result.value}, {headers: noStore});
  } catch { return Response.json({status: 'unavailable'}, {status: 503, headers: noStore}); }
}
