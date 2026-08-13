import {describe, expect, it, vi} from 'vitest';
import {createHermesDeliveryAdapter} from './hermes.ts';

const request = {
  role: 'developer' as const,
  repository: {id: 'repo', url: 'https://example.test/repo'},
  projectItem: {id: 'item', projectId: 'project', issueId: 'issue', url: 'https://example.test/issues/1'},
  observedVersion: 'v1', sources: [], constraints: ['No merge'], acceptanceCriteria: ['Checks pass'],
  approval: null, correlationId: 'correlation', idempotencyKey: 'delivery'
};

describe('MVP Hermes adapter', () => {
  it('delivers the neutral role contract and returns opaque evidence', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({deliveryReference: 'delivery-ref', sessionReference: 'session-ref'}), {status: 202}));
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://agent.example.test/role-requests',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch});
    await expect(adapter.submit(request)).resolves.toEqual({deliveryReference: 'delivery-ref', sessionReference: 'session-ref'});
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({contract: 'fai.agent-role-request.v1'});
  });

  it('rejects a non-HTTPS agent endpoint at composition', () => {
    expect(() => createHermesDeliveryAdapter({endpoint: 'http://agent.example.test/requests',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}})).toThrow('agent_endpoint_invalid');
  });

  it('rejects malformed provider evidence', async () => {
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://agent.example.test/role-requests',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})},
      fetch: vi.fn(async () => new Response('{}', {status: 202}))});
    await expect(adapter.submit(request)).rejects.toThrow('agent_response_invalid');
  });
});
