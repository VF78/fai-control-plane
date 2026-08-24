import {isBoundedId} from './model.ts';

export const hermesTaskClasses = [
  'manager_project_ops', 'ordinary_implementation', 'ui_responsive', 'complex_implementation',
  'qa_audit', 'architecture_design', 'critical_decision', 'release_preflight', 'protected_operation'
] as const;
export type HermesTaskClass = (typeof hermesTaskClasses)[number];
export type HermesCliProvider = 'codex-cli' | 'claude-code-cli';
export type HermesRoute = Readonly<{
  taskClass: HermesTaskClass;
  executor: Readonly<{kind: 'direct-hermes'}> | Readonly<{kind: 'cli'; provider: HermesCliProvider}>;
  model: 'gpt-5.6-terra' | 'gpt-5.6-sol';
  effort: 'medium' | 'high';
  hermesAcceptance: 'required';
  humanGate: 'none' | 'product_visual' | 'architecture_decision' | 'production_exact';
}>;
export type HermesRoutingPolicy = Readonly<{contract: 'fai.hermes-routing.v1'; routes: readonly HermesRoute[]}>;
export type HermesExecutorCatalog = Readonly<Record<HermesCliProvider, Readonly<{
  available: boolean; models: readonly string[];
}>>>;

export const defaultHermesRoutingPolicy: HermesRoutingPolicy = {contract: 'fai.hermes-routing.v1', routes: [
  {taskClass: 'manager_project_ops', executor: {kind: 'direct-hermes'}, model: 'gpt-5.6-terra', effort: 'medium', hermesAcceptance: 'required', humanGate: 'none'},
  {taskClass: 'ordinary_implementation', executor: {kind: 'cli', provider: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'medium', hermesAcceptance: 'required', humanGate: 'none'},
  {taskClass: 'ui_responsive', executor: {kind: 'cli', provider: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'high', hermesAcceptance: 'required', humanGate: 'product_visual'},
  {taskClass: 'complex_implementation', executor: {kind: 'cli', provider: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'high', hermesAcceptance: 'required', humanGate: 'none'},
  {taskClass: 'qa_audit', executor: {kind: 'cli', provider: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'medium', hermesAcceptance: 'required', humanGate: 'none'},
  {taskClass: 'architecture_design', executor: {kind: 'direct-hermes'}, model: 'gpt-5.6-sol', effort: 'medium', hermesAcceptance: 'required', humanGate: 'architecture_decision'},
  {taskClass: 'critical_decision', executor: {kind: 'direct-hermes'}, model: 'gpt-5.6-sol', effort: 'high', hermesAcceptance: 'required', humanGate: 'architecture_decision'},
  {taskClass: 'release_preflight', executor: {kind: 'cli', provider: 'codex-cli'}, model: 'gpt-5.6-sol', effort: 'medium', hermesAcceptance: 'required', humanGate: 'none'},
  {taskClass: 'protected_operation', executor: {kind: 'direct-hermes'}, model: 'gpt-5.6-sol', effort: 'medium', hermesAcceptance: 'required', humanGate: 'production_exact'}
]};

export const parseHermesRoutingPolicy = (value: unknown): HermesRoutingPolicy | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const policy = value as Partial<HermesRoutingPolicy>;
  if (policy.contract !== 'fai.hermes-routing.v1' || !Array.isArray(policy.routes) ||
    policy.routes.length !== hermesTaskClasses.length) return null;
  const routes: HermesRoute[] = [];
  for (const candidate of policy.routes as unknown[]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const route = candidate as Record<string, unknown>; const executor = route.executor;
    if (!hermesTaskClasses.includes(route.taskClass as HermesTaskClass) ||
      !['gpt-5.6-terra', 'gpt-5.6-sol'].includes(String(route.model)) ||
      !['medium', 'high'].includes(String(route.effort)) || route.hermesAcceptance !== 'required' ||
      !['none', 'product_visual', 'architecture_decision', 'production_exact'].includes(String(route.humanGate)) ||
      executor === null || typeof executor !== 'object' || Array.isArray(executor)) return null;
    const typedExecutor = executor as Record<string, unknown>;
    if (typedExecutor.kind !== 'direct-hermes' && (typedExecutor.kind !== 'cli' ||
      !['codex-cli', 'claude-code-cli'].includes(String(typedExecutor.provider)))) return null;
    const typedRoute = route as unknown as HermesRoute;
    const cliRequired = ['ordinary_implementation', 'ui_responsive', 'complex_implementation',
      'qa_audit'].includes(typedRoute.taskClass);
    const directRequired = typedRoute.taskClass === 'protected_operation';
    if ((cliRequired && typedRoute.executor.kind !== 'cli') ||
      (directRequired && typedRoute.executor.kind !== 'direct-hermes')) return null;
    if ((typedRoute.taskClass === 'ui_responsive' && typedRoute.humanGate !== 'product_visual') ||
      (['architecture_design', 'critical_decision'].includes(typedRoute.taskClass) &&
        typedRoute.humanGate !== 'architecture_decision') ||
      (typedRoute.taskClass === 'protected_operation' && typedRoute.humanGate !== 'production_exact') ||
      (!['ui_responsive', 'architecture_design', 'critical_decision', 'protected_operation'].includes(
        typedRoute.taskClass) && typedRoute.humanGate !== 'none')) return null;
    routes.push(typedRoute);
  }
  if (new Set(routes.map((route) => route.taskClass)).size !== hermesTaskClasses.length) return null;
  return {contract: 'fai.hermes-routing.v1', routes};
};

export const resolveHermesRoute = (policy: HermesRoutingPolicy, taskClass: string,
  catalog: HermesExecutorCatalog): HermesRoute => {
  if (!isBoundedId(taskClass) || parseHermesRoutingPolicy(policy) === null) throw new Error('hermes_route_denied');
  const route = policy.routes.find((candidate) => candidate.taskClass === taskClass);
  if (route === undefined) throw new Error('hermes_route_denied');
  if (route.executor.kind === 'cli') {
    const provider = catalog[route.executor.provider];
    if (!provider.available || !provider.models.includes(route.model)) throw new Error('hermes_executor_unavailable');
  }
  return route;
};

export const assertHermesRoutingPolicyAvailable = (policy: HermesRoutingPolicy,
  catalog: HermesExecutorCatalog): void => {
  if (parseHermesRoutingPolicy(policy) === null) throw new Error('hermes_route_denied');
  for (const taskClass of hermesTaskClasses) resolveHermesRoute(policy, taskClass, catalog);
};
