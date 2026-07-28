import {requireOperatorSession} from './operator-auth-runtime';
import {getPolicySimulationRuntime} from './policy-simulation-runtime';

const MAX_BODY_BYTES = 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'} as const;

type Runtime = Awaited<ReturnType<typeof getPolicySimulationRuntime>>;

export type PolicySimulationCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<Runtime>;
}>;

const dependencies: PolicySimulationCommandDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getPolicySimulationRuntime
};

const parse = async (request: Request): Promise<Readonly<{
  csrfToken: string;
  profileId: string;
}> | null> => {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json' ||
    request.body === null) return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return null;
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 ||
      typeof record._csrf !== 'string' || record._csrf.length === 0 || record._csrf.length > 128 ||
      typeof record.profileId !== 'string' || !UUID_PATTERN.test(record.profileId)) return null;
    return {csrfToken: record._csrf, profileId: record.profileId};
  } catch {
    return null;
  }
};

export async function simulatePolicyCommand(
  request: Request,
  taskPacketId: string,
  overrides: PolicySimulationCommandDependencies = dependencies
): Promise<Response> {
  const input = await parse(request);
  const authorization = await overrides.requireSession(request, {
    csrfToken: input?.csrfToken ?? null
  });
  if (!authorization.ok) return authorization.response;
  if (!UUID_PATTERN.test(taskPacketId) || input === null) {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  try {
    const result = await (await overrides.getRuntime()).simulate({
      workspaceId: authorization.runtime.config.workspaceId,
      actorId: authorization.session.actorId,
      taskPacketId,
      profileId: input.profileId
    });
    if (result.status === 'forbidden') return new Response(null, {status: 403, headers: noStore});
    return Response.json(result.simulation, {status: 200, headers: noStore});
  } catch {
    return new Response(null, {status: 503, headers: noStore});
  }
}
