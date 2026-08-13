import {describe, expect, it, vi} from 'vitest';
import {createHermesApiRunsAdapter} from './hermes-api-runs';
const ref = {provider: 'file', reference: '/run/secrets/hermes', scope: ['hermes:api:runs:submit']};
const request = {role: 'qa' as const, repository: {id: 'github:repository:1', url: 'https://github.com/VF78/ascon'}, projectItem: {id: 'PVTI_1', projectId: 'PVT_1', issueId: 'github:issue:1', url: 'https://github.com/VF78/ascon/issues/1'}, observedVersion: 'v1', sourceReferences: [], constraints: [], acceptanceCriteria: [], approval: null, correlationId: 'c1', idempotencyKey: 'k1'};
const message = {
  projectRef: 'project:opaque',
  origin: {
    visibility: 'client' as const,
    channelRef: 'channel:opaque',
    actorRef: 'actor:opaque',
    messageRef: 'message:opaque',
    observedAt: '2026-08-13T00:00:00.000Z'
  },
  text: 'The report fails with error 500.',
  correlationId: 'conversation-c1',
  idempotencyKey: 'conversation-k1'
};
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
    const invalidAckAdapter = createHermesApiRunsAdapter({baseUrl: 'http://127.0.0.1:8642', credentialRef: ref, secrets: {resolve: async () => ({value: 'x'})}, fetch: vi.fn().mockResolvedValue(new Response('{}'))});
    await expect(invalidAckAdapter.submit(request)).rejects.toMatchObject({code: 'invalid_ack'});
  });
  it('rejects unsafe identity and non-TLS remote configuration before egress', async () => {
    const fetch = vi.fn();
    const adapter = createHermesApiRunsAdapter({baseUrl: 'http://127.0.0.1:8642', credentialRef: ref, secrets: {resolve: async () => ({value: 'secret\nvalue'})}, fetch});
    await expect(adapter.submit(request)).rejects.toMatchObject({code: 'identity_denied'});
    expect(fetch).not.toHaveBeenCalled();
    expect(() => createHermesApiRunsAdapter({baseUrl: 'http://hermes.internal:8642', credentialRef: ref, secrets: {resolve: async () => ({value: 'x'})}}))
      .toThrow('hermes_runs_config_invalid');
  });
  it('delivers one bounded message with an exact whitelisted runtime input', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({run_id: 'run_conversation', status: 'started'})));
    const adapter = createHermesApiRunsAdapter({baseUrl: 'http://127.0.0.1:8642', credentialRef: ref, secrets: {resolve: async () => ({value: 'never-log-me'})}, fetch});
    await expect(adapter.deliver(message)).resolves.toEqual({
      deliveryReference: 'run_conversation', sessionReference: 'conversation-c1'
    });
    const init = fetch.mock.calls[0]![1];
    expect(init.headers['idempotency-key']).toBe('conversation-k1');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'session_id']);
    expect(body.session_id).toBe('conversation-c1');
    expect(JSON.parse(body.input as string)).toEqual({
      contractVersion: 1,
      projectRef: 'project:opaque',
      channelRef: 'channel:opaque',
      actorRef: 'actor:opaque',
      messageRef: 'message:opaque',
      text: 'The report fails with error 500.',
      correlationId: 'conversation-c1',
      idempotencyKey: 'conversation-k1'
    });
    expect(init.body).not.toContain('visibility');
    expect(init.body).not.toContain('observedAt');
    expect(init.body).not.toContain('never-log-me');
    const invalidFetch = vi.fn();
    const resolve = vi.fn();
    const invalidAdapter = createHermesApiRunsAdapter({baseUrl: 'http://127.0.0.1:8642', credentialRef: ref, secrets: {resolve}, fetch: invalidFetch});
    await expect(invalidAdapter.deliver({...message, text: ''})).rejects.toMatchObject({code: 'invalid_request'});
    expect(resolve).not.toHaveBeenCalled();
    expect(invalidFetch).not.toHaveBeenCalled();
  });
});
