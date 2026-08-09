import {authorize} from '@fai-control-plane/domain';
import {requireOperatorSession} from './operator-auth-runtime';
import {getDeliveryRuntime} from './delivery-runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'};
const policyRequest = {actionCategory: 'write', surface: 'control_plane', environment: 'development'} as const;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const invalid = (status: string, code = 400, message?: string) => Response.json(
  {status, ...(message === undefined ? {} : {message})}, {status: code, headers: noStore}
);
const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json' || request.body === null) return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2_048)) {
    await request.body.cancel().catch(() => undefined); return null;
  }
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > 2_048) { await reader.cancel().catch(() => undefined); return null; }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; } finally { reader.releaseLock(); }
};

export type ProjectExecutionDispatchCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime: typeof getDeliveryRuntime;
}>;
const dependencies: ProjectExecutionDispatchCommandDependencies = {
  requireSession: requireOperatorSession, getRuntime: getDeliveryRuntime
};

export async function projectExecutionDispatchCommand(
  request: Request,
  overrides: ProjectExecutionDispatchCommandDependencies = dependencies
): Promise<Response> {
  const body = await readBody(request);
  if (body === null || !exact(body, ['_csrf', 'projectId', 'executionVersion']) ||
    typeof body._csrf !== 'string' || body._csrf.length < 1 || body._csrf.length > 128 ||
    typeof body.projectId !== 'string' || !UUID.test(body.projectId) ||
    !Number.isSafeInteger(body.executionVersion) || (body.executionVersion as number) < 1) {
    return invalid('invalid_request');
  }
  const auth = await overrides.requireSession(request, {csrfToken: body._csrf});
  if (!auth.ok) return auth.response;
  try {
    const runtime = await overrides.getRuntime();
    const actor = await runtime.actor(auth.runtime.config.workspaceId, auth.session.actorId);
    if (!actor.ok || actor.value.actorType !== 'human') return invalid('forbidden', 403);
    const capability = authorize(actor.value, policyRequest);
    if (!capability.ok) return invalid(capability.error.code.toLowerCase(), 403, capability.error.message);
    const executionVersion = body.executionVersion as number;
    const dispatch = await runtime.projectExecutionDispatch.run({workspaceId: auth.runtime.config.workspaceId,
      projectId: body.projectId,
      expectedVersion: executionVersion, requestedByActorId: actor.value.actorId});
    if (dispatch.denied === 1) {
      return Response.json({status: 'capability_denied',
        message: 'Только владелец проекта или delivery-администратор может подготовить запуск.'},
      {status: 403, headers: noStore});
    }
    const execution = await runtime.projectExecutionProjection(auth.runtime.config.workspaceId, body.projectId);
    const currentDispatch = execution.version === executionVersion ? execution.dispatch : null;
    if (dispatch.dispatched === 1 || dispatch.replayed === 1 && currentDispatch !== null) {
      return Response.json({activation: dispatch.dispatched === 1 ? 'queued' : 'replayed',
        receipt: {commandType: 'project_execution.dispatch.v1'}, execution}, {headers: noStore});
    }
    if (dispatch.blocked === 1 && execution.blockReason === 'active_agent_run_exists') {
      return Response.json({status: 'invalid_transition',
        message: 'У этой работы уже есть активный AgentRun.',
        receipt: {commandType: 'project_execution.dispatch.v1'}, execution}, {status: 409, headers: noStore});
    }
    if (dispatch.blocked === 1 && execution.blockReason !== 'selection_preconditions_stale') {
      return Response.json({status: 'policy_denied',
        message: 'Текущий фактический выбор нельзя передать агенту.',
        receipt: {commandType: 'project_execution.dispatch.v1'}, execution}, {status: 403, headers: noStore});
    }
    if (execution.version !== executionVersion || execution.blockReason === 'selection_preconditions_stale') {
      return Response.json({status: 'version_conflict', message: 'Факты выбора изменились. Обновите проект.', execution},
        {status: 409, headers: noStore});
    }
    if (execution.status === 'paused') {
      return Response.json({status: 'project_execution_paused', message: 'Исполнение проекта поставлено на паузу.', execution},
        {status: 409, headers: noStore});
    }
    return Response.json({status: 'policy_denied',
      message: 'Текущий фактический выбор нельзя передать агенту.', execution}, {status: 403, headers: noStore});
  } catch { return invalid('unavailable', 503); }
}
