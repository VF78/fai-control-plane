import type {VerifiedIncomingEventInput} from '@fai-control-plane/application';
import type {
  GitHubWebhookProjection,
  GitHubWebhookResult
} from './github-webhook';

export type GitHubIncomingEventAdaptation =
  | Readonly<{status: 'ready'; input: VerifiedIncomingEventInput}>
  | Readonly<{
      status: 'ignored';
      reason:
        | 'github_webhook_not_accepted'
        | 'github_webhook_not_project_scoped';
    }>;

type ProjectScopedProjection = Exclude<
  GitHubWebhookProjection,
  {eventType: 'installation_repositories'}
>;

const projectScoped = (
  projection: GitHubWebhookProjection
): projection is ProjectScopedProjection =>
  projection.eventType !== 'installation_repositories';

export function adaptGitHubWebhookToIncomingEvent(
  workspaceId: string,
  result: GitHubWebhookResult
): GitHubIncomingEventAdaptation {
  if (result.outcome !== 'accepted') {
    return {status: 'ignored', reason: 'github_webhook_not_accepted'};
  }
  if (!projectScoped(result.projection)) {
    return {
      status: 'ignored',
      reason: 'github_webhook_not_project_scoped'
    };
  }

  const projection = result.projection;
  const sanitizedProjection =
    projection.eventType === 'issues'
      ? {issue: projection.issue}
      : projection.eventType === 'pull_request'
        ? {pullRequest: projection.pullRequest}
        : {checkRun: projection.checkRun};

  return {
    status: 'ready',
    input: {
      workspaceId,
      projectId: projection.project.projectId,
      provider: 'github',
      deliveryId: projection.deliveryId,
      eventType: projection.eventType,
      action: projection.action,
      payloadSha256: projection.payloadSha256,
      verification: {outcome: 'verified', method: 'hmac-sha256'},
      source: {
        kind: 'github',
        installationId: String(projection.installationId),
        repositoryId: String(projection.repository.repositoryId),
        projectNodeId: projection.project.projectNodeId
      },
      projection: sanitizedProjection
    }
  };
}
