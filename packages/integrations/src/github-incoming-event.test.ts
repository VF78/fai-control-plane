import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import type {GitHubWebhookResult} from './github-webhook';
import {adaptGitHubWebhookToIncomingEvent} from './github-incoming-event';

const acceptedIssue = (): GitHubWebhookResult => ({
  outcome: 'accepted',
  projection: {
    provider: 'github',
    deliveryId: randomUUID(),
    eventType: 'issues',
    action: 'opened',
    installationId: 1001,
    repository: {
      repositoryId: 1278325372,
      fullName: 'VF78/MSA',
      ownerId: 75837222
    },
    project: {
      projectId: randomUUID(),
      projectNumber: 3,
      projectNodeId: 'PVT_kwHOBIUvJs4Bbefq'
    },
    payloadSha256: 'a'.repeat(64),
    issue: {id: 10, number: 4, state: 'open'}
  }
});

describe('GitHub incoming event adapter', () => {
  it('maps only the project-scoped allowlist projection', () => {
    const result = adaptGitHubWebhookToIncomingEvent(
      randomUUID(),
      acceptedIssue()
    );

    expect(result).toMatchObject({
      status: 'ready',
      input: {
        provider: 'github',
        verification: {outcome: 'verified', method: 'hmac-sha256'},
        source: {
          kind: 'github',
          installationId: '1001',
          repositoryId: '1278325372',
          projectNodeId: 'PVT_kwHOBIUvJs4Bbefq'
        },
        projection: {issue: {id: 10, number: 4, state: 'open'}}
      }
    });
    expect(JSON.stringify(result)).not.toMatch(
      /title|body|url|sender|header|signature/i
    );
  });

  it.each([
    {outcome: 'acknowledged', code: 'github_ping_acknowledged'},
    {outcome: 'rejected', code: 'github_signature_invalid'}
  ] as const)('does not adapt non-accepted webhook results', (result) => {
    expect(
      adaptGitHubWebhookToIncomingEvent(randomUUID(), result)
    ).toEqual({
      status: 'ignored',
      reason: 'github_webhook_not_accepted'
    });
  });

  it('does not adapt an installation-wide projection to one canonical project', () => {
    const result: GitHubWebhookResult = {
      outcome: 'accepted',
      projection: {
        provider: 'github',
        deliveryId: randomUUID(),
        eventType: 'installation_repositories',
        action: 'added',
        installationId: 1001,
        payloadSha256: 'a'.repeat(64),
        repositoryChanges: [{
          repositoryId: 1278325372,
          fullName: 'VF78/MSA',
          ownerId: 75837222,
          project: {
            projectId: randomUUID(),
            projectNumber: 3,
            projectNodeId: 'PVT_kwHOBIUvJs4Bbefq'
          }
        }]
      }
    };

    expect(
      adaptGitHubWebhookToIncomingEvent(randomUUID(), result)
    ).toEqual({
      status: 'ignored',
      reason: 'github_webhook_not_project_scoped'
    });
  });
});
