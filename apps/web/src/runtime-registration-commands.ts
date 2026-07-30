import {requireOperatorSession} from './operator-auth-runtime';
import {
  getRuntimeRegistrationRuntime,
  type RuntimeRegistrationRuntime
} from './runtime-registration-runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 2 * 1024;
const noStore = {'Cache-Control': 'no-store'} as const;

export type RuntimeRegistrationCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<RuntimeRegistrationRuntime>;
}>;

const dependencies: RuntimeRegistrationCommandDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getRuntimeRegistrationRuntime
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const csrf = (value: unknown): string | null =>
  isRecord(value) && typeof value._csrf === 'string' &&
  value._csrf.length > 0 && value._csrf.length <= 128
    ? value._csrf
    : null;
const boundedJson = async (request: Request): Promise<unknown> => {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json' || request.body === null) {
    return null;
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return null;
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};
const response = (status: string, message: string, code: number): Response =>
  Response.json({status, message}, {status: code, headers: noStore});

export async function runtimeRegistrationStateCommand(
  request: Request,
  registrationId: string,
  overrides: RuntimeRegistrationCommandDependencies = dependencies
): Promise<Response> {
  const body = await boundedJson(request);
  const authorization = await overrides.requireSession(request, {csrfToken: csrf(body)});
  if (!authorization.ok) return authorization.response;
  if (
    !UUID.test(registrationId) ||
    !isRecord(body) ||
    !exact(body, ['_csrf', 'action', 'agentId', 'expectedVersion', 'projectId']) ||
    (body.action !== 'enable' && body.action !== 'disable') ||
    typeof body.agentId !== 'string' || !UUID.test(body.agentId) ||
    typeof body.projectId !== 'string' || !UUID.test(body.projectId) ||
    !Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1
  ) {
    return response('invalid_request', 'The registration request is malformed.', 400);
  }

  try {
    const result = await (await overrides.getRuntime()).setEnabled({
      workspaceId: authorization.runtime.config.workspaceId,
      operatorActorId: authorization.session.actorId,
      registrationId,
      expectedProjectId: body.projectId,
      expectedAgentId: body.agentId,
      expectedVersion: body.expectedVersion as number,
      enabled: body.action === 'enable'
    });
    if (result.status === 'updated' || result.status === 'replayed') {
      return Response.json({
        status: result.status,
        registration: {enabled: result.enabled, version: result.version},
        receipt: {
          commandId: result.commandId,
          commandType: result.commandType
        }
      }, {headers: noStore});
    }
    if (result.status === 'forbidden') {
      return response('forbidden', 'You are not authorized to manage this project registration.', 403);
    }
    if (result.status === 'not_found') {
      return response('not_found', 'The project registration was not found.', 404);
    }
    if (result.status === 'stale') {
      return response('version_conflict', 'Registration changed. Refresh and retry.', 409);
    }
    return response('invalid', 'The canonical command was not accepted.', 400);
  } catch {
    return response('unavailable', 'Registration control is temporarily unavailable.', 503);
  }
}
