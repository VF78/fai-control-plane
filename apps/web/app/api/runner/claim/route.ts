import {
  authenticateRunnerBearerToken,
  getLocalRunnerClaimRuntime
} from '../../../../src/runner-claim-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const noStore = {'Cache-Control': 'no-store'};

export async function POST(request: Request): Promise<Response> {
  if (process.env.LOCAL_RUNNER_TRANSPORT_ENABLED !== 'true') {
    return Response.json(
      {status: 'unavailable'},
      {status: 503, headers: noStore}
    );
  }
  try {
    const runner = await getLocalRunnerClaimRuntime();
    if (
      !authenticateRunnerBearerToken(
        request.headers.get('authorization'),
        runner.tokenHash
      )
    ) {
      return new Response(null, {status: 401, headers: noStore});
    }
    const envelope = await runner.service.claim(runner.authorization);
    return envelope === null
      ? new Response(null, {status: 204, headers: noStore})
      : Response.json(envelope, {status: 200, headers: noStore});
  } catch {
    return Response.json(
      {status: 'unavailable'},
      {status: 503, headers: noStore}
    );
  }
}
