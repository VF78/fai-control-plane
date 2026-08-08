import {requireOperatorSession} from './operator-auth-runtime';
import {getInstructionManagementRuntime} from './instruction-management-runtime';

const MAX_BODY_BYTES = 72 * 1024;
const noStore = {'Cache-Control': 'no-store'} as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Runtime = Awaited<ReturnType<typeof getInstructionManagementRuntime>>;
export type InstructionManagementCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<Runtime>;
}>;
const dependencies: InstructionManagementCommandDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getInstructionManagementRuntime
};

const readForm = async (request: Request): Promise<URLSearchParams | null> => {
  const type = request.headers.get('content-type')?.toLowerCase();
  const length = request.headers.get('content-length');
  if (type === undefined || !type.startsWith('application/x-www-form-urlencoded') ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))) return null;
  const text = await request.text();
  return Buffer.byteLength(text) <= MAX_BODY_BYTES ? new URLSearchParams(text) : null;
};
const exact = (form: URLSearchParams | null): Record<string, string> | null => {
  if (form === null) return null;
  const keys = ['_csrf', 'action', 'scope', 'targetId', 'expectedVersion', 'instructions', 'rollbackOfVersionId'];
  const entries = [...form.entries()];
  if (entries.length !== keys.length || new Set(entries.map(([key]) => key)).size !== keys.length || !keys.every((key) => form.has(key))) return null;
  return Object.fromEntries(entries);
};
const json = (status: string, code: number): Response => Response.json({status}, {status: code, headers: noStore});
const redirect = (request: Request): Response => {
  const fallback = new URL('/people', request.url);
  try {
    const candidate = new URL(request.headers.get('referer') ?? '');
    return new Response(null, {status: 303, headers: {
      ...noStore,
      location: candidate.origin === fallback.origin ? candidate.toString() : fallback.toString()
    }});
  } catch {
    return new Response(null, {status: 303, headers: {...noStore, location: fallback.toString()}});
  }
};

export async function mutateInstructionVersionCommand(
  request: Request,
  overrides: InstructionManagementCommandDependencies = dependencies
): Promise<Response> {
  const values = exact(await readForm(request));
  const authorization = await overrides.requireSession(request, {csrfToken: values?._csrf ?? null});
  if (!authorization.ok) return authorization.response;
  if (values === null) return json('invalid_request', 400);
  const action = values.action ?? '';
  const scope = values.scope ?? '';
  const targetId = values.targetId ?? '';
  const expectedVersion = values.expectedVersion ?? '';
  const instructions = values.instructions ?? '';
  const rollbackOfVersionId = values.rollbackOfVersionId ?? '';
  if (
    (action !== 'publish' && action !== 'rollback') ||
    (scope !== 'workspace' && scope !== 'agent_profile') ||
    (scope === 'workspace' ? targetId !== '' : !uuidPattern.test(targetId)) ||
    !/^(0|[1-9][0-9]{0,8})$/.test(expectedVersion) ||
    (action === 'publish'
      ? instructions.trim().length === 0 || Buffer.byteLength(instructions) > 64 * 1024 || rollbackOfVersionId !== ''
      : instructions !== '' || !uuidPattern.test(rollbackOfVersionId) || expectedVersion === '0')
  ) return json('invalid_request', 400);
  const target = scope === 'workspace'
    ? {scope: 'workspace' as const}
    : {scope: 'agent_profile' as const, agentProfileId: targetId};
  try {
    const runtime = await overrides.getRuntime();
    const status = action === 'publish'
      ? await runtime.publish({
          workspaceId: authorization.runtime.config.workspaceId,
          operatorActorId: authorization.session.actorId,
          target,
          expectedVersion: expectedVersion === '0' ? null : Number(expectedVersion),
          instructions
        })
      : await runtime.rollback({
          workspaceId: authorization.runtime.config.workspaceId,
          operatorActorId: authorization.session.actorId,
          target,
          expectedVersion: Number(expectedVersion),
          rollbackOfVersionId
        });
    if (status === 'updated' || status === 'replayed') return redirect(request);
    return status === 'forbidden' ? json(status, 403) : status === 'not_found' ? json(status, 404) : status === 'stale' ? json(status, 409) : json(status, 400);
  } catch {
    return json('unavailable', 503);
  }
}
