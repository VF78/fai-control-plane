import {
  accessLevels,
  containsHighConfidenceSecretContent,
  projectMembershipRoles
} from '@fai-control-plane/domain';
import {requireOperatorSession} from './operator-auth-runtime';
import {getAccessManagementRuntime} from './access-management-runtime';

const MAX_BODY_BYTES = 2 * 1024;
const noStore = {'Cache-Control': 'no-store'} as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Runtime = Awaited<ReturnType<typeof getAccessManagementRuntime>>;
export type AccessManagementCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<Runtime>;
}>;
const dependencies: AccessManagementCommandDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getAccessManagementRuntime
};

const readForm = async (request: Request): Promise<URLSearchParams | null> => {
  const type = request.headers.get('content-type')?.toLowerCase();
  const length = request.headers.get('content-length');
  if (
    type === undefined || !type.startsWith('application/x-www-form-urlencoded') ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))
  ) return null;
  const text = await request.text();
  return Buffer.byteLength(text) <= MAX_BODY_BYTES ? new URLSearchParams(text) : null;
};

const exact = (form: URLSearchParams | null, keys: readonly string[]): Record<string, string> | null => {
  if (form === null) return null;
  const entries = [...form.entries()];
  if (entries.length !== keys.length || new Set(entries.map(([key]) => key)).size !== keys.length) return null;
  if (!keys.every((key) => form.has(key))) return null;
  return Object.fromEntries(entries);
};

const redirect = (request: Request): Response => {
  const fallback = new URL('/people', request.url);
  const referer = request.headers.get('referer');
  if (referer === null) return new Response(null, {status: 303, headers: {...noStore, location: fallback.toString()}});
  try {
    const candidate = new URL(referer);
    const origin = new URL(request.url).origin;
    return new Response(null, {
      status: 303,
      headers: {...noStore, location: candidate.origin === origin ? candidate.toString() : fallback.toString()}
    });
  } catch {
    return new Response(null, {status: 303, headers: {...noStore, location: fallback.toString()}});
  }
};
const json = (status: string, code: number, extra: Record<string, unknown> = {}): Response =>
  Response.json({status, ...extra}, {status: code, headers: noStore});
const responseFor = (request: Request, status: Awaited<ReturnType<Runtime['setMembership']>>): Response =>
  status === 'updated' || status === 'replayed' ? redirect(request) :
    status === 'forbidden' ? json(status, 403) :
      status === 'not_found' ? json(status, 404) :
      status === 'stale' ? json(status, 409) : json(status, 400);

export async function onboardActorCommand(
  request: Request,
  overrides: AccessManagementCommandDependencies = dependencies
): Promise<Response> {
  const form = await readForm(request);
  const kind = form?.get('actorType');
  const keys = kind === 'human'
    ? ['_csrf', 'idempotencyKey', 'projectId', 'actorType', 'displayName', 'actorRole', 'membershipRole']
    : ['_csrf', 'idempotencyKey', 'projectId', 'actorType', 'displayName', 'runtimeId', 'runtimeProfile', 'runtimeKey'];
  const values = exact(form, keys);
  const authorization = await overrides.requireSession(request, {csrfToken: values?._csrf ?? null});
  if (!authorization.ok) return authorization.response;
  const bounded = (value: string | undefined, maximum: number): value is string =>
    value !== undefined && value.trim() === value && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value) && !containsHighConfidenceSecretContent(value);
  if (values === null || !uuidPattern.test(values.idempotencyKey ?? '') ||
    !uuidPattern.test(values.projectId ?? '') || !bounded(values.displayName, 120) ||
    (kind !== 'human' && kind !== 'agent')) return json('invalid_request', 400);
  if (kind === 'human' && (
    !['delivery_lead', 'developer'].includes(values.actorRole ?? '') ||
    !['project_owner', 'contributor', 'reviewer', 'client_viewer'].includes(values.membershipRole ?? '')
  )) return json('invalid_request', 400);
  if (kind === 'agent' && (
    !bounded(values.runtimeId, 64) || !bounded(values.runtimeProfile, 64) ||
    !bounded(values.runtimeKey, 256)
  )) return json('invalid_request', 400);
  try {
    const status = await (await overrides.getRuntime()).onboardActor({
      workspaceId: authorization.runtime.config.workspaceId,
      operatorActorId: authorization.session.actorId,
      idempotencyKey: values.idempotencyKey!,
      projectId: values.projectId!,
      actorType: kind,
      displayName: values.displayName,
      actorRole: kind === 'agent' ? 'agent_operator' : values.actorRole as 'delivery_lead' | 'developer',
      membershipRole: kind === 'agent' ? 'agent' : values.membershipRole as (typeof projectMembershipRoles)[number],
      ...(kind === 'agent' ? {
        runtimeId: values.runtimeId, runtimeProfile: values.runtimeProfile, runtimeKey: values.runtimeKey
      } : {})
    });
    return responseFor(request, status);
  } catch {
    return json('unavailable', 503);
  }
}

export async function setMembershipCommand(
  request: Request,
  membershipId: string,
  overrides: AccessManagementCommandDependencies = dependencies
): Promise<Response> {
  const values = exact(await readForm(request), ['_csrf', 'expectedVersion', 'role', 'active']);
  const authorization = await overrides.requireSession(request, {csrfToken: values?._csrf ?? null});
  if (!authorization.ok) return authorization.response;
  if (
    values === null || !uuidPattern.test(membershipId) ||
    !/^[1-9][0-9]{0,8}$/.test(values.expectedVersion ?? '') ||
    !projectMembershipRoles.includes(values.role as never) ||
    (values.active !== 'true' && values.active !== 'false')
  ) return json('invalid_request', 400);
  try {
    return responseFor(request, await (await overrides.getRuntime()).setMembership({
      workspaceId: authorization.runtime.config.workspaceId,
      operatorActorId: authorization.session.actorId,
      membershipId,
      expectedVersion: Number(values.expectedVersion),
      role: values.role as (typeof projectMembershipRoles)[number],
      active: values.active === 'true'
    }));
  } catch {
    return json('unavailable', 503);
  }
}

export async function setDesiredAccessCommand(
  request: Request,
  grantId: string,
  overrides: AccessManagementCommandDependencies = dependencies
): Promise<Response> {
  const values = exact(await readForm(request), ['_csrf', 'expectedVersion', 'desiredLevel']);
  const authorization = await overrides.requireSession(request, {csrfToken: values?._csrf ?? null});
  if (!authorization.ok) return authorization.response;
  if (
    values === null || !uuidPattern.test(grantId) ||
    !/^[1-9][0-9]{0,8}$/.test(values.expectedVersion ?? '') ||
    !accessLevels.includes(values.desiredLevel as never)
  ) return json('invalid_request', 400);
  try {
    const status = await (await overrides.getRuntime()).setDesiredAccess({
      workspaceId: authorization.runtime.config.workspaceId,
      operatorActorId: authorization.session.actorId,
      grantId,
      expectedVersion: Number(values.expectedVersion),
      desiredLevel: values.desiredLevel as (typeof accessLevels)[number]
    });
    if (status === 'updated' || status === 'replayed') return redirect(request);
    return responseFor(request, status);
  } catch {
    return json('unavailable', 503);
  }
}
