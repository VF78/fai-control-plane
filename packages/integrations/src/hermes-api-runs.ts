import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {
  renderAgentRoleInstructions,
  validateConversationInboundMessage,
  validateConversationRuntimeDeliveryAcknowledgement,
  type AgentRoleRequest,
  type ConversationInboundMessage,
  type ConversationRuntimeDeliveryAcknowledgement
} from '@fai-control-plane/domain';

export const hermesRunsSecretPurpose = 'hermes_api_runs_submit';
export const hermesRunsSecretScope = Object.freeze(['hermes:api:runs:submit']);
export class HermesRunsError extends Error { constructor(readonly code: 'identity_denied' | 'retryable' | 'invalid_ack' | 'invalid_request') { super(code); } }
type Fetch = (input: string, init: Readonly<{method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal}>) => Promise<Response>;
const validAck = (value: unknown): value is {run_id: string; status: 'started'} => {
  if (value === null || typeof value !== 'object') return false;
  const ack = value as Record<string, unknown>;
  return typeof ack.run_id === 'string' && ack.run_id.length > 0 && ack.run_id.length <= 256 &&
    !/[\0\r\n]/.test(ack.run_id) && ack.status === 'started';
};
const validBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && url.username === '' &&
      url.password === '' && (url.pathname === '' || url.pathname === '/') && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
};

export const createHermesApiRunsAdapter = (input: Readonly<{baseUrl: string; credentialRef: OpaqueSecretRef; secrets: SecretsProvider; fetch?: Fetch; timeoutMs?: number}>) => {
  if (!validBaseUrl(input.baseUrl) || input.credentialRef.provider !== 'file' ||
    input.credentialRef.scope.length !== hermesRunsSecretScope.length || input.credentialRef.scope.some((x, i) => x !== hermesRunsSecretScope[i])) throw new Error('hermes_runs_config_invalid');
  const fetch = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const start = async (
    runInput: string,
    sessionId: string,
    idempotencyKey: string,
    instructions: string
  ): Promise<ConversationRuntimeDeliveryAcknowledgement> => {
    if (idempotencyKey.length === 0 || idempotencyKey.length > 256 || /[\0\r\n]/.test(idempotencyKey)) {
      throw new HermesRunsError('invalid_ack');
    }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
    try {
      const secret = await input.secrets.resolve(input.credentialRef, hermesRunsSecretPurpose);
      if (secret.value.length === 0 || secret.value.length > 65_536 || /[\0\r\n]/.test(secret.value) || secret.value.trim() !== secret.value) {
        throw new HermesRunsError('identity_denied');
      }
      const response = await fetch(`${input.baseUrl.replace(/\/$/, '')}/v1/runs`, {method: 'POST', signal: controller.signal,
        headers: {'authorization': `Bearer ${secret.value}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey},
        body: JSON.stringify({input: runInput, session_id: sessionId, instructions})});
      if (!response.ok) throw new HermesRunsError(response.status === 401 || response.status === 403 ? 'identity_denied' : 'retryable');
      const ack: unknown = await response.json().catch(() => null);
      if (!validAck(ack)) throw new HermesRunsError('invalid_ack');
      const acknowledgement = validateConversationRuntimeDeliveryAcknowledgement({
        deliveryReference: ack.run_id,
        sessionReference: sessionId
      });
      if (acknowledgement === null) throw new HermesRunsError('invalid_ack');
      return acknowledgement;
    } catch (error) { if (error instanceof HermesRunsError) throw error; throw new HermesRunsError('retryable'); } finally { clearTimeout(timer); }
  };
  return {
    async submit(request: AgentRoleRequest): Promise<Readonly<{deliveryReference: string; sessionReference: string}>> {
      return start(
        renderAgentRoleInstructions(request),
        request.correlationId,
        request.idempotencyKey,
        'Use the bounded role request contract.'
      );
    },
    async deliver(value: ConversationInboundMessage): Promise<ConversationRuntimeDeliveryAcknowledgement> {
      const message = validateConversationInboundMessage(value);
      if (message === null) throw new HermesRunsError('invalid_request');
      const runInput = JSON.stringify({
        contractVersion: 1,
        projectRef: message.projectRef,
        channelRef: message.origin.channelRef,
        actorRef: message.origin.actorRef,
        messageRef: message.origin.messageRef,
        text: message.text,
        correlationId: message.correlationId,
        idempotencyKey: message.idempotencyKey
      });
      return start(
        runInput,
        message.correlationId,
        message.idempotencyKey,
        'Interpret one bounded project message using only the configured conversation capabilities.'
      );
    }
  };
};
