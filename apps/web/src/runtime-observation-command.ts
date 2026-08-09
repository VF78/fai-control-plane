import {containsHighConfidenceSecretContent} from '@fai-control-plane/domain';
import {
  authenticateRuntimeObservation,
  getRuntimeObservationRuntime,
  type RuntimeObservationInput
} from './runtime-observation-runtime';
import {readBoundedRunnerJson} from './runner-transport-request';

const MAX_BODY = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'} as const;
type Dependencies = Readonly<{
  getRuntime: typeof getRuntimeObservationRuntime;
}>;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const parse = async (request: Request): Promise<RuntimeObservationInput | null> => {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json' || request.body === null) return null;
  const value = await readBoundedRunnerJson(request, MAX_BODY);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!exact(body, ['registrationId', 'component', 'state', 'observedAt', 'ttlSeconds', 'evidenceReference'])) return null;
  const observedAt = typeof body.observedAt === 'string' ? new Date(body.observedAt) : null;
  if (!UUID.test(String(body.registrationId)) ||
    !['service', 'scheduler', 'delivery'].includes(String(body.component)) ||
    !['available', 'unavailable'].includes(String(body.state)) ||
    observedAt === null || Number.isNaN(observedAt.getTime()) || observedAt.toISOString() !== body.observedAt ||
    !Number.isInteger(body.ttlSeconds) || Number(body.ttlSeconds) < 30 || Number(body.ttlSeconds) > 604800 ||
    typeof body.evidenceReference !== 'string' || body.evidenceReference.length < 1 ||
    body.evidenceReference.length > 500 || /[\u0000-\u001f\u007f]/.test(body.evidenceReference) ||
    containsHighConfidenceSecretContent(body.evidenceReference)) return null;
  return body as RuntimeObservationInput;
};

export const runtimeObservationCommand = async (
  request: Request,
  overrides: Dependencies = {getRuntime: getRuntimeObservationRuntime}
): Promise<Response> => {
  if (process.env.RUNTIME_OBSERVATION_TRANSPORT_ENABLED !== 'true') {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
  try {
    const runtime = await overrides.getRuntime();
    if (!authenticateRuntimeObservation(request.headers.get('authorization'), runtime.tokenHash)) {
      return new Response(null, {status: 401, headers: noStore});
    }
    const input = await parse(request);
    if (input === null) return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
    const result = await runtime.execute(input);
    return result.status === 'rejected'
      ? Response.json({status: 'rejected'}, {status: 409, headers: noStore})
      : Response.json(result, {status: result.status === 'recorded' ? 201 : 200, headers: noStore});
  } catch {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
};
