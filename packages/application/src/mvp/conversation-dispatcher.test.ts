import {describe, expect, it, vi} from 'vitest';
import {dispatchClientConversationAction, dispatchConversationAction} from './conversation-dispatcher.ts';
import type {AgentRoleRequest, ClientConversationEnvelope, InternalConversationEnvelope, ProjectRole} from '@fai-control-plane/domain';

const envelope: ClientConversationEnvelope = {message: {projectId: 'project', contour: 'client-edge',
  channelReference: 'channel', senderReference: 'sender', messageReference: 'message',
  observedAt: '2026-08-13T00:00:00.000Z', text: '/issue Defect | Fails', correlationId: 'correlation',
  idempotencyKey: 'message-key'}, action: {type: 'issue.create', title: 'Defect', statement: 'Fails'}};
const ports = (identity: {actorId: string; role: ProjectRole} | null = {actorId: 'human', role: 'client'}) => ({
  facts: {read: vi.fn(async () => ({referenceId: 'snapshot-1'}))},
  tracker: {createIssue: vi.fn(async () => ({referenceId: 'issue-1', url: 'https://example.test/1', version: 'v1'})),
    addIssueContext: vi.fn(async () => ({referenceId: 'issue-1', url: 'https://example.test/1', version: 'v2'}))},
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
  it('adds bounded source context as the exact resolved client actor', async () => {
    const target = ports({actorId: 'client-a', role: 'client'}); const source: ClientConversationEnvelope = {...envelope,
      action: {type: 'source.add', name: 'Protocol', content: 'Expected result'}};
    await expect(dispatchClientConversationAction({workspaceId: 'workspace', envelope: source, ports: target}))
      .resolves.toEqual({status: 'completed', referenceId: 'source-1'});
    expect(target.sources.add).toHaveBeenCalledWith(expect.objectContaining({actorId: 'client-a'}));
  });
  it('does not let a client role submit an agent request even on trusted-main', async () => {
    const request: AgentRoleRequest = {role: 'developer', repository: {id: 'repo', url: 'https://example.test/repo'},
      projectItem: {id: 'item', projectId: 'project', issueId: 'issue', url: 'https://example.test/issue'},
      observedVersion: 'v1', sources: [], constraints: ['bounded'], acceptanceCriteria: ['verified'], approval: null,
      correlationId: 'correlation', idempotencyKey: 'agent-key'};
    const internal: InternalConversationEnvelope = {message: {...envelope.message, contour: 'trusted-main',
      text: 'agent request'}, action: {type: 'agent.submit', request}};
    const target = {...ports({actorId: 'client-a', role: 'client'}),
      agent: {submit: vi.fn(async () => ({deliveryReference: 'delivery', sessionReference: 'session'}))}};
    await expect(dispatchConversationAction({workspaceId: 'workspace', envelope: internal, ports: target}))
      .resolves.toEqual({status: 'denied'});
    expect(target.agent.submit).not.toHaveBeenCalled();
  });
  it('keeps core semantics identical when Hermes/OpenClaw or Codex/Claude execution is substituted', async () => {
    const request: AgentRoleRequest = {role: 'developer', repository: {id: 'repo', url: 'https://example.test/repo'},
      projectItem: {id: 'item', projectId: 'project', issueId: 'issue', url: 'https://example.test/issue'},
      observedVersion: 'v1', sources: [], constraints: ['bounded'], acceptanceCriteria: ['verified'], approval: null,
      correlationId: 'correlation', idempotencyKey: 'agent-key'};
    const internal: InternalConversationEnvelope = {message: {...envelope.message, contour: 'trusted-main',
      text: 'agent request', idempotencyKey: 'agent-key'}, action: {type: 'agent.submit', request}};
    const run = async (deliveryReference: string) => dispatchConversationAction({workspaceId: 'workspace', envelope: internal,
      ports: {...ports({actorId: 'operator-a', role: 'operator'}), agent: {submit: async () => ({deliveryReference,
        sessionReference: `session:${deliveryReference}`})}}});
    await expect(run('hermes-codex')).resolves.toEqual({status: 'completed', referenceId: 'hermes-codex'});
    await expect(run('openclaw-claude')).resolves.toEqual({status: 'completed', referenceId: 'openclaw-claude'});
    expect(request).not.toHaveProperty('runtimeVendor');
    expect(request).not.toHaveProperty('cliVendor');
  });
});
