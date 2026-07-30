import {requireOperatorSession} from './operator-auth-runtime';
import {
  getAgentRetirementRuntime,
  type AgentRetirementRuntime
} from './agent-retirement-runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'} as const;
const response = (status: string, message: string, code: number): Response =>
  Response.json({status, message}, {status: code, headers: noStore});

export async function agentRetirementCommand(
  request: Request,
  agentId: string,
  overrides: Readonly<{
    requireSession: typeof requireOperatorSession;
    getRuntime(): Promise<AgentRetirementRuntime>;
  }> = {
    requireSession: requireOperatorSession,
    getRuntime: getAgentRetirementRuntime
  }
): Promise<Response> {
  if (
    request.headers.get('content-type')?.toLowerCase() !== 'application/json' ||
    Number(request.headers.get('content-length') ?? 0) > 1024
  ) return response('invalid_request', 'The retirement request is malformed.', 400);
  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 1024) throw new Error('oversized');
    body = JSON.parse(text) as unknown;
  } catch {
    return response('invalid_request', 'The retirement request is malformed.', 400);
  }
  if (
    typeof body !== 'object' || body === null || Array.isArray(body) ||
    Object.keys(body).length !== 1 || !Object.hasOwn(body, '_csrf') ||
    typeof (body as {_csrf?: unknown})._csrf !== 'string' ||
    (body as {_csrf: string})._csrf.length < 1 ||
    (body as {_csrf: string})._csrf.length > 128 ||
    !UUID.test(agentId)
  ) return response('invalid_request', 'The retirement request is malformed.', 400);
  const authorization = await overrides.requireSession(request, {
    csrfToken: (body as {_csrf: string})._csrf
  });
  if (!authorization.ok) return authorization.response;
  try {
    const result = await (await overrides.getRuntime()).retire({
      workspaceId: authorization.runtime.config.workspaceId,
      operatorActorId: authorization.session.actorId,
      agentId
    });
    if (result.status === 'retired' || result.status === 'replayed') {
      return Response.json({
        status: result.status,
        agent: {id: agentId, disabledAt: result.disabledAt},
        receipt: {commandId: result.commandId, commandType: 'actor.retire'}
      }, {headers: noStore});
    }
    if (result.status === 'forbidden') return response('forbidden', 'You are not authorized to retire this agent.', 403);
    if (result.status === 'not_found') return response('not_found', 'The agent was not found.', 404);
    if (result.status === 'conflict') return response('already_retired', 'The agent is already retired.', 409);
    return response('invalid', 'The canonical command was not accepted.', 400);
  } catch {
    return response('unavailable', 'Agent retirement is temporarily unavailable.', 503);
  }
}
