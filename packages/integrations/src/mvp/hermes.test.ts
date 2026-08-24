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
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({run_id: 'run_ref', status: 'started'}), {status: 202}));
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://agent.example.test/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch});
    await expect(adapter.submit(request)).resolves.toEqual({deliveryReference: 'run_ref', sessionReference: 'correlation'});
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {input: string; session_id: string;
      provider: string; model: string; model_options: {reasoning_effort: string}};
    expect(JSON.parse(body.input)).toMatchObject({contract: 'fai.agent-role-request.v1'});
    expect(body.session_id).toBe('correlation');
    expect(body).toMatchObject({provider: 'openai-codex', model: 'gpt-5.6-terra',
      model_options: {reasoning_effort: 'medium'}});
  });

  it('maps retained Hermes terminal status without exposing provider output', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({run_id: 'run_ref', status: 'failed', error: 'secret detail'})));
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch});
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'failed', failureCode: 'provider_failed'});
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://hermes.example/v1/runs/run_ref');
  });

  it('keeps an expired run unobservable instead of treating 404 as failure', async () => {
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async (_input, init) => {
        expect(init?.headers).toMatchObject({authorization: 'Bearer bearer'});
        return new Response(JSON.stringify({error: {code: 'run_not_found'}}), {status: 404});
      })});
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'unknown'});
  });

  it.each([null, {error: {code: 'proxy_not_found'}}, {error: 'run_not_found'}])(
    'fails closed for a generic 404 payload %#', async (payload) => {
      const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
        credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
        secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
          payload === null ? new Response('<html>nginx</html>', {status: 404})
            : new Response(JSON.stringify(payload), {status: 404}))});
      await expect(adapter.observe('run_ref')).rejects.toThrow('agent_status_failed');
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
