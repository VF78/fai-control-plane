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
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new Error('agent_endpoint_invalid');
  }
  const request = input.fetch ?? globalThis.fetch;
  return {async submit(roleRequest) {
    if (!validateAgentRoleRequest(roleRequest)) throw new Error('agent_request_invalid');
    const token = (await input.secrets.resolve(input.credentialRef, purpose)).value;
    if (token.length === 0 || token.length > 65_536 || token.includes('\0')) throw new Error('agent_credential_invalid');
    const response = await request(endpoint, {
      method: 'POST',
      headers: {accept: 'application/json', authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      body: renderAgentRoleRequest(roleRequest),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error('agent_delivery_failed');
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.deliveryReference !== 'string' || typeof value.sessionReference !== 'string' ||
      value.deliveryReference.length === 0 || value.sessionReference.length === 0) {
      throw new Error('agent_response_invalid');
    }
    return {deliveryReference: value.deliveryReference, sessionReference: value.sessionReference};
  }};
};
