import {accessLevels} from '@fai-control-plane/domain';
import {requireOperatorSession} from './operator-auth-runtime';
import {getConversationManagementRuntime} from './conversation-management-runtime';

const MAX_BODY_BYTES = 2 * 1024;
const noStore = {'Cache-Control': 'no-store'} as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Runtime = Awaited<ReturnType<typeof getConversationManagementRuntime>>;
export type ConversationManagementDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<Runtime>;
}>;
const dependencies: ConversationManagementDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getConversationManagementRuntime
};

const readForm = async (request: Request): Promise<URLSearchParams | null> => {
  const type = request.headers.get('content-type')?.toLowerCase();
  const length = request.headers.get('content-length');
  if (type === undefined || !type.startsWith('application/x-www-form-urlencoded') ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))) return null;
  const text = await request.text();
  return Buffer.byteLength(text) <= MAX_BODY_BYTES ? new URLSearchParams(text) : null;
};
const exact = <Key extends string>(
  form: URLSearchParams | null,
  keys: readonly Key[]
): Record<Key, string> | null => {
  if (form === null) return null;
  const entries = [...form.entries()];
  if (entries.length !== keys.length || new Set(entries.map(([key]) => key)).size !== keys.length ||
    !keys.every((key) => form.has(key))) return null;
  return Object.fromEntries(entries) as Record<Key, string>;
};
const redirect = (request: Request, publicBaseUrl: URL): Response => {
  const fallback = new URL('/dashboard', publicBaseUrl);
  const referer = request.headers.get('referer');
  if (referer === null) return new Response(null, {status: 303, headers: {...noStore, location: fallback.toString()}});
  try {
    const candidate = new URL(referer);
    return new Response(null, {
      status: 303,
      headers: {
        ...noStore,
        location: candidate.origin === publicBaseUrl.origin ? candidate.toString() : fallback.toString()
      }
    });
  } catch {
    return new Response(null, {status: 303, headers: {...noStore, location: fallback.toString()}});
  }
};
const response = (
  request: Request,
  status: Awaited<ReturnType<Runtime['setChannel']>>,
  publicBaseUrl: URL
): Response =>
  status === 'updated' || status === 'replayed' ? redirect(request, publicBaseUrl) :
    Response.json({status}, {status: status === 'forbidden' ? 403 : status === 'not_found' ? 404 :
      status === 'stale' ? 409 : 400, headers: noStore});
const version = (value: string | undefined): number | null | undefined =>
  value === '0' ? null : typeof value === 'string' && /^[1-9][0-9]{0,8}$/.test(value)
    ? Number(value) : undefined;

export async function setConversationChannelCommand(
  request: Request,
  overrides: ConversationManagementDependencies = dependencies
): Promise<Response> {
  const values = exact(await readForm(request), [
    '_csrf', 'projectId', 'channelId', 'conversationClass', 'action', 'expectedVersion'
  ]);
  const authorization = await overrides.requireSession(request, {csrfToken: values?._csrf ?? null});
  if (!authorization.ok) return authorization.response;
  const expectedVersion = version(values?.expectedVersion);
  if (values === null || !uuid.test(values.projectId) || !uuid.test(values.channelId) ||
    (values.conversationClass !== 'internal' && values.conversationClass !== 'client') ||
    !['activate', 'deactivate', 'not_used'].includes(values.action) || expectedVersion === undefined) {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  try {
    return response(request, await (await overrides.getRuntime()).setChannel({
      workspaceId: authorization.runtime.config.workspaceId,
      operatorActorId: authorization.session.actorId,
      projectId: values.projectId,
      channelId: values.channelId,
      conversationClass: values.conversationClass,
      desiredState: values.action === 'activate' ? 'active' :
        values.action === 'deactivate' ? 'inactive' : 'not_used',
      expectedVersion
    }), authorization.runtime.config.publicBaseUrl);
  } catch {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
}

export async function setConversationAccessCommand(
  request: Request,
  overrides: ConversationManagementDependencies = dependencies
): Promise<Response> {
  const values = exact(await readForm(request), [
    '_csrf', 'projectId', 'channelId', 'conversationClass', 'actorId',
    'grantId', 'expectedVersion', 'desiredLevel'
  ]);
  const authorization = await overrides.requireSession(request, {csrfToken: values?._csrf ?? null});
  if (!authorization.ok) return authorization.response;
  const expectedVersion = version(values?.expectedVersion);
  if (values === null || !uuid.test(values.projectId) || !uuid.test(values.channelId) ||
    !uuid.test(values.actorId) || !uuid.test(values.grantId) ||
    (values.conversationClass !== 'internal' && values.conversationClass !== 'client') ||
    !accessLevels.includes(values.desiredLevel as never) || expectedVersion === undefined) {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  try {
    const status = await (await overrides.getRuntime()).setAccess({
      workspaceId: authorization.runtime.config.workspaceId,
      operatorActorId: authorization.session.actorId,
      projectId: values.projectId,
      channelId: values.channelId,
      conversationClass: values.conversationClass,
      subjectActorId: values.actorId,
      grantId: values.grantId,
      expectedVersion,
      desiredLevel: values.desiredLevel as (typeof accessLevels)[number]
    });
    return response(request, status, authorization.runtime.config.publicBaseUrl);
  } catch {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
}
