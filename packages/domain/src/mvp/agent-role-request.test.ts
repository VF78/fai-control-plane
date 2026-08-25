import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {renderAgentRoleRequest, validateAgentRoleRequest} from './agent-role-request.ts';
import {defaultAgentRoutingPolicy} from './routing-policy.ts';
import type {AgentRoleRequest} from './ports.ts';

const request = (role: AgentRoleRequest['role'] = 'developer'): AgentRoleRequest => ({
  role,
  repository: {id: 'repo-1', url: 'https://example.test/repository', defaultBranch: 'main',
    defaultBranchSha: 'a'.repeat(40)},
  projectItem: {id: 'item-1', projectId: 'project-1', issueId: 'issue-1', url: 'https://example.test/issues/1'},
  observedVersion: 'version-1',
  sources: [{id: 'source-1', sha256: 'a'.repeat(64), kind: 'requirements', provenance: 'operator upload',
    content: 'Approved requirements'}],
  constraints: ['Do not merge'],
  acceptanceCriteria: ['Focused checks pass'],
  approval: null,
  routing: {policyVersion: createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex'),
    policy: defaultAgentRoutingPolicy, classification: 'runtime-classification-required'},
  process: {policyVersion: 'b'.repeat(64), stageId: 'in-dev', stageTitle: 'In Dev',
    successTargetTitle: 'QA', reworkTargetTitle: null},
  correlationId: 'correlation-1',
  idempotencyKey: 'delivery-1'
});
describe('MVP agent role request', () => {
  it('accepts a bounded non-production request', () => {
    expect(validateAgentRoleRequest(request())).toBe(true);
  });

  it('rejects a missing or malformed pinned repository base', () => {
    const value = request();
    expect(validateAgentRoleRequest({...value, repository: {...value.repository, defaultBranch: ''}})).toBe(false);
    expect(validateAgentRoleRequest({...value, repository: {...value.repository,
      defaultBranchSha: 'not-a-commit'}})).toBe(false);
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
        classification: 'runtime-classification-required', policy: {contract: 'fai.agent-routing.v1'}}},
      execution: {classification: {by: 'agent-runtime', unknown: 'deny', unavailableRoute: 'deny'},
        cli: {routeFieldsAreExact: ['id', 'model', 'effort'], attempts: 1,
          resultContract: 'fai.agent-executor-result.v1'},
        acceptance: {evidenceRequired: true, stageMutation: 'control-plane-after-accepted',
          exactResultFields: ['contract', 'decision', 'execution', 'outcome', 'transition', 'reason',
            'evidence', 'deliverables'],
          rejectedWithoutReworkTarget: 'request-current-stage',
          deliverables: 'bounded-https-references'}}
    });
    expect(renderAgentRoleRequest(request())).toContain('codex-cli');
  });

  it('rejects a stale policy version while allowing the manager work route to be configured', () => {
    const value = request();
    expect(validateAgentRoleRequest({...value, routing: {...value.routing, policyVersion: 'a'.repeat(64)}})).toBe(false);
    const policy = {...defaultAgentRoutingPolicy, routes: defaultAgentRoutingPolicy.routes.map((route) =>
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
