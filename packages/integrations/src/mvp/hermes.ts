import type {
  AgentDeliveryPort,
  OpaqueSecretRef,
  SecretResolverPort
} from '@fai-control-plane/domain';
import {renderAgentRoleRequest, validateAgentRoleRequest} from '@fai-control-plane/domain';

type Fetch = typeof globalThis.fetch;
const purpose = 'agent_delivery';

export const createHermesDeliveryAdapter = (input: Readonly<{
  endpoint: string;
  credentialRef: OpaqueSecretRef;
  secrets: SecretResolverPort;
  fetch?: Fetch;
}>): AgentDeliveryPort => {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.pathname !== '/v1/runs' || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('agent_endpoint_invalid');
  }
  const request = input.fetch ?? globalThis.fetch;
  const authorization = async (): Promise<string> => {
    const token = (await input.secrets.resolve(input.credentialRef, purpose)).value;
    if (token.length === 0 || token.length > 65_536 || token.includes('\0')) throw new Error('agent_credential_invalid');
    return `Bearer ${token}`;
  };
  return {async submit(roleRequest) {
    if (!validateAgentRoleRequest(roleRequest)) throw new Error('agent_request_invalid');
    const response = await request(endpoint, {
      method: 'POST',
      headers: {accept: 'application/json', authorization: await authorization(), 'content-type': 'application/json'},
      body: JSON.stringify({input: renderAgentRoleRequest(roleRequest), session_id: roleRequest.correlationId,
        provider: 'openai-codex', model: 'gpt-5.6-terra',
        model_options: {reasoning_effort: 'medium'}}),
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status !== 202) throw new Error('agent_delivery_failed');
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.run_id !== 'string' || value.run_id.length === 0 || value.run_id.length > 256 ||
      value.status !== 'started') {
      throw new Error('agent_response_invalid');
    }
    return {deliveryReference: value.run_id, sessionReference: roleRequest.correlationId};
  }, async observe(deliveryReference) {
    if (!/^run_[A-Za-z0-9_-]{1,250}$/.test(deliveryReference)) throw new Error('agent_attempt_reference_invalid');
    const statusEndpoint = new URL(`${endpoint.pathname}/${encodeURIComponent(deliveryReference)}`, endpoint);
    const response = await request(statusEndpoint, {method: 'GET', headers: {
      accept: 'application/json', authorization: await authorization()
    }, signal: AbortSignal.timeout(15_000)});
    if (response.status === 404) {
      let missing: unknown;
      try { missing = await response.json(); } catch { throw new Error('agent_status_failed'); }
      if (missing !== null && typeof missing === 'object' && !Array.isArray(missing) &&
        (missing as {error?: unknown}).error !== null && typeof (missing as {error?: unknown}).error === 'object' &&
        !Array.isArray((missing as {error?: unknown}).error) &&
        (missing as {error: {code?: unknown}}).error.code === 'run_not_found') return {status: 'unknown'};
      throw new Error('agent_status_failed');
    }
    if (!response.ok) throw new Error('agent_status_failed');
    const value = await response.json() as Record<string, unknown>;
    if (value.run_id !== deliveryReference || typeof value.status !== 'string') throw new Error('agent_status_invalid');
    if (value.status === 'completed') return {status: 'completed'};
    if (value.status === 'failed') return {status: 'failed', failureCode: 'provider_failed'};
    if (value.status === 'cancelled') return {status: 'failed', failureCode: 'provider_cancelled'};
    if (['started','queued','running','stopping','waiting_for_approval'].includes(value.status)) {
      return {status: 'started'};
    }
    throw new Error('agent_status_invalid');
  }};
};
