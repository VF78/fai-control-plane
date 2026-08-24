import {describe, expect, it} from 'vitest';
import {assertHermesRoutingPolicyAvailable, defaultHermesRoutingPolicy, parseHermesRoutingPolicy, resolveHermesRoute,
  type HermesRoutingPolicy} from './routing-policy.ts';

const catalog = {['codex-cli']: {available: true, models: ['gpt-5.6-terra', 'gpt-5.6-sol']},
  ['claude-code-cli']: {available: false, models: []}} as const;

describe('Hermes routing policy', () => {
  it('routes ordinary work to Codex CLI Terra medium', () => {
    expect(resolveHermesRoute(defaultHermesRoutingPolicy, 'ordinary_implementation', catalog)).toMatchObject({
      executor: {kind: 'cli', provider: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'medium'
    });
  });
  it('denies unknown classes and unavailable future executors', () => {
    expect(() => resolveHermesRoute(defaultHermesRoutingPolicy, 'unknown', catalog)).toThrow('hermes_route_denied');
    const future: HermesRoutingPolicy = {...defaultHermesRoutingPolicy, routes: defaultHermesRoutingPolicy.routes.map(
      (route) => route.taskClass === 'ordinary_implementation'
        ? {...route, executor: {kind: 'cli', provider: 'claude-code-cli'}} : route)};
    expect(() => resolveHermesRoute(future, 'ordinary_implementation', catalog))
      .toThrow('hermes_executor_unavailable');
  });
  it('denies the complete policy when any configured CLI route is unavailable', () => {
    expect(() => assertHermesRoutingPolicyAvailable(defaultHermesRoutingPolicy, {...catalog,
      'codex-cli': {available: false, models: []}})).toThrow('hermes_executor_unavailable');
    const claude: HermesRoutingPolicy = {...defaultHermesRoutingPolicy,
      routes: defaultHermesRoutingPolicy.routes.map((route) => route.taskClass === 'ordinary_implementation'
        ? {...route, executor: {kind: 'cli', provider: 'claude-code-cli'}} : route)};
    expect(() => assertHermesRoutingPolicyAvailable(claude, catalog)).toThrow('hermes_executor_unavailable');
  });
  it('rejects duplicate or unknown task classes', () => {
    const duplicate: HermesRoutingPolicy = {...defaultHermesRoutingPolicy, routes: defaultHermesRoutingPolicy.routes.map(
      (route, index) => index === 1 ? {...route, taskClass: 'manager_project_ops'} : route)};
    expect(parseHermesRoutingPolicy(duplicate)).toBeNull();
  });
  it('keeps implementation in CLI, protected operations direct, and exact gates bounded', () => {
    const replace = (taskClass: HermesRoutingPolicy['routes'][number]['taskClass'], change: object) => ({
      ...defaultHermesRoutingPolicy, routes: defaultHermesRoutingPolicy.routes.map((route) =>
        route.taskClass === taskClass ? {...route, ...change} : route)
    });
    expect(parseHermesRoutingPolicy(replace('ordinary_implementation', {executor: {kind: 'direct-hermes'}})))
      .toBeNull();
    expect(parseHermesRoutingPolicy(replace('protected_operation', {
      executor: {kind: 'cli', provider: 'codex-cli'}}))).toBeNull();
    expect(parseHermesRoutingPolicy(replace('release_preflight', {humanGate: 'production_exact'}))).toBeNull();
    expect(defaultHermesRoutingPolicy.routes.find((route) => route.taskClass === 'release_preflight')?.humanGate)
      .toBe('none');
  });
  it('allows non-implementation work to switch between Hermes and an available CLI', () => {
    const replace = (taskClass: HermesRoutingPolicy['routes'][number]['taskClass'], executor: object) => ({
      ...defaultHermesRoutingPolicy, routes: defaultHermesRoutingPolicy.routes.map((route) =>
        route.taskClass === taskClass ? {...route, executor} : route)
    });
    expect(parseHermesRoutingPolicy(replace('manager_project_ops', {kind: 'cli', provider: 'codex-cli'})))
      .not.toBeNull();
    expect(parseHermesRoutingPolicy(replace('architecture_design', {kind: 'cli', provider: 'codex-cli'})))
      .not.toBeNull();
    expect(parseHermesRoutingPolicy(replace('critical_decision', {kind: 'cli', provider: 'codex-cli'})))
      .not.toBeNull();
    expect(parseHermesRoutingPolicy(replace('release_preflight', {kind: 'direct-hermes'}))).not.toBeNull();
  });
});
