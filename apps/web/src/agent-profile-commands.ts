import {requireOperatorSession} from './operator-auth-runtime';
import {getAgentProfileRuntime} from './agent-profile-runtime';

const MAX_BODY_BYTES = 4 * 1024;
const noStore = {'Cache-Control': 'no-store'} as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Runtime = Awaited<ReturnType<typeof getAgentProfileRuntime>>;
export type AgentProfileCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<Runtime>;
}>;

const dependencies: AgentProfileCommandDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getAgentProfileRuntime
};

const readForm = async (request: Request): Promise<URLSearchParams | null> => {
  const contentType = request.headers.get('content-type')?.toLowerCase();
  const contentLength = request.headers.get('content-length');
  if (
    contentType === undefined ||
    !contentType.startsWith('application/x-www-form-urlencoded') ||
    (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES))
  ) return null;
  const text = await request.text();
  return Buffer.byteLength(text) <= MAX_BODY_BYTES ? new URLSearchParams(text) : null;
};

const exactValues = (form: URLSearchParams | null): Readonly<{
  csrf: string;
  expectedVersion: number;
  instructions: string;
  includeEvidence: boolean;
  enabled: boolean;
}> | null => {
  if (form === null) return null;
  const entries = [...form.entries()];
  const keys = entries.map(([key]) => key);
  if (
    entries.length !== 5 ||
    new Set(keys).size !== 5 ||
    !['_csrf', 'expectedVersion', 'instructions', 'includeEvidence', 'enabled']
      .every((key) => keys.includes(key))
  ) return null;
  const csrf = form.get('_csrf');
  const version = form.get('expectedVersion');
  const instructions = form.get('instructions');
  const includeEvidence = form.get('includeEvidence');
  const enabled = form.get('enabled');
  if (
    csrf === null || csrf.length < 1 || csrf.length > 128 ||
    version === null || !/^[1-9][0-9]{0,8}$/.test(version) ||
    instructions === null || instructions.trim().length < 1 || instructions.length > 2_000 ||
    (includeEvidence !== 'true' && includeEvidence !== 'false') ||
    (enabled !== 'true' && enabled !== 'false')
  ) return null;
  return {
    csrf,
    expectedVersion: Number(version),
    instructions,
    includeEvidence: includeEvidence === 'true',
    enabled: enabled === 'true'
  };
};

const json = (status: string, code: number): Response =>
  Response.json({status}, {status: code, headers: noStore});

export async function updateAgentProfileCommand(
  request: Request,
  profileId: string,
  overrides: AgentProfileCommandDependencies = dependencies
): Promise<Response> {
  const form = exactValues(await readForm(request));
  const authorization = await overrides.requireSession(request, {csrfToken: form?.csrf ?? null});
  if (!authorization.ok) return authorization.response;
  if (form === null || !uuidPattern.test(profileId)) return json('invalid_request', 400);
  try {
    const status = await (await overrides.getRuntime()).update({
      workspaceId: authorization.runtime.config.workspaceId,
      actorId: authorization.session.actorId,
      profileId,
      expectedVersion: form.expectedVersion,
      instructions: form.instructions,
      settings: {resultFormat: 'structured_v1', includeEvidence: form.includeEvidence},
      enabled: form.enabled
    });
    if (status === 'updated' || status === 'replayed') {
      return new Response(null, {
        status: 303,
        headers: {...noStore, location: new URL('/agents', request.url).toString()}
      });
    }
    return status === 'forbidden'
      ? json(status, 403)
      : status === 'not_found'
        ? json(status, 404)
        : status === 'stale'
          ? json(status, 409)
          : json(status, 400);
  } catch {
    return json('unavailable', 503);
  }
}
