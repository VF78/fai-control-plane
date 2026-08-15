import {describe, expect, it} from 'vitest';
import {renderAgentRoleRequest, validateAgentRoleRequest} from './agent-role-request.ts';
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

  it('renders one stable external contract without executor details', () => {
    expect(JSON.parse(renderAgentRoleRequest(request()))).toMatchObject({
      contract: 'fai.agent-role-request.v1', request: {role: 'developer'}
    });
    expect(renderAgentRoleRequest(request())).not.toContain('codex-cli');
  });

  it('rejects more than 64 KiB of selected UTF-8 source text', () => {
    const value = request();
    expect(validateAgentRoleRequest({...value, sources: [{...value.sources[0]!, content: 'я'.repeat(32_769)}]}))
      .toBe(false);
  });
});
