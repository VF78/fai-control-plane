import {randomUUID} from 'node:crypto';
import {
  PROJECT_EXECUTION_COMPLETE_COMMAND, PROJECT_RELEASE_NOT_REQUIRED_COMMAND,
  PROJECT_UAT_PREPARE_COMMAND, PROJECT_UAT_RECORD_RESULT_COMMAND, PROJECT_UAT_SIGNOFF_COMMAND
} from '@fai-control-plane/application';
import {requireOperatorSession} from './operator-auth-runtime';
import {getDeliveryRuntime} from './delivery-runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'};
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const invalid = (status: string, code = 400) => Response.json({status}, {status: code, headers: noStore});
const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json' || request.body === null) return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65_536)) {
    await request.body.cancel().catch(() => undefined); return null;
  }
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.byteLength;
      if (total > 65_536) { await reader.cancel().catch(() => undefined); return null; } chunks.push(chunk.value); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; } finally { reader.releaseLock(); }
};

export type ProjectAcceptanceCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession; getRuntime: typeof getDeliveryRuntime; nextId(): string; now(): Date;
}>;
const dependencies: ProjectAcceptanceCommandDependencies = {requireSession: requireOperatorSession,
  getRuntime: getDeliveryRuntime, nextId: randomUUID, now: () => new Date()};

