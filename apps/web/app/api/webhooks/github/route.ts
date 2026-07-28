import {getGitHubWebhookHandler} from '../../../../src/github-webhook-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  if (
    process.env.GITHUB_SYNC_ENABLED !== 'true' ||
    process.env.GITHUB_INGRESS_ENABLED !== 'true'
  ) {
    return Response.json(
      {status: 'not_found'},
      {status: 404, headers: {'Cache-Control': 'no-store'}}
    );
  }
  try {
    return (await getGitHubWebhookHandler())(request);
  } catch {
    console.error('GitHub webhook request could not be processed.');
    return Response.json(
      {status: 'unavailable'},
      {status: 503, headers: {'Cache-Control': 'no-store'}}
    );
  }
}
