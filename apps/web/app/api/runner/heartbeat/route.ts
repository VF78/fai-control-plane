import {parseRunnerHeartbeatPayload} from '@fai-control-plane/application';
import {
  readBoundedRunnerJson,
  runnerLeaseToken
} from '../../../../src/runner-transport-request';
import {
  authenticateRunnerBearerToken,
  getLocalRunnerClaimRuntime
} from '../../../../src/runner-claim-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const noStore = {'Cache-Control': 'no-store'};
const denied = () => Response.json({status: 'not_found'}, {
  status: 404,
  headers: noStore
});

export async function POST(request: Request): Promise<Response> {
  if (process.env.LOCAL_RUNNER_TRANSPORT_ENABLED !== 'true') {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
  try {
    const runner = await getLocalRunnerClaimRuntime();
    if (!authenticateRunnerBearerToken(request.headers.get('authorization'), runner.tokenHash)) {
      return new Response(null, {status: 401, headers: noStore});
    }
    const leaseToken = runnerLeaseToken(request);
    const payload = parseRunnerHeartbeatPayload(
      await readBoundedRunnerJson(request, 1024)
    );
    if (leaseToken === null || payload === null) return denied();
    const heartbeat = await runner.service.heartbeat({
      authorization: runner.authorization,
      ...payload,
      leaseToken
    });
    return heartbeat === null
      ? denied()
      : Response.json(heartbeat, {status: 200, headers: noStore});
  } catch {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
}
