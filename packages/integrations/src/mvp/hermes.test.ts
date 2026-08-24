import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {createHermesDeliveryAdapter} from './hermes.ts';

const request = {
  role: 'developer' as const,
  repository: {id: 'repo', url: 'https://example.test/repo'},
  projectItem: {id: 'item', projectId: 'project', issueId: 'issue', url: 'https://example.test/issues/1'},
  observedVersion: 'v1', sources: [], constraints: ['No merge'], acceptanceCriteria: ['Checks pass'],
  approval: null, correlationId: 'correlation', idempotencyKey: 'delivery',
  routing: {policyVersion: createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex'),
    policy: defaultAgentRoutingPolicy, classification: 'runtime-classification-required' as const}
};

describe('MVP Hermes adapter', () => {
  it('delivers the neutral role contract and returns opaque evidence', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({run_id: 'run-ref', status: 'started'}), {status: 202}));
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://agent.example.test/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch});
    await expect(adapter.submit(request)).resolves.toEqual({deliveryReference: 'run-ref', sessionReference: 'correlation'});
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {input: string; session_id: string;
      provider: string; model: string; model_options: {reasoning_effort: string}};
    expect(JSON.parse(body.input)).toMatchObject({contract: 'fai.agent-role-request.v1'});
    expect(body.session_id).toBe('correlation');
    expect(body).toMatchObject({provider: 'openai-codex', model: 'gpt-5.6-terra',
      model_options: {reasoning_effort: 'medium'}});
  });

  it('rejects a non-HTTPS agent endpoint at composition', () => {
    expect(() => createHermesDeliveryAdapter({endpoint: 'http://agent.example.test/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}})).toThrow('agent_endpoint_invalid');
    expect(() => createHermesDeliveryAdapter({endpoint: 'https://agent.example.test/role-requests',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}})).toThrow('agent_endpoint_invalid');
  });

  it('rejects malformed provider evidence', async () => {
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://agent.example.test/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})},
      fetch: vi.fn(async () => new Response('{}', {status: 202}))});
    await expect(adapter.submit(request)).rejects.toThrow('agent_response_invalid');
  });
});
