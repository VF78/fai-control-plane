import {randomUUID} from 'node:crypto';
import {PROJECT_OUTCOME_ACCEPTANCE_COMMAND} from '@fai-control-plane/application';
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
    const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; } finally { reader.releaseLock(); }
};

export type ProjectOutcomeAcceptanceDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime: typeof getDeliveryRuntime;
  nextId(): string;
  now(): Date;
}>;

const dependencies: ProjectOutcomeAcceptanceDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getDeliveryRuntime,
  nextId: randomUUID,
  now: () => new Date()
};

export async function projectOutcomeAcceptanceCommand(
  request: Request,
  overrides: ProjectOutcomeAcceptanceDependencies = dependencies
): Promise<Response> {
  const body = await boundedBody(request);
  const csrfToken = body !== null && typeof body._csrf === 'string' ? body._csrf : null;
  const authorization = await overrides.requireSession(request, {csrfToken});
  if (!authorization.ok) return authorization.response;
  if (body === null || !exact(body, ['_csrf', 'projectId', 'baselineId', 'outcomeId',
    'expectedExecutionVersion']) || typeof body._csrf !== 'string' ||
    typeof body.projectId !== 'string' || !UUID.test(body.projectId) ||
    typeof body.baselineId !== 'string' || !UUID.test(body.baselineId) ||
    typeof body.outcomeId !== 'string' || !UUID.test(body.outcomeId) ||
    !Number.isSafeInteger(body.expectedExecutionVersion) ||
    (body.expectedExecutionVersion as number) < 1) {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  try {
    const runtime = await overrides.getRuntime();
    const actor = await runtime.actor(
      authorization.runtime.config.workspaceId,
      authorization.session.actorId
    );
    if (!actor.ok) return Response.json({status: 'forbidden'}, {status: 403, headers: noStore});
    const result = await runtime.projectOutcomeAcceptance.execute({
      commandId: overrides.nextId(),
      workspaceId: authorization.runtime.config.workspaceId,
      correlationId: overrides.nextId(),
      idempotencyKey: `project-outcome-accept:v1:${body.outcomeId}:${body.expectedExecutionVersion}:${actor.value.actorId}`,
      issuedAt: overrides.now().toISOString(),
      actor: actor.value,
      type: PROJECT_OUTCOME_ACCEPTANCE_COMMAND,
      payload: {
        projectId: body.projectId,
        baselineId: body.baselineId,
        outcomeId: body.outcomeId,
        expectedExecutionVersion: body.expectedExecutionVersion as number
      }
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
      const error = result.receipt.result.error;
      const status = error.code === 'CAPABILITY_DENIED' || error.code === 'POLICY_DENIED' ? 403
        : error.code === 'NOT_FOUND' ? 404
          : error.code === 'VERSION_CONFLICT' || error.code === 'INVALID_TRANSITION' ? 409 : 422;
      return Response.json({status: error.code.toLowerCase(), message: error.message},
        {status, headers: noStore});
    }
    return Response.json({
      receipt: {commandId: result.receipt.commandId, commandType: result.receipt.commandType},
      acceptance: result.receipt.result.value
    }, {headers: noStore});
  } catch {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
}
