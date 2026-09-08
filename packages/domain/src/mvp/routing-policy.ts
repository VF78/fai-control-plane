import {isBoundedId} from './model.ts';

export const agentTaskClasses = [
  'manager_project_ops', 'ordinary_implementation', 'ui_responsive', 'complex_implementation',
  'qa_audit', 'architecture_design', 'critical_decision', 'release_preflight', 'protected_operation'
] as const;
export type AgentTaskClass = (typeof agentTaskClasses)[number];
export type AgentRoute = Readonly<{
  taskClass: AgentTaskClass;
  executor: Readonly<{kind: 'direct-agent'}> | Readonly<{kind: 'cli'; id: string}>;
  model: string;
  effort: 'medium' | 'high';
  runtimeAcceptance: 'required';
  humanGate: 'none' | 'product_visual' | 'architecture_decision' | 'production_exact';
}>;
export type AgentRoutingPolicy = Readonly<{contract: 'fai.agent-routing.v1'; routes: readonly AgentRoute[]}>;
export type AgentExecutorCatalog = Readonly<Record<string, Readonly<{
  available: boolean; models: readonly string[];
}>>>;

export const defaultAgentRoutingPolicy: AgentRoutingPolicy = {contract: 'fai.agent-routing.v1', routes: [
  {taskClass: 'manager_project_ops', executor: {kind: 'direct-agent'}, model: 'gpt-5.6-terra', effort: 'medium', runtimeAcceptance: 'required', humanGate: 'none'},
  {taskClass: 'ordinary_implementation', executor: {kind: 'cli', id: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'medium', runtimeAcceptance: 'required', humanGate: 'none'},
  {taskClass: 'ui_responsive', executor: {kind: 'cli', id: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'high', runtimeAcceptance: 'required', humanGate: 'product_visual'},
  {taskClass: 'complex_implementation', executor: {kind: 'cli', id: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'high', runtimeAcceptance: 'required', humanGate: 'none'},
  {taskClass: 'qa_audit', executor: {kind: 'cli', id: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'medium', runtimeAcceptance: 'required', humanGate: 'none'},
  {taskClass: 'architecture_design', executor: {kind: 'cli', id: 'codex-cli'}, model: 'gpt-6-astra', effort: 'medium', runtimeAcceptance: 'required', humanGate: 'architecture_decision'},
  {taskClass: 'critical_decision', executor: {kind: 'cli', id: 'codex-cli'}, model: 'gpt-6-astra', effort: 'high', runtimeAcceptance: 'required', humanGate: 'architecture_decision'},
  {taskClass: 'release_preflight', executor: {kind: 'cli', id: 'codex-cli'}, model: 'gpt-5.6-sol', effort: 'medium', runtimeAcceptance: 'required', humanGate: 'none'},
  {taskClass: 'protected_operation', executor: {kind: 'direct-agent'}, model: 'gpt-5.6-sol', effort: 'medium', runtimeAcceptance: 'required', humanGate: 'production_exact'}
]};

export const parseAgentRoutingPolicy = (value: unknown): AgentRoutingPolicy | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const policy = value as Partial<AgentRoutingPolicy>;
  if (policy.contract !== 'fai.agent-routing.v1' || !Array.isArray(policy.routes) ||
    policy.routes.length !== agentTaskClasses.length) return null;
  const routes: AgentRoute[] = [];
  for (const candidate of policy.routes as unknown[]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const route = candidate as Record<string, unknown>; const executor = route.executor;
    if (!agentTaskClasses.includes(route.taskClass as AgentTaskClass) ||
      typeof route.model !== 'string' || !isBoundedId(route.model) ||
      !['medium', 'high'].includes(String(route.effort)) || route.runtimeAcceptance !== 'required' ||
      !['none', 'product_visual', 'architecture_decision', 'production_exact'].includes(String(route.humanGate)) ||
      executor === null || typeof executor !== 'object' || Array.isArray(executor)) return null;
    const typedExecutor = executor as Record<string, unknown>;
    if (typedExecutor.kind !== 'direct-agent' && (typedExecutor.kind !== 'cli' ||
      !isBoundedId(typedExecutor.id))) return null;
    const typedRoute = route as unknown as AgentRoute;
    const cliRequired = ['ordinary_implementation', 'ui_responsive', 'complex_implementation',
      'qa_audit'].includes(typedRoute.taskClass);
    const directRequired = typedRoute.taskClass === 'protected_operation';
    if ((cliRequired && typedRoute.executor.kind !== 'cli') ||
      (directRequired && typedRoute.executor.kind !== 'direct-agent')) return null;
    if ((typedRoute.taskClass === 'ui_responsive' && typedRoute.humanGate !== 'product_visual') ||
      (['architecture_design', 'critical_decision'].includes(typedRoute.taskClass) &&
        typedRoute.humanGate !== 'architecture_decision') ||
      (typedRoute.taskClass === 'protected_operation' && typedRoute.humanGate !== 'production_exact') ||
      (!['ui_responsive', 'architecture_design', 'critical_decision', 'protected_operation'].includes(
        typedRoute.taskClass) && typedRoute.humanGate !== 'none')) return null;
    routes.push(typedRoute);
  }
  if (new Set(routes.map((route) => route.taskClass)).size !== agentTaskClasses.length) return null;
  return {contract: 'fai.agent-routing.v1', routes};
};

export const resolveAgentRoute = (policy: AgentRoutingPolicy, taskClass: string,
  catalog: AgentExecutorCatalog): AgentRoute => {
  if (!isBoundedId(taskClass) || parseAgentRoutingPolicy(policy) === null) throw new Error('agent_route_denied');
  const route = policy.routes.find((candidate) => candidate.taskClass === taskClass);
  if (route === undefined) throw new Error('agent_route_denied');
  if (route.executor.kind === 'cli') {
    const executor = catalog[route.executor.id];
    if (executor === undefined || !executor.available || !executor.models.includes(route.model)) throw new Error('agent_executor_unavailable');
  }
  return route;
};

export const assertAgentRoutingPolicyAvailable = (policy: AgentRoutingPolicy,
  catalog: AgentExecutorCatalog): void => {
  if (parseAgentRoutingPolicy(policy) === null) throw new Error('agent_route_denied');
  for (const taskClass of agentTaskClasses) resolveAgentRoute(policy, taskClass, catalog);
};
