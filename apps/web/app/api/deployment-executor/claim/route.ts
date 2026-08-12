import {authenticateDeploymentExecutorBearer,
  getDeploymentExecutorRuntime} from '../../../../src/deployment-executor-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const noStore = {'Cache-Control': 'no-store'};

export async function POST(request: Request): Promise<Response> {
  if (process.env.DEPLOYMENT_EXECUTOR_TRANSPORT_ENABLED !== 'true') {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
  try {
    const executor = await getDeploymentExecutorRuntime();
    if (!authenticateDeploymentExecutorBearer(request.headers.get('authorization'), executor.tokenHash)) {
      return new Response(null, {status: 401, headers: noStore});
    }
    const envelope = await executor.service.claim(executor.authorization);
    return envelope === null ? new Response(null, {status: 204, headers: noStore})
      : Response.json(envelope, {status: 200, headers: noStore});
  } catch {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
}
