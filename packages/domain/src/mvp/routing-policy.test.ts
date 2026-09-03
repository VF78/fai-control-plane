import {describe, expect, it} from 'vitest';
import {assertAgentRoutingPolicyAvailable, defaultAgentRoutingPolicy, parseAgentRoutingPolicy, resolveAgentRoute,
  type AgentRoutingPolicy} from './routing-policy.ts';

const catalog = {['codex-cli']: {available: true, models: ['gpt-5.6-terra', 'gpt-5.6-sol']},
  ['claude-code-cli']: {available: false, models: []}} as const;

describe('Hermes routing policy', () => {
  it('routes ordinary work to Codex CLI Terra medium', () => {
    expect(resolveAgentRoute(defaultAgentRoutingPolicy, 'ordinary_implementation', catalog)).toMatchObject({
      executor: {kind: 'cli', id: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'medium'
    });
  });
  it('routes repository architecture and critical decisions to Codex with the approved Sol effort', () => {
    expect(resolveAgentRoute(defaultAgentRoutingPolicy, 'architecture_design', catalog)).toMatchObject({
      executor: {kind: 'cli', id: 'codex-cli'}, model: 'gpt-5.6-sol', effort: 'medium'
    });
    expect(resolveAgentRoute(defaultAgentRoutingPolicy, 'critical_decision', catalog)).toMatchObject({
      executor: {kind: 'cli', id: 'codex-cli'}, model: 'gpt-5.6-sol', effort: 'high'
    });
  });
  it('denies unknown classes and unavailable future executors', () => {
    expect(() => resolveAgentRoute(defaultAgentRoutingPolicy, 'unknown', catalog)).toThrow('agent_route_denied');
    const future: AgentRoutingPolicy = {...defaultAgentRoutingPolicy, routes: defaultAgentRoutingPolicy.routes.map(
      (route) => route.taskClass === 'ordinary_implementation'
        ? {...route, executor: {kind: 'cli', id: 'claude-code-cli'}} : route)};
    expect(() => resolveAgentRoute(future, 'ordinary_implementation', catalog))
      .toThrow('agent_executor_unavailable');
  });
  it('denies the complete policy when any configured CLI route is unavailable', () => {
    expect(() => assertAgentRoutingPolicyAvailable(defaultAgentRoutingPolicy, {...catalog,
      'codex-cli': {available: false, models: []}})).toThrow('agent_executor_unavailable');
    const claude: AgentRoutingPolicy = {...defaultAgentRoutingPolicy,
      routes: defaultAgentRoutingPolicy.routes.map((route) => route.taskClass === 'ordinary_implementation'
        ? {...route, executor: {kind: 'cli', id: 'claude-code-cli'}} : route)};
    expect(() => assertAgentRoutingPolicyAvailable(claude, catalog)).toThrow('agent_executor_unavailable');
  });
  it('rejects duplicate or unknown task classes', () => {
    const duplicate: AgentRoutingPolicy = {...defaultAgentRoutingPolicy, routes: defaultAgentRoutingPolicy.routes.map(
      (route, index) => index === 1 ? {...route, taskClass: 'manager_project_ops'} : route)};
    expect(parseAgentRoutingPolicy(duplicate)).toBeNull();
  });
  it('accepts a bounded alternative model when its configured executor exposes it', () => {
    const policy = {...defaultAgentRoutingPolicy, routes: defaultAgentRoutingPolicy.routes.map((route,index) =>
      index === 1 ? {...route,executor:{kind:'cli' as const,id:'claude-code-cli'},model:'claude-sonnet'} : route)};
    expect(parseAgentRoutingPolicy(policy)).not.toBeNull();
    expect(resolveAgentRoute(policy,'ordinary_implementation',{...catalog,
      'claude-code-cli':{available:true,models:['claude-sonnet']}})).toMatchObject({
        executor:{kind:'cli',id:'claude-code-cli'},model:'claude-sonnet'});
  });
  it('rejects unbounded or multiline model identifiers', () => {
    const replace=(model:string)=>({...defaultAgentRoutingPolicy,routes:defaultAgentRoutingPolicy.routes.map((route,index)=>
      index===0?{...route,model}:route)});
    expect(parseAgentRoutingPolicy(replace('line one\nline two'))).toBeNull();
    expect(parseAgentRoutingPolicy(replace('x'.repeat(257)))).toBeNull();
  });
  it('keeps implementation in CLI, protected operations direct, and exact gates bounded', () => {
    const replace = (taskClass: AgentRoutingPolicy['routes'][number]['taskClass'], change: object) => ({
      ...defaultAgentRoutingPolicy, routes: defaultAgentRoutingPolicy.routes.map((route) =>
        route.taskClass === taskClass ? {...route, ...change} : route)
    });
    expect(parseAgentRoutingPolicy(replace('ordinary_implementation', {executor: {kind: 'direct-agent'}})))
      .toBeNull();
    expect(parseAgentRoutingPolicy(replace('protected_operation', {
      executor: {kind: 'cli', id: 'codex-cli'}}))).toBeNull();
    expect(parseAgentRoutingPolicy(replace('release_preflight', {humanGate: 'production_exact'}))).toBeNull();
    expect(defaultAgentRoutingPolicy.routes.find((route) => route.taskClass === 'release_preflight')?.humanGate)
      .toBe('none');
  });
  it('allows non-implementation work to switch between Hermes and an available CLI', () => {
    const replace = (taskClass: AgentRoutingPolicy['routes'][number]['taskClass'], executor: object) => ({
      ...defaultAgentRoutingPolicy, routes: defaultAgentRoutingPolicy.routes.map((route) =>
        route.taskClass === taskClass ? {...route, executor} : route)
    });
    expect(parseAgentRoutingPolicy(replace('manager_project_ops', {kind: 'cli', id: 'codex-cli'})))
      .not.toBeNull();
    expect(parseAgentRoutingPolicy(replace('architecture_design', {kind: 'cli', id: 'codex-cli'})))
      .not.toBeNull();
    expect(parseAgentRoutingPolicy(replace('critical_decision', {kind: 'cli', id: 'codex-cli'})))
      .not.toBeNull();
    expect(parseAgentRoutingPolicy(replace('release_preflight', {kind: 'direct-agent'}))).not.toBeNull();
  });
});
