import {createHmac, randomUUID} from 'node:crypto';
import type {
  IncomingEventIngestionService,
  VerifiedIncomingEventInput
} from '@fai-control-plane/application';
import type {SecretsProvider} from '@fai-control-plane/domain';
import {createGitHubAppWebhookConfig} from '@fai-control-plane/integrations';
import {describe, expect, it, vi} from 'vitest';
import {createGitHubWebhookHandler} from './github-webhook-handler';

const secret = 'test-webhook-secret';
const workspaceId = randomUUID();
const projectId = randomUUID();
const config = createGitHubAppWebhookConfig({
  webhookSecretRef: {
    provider: 'test',
    reference: 'github-webhook-secret',
    scope: ['github:webhook:verify']
  },
  scopes: [
    {
      repositoryId: 1_278_325_372,
      fullName: 'VF78/MSA',
      ownerId: 75_837_222,
      installationId: 1001,
      projectId,
      projectNumber: 3,
      projectNodeId: 'PVT_kwHOBIUvJs4Bbefq'
    },
    {
      repositoryId: 1_279_114_011,
      fullName: 'VF78/ascon',
      ownerId: 75_837_222,
      installationId: 1002,
      projectId: randomUUID(),
      projectNumber: 4,
      projectNodeId: 'PVT_kwHOBIUvJs4Bbi0Q'
    }
  ]
});
const secrets: SecretsProvider = {
  resolve: async () => ({value: secret})
};

const payload = (overrides: Record<string, unknown> = {}) => ({
  action: 'opened',
  installation: {id: 1001},
  repository: {
    id: 1_278_325_372,
    full_name: 'VF78/MSA',
    owner: {id: 75_837_222}
  },
  issue: {
    id: 501,
    number: 42,
    state: 'open',
    title: 'must not cross the boundary',
    body: 'must not cross the boundary'
  },
  ...overrides
});

const request = (
  value: unknown,
  overrides: Readonly<{
    event?: string;
    contentType?: string;
    signature?: string;
    contentLength?: string;
  }> = {}
): Request => {
  const body = JSON.stringify(value);
  const signature =
    overrides.signature ??
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return new Request('http://control-plane.test/api/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': overrides.contentType ?? 'application/json',
      'x-github-delivery': randomUUID(),
      'x-github-event': overrides.event ?? 'issues',
      'x-hub-signature-256': signature,
      ...(overrides.contentLength === undefined
        ? {}
        : {'content-length': overrides.contentLength})
    },
    body
  });
};

const handler = (
  status: 'accepted' | 'replayed' | 'collision' = 'accepted'
) => {
  const inputs: VerifiedIncomingEventInput[] = [];
  const ingestion: IncomingEventIngestionService = {
    ingest: vi.fn(async (input) => {
      inputs.push(input);
      return {status, eventId: randomUUID()};
    })
  };
  return {
    inputs,
    ingestion,
    handle: createGitHubWebhookHandler({
      workspaceId,
      config,
      secrets,
      ingestion
    })
  };
};

describe('GitHub webhook HTTP boundary', () => {
  it.each(['accepted', 'replayed', 'collision'] as const)(
    'acknowledges durable %s outcomes without exposing payload details',
    async (status) => {
      const boundary = handler(status);
      const response = await boundary.handle(request(payload()));

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({status});
      expect(boundary.inputs).toHaveLength(1);
      expect(boundary.inputs[0]).toMatchObject({
        workspaceId,
        projectId,
        provider: 'github',
        eventType: 'issues',
        projection: {issue: {id: 501, number: 42, state: 'open'}}
      });
      expect(JSON.stringify(boundary.inputs[0])).not.toMatch(/title|body/i);
    }
  );

  it.each([
    ['invalid signature', {signature: `sha256=${'0'.repeat(64)}`}, 401],
    ['invalid media type', {contentType: 'text/plain'}, 415],
    ['oversized body', {contentLength: String(2 * 1024 * 1024 + 1)}, 413],
    ['unauthorized installation', {}, 403]
  ] as const)('rejects %s before ingestion', async (_, overrides, status) => {
    const boundary = handler();
    const value =
      status === 403
        ? payload({installation: {id: 9999}})
        : payload();
    const response = await boundary.handle(request(value, overrides));

    expect(response.status).toBe(status);
    expect(boundary.ingestion.ingest).not.toHaveBeenCalled();
  });

  it('acknowledges signed ping and unsupported events without retry pressure', async () => {
    const boundary = handler();
    const ping = await boundary.handle(request({}, {event: 'ping'}));
    const unsupported = await boundary.handle(
      request({}, {event: 'projects_v2_item'})
    );

    expect(ping.status).toBe(204);
    expect(unsupported.status).toBe(204);
    expect(boundary.ingestion.ingest).not.toHaveBeenCalled();
  });
});
