import {describe, expect, it, vi} from 'vitest';
import {createHermesApiRunsAdapter} from './hermes-api-runs';
const ref = {provider: 'file', reference: '/run/secrets/hermes', scope: ['hermes:api:runs:submit']};
const request = {role: 'qa' as const, repository: {id: 'github:repository:1', url: 'https://github.com/VF78/ascon'}, projectItem: {id: 'PVTI_1', projectId: 'PVT_1', issueId: 'github:issue:1', url: 'https://github.com/VF78/ascon/issues/1'}, observedVersion: 'v1', sourceReferences: [], constraints: [], acceptanceCriteria: [], approval: null, correlationId: 'c1', idempotencyKey: 'k1'};
describe('Hermes runs adapter', () => {
  it('sends only the documented run request and returns correlation evidence', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({run_id: 'run_1', status: 'started'})));
    const adapter = createHermesApiRunsAdapter({baseUrl: 'http://127.0.0.1:8642', credentialRef: ref, secrets: {resolve: async () => ({value: 'never-log-me'})}, fetch});
    await expect(adapter.submit(request)).resolves.toEqual({deliveryReference: 'run_1', sessionReference: 'c1'});
    const call = fetch.mock.calls[0];
    expect(call).toBeDefined();
    const init = call![1];
    expect(init.headers.authorization).toBe('Bearer never-log-me');
    expect(JSON.parse(init.body)).toMatchObject({session_id: 'c1'});
  });
  it('rejects a non-started acknowledgement', async () => {
    const adapter = createHermesApiRunsAdapter({baseUrl: 'http://127.0.0.1:8642', credentialRef: ref, secrets: {resolve: async () => ({value: 'x'})}, fetch: vi.fn().mockResolvedValue(new Response('{}'))});
    await expect(adapter.submit(request)).rejects.toMatchObject({code: 'invalid_ack'});
  });
  it('rejects a secret containing header control characters before egress', async () => {
    const fetch = vi.fn();
    const adapter = createHermesApiRunsAdapter({baseUrl: 'http://127.0.0.1:8642', credentialRef: ref, secrets: {resolve: async () => ({value: 'secret\nvalue'})}, fetch});
    await expect(adapter.submit(request)).rejects.toMatchObject({code: 'identity_denied'});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires TLS except for a loopback Hermes server', () => {
    expect(() => createHermesApiRunsAdapter({baseUrl: 'http://hermes.internal:8642', credentialRef: ref, secrets: {resolve: async () => ({value: 'x'})}}))
      .toThrow('hermes_runs_config_invalid');
  });
});
