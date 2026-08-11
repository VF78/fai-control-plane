import {randomUUID} from 'node:crypto';
import {containsHighConfidenceSecretContent} from '@fai-control-plane/domain';
import {requireOperatorSession} from './operator-auth-runtime';
import {getAccessManagementRuntime} from './access-management-runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 4096;
const noStore = {'Cache-Control': 'no-store'} as const;
type Runtime = Awaited<ReturnType<typeof getAccessManagementRuntime>>;
export type EnvironmentAccessCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<Runtime>;
}>;
const dependencies: EnvironmentAccessCommandDependencies = {
  requireSession: requireOperatorSession, getRuntime: getAccessManagementRuntime
};

const response = (status: string, code: number) => Response.json({status}, {status: code, headers: noStore});
const redirect = (request: Request) => new Response(null, {status: 303, headers: {
  ...noStore, location: request.headers.get('referer') ?? new URL('/projects', request.url).toString()
}});
const bounded = (value: string | null, max: number): value is string => value !== null &&
  value.trim() === value && value.length > 0 && value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value) && !containsHighConfidenceSecretContent(value);
const form = async (request: Request): Promise<URLSearchParams | null> => {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
  const body = await request.text();
  return Buffer.byteLength(body) <= MAX_BODY ? new URLSearchParams(body) : null;
};
const exact = (value: URLSearchParams, keys: readonly string[]) =>
  [...value.keys()].length === keys.length && keys.every((key) => value.getAll(key).length === 1);
const iso = (value: string | null): string | null => {
  if (value === null || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
const finish = (request: Request, status: Awaited<ReturnType<Runtime['setProjectEnvironment']>>) =>
  status === 'updated' || status === 'replayed' ? redirect(request) :
    response(status, status === 'forbidden' ? 403 : status === 'not_found' ? 404 : status === 'stale' ? 409 : 400);

export async function environmentAccessCommand(
  request: Request,
  overrides: EnvironmentAccessCommandDependencies = dependencies
): Promise<Response> {
  const data = await form(request);
  const csrf = data?.get('_csrf') ?? null;
  const auth = await overrides.requireSession(request, {csrfToken: csrf});
  if (!auth.ok) return auth.response;
  if (data === null) return response('invalid_request', 400);
  const action = data.get('action');
  try {
    const runtime = await overrides.getRuntime();
    const common = {workspaceId: auth.runtime.config.workspaceId, operatorActorId: auth.session.actorId};
    if (action === 'configure' && exact(data, ['_csrf', 'action', 'environmentId', 'projectId', 'kind',
      'provider', 'endpoint', 'port', 'purpose', 'adapterKey', 'adapterCredentialRefId',
      'reconcilerActorId', 'enabled', 'expectedVersion'])) {
      const environmentId = data.get('environmentId') || randomUUID();
      const projectId = data.get('projectId'); const credential = data.get('adapterCredentialRefId');
      const reconcilerActorId = data.get('reconcilerActorId');
      const expected = data.get('expectedVersion'); const port = Number(data.get('port'));
      const kind = data.get('kind'); const provider = data.get('provider'); const endpoint = data.get('endpoint');
      const purpose = data.get('purpose'); const adapterKey = data.get('adapterKey');
      if (!UUID.test(environmentId) || projectId === null || !UUID.test(projectId) ||
        credential === null || !UUID.test(credential) || reconcilerActorId === null ||
        !UUID.test(reconcilerActorId) || !['development', 'production'].includes(kind ?? '') ||
        !bounded(provider, 64) || !bounded(endpoint, 255) || !bounded(purpose, 240) || !bounded(adapterKey, 64) ||
        !Number.isInteger(port) || port < 1 || port > 65535 ||
        (expected !== '' && !/^[1-9][0-9]{0,8}$/.test(expected ?? '')) ||
        !['true', 'false'].includes(data.get('enabled') ?? '')) return response('invalid_request', 400);
      return finish(request, await runtime.setProjectEnvironment({...common, environmentId, projectId,
        kind: kind as 'development' | 'production', provider, endpoint, port, purpose, adapterKey,
        adapterCredentialRefId: credential, reconcilerActorId, enabled: data.get('enabled') === 'true',
        expectedVersion: expected === '' ? null : Number(expected)}));
    }
    if (action === 'request' && exact(data, ['_csrf', 'action', 'projectId', 'subjectActorId',
      'environmentId', 'credentialRefId', 'expiresAt'])) {
      const projectId = data.get('projectId'); const actorId = data.get('subjectActorId');
      const environmentId = data.get('environmentId'); const credential = data.get('credentialRefId');
      const expiresAt = iso(data.get('expiresAt'));
      if ([projectId, actorId, environmentId, credential].some((value) => value === null || !UUID.test(value)) ||
        expiresAt === null) return response('invalid_request', 400);
      return finish(request, await runtime.requestEnvironmentAccess({...common, requestId: randomUUID(),
        projectId: projectId!, subjectActorId: actorId!, environmentId: environmentId!,
        credentialRefId: credential!, expiresAt}));
    }
    if (action === 'decide' && exact(data, ['_csrf', 'action', 'requestId', 'status', 'expectedVersion'])) {
      const requestId = data.get('requestId'); const status = data.get('status');
      const expected = data.get('expectedVersion');
      if (requestId === null || !UUID.test(requestId) || !['granted', 'rejected'].includes(status ?? '') ||
        !/^[1-9][0-9]{0,8}$/.test(expected ?? '')) return response('invalid_request', 400);
      return finish(request, await runtime.decideEnvironmentAccess({...common, requestId,
        status: status as 'granted' | 'rejected', expectedVersion: Number(expected)}));
    }
    if (action === 'grant' && exact(data, ['_csrf', 'action', 'grantId', 'projectId', 'subjectActorId',
      'environmentId', 'credentialRefId', 'approvalRequestId', 'expiresAt', 'desiredLevel', 'expectedVersion'])) {
      const desired = data.get('desiredLevel'); const projectId = data.get('projectId');
      const actorId = data.get('subjectActorId'); const environmentId = data.get('environmentId');
      const grantId = data.get('grantId') || randomUUID(); const expected = data.get('expectedVersion');
      const credential = data.get('credentialRefId') || null;
      const approval = data.get('approvalRequestId') || null; const expiresAt = iso(data.get('expiresAt'));
      if (!['none', 'write'].includes(desired ?? '') || [grantId, projectId, actorId, environmentId]
        .some((value) => value === null || !UUID.test(value)) ||
        (credential !== null && !UUID.test(credential)) || (approval !== null && !UUID.test(approval)) ||
        (expected !== '' && !/^[1-9][0-9]{0,8}$/.test(expected ?? '')) ||
        (desired === 'write' && (credential === null || expiresAt === null)) ||
        (desired === 'none' && (credential !== null || approval !== null || expiresAt !== null))) {
        return response('invalid_request', 400);
      }
      return finish(request, await runtime.setEnvironmentAccess({...common, grantId, projectId: projectId!,
        subjectActorId: actorId!, environmentId: environmentId!, credentialRefId: credential,
        approvalRequestId: approval, expiresAt, desiredLevel: desired as 'none' | 'write',
        expectedVersion: expected === '' ? null : Number(expected)}));
    }
    return response('invalid_request', 400);
  } catch {
    return response('unavailable', 503);
  }
}