export async function projectAcceptanceCommand(request: Request,
  overrides: ProjectAcceptanceCommandDependencies = dependencies): Promise<Response> {
  const body = await readBody(request);
  if (body === null || typeof body._csrf !== 'string' || typeof body.action !== 'string' ||
    typeof body.projectId !== 'string' || !UUID.test(body.projectId) || typeof body.protocolId !== 'string' ||
    !UUID.test(body.protocolId)) return invalid('invalid_request');
  const action = body.action;
  const shape = action === 'prepare' ? exact(body, ['_csrf', 'action', 'projectId', 'protocolId',
    'expectedExecutionVersion', 'requiredSmokeChecks', 'requiredDeploymentEnvironment']) &&
      Number.isSafeInteger(body.expectedExecutionVersion) && Array.isArray(body.requiredSmokeChecks) &&
      ['staging', 'production'].includes(body.requiredDeploymentEnvironment as string)
    : action === 'record_result' ? exact(body, ['_csrf', 'action', 'projectId', 'protocolId', 'resultId',
      'expectedVersion', 'outcome', 'checks']) && typeof body.resultId === 'string' && UUID.test(body.resultId) &&
      Number.isSafeInteger(body.expectedVersion) && ['passed', 'failed'].includes(body.outcome as string) && Array.isArray(body.checks)
    : action === 'signoff' ? exact(body, ['_csrf', 'action', 'projectId', 'protocolId', 'resultId',
      'expectedVersion', 'kind', 'evidenceReference']) && typeof body.resultId === 'string' && UUID.test(body.resultId) &&
      Number.isSafeInteger(body.expectedVersion) && ['product_owner', 'client_representative'].includes(body.kind as string) &&
      typeof body.evidenceReference === 'string'
    : action === 'waive_release' ? exact(body, ['_csrf', 'action', 'projectId', 'protocolId',
      'expectedVersion', 'reason']) && Number.isSafeInteger(body.expectedVersion) && typeof body.reason === 'string'
    : action === 'complete' ? exact(body, ['_csrf', 'action', 'projectId', 'protocolId',
      'expectedVersion', 'expectedExecutionVersion']) && Number.isSafeInteger(body.expectedVersion) &&
      Number.isSafeInteger(body.expectedExecutionVersion) : false;
  if (!shape) return invalid('invalid_request');
  const authorization = await overrides.requireSession(request, {csrfToken: body._csrf});
  if (!authorization.ok) return authorization.response;
  try {
    const runtime = await overrides.getRuntime(); const actor = await runtime.actor(
      authorization.runtime.config.workspaceId, authorization.session.actorId);
    if (!actor.ok) return invalid('forbidden', 403);
    const base = {commandId: overrides.nextId(), workspaceId: authorization.runtime.config.workspaceId,
      correlationId: overrides.nextId(), issuedAt: overrides.now().toISOString(), actor: actor.value};
    const actorId = actor.value.actorId; let command;
    if (action === 'prepare') command = {...base, type: PROJECT_UAT_PREPARE_COMMAND,
      idempotencyKey: `project-uat-prepare:v1:${body.projectId}:${body.expectedExecutionVersion}:${actorId}`,
      payload: {projectId: body.projectId, protocolId: body.protocolId,
        expectedExecutionVersion: body.expectedExecutionVersion, requiredSmokeChecks: body.requiredSmokeChecks,
        requiredDeploymentEnvironment: body.requiredDeploymentEnvironment}};
    else if (action === 'record_result') command = {...base, type: PROJECT_UAT_RECORD_RESULT_COMMAND,
      idempotencyKey: `project-uat-result:v1:${body.protocolId}:${body.expectedVersion}:${actorId}`,
      payload: {projectId: body.projectId, protocolId: body.protocolId, resultId: body.resultId,
        expectedVersion: body.expectedVersion, outcome: body.outcome, checks: body.checks}};
    else if (action === 'signoff') command = {...base, type: PROJECT_UAT_SIGNOFF_COMMAND,
      idempotencyKey: `project-uat-signoff:v1:${body.kind}:${body.resultId}:${body.expectedVersion}:${actorId}`,
      payload: {projectId: body.projectId, protocolId: body.protocolId, resultId: body.resultId,
        expectedVersion: body.expectedVersion, kind: body.kind, evidenceReference: body.evidenceReference}};
    else if (action === 'waive_release') command = {...base, type: PROJECT_RELEASE_NOT_REQUIRED_COMMAND,
      idempotencyKey: `project-release-not-required:v1:${body.protocolId}:${body.expectedVersion}:${actorId}`,
      payload: {projectId: body.projectId, protocolId: body.protocolId,
        expectedVersion: body.expectedVersion, reason: body.reason}};
    else command = {...base, type: PROJECT_EXECUTION_COMPLETE_COMMAND,
      idempotencyKey: `project-execution-complete:v1:${body.projectId}:${body.expectedExecutionVersion}:${body.expectedVersion}:${actorId}`,
      payload: {projectId: body.projectId, protocolId: body.protocolId, expectedVersion: body.expectedVersion,
        expectedExecutionVersion: body.expectedExecutionVersion}};
    const result = await runtime.projectAcceptance.execute(command as never);
    if (!('receipt' in result)) { const status = result.error.code === 'CAPABILITY_DENIED' || result.error.code === 'POLICY_DENIED' ? 403
      : result.error.code === 'NOT_FOUND' ? 404 : result.error.code === 'VERSION_CONFLICT' ||
        result.error.code === 'INVALID_TRANSITION' || result.error.code === 'IDEMPOTENCY_KEY_REUSED' ? 409 : 422;
      return Response.json({status: result.error.code.toLowerCase(), message: result.error.message}, {status, headers: noStore}); }
    if (!result.receipt.result.ok) { const error = result.receipt.result.error;
      const status = error.code === 'CAPABILITY_DENIED' || error.code === 'POLICY_DENIED' ? 403
        : error.code === 'NOT_FOUND' ? 404 : error.code === 'VERSION_CONFLICT' || error.code === 'INVALID_TRANSITION' ? 409 : 422;
      return Response.json({status: error.code.toLowerCase(), message: error.message}, {status, headers: noStore}); }
    return Response.json({receipt: {commandId: result.receipt.commandId, commandType: result.receipt.commandType},
      acceptance: result.receipt.result.value}, {headers: noStore});
  } catch { return invalid('unavailable', 503); }
}
