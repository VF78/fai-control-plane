import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {renderAgentRoleRequest, validateAgentRoleRequest} from './agent-role-request.ts';
import {defaultHermesRoutingPolicy} from './routing-policy.ts';
import type {AgentRoleRequest} from './ports.ts';

const request = (role: AgentRoleRequest['role'] = 'developer'): AgentRoleRequest => ({
  role,
  repository: {id: 'repo-1', url: 'https://example.test/repository'},
  projectItem: {id: 'item-1', projectId: 'project-1', issueId: 'issue-1', url: 'https://example.test/issues/1'},
  observedVersion: 'version-1',
  sources: [{id: 'source-1', sha256: 'a'.repeat(64), kind: 'requirements', provenance: 'operator upload',
    content: 'Approved requirements'}],
  constraints: ['Do not merge'],
  acceptanceCriteria: ['Focused checks pass'],
  approval: null,
  routing: {policyVersion: createHash('sha256').update(JSON.stringify(defaultHermesRoutingPolicy)).digest('hex'),
    policy: defaultHermesRoutingPolicy, classification: 'hermes-manager-required'},
  correlationId: 'correlation-1',
  idempotencyKey: 'delivery-1'
});
describe('MVP agent role request', () => {
  it('accepts a bounded non-production request', () => {
    expect(validateAgentRoleRequest(request())).toBe(true);
  });

  it('rejects devops without exact production approval', () => {
    expect(validateAgentRoleRequest(request('devops'))).toBe(false);
  });

  it('accepts devops with approval bound to the observed version', () => {
    const value = request('devops');
    expect(validateAgentRoleRequest({...value, approval: {
      id: 'approval-1', projectId: 'project-1', kind: 'production', decision: 'approved',
      actorId: 'actor-1', target: {id: 'commit-1', url: 'https://example.test/commit/1', version: 'version-1'},
      decidedAt: '2026-08-13T00:00:00.000Z', idempotencyKey: 'approval-command-1'
    }})).toBe(true);
  });

  it('renders the immutable policy and deterministic Hermes classification/execution contract', () => {
    expect(JSON.parse(renderAgentRoleRequest(request()))).toMatchObject({
      contract: 'fai.agent-role-request.v1', request: {role: 'developer', routing: {
        classification: 'hermes-manager-required', policy: {contract: 'fai.hermes-routing.v1'}}},
      execution: {classification: {by: 'hermes-manager', unknown: 'deny', unavailableRoute: 'deny'},
        cli: {routeFieldsAreExact: ['provider', 'model', 'effort'], resultContract: 'fai.hermes-executor-result.v1'},
        acceptance: {evidenceRequired: true, stageMutation: 'only-after-accepted'}}
    });
    expect(renderAgentRoleRequest(request())).toContain('codex-cli');
  });

  it('rejects a stale policy version while allowing the manager work route to be configured', () => {
    const value = request();
    expect(validateAgentRoleRequest({...value, routing: {...value.routing, policyVersion: 'a'.repeat(64)}})).toBe(false);
    const policy = {...defaultHermesRoutingPolicy, routes: defaultHermesRoutingPolicy.routes.map((route) =>
      route.taskClass === 'manager_project_ops' ? {...route, model: 'gpt-5.6-sol' as const} : route)};
    expect(validateAgentRoleRequest({...value, routing: {...value.routing, policy,
      policyVersion: createHash('sha256').update(JSON.stringify(policy)).digest('hex')}})).toBe(true);
  });

  it('rejects more than 64 KiB of selected UTF-8 source text', () => {
    const value = request();
    expect(validateAgentRoleRequest({...value, sources: [{...value.sources[0]!, content: 'я'.repeat(32_769)}]}))
      .toBe(false);
  });
});
