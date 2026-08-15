import {describe, expect, it, vi} from 'vitest';
import type {TrackerSnapshot} from '@fai-control-plane/domain';
import type {AgentSubmissionPorts} from './agent-submission.ts';
import {submitExplicitAgent} from './agent-submission.ts';

const snapshot: TrackerSnapshot = {bindingId: 'binding', externalVersion: 'snapshot-v1', cursor: null,
  observedAt: '2026-08-15T10:00:00.000Z', sourceUrl: 'https://github.com/users/VF78/projects/1', items: [{
    itemId: 'PVTI_item', projectId: 'project', issueId: '210', title: 'GUI recovery',
    url: 'https://github.com/VF78/fai-control-plane/issues/210', version: 'github:updated-at:v1',
    statusOptionId: 'ready', statusOptionName: 'Ready', ownerOptionId: 'owner-hermes', blocked: false, targetDate: null,
    parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: [],
    observedAt: '2026-08-15T10:00:00.000Z'}]};
const task = snapshot.items[0]!;

const ports = (role: 'project_owner'|'operator'|'contributor' = 'operator'): AgentSubmissionPorts => ({
  resolveContext: async () => ({workspaceId: 'workspace', projectId: 'project', requesterRole: role,
    bindingId: 'binding', repository: {id: 'R_repo', url: 'https://github.com/VF78/fai-control-plane'},
    agentTrackerOwnerOptionId: 'owner-hermes', doneStatusOptionId: 'done'}),
  readFreshSnapshot: async () => snapshot, persistSnapshot: async () => undefined,
  resolveSources: async () => [{id: 'source', sha256: 'a'.repeat(64), kind: 'requirements', provenance: 'operator',
    content: 'Approved source text'}],
  repository: {readRepository: async () => ({repositoryId: 'R_repo',
    url: 'https://github.com/VF78/fai-control-plane', defaultBranch: 'main', observedAt: '2026-08-15T10:00:00.000Z'})},
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
      observedVersion: 'github:updated-at:v1', constraints: ['Do not deploy'],
      sources: [{id: 'source', content: 'Approved source text'}]});
  });

  it('rejects aggregate selected source text above 64 KiB before delivery', async () => {
    const base = ports();
    const value: AgentSubmissionPorts = {...base, resolveSources: async () => [{id: 'source',
      sha256: 'a'.repeat(64), kind: 'requirements', provenance: 'operator', content: 'я'.repeat(32_769)}]};
    const deliver = vi.spyOn(value.delivery, 'submit');
    await expect(submitExplicitAgent(command, value)).rejects.toThrow('agent_source_payload_too_large');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('never exposes the devops/production role on this seam', async () => {
    await expect(submitExplicitAgent({...command, role: 'devops'}, ports('project_owner')))
      .rejects.toThrow('agent_submit_denied');
  });

  it('denies a Done task even when it is assigned exactly to Hermes', async () => {
    const base = ports();
    const value: AgentSubmissionPorts = {...base, readFreshSnapshot: async () => ({...snapshot, items: [
      {...task, statusOptionId: 'done'}
    ]})};
    const deliver = vi.spyOn(value.delivery, 'submit');
    await expect(submitExplicitAgent(command, value)).rejects.toThrow('agent_submit_denied');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('denies a non-Done task without the exact Hermes Owner option', async () => {
    for (const ownerOptionId of [null, 'owner-other', 'OWNER-HERMES']) {
      const base = ports();
      const value: AgentSubmissionPorts = {...base, readFreshSnapshot: async () => ({...snapshot, items: [
        {...task, ownerOptionId}
      ]})};
      const deliver = vi.spyOn(value.delivery, 'submit');
      await expect(submitExplicitAgent(command, value)).rejects.toThrow('agent_submit_denied');
      expect(deliver).not.toHaveBeenCalled();
    }
  });

  it('allows an exact assigned non-Done task and refreshes it immediately before delivery', async () => {
    const order: string[] = [];
    const base = ports();
    const value: AgentSubmissionPorts = {...base,
      resolveSources: async (input) => { order.push('sources'); return base.resolveSources(input); },
      repository: {readRepository: async (input) => { order.push('repository'); return base.repository.readRepository(input); }},
      readFreshSnapshot: async () => { order.push('fresh-snapshot'); return snapshot; },
      persistSnapshot: async () => { order.push('persist-snapshot'); },
      delivery: {submit: async (request) => { order.push('delivery'); return base.delivery.submit(request); }}
    };
    await expect(submitExplicitAgent(command, value)).resolves.toMatchObject({status: 'completed'});
    expect(order).toEqual(['repository', 'sources', 'fresh-snapshot', 'persist-snapshot', 'delivery']);
  });
});
