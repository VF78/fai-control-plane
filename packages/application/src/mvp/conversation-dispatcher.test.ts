import {describe, expect, it, vi} from 'vitest';
import {dispatchClientConversationAction, dispatchConversationAction, type ReceiptBoundRoleRun} from './conversation-dispatcher.ts';
import type {ClientConversationEnvelope, InternalConversationEnvelope, ProjectRole} from '@fai-control-plane/domain';

const envelope: ClientConversationEnvelope = {message: {projectId: 'project', contour: 'client-edge',
  channelReference: 'channel', senderReference: 'sender', messageReference: 'message',
  observedAt: '2026-08-13T00:00:00.000Z', text: '/issue Defect | Fails', correlationId: 'correlation',
  idempotencyKey: 'message-key'}, action: {type: 'issue.create', title: 'Defect', statement: 'Fails'}};
const ports = (identity: {actorId: string; role: ProjectRole} | null = {actorId: 'human', role: 'client'}) => ({
  facts: {read: vi.fn(async () => ({referenceId: 'snapshot-1'}))},
  tracker: {createIssue: vi.fn(async () => ({referenceId: 'issue-1', url: 'https://example.test/1', version: 'v1'})),
    updateIssue: vi.fn(async () => ({referenceId: 'issue-1', url: 'https://example.test/1', version: 'v2'})),
    addIssueContext: vi.fn(async () => ({referenceId: 'issue-1', url: 'https://example.test/1', version: 'v2'})),
    setProjectItemStage: vi.fn(async () => ({referenceId: 'item-1', url: 'https://example.test/project', version: 'v2'}))},
  approvals: {decide: vi.fn(async () => ({referenceId: 'approval-1'}))},
  sources: {add: vi.fn(async () => ({referenceId: 'source-1'}))},
  identities: {resolveActiveHuman: vi.fn(async () => identity)},
  receipts: {exists: vi.fn(async () => false), record: vi.fn(async () => undefined)},
  completion: {complete: vi.fn(async () => 'recorded' as const)}
});
describe('client conversation trust boundary', () => {
  it('creates one bounded issue without an agent port', async () => {
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope, ports: ports()}))
      .resolves.toEqual({status: 'completed', referenceId: 'issue-1'});
  });
  it('denies an unmapped approval sender', async () => {
    const target = ports(null); const approval: ClientConversationEnvelope = {...envelope,
      action: {type: 'approval.decide', approvalId: 'approval', kind: 'client_uat', targetReference: 'issue', decision: 'approved'}};
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope: approval, ports: target}))
      .resolves.toEqual({status: 'denied'});
    expect(target.approvals.decide).not.toHaveBeenCalled();
  });
  it('denies an unmapped sender before an issue mutation', async () => {
    const target = ports(null);
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope, ports: target}))
      .resolves.toEqual({status: 'denied'});
    expect(target.tracker.createIssue).not.toHaveBeenCalled();
  });
  it('denies an unmapped sender before reading project facts', async () => {
    const target = ports(null); const facts: ClientConversationEnvelope = {...envelope,
      action: {type: 'project_facts.read'}};
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope: facts, ports: target}))
      .resolves.toEqual({status: 'denied'});
    expect(target.facts.read).not.toHaveBeenCalled();
  });
  it('never exposes Project stage mutation to the client contour', async () => {
    const target = ports({actorId: 'client-a', role: 'client'}); const stage: ClientConversationEnvelope = {...envelope,
      action: {type: 'project_item.stage', itemId: 'item', issueId: '42', expectedVersion: 'v1', stage: 'QA'}};
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope: stage, ports: target}))
      .resolves.toEqual({status: 'denied'});
    expect(target.tracker.setProjectItemStage).not.toHaveBeenCalled();
  });
  it('adds bounded source context as the exact resolved client actor', async () => {
    const target = ports({actorId: 'client-a', role: 'client'}); const source: ClientConversationEnvelope = {...envelope,
      action: {type: 'source.add', name: 'Protocol', content: 'Expected result'}};
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope: source, ports: target}))
      .resolves.toEqual({status: 'completed', referenceId: 'source-1'});
    expect(target.sources.add).toHaveBeenCalledWith(expect.objectContaining({actorId: 'client-a'}));
  });
});

