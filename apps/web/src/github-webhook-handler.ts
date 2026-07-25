import type {IncomingEventIngestionService} from '@fai-control-plane/application';
import type {SecretsProvider} from '@fai-control-plane/domain';
import {
  adaptGitHubWebhookToIncomingEvent,
  readGitHubWebhookBody,
  verifyAndProjectGitHubWebhook,
  type GitHubAppWebhookConfig,
  type GitHubWebhookRejectionCode
} from '@fai-control-plane/integrations';

export type GitHubWebhookHandlerDependencies = Readonly<{
  workspaceId: string;
  config: GitHubAppWebhookConfig;
  secrets: SecretsProvider;
  ingestion: IncomingEventIngestionService;
}>;

const response = (status: number, outcome: string): Response =>
  Response.json(
    {status: outcome},
    {status, headers: {'Cache-Control': 'no-store'}}
  );

const rejectionStatus = (code: GitHubWebhookRejectionCode): number => {
  if (code === 'github_body_too_large') return 413;
  if (code === 'github_secret_unavailable') return 503;
  if (
    code === 'github_signature_missing' ||
    code === 'github_signature_malformed' ||
    code === 'github_signature_invalid'
  ) {
    return 401;
  }
  if (
    code === 'github_installation_unauthorized' ||
    code === 'github_repository_unauthorized'
  ) {
    return 403;
  }
  if (
    code === 'github_event_unsupported' ||
    code === 'github_project_event_unsupported' ||
    code === 'github_action_unsupported'
  ) {
    return 204;
  }
  if (code === 'github_media_type_invalid') return 415;
  return 400;
};

export const createGitHubWebhookHandler = (
  dependencies: GitHubWebhookHandlerDependencies
) => async (request: Request): Promise<Response> => {
  if (request.body === null) return response(400, 'rejected');

  const body = await readGitHubWebhookBody(
    request.body,
    request.headers.get('content-length') ?? undefined
  );
  if (!body.ok) {
    return response(
      body.code === 'github_body_too_large' ? 413 : 400,
      'rejected'
    );
  }

  const verified = await verifyAndProjectGitHubWebhook({
    config: dependencies.config,
    secrets: dependencies.secrets,
    headers: {
      'content-type': request.headers.get('content-type') ?? undefined,
      'x-github-delivery':
        request.headers.get('x-github-delivery') ?? undefined,
      'x-github-event': request.headers.get('x-github-event') ?? undefined,
      'x-hub-signature-256':
        request.headers.get('x-hub-signature-256') ?? undefined
    },
    body: body.body
  });

  if (verified.outcome === 'acknowledged') {
    return new Response(null, {
      status: 204,
      headers: {'Cache-Control': 'no-store'}
    });
  }
  if (verified.outcome === 'rejected') {
    const status = rejectionStatus(verified.code);
    if (status === 204) {
      return new Response(null, {
        status,
        headers: {'Cache-Control': 'no-store'}
      });
    }
    return response(status, status === 202 ? 'ignored' : 'rejected');
  }

  const adapted = adaptGitHubWebhookToIncomingEvent(
    dependencies.workspaceId,
    verified
  );
  if (adapted.status === 'ignored') {
    return new Response(null, {
      status: 204,
      headers: {'Cache-Control': 'no-store'}
    });
  }

  const accepted = await dependencies.ingestion.ingest(adapted.input);
  return response(202, accepted.status);
};
