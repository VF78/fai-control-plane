import type {
  AgentDeliveryPort,
  AgentExecutorResult,
  OpaqueSecretRef,
  SecretResolverPort
} from '@fai-control-plane/domain';
import {renderAgentRoleRequest, validateAgentRoleRequest} from '@fai-control-plane/domain';
import {agentTaskClasses} from '@fai-control-plane/domain';

type Fetch = typeof globalThis.fetch;
const purpose = 'agent_delivery';
const roleRunInstructions = `Execute the exact project-role request in the input JSON.
GitHub Project facts and stage changes MUST use fai_project_facts and fai_project_item_stage; never query projectItems through gh or GitHub GraphQL. gh is only for repository issues, branches, commits and pull requests.
Follow the requested role boundary and configured route exactly. Do not start another process stage.
Your final response MUST contain only one compact valid fai.agent-executor-result.v1 JSON object matching the receipt requested by the input. Do not add prose or Markdown fences.`;
const bounded = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');

const executorResult = (output: unknown): AgentExecutorResult | null => {
  if (!bounded(output, 65_536)) return null;
  const normalized = output.startsWith('```json\n') && output.endsWith('\n```')
    ? output.slice(8, -4) : output;
  let value: unknown;
  try { value = JSON.parse(normalized); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.contract !== 'fai.agent-executor-result.v1' ||
    (record.decision !== 'accepted' && record.decision !== 'rejected') || !bounded(record.reason, 4_000) ||
    !Array.isArray(record.evidence) || record.evidence.length === 0 || record.evidence.length > 20) return null;
  const execution = record.execution; const transition = record.transition;
  if (execution === null || typeof execution !== 'object' || Array.isArray(execution) ||
    transition === null || typeof transition !== 'object' || Array.isArray(transition) ||
    (record.outcome !== 'success' && record.outcome !== 'rework')) return null;
  const route = execution as Record<string, unknown>; const executor = route.executor;
  const moved = transition as Record<string, unknown>;
  if (!agentTaskClasses.includes(route.taskClass as never) || !bounded(route.model, 100) ||
    (route.effort !== 'medium' && route.effort !== 'high') || executor === null || typeof executor !== 'object' ||
    Array.isArray(executor) || !['direct-agent','cli'].includes(String((executor as Record<string, unknown>).kind)) ||
    ((executor as Record<string, unknown>).kind === 'cli' && !bounded((executor as Record<string, unknown>).id, 256)) ||
    !bounded(moved.itemId, 512) || !bounded(moved.fromVersion, 512) || !bounded(moved.targetStage, 200)) return null;
  const evidence = record.evidence.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const fact = entry as Record<string, unknown>;
    return bounded(fact.kind, 100) && bounded(fact.result, 2_000) ? [{kind: fact.kind, result: fact.result}] : [];
  });
  if (evidence.length !== record.evidence.length) return null;
  const rawDeliverables = record.deliverables === undefined ? [] : record.deliverables;
  if (!Array.isArray(rawDeliverables) || rawDeliverables.length > 10) return null;
  const deliverables = rawDeliverables.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const reference = entry as Record<string, unknown>;
    if (!bounded(reference.label, 200) || !bounded(reference.url, 2_048)) return [];
    let url: URL;
    try { url = new URL(reference.url); } catch { return []; }
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? [{label: reference.label, url: url.toString()}] : [];
  });
  if (deliverables.length !== rawDeliverables.length) return null;
  return {contract: 'fai.agent-executor-result.v1', decision: record.decision,
    execution: route as AgentExecutorResult['execution'], outcome: record.outcome,
    transition: moved as AgentExecutorResult['transition'], reason: record.reason, evidence, deliverables};
};

export const createHermesDeliveryAdapter = (input: Readonly<{
  endpoint: string;
  credentialRef: OpaqueSecretRef;
  secrets: SecretResolverPort;
  fetch?: Fetch;
  allowPrivateHttp?: boolean;
}>): AgentDeliveryPort => {
  const endpoint = new URL(input.endpoint);
  const privateHttp = input.allowPrivateHttp === true && endpoint.protocol === 'http:' &&
    !endpoint.hostname.includes('.');
  const runPath = endpoint.pathname === '/v1/runs' ||
    /^\/p\/[a-z0-9][a-z0-9-]{1,98}[a-z0-9]\/v1\/runs$/.test(endpoint.pathname);
  if ((endpoint.protocol !== 'https:' && !privateHttp) || endpoint.username !== '' || endpoint.password !== '' ||
    !runPath || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('agent_endpoint_invalid');
  }
  const request = input.fetch ?? globalThis.fetch;
  // This cache is verification context for accepted runs, not a scheduler or
  // lifecycle. Canonical attempt/receipt state remains in PostgreSQL.
  const submitted = new Map<string, Parameters<AgentDeliveryPort['submit']>[0]>();
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
      body: JSON.stringify({input: renderAgentRoleRequest(roleRequest), instructions: roleRunInstructions,
        session_id: roleRequest.correlationId,
        provider: 'openai-codex', model: 'gpt-5.6-terra', model_options: {reasoning_effort: 'medium'},
        orchestration: {kind: 'hermes-classifier', attempts: 1,
          executorRoute: 'resolve-from-input-policy-and-attest'}}),
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status !== 202) throw new Error('agent_delivery_failed');
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.run_id !== 'string' || value.run_id.length === 0 || value.run_id.length > 256 ||
      value.status !== 'started') {
      throw new Error('agent_response_invalid');
    }
    submitted.set(value.run_id, roleRequest);
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
    if (value.status === 'completed') {
      const result = executorResult(value.output);
      if (result === null) return {status: 'failed', failureCode: 'agent_result_invalid'};
      const expected = submitted.get(deliveryReference);
      if (expected !== undefined) {
        const route = expected.routing.policy.routes.find((candidate) => candidate.taskClass === result.execution.taskClass);
        const target = result.outcome === 'success' ? expected.process.successTargetTitle
          : expected.process.reworkTargetTitle ?? expected.process.stageTitle;
        if (route === undefined || JSON.stringify(route.executor) !== JSON.stringify(result.execution.executor) ||
          route.model !== result.execution.model || route.effort !== result.execution.effort ||
          result.transition.itemId !== expected.projectItem.id ||
          result.transition.fromVersion !== expected.observedVersion || target === null ||
          result.transition.targetStage !== target) {
          return {status: 'failed', failureCode: 'agent_result_invalid'};
        }
      }
      return result.decision === 'accepted' ? {status: 'completed', result}
        : {status: 'failed', failureCode: 'agent_result_rejected', result};
    }
    if (value.status === 'failed') return {status: 'failed', failureCode: 'provider_failed'};
    if (value.status === 'cancelled') return {status: 'failed', failureCode: 'provider_cancelled'};
    if (['started','queued','running','stopping','waiting_for_approval'].includes(value.status)) {
      return {status: 'started'};
    }
    throw new Error('agent_status_invalid');
  }};
};