describe('receipt-bound role-run authority', () => {
  const sessionId = `browser:${'a'.repeat(64)}`;
  const roleRun: ReceiptBoundRoleRun = {sessionId, actorId: 'requester', projectId: 'project',
    requesterRole: 'operator', role: 'developer', itemId: 'item', observedVersion: 'v1',
    occurredAt: '2026-08-13T00:00:00.000Z'};
  const internal = (action: InternalConversationEnvelope['action']): InternalConversationEnvelope => ({
    message: {...envelope.message, contour: 'trusted-main', correlationId: sessionId}, action});

  it('allows only the developer transition for the exact receipt item and version', async () => {
    const target = ports({actorId: 'must-not-resolve', role: 'client'});
    await expect(dispatchConversationAction({workspaceId: 'workspace', ports: target, roleRun,
      envelope: internal({type: 'project_item.stage', itemId: 'item', issueId: '42', expectedVersion: 'v1', stage: 'QA'})}))
      .resolves.toMatchObject({status: 'completed'});
    expect(target.identities.resolveActiveHuman).not.toHaveBeenCalled();
    expect(target.tracker.setProjectItemStage).toHaveBeenCalledOnce();
  });

  it.each([
    ['project', 'other', 'v1', 'developer'],
    ['project', 'item', 'other', 'developer'],
    ['other', 'item', 'v1', 'developer'],
    ['project', 'item', 'v1', 'manager']
  ] as const)('denies mismatched project/item/version/role', async (projectId, itemId, version, role) => {
    const target = ports(); const bound = {...roleRun, projectId, role};
    await expect(dispatchConversationAction({workspaceId: 'workspace', ports: target, roleRun: bound,
      envelope: internal({type: 'project_item.stage', itemId, issueId: '42', expectedVersion: version, stage: 'QA'})}))
      .resolves.toEqual({status: 'denied'});
    expect(target.tracker.setProjectItemStage).not.toHaveBeenCalled();
  });

  it('denies client requesters, approvals, issue updates by non-manager, and Done', async () => {
    for (const [bound, action] of [
      [{...roleRun, requesterRole: 'client' as const}, {type: 'project_item.stage', itemId: 'item', issueId: '42', expectedVersion: 'v1', stage: 'QA'}],
      [roleRun, {type: 'approval.decide', approvalId: 'a', kind: 'plan', targetReference: 'item', decision: 'approved'}],
      [roleRun, {type: 'issue.update', itemId: 'item', issueId: '42', expectedVersion: 'v1', operation: 'title', value: 'New'}],
      [roleRun, {type: 'project_item.stage', itemId: 'item', issueId: '42', expectedVersion: 'v1', stage: 'Done'}]
    ] as const) {
      const target = ports();
      await expect(dispatchConversationAction({workspaceId: 'workspace', ports: target, roleRun: bound,
        envelope: internal(action as InternalConversationEnvelope['action'])})).resolves.toEqual({status: 'denied'});
      expect(target.tracker.setProjectItemStage).not.toHaveBeenCalled();
      expect(target.tracker.updateIssue).not.toHaveBeenCalled();
    }
  });

  it('allows manager issue update only for its exact item and version', async () => {
    const target = ports();
    await expect(dispatchConversationAction({workspaceId: 'workspace', ports: target,
      roleRun: {...roleRun, role: 'manager'}, envelope: internal({type: 'issue.update', itemId: 'item',
        issueId: '42', expectedVersion: 'v1', operation: 'body', value: 'Bounded body'})}))
      .resolves.toMatchObject({status: 'completed', referenceId: 'issue-1'});
    expect(target.tracker.updateIssue).toHaveBeenCalledOnce();
  });

  it('allows only a receipt-bound manager to create a bounded issue in the same project', async () => {
    const manager = ports();
    await expect(dispatchConversationAction({workspaceId: 'workspace', ports: manager,
      roleRun: {...roleRun, role: 'manager'}, envelope: internal({type: 'issue.create', title: 'Plan',
        statement: 'Bounded project work'})})).resolves.toMatchObject({status: 'completed', referenceId: 'issue-1'});
    expect(manager.tracker.createIssue).toHaveBeenCalledOnce();
    const developer = ports();
    await expect(dispatchConversationAction({workspaceId: 'workspace', ports: developer, roleRun,
      envelope: internal({type: 'issue.create', title: 'Forged', statement: 'Must be denied'})}))
      .resolves.toEqual({status: 'denied'});
    expect(developer.tracker.createIssue).not.toHaveBeenCalled();
  });
});
