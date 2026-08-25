import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {createHermesDeliveryAdapter} from './hermes.ts';

const request = {
  role: 'developer' as const,
  repository: {id: 'repo', url: 'https://example.test/repo', defaultBranch: 'main',
    defaultBranchSha: 'a'.repeat(40)},
  projectItem: {id: 'item', projectId: 'project', issueId: 'issue', url: 'https://example.test/issues/1'},
  observedVersion: 'v1', sources: [], constraints: ['No merge'], acceptanceCriteria: ['Checks pass'],
  approval: null, correlationId: `browser:${'c'.repeat(64)}`, idempotencyKey: 'delivery',
  routing: {policyVersion: createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex'),
    policy: defaultAgentRoutingPolicy, classification: 'runtime-classification-required' as const}
  ,process: {policyVersion: 'b'.repeat(64), stageId: 'in-dev', stageTitle: 'In Dev',
    successTargetTitle: 'QA', reworkTargetTitle: null}
};
const attestation = {execution: {taskClass: 'ordinary_implementation' as const,
  executor: {kind: 'cli' as const, id: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'medium' as const},
outcome: 'success' as const, transition: {itemId: 'item', fromVersion: 'v1', targetStage: 'QA', toVersion: 'v2'}};

describe('MVP Hermes adapter', () => {
  it('delivers the neutral role contract and returns opaque evidence', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({run_id: 'run_ref', status: 'started'}), {status: 202}));
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://agent.example.test/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch});
    await expect(adapter.submit(request)).resolves.toEqual({deliveryReference: 'run_ref', sessionReference: request.correlationId});
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {input: string; session_id: string;
      provider: string; model: string; model_options: {reasoning_effort: string}};
    expect(JSON.parse(body.input)).toMatchObject({contract: 'fai.agent-role-request.v1'});
    expect(body.session_id).toBe(request.correlationId);
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

  it('accepts only the bounded executor-result contract and preserves stable deliverable links', async () => {
    const result = {contract: 'fai.agent-executor-result.v1', decision: 'accepted', ...attestation,
      reason: 'Ready for QA',
      evidence: [{kind: 'checks', result: 'Focused tests passed'}],
      deliverables: [{label: 'Review document', url: 'https://example.test/result.docx'}]};
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
        new Response(JSON.stringify({run_id: 'run_ref', status: 'completed', output: JSON.stringify(result)})))});
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'completed', result});
  });

  it('maps a rejected executor result to failure', async () => {
    const result = {contract: 'fai.agent-executor-result.v1', decision: 'rejected', ...attestation,
      outcome: 'rework' as const, reason: 'Repository unavailable',
      evidence: [{kind: 'source_access', result: 'No checkout'}]};
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
        new Response(JSON.stringify({run_id: 'run_ref', status: 'completed', output: JSON.stringify(result)})))});
    await expect(adapter.observe('run_ref')).resolves.toMatchObject({status: 'failed',
      failureCode: 'agent_result_rejected', result: {...result, deliverables: []}});
  });

  it('accepts direct-agent results', async () => {
    const result = {contract: 'fai.agent-executor-result.v1', decision: 'accepted',
      execution: {taskClass: 'manager_project_ops', executor: {kind: 'direct-agent'},
        model: 'gpt-5.6-terra', effort: 'medium'}, outcome: 'success',
      transition: attestation.transition, reason: 'planned', evidence: [{kind: 'plan', result: 'ready'}]};
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})},
      fetch: vi.fn(async () => new Response(JSON.stringify({run_id: 'run_ref', status: 'completed',
        output: JSON.stringify(result)})))});
    await expect(adapter.observe('run_ref')).resolves.toMatchObject({status: 'completed'});
  });

  it.each([undefined, 'not-json', JSON.stringify({contract: 'other', decision: 'accepted'})])(
    'fails closed when a completed run has no valid executor result %#', async (output) => {
      const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
        credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
        secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
          new Response(JSON.stringify({run_id: 'run_ref', status: 'completed', ...(output === undefined ? {} : {output})})))});
      await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'failed', failureCode: 'agent_result_invalid'});
    });

  it('fails closed when an accepted executor result has no evidence', async () => {
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
        new Response(JSON.stringify({run_id: 'run_ref', status: 'completed', output: JSON.stringify({
          contract: 'fai.agent-executor-result.v1', decision: 'accepted', ...attestation, reason: 'done', evidence: []
        })})))});
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'failed', failureCode: 'agent_result_invalid'});
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
