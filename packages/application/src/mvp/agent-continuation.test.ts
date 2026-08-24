import {describe, expect, it, vi} from 'vitest';
import {continueExplicitAgentChain} from './agent-continuation.ts';

const item = {itemId: 'item', projectId: 'project', issueId: 'issue', title: 'Task', body: '', url: 'https://example.test/1',
  statusOptionId: 'qa', statusOptionName: 'QA', ownerOptionId: 'agent', ownerOptionName: 'Hermes', blocked: false,
  assigneeIds: [], assignees: [], version: 'v2', targetDate: null, parentIssueId: null, subIssueIds: [],
  dependencyIssueIds: [], updatedAt: '2026-08-24T00:00:00.000Z', observedAt: '2026-08-24T00:00:00.000Z'} as const;

describe('bounded policy-driven agent continuation', () => {
  it('does nothing without an accepted explicit developer chain', async () => {
    const submit = vi.fn();
    await expect(continueExplicitAgentChain({projectId: 'project', item, stage: {agentRole: 'qa', afterRoles: ['developer'], maxStarts: 2},
      stores: {resolveActor: async () => null},
      instructions: () => ({constraints: ['qa'], acceptanceCriteria: ['evidence']}),
      ports: submit as never})).resolves.toBe('not-authorized');
    expect(submit).not.toHaveBeenCalled();
  });

  it('does nothing when the current project stage has no automation setting', async () => {
    await expect(continueExplicitAgentChain({projectId: 'project', item: {...item, statusOptionName: 'In Dev'}, stage: null,
      stores: {resolveActor: vi.fn()},
      instructions: () => ({constraints: ['qa'], acceptanceCriteria: ['evidence']}),
      ports: {} as never})).resolves.toBe('not-authorized');
  });
});
