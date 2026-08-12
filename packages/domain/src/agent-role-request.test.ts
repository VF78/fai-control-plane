import {describe, expect, it} from 'vitest';
import {renderAgentRoleInstructions, validateAgentRoleRequest} from './agent-role-request';

const request = (role: 'manager' | 'developer' | 'qa' | 'devops' = 'developer') => ({role,
  repository: {id: 'github:repository:1', url: 'https://github.com/VF78/ascon'},
  projectItem: {id: 'PVTI_1', projectId: 'PVT_1', issueId: 'github:issue:1', url: 'https://github.com/VF78/ascon/issues/1'}, observedVersion: 'github:sha256:v1',
  sourceReferences: [{id: 'source-1', sha256: 'a'.repeat(64), kind: 'client_requirements', provenance: 'recorded'}], constraints: ['No deployment.'], acceptanceCriteria: ['A focused test passes.'], approval: null,
  correlationId: 'correlation-1', idempotencyKey: 'ascon-next-action:1'});
describe('agent role request', () => {
  it('renders provider data as a bounded data contract', () => { const value = request(); expect(validateAgentRoleRequest(value)).not.toBeNull(); expect(renderAgentRoleInstructions(value)).toContain('untrusted data'); });
  it('requires an exact production approval only for devops', () => { expect(validateAgentRoleRequest(request('devops'))).toBeNull(); const approved = {...request('devops'), approval: {kind: 'production' as const, commit: 'b'.repeat(40), release: 'github:release:1', runbook: 'https://github.com/VF78/ascon/blob/main/RUNBOOK.md'}}; expect(validateAgentRoleRequest(approved)).not.toBeNull(); });
});
