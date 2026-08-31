import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {renderAgentRoleRequest, validateAgentRoleRequest} from './agent-role-request.ts';
import {defaultAgentRoutingPolicy} from './routing-policy.ts';
import type {AgentRoleRequest} from './ports.ts';

const request = (role: AgentRoleRequest['role'] = 'developer'): AgentRoleRequest => ({
  role,
  repository: {id: 'repo-1', url: 'https://example.test/repository', defaultBranch: 'main',
    defaultBranchSha: 'a'.repeat(40)},
  projectItem: {id: 'item-1', projectId: 'project-1', issueId: 'issue-1', title: 'Fix the exact issue',
    url: 'https://example.test/issues/1'},
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

  it('requires a bounded task title for classification without another provider read', () => {
    const value = request();
    expect(validateAgentRoleRequest({...value, projectItem: {...value.projectItem, title: ''}})).toBe(false);
    expect(validateAgentRoleRequest({...value, projectItem: {...value.projectItem,
      title: 'x'.repeat(513)}})).toBe(false);
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

  it('renders the compact task contract without resending project sources or chat history', () => {
    const value=request();
    expect(JSON.parse(renderAgentRoleRequest(value))).toEqual({
      contract:'fai.agent-role-request.v1',
      task:{role:'developer',stage:{id:'in-dev',title:'In Dev'},issueUrl:'https://example.test/issues/1'},
      versions:{process:'b'.repeat(64),routing:value.routing.policyVersion},
      receipt:{correlationId:'correlation-1',idempotencyKey:'delivery-1',
        contract:'fai.agent-executor-result.v1'}});
    const rendered = renderAgentRoleRequest(request());
    expect(rendered).not.toContain('codex-cli');
    expect(rendered).not.toContain('repository');
    expect(rendered).not.toContain('defaultBranch');
    expect(rendered).not.toContain('routing.policy');
    expect(rendered).not.toContain('sources');
    expect(rendered).not.toContain('constraints');
    expect(rendered).not.toContain('acceptanceCriteria');
    expect(rendered).not.toContain('profile');
    expect(rendered).not.toContain('documents');
    expect(rendered).not.toContain('chat');
    expect(rendered).not.toContain('chatHistory');
    expect(rendered).not.toContain('approval');
    expect(rendered).not.toContain('project-1');
    expect(rendered).not.toContain('repo-1');
    expect(rendered).not.toContain('issue-1');
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
