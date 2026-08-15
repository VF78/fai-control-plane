import {describe, expect, it, vi} from 'vitest';
import type {AgentSubmissionPorts} from './agent-submission.ts';
import {submitExplicitAgent} from './agent-submission.ts';

const snapshot = {bindingId: 'binding', externalVersion: 'snapshot-v1', cursor: null,
  observedAt: '2026-08-15T10:00:00.000Z', sourceUrl: 'https://github.com/users/VF78/projects/1', items: [{
    itemId: 'PVTI_item', projectId: 'project', issueId: '210', title: 'GUI recovery',
    url: 'https://github.com/VF78/fai-control-plane/issues/210', version: 'github:updated-at:v1',
    statusOptionId: 'ready', statusOptionName: 'Ready', blocked: false, targetDate: null,
    parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: [],
    observedAt: '2026-08-15T10:00:00.000Z'}]};

const ports = (role: 'project_owner'|'operator'|'contributor' = 'operator'): AgentSubmissionPorts => ({
  resolveContext: async () => ({workspaceId: 'workspace', projectId: 'project', requesterRole: role,
    bindingId: 'binding', repository: {id: 'R_repo', url: 'https://github.com/VF78/fai-control-plane'}}),
  readFreshSnapshot: async () => snapshot, persistSnapshot: async () => undefined,
  resolveSources: async () => [{id: 'source', sha256: 'a'.repeat(64), kind: 'requirements', provenance: 'operator'}],
  delivery: {submit: async (request) => ({deliveryReference: `hermes:${request.idempotencyKey}`,
    sessionReference: request.correlationId})},
  transaction: {execute: async (_input, submit) => ({status: 'completed', ...(await submit())})}
});
const command = {actorId: 'actor', projectId: 'project', projectItemId: 'PVTI_item', role: 'developer' as const,
  sourceIds: ['source'], constraints: ['Do not deploy'], acceptanceCriteria: ['Focused tests pass']};

describe('explicit agent submission', () => {
  it('denies inactive/disallowed membership before reading a provider or delivering', async () => {
    const value = ports('contributor'); const read = vi.spyOn(value, 'readFreshSnapshot'); const deliver = vi.spyOn(value.delivery, 'submit');
    await expect(submitExplicitAgent(command, value)).rejects.toThrow('agent_submit_denied');
    expect(read).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
  });

  it('derives stable request idempotency and lets the canonical transaction return a duplicate', async () => {
    const seen = new Map<string, string>(); const base = ports();
    const value: AgentSubmissionPorts = {...base, transaction: {execute: async (input, submit) => {
      const prior = seen.get(input.idempotencyKey);
      if (prior !== undefined) return {status: 'duplicate', deliveryReference: prior};
      const delivered = await submit(); seen.set(input.idempotencyKey, delivered.deliveryReference);
      return {status: 'completed', deliveryReference: delivered.deliveryReference};
    }}};
    const deliver = vi.spyOn(value.delivery, 'submit');
    await expect(submitExplicitAgent(command, value)).resolves.toMatchObject({status: 'completed'});
    await expect(submitExplicitAgent(command, value)).resolves.toMatchObject({status: 'duplicate'});
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]).toMatchObject({projectItem: {id: 'PVTI_item', projectId: 'project'},
      observedVersion: 'github:updated-at:v1', constraints: ['Do not deploy']});
  });

  it('never exposes the devops/production role on this seam', async () => {
    await expect(submitExplicitAgent({...command, role: 'devops'}, ports('project_owner')))
      .rejects.toThrow('agent_submit_denied');
  });
});
