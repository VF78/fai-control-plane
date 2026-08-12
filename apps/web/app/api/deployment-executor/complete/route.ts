import {parseDeploymentExecutorCompletionPayload} from '@fai-control-plane/application';
import {deploymentExecutorLeaseToken,
  readBoundedDeploymentExecutorJson} from '../../../../src/deployment-executor-request';
import {authenticateDeploymentExecutorBearer,
  getDeploymentExecutorRuntime} from '../../../../src/deployment-executor-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const noStore = {'Cache-Control': 'no-store'};
const denied = () => Response.json({status: 'not_found'}, {status: 404, headers: noStore});

export async function POST(request: Request): Promise<Response> {
  if (process.env.DEPLOYMENT_EXECUTOR_TRANSPORT_ENABLED !== 'true') {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
  try {
    const executor = await getDeploymentExecutorRuntime();
    if (!authenticateDeploymentExecutorBearer(request.headers.get('authorization'), executor.tokenHash)) {
      return new Response(null, {status: 401, headers: noStore});
    }
    const leaseToken = deploymentExecutorLeaseToken(request);
    const payload = parseDeploymentExecutorCompletionPayload(
      await readBoundedDeploymentExecutorJson(request, 16 * 1_024));
    if (leaseToken === null || payload === null) return denied();
    const result = await executor.service.complete({authorization: executor.authorization, payload, leaseToken});
    return result === null ? denied() : Response.json(result, {status: 200, headers: noStore});
  } catch {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
}
