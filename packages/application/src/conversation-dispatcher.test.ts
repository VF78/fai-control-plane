import {describe, expect, it, vi} from 'vitest';
import type {AgentRoleRequest, ConversationActionEnvelope} from '@fai-control-plane/domain';
import {
  createConversationDispatcher,
  type ConversationCapabilityPorts,
  type TrustedConversationCapabilityPorts
} from './conversation-dispatcher';

const origin = (visibility: 'internal' | 'client') => ({
  visibility,
  channelRef: 'channel:opaque',
  actorRef: 'actor:opaque',
  messageRef: 'message:opaque',
  observedAt: '2026-08-13T00:00:00.000Z'
});
const envelope = (
  visibility: 'internal' | 'client',
  action: ConversationActionEnvelope['action'],
  correlationId = 'correlation-42',
  idempotencyKey = 'idempotency-42'
): ConversationActionEnvelope => ({
  projectRef: 'project:opaque', origin: origin(visibility), action,
  correlationId, idempotencyKey
});
const roleRequest = (correlationId = 'correlation-42', idempotencyKey = 'idempotency-42'): AgentRoleRequest => ({
  role: 'qa', repository: {id: 'repository-1', url: 'https://repository.example.test/repositories/1'},
  projectItem: {id: 'item-1', projectId: 'project-1', issueId: 'issue-1', url: 'https://tracker.example.test/items/1'},
  observedVersion: 'v1', sourceReferences: [], constraints: ['Same item only.'],
  acceptanceCriteria: ['Report evidence.'], approval: null, correlationId, idempotencyKey
});
const ports = (overrides: Partial<ConversationCapabilityPorts> = {}): ConversationCapabilityPorts => ({
  readClientProjectFacts: vi.fn(async () => ({
    evidence: {kind: 'source' as const, referenceId: 'project:external',
      url: 'https://tracker.example.test/projects/1', version: 'v7'},
    facts: {projectUrl: 'https://tracker.example.test/projects/1', projectVersion: 'v7',
      closed: false, itemCount: 7}
  })),
  createIssueIntake: vi.fn(async () => ({kind: 'issue' as const, referenceId: 'issue-42', url: 'https://tracker.example.test/items/42', version: 'v1'})),
  clarifyIssueIntake: vi.fn(async () => ({kind: 'issue' as const, referenceId: 'issue-42', url: 'https://tracker.example.test/items/42', version: 'v2'})),
  addSourceContext: vi.fn(async () => ({kind: 'source' as const, referenceId: 'source-42', url: 'https://sources.example.test/42'})),
  requestExternalApproval: vi.fn(async () => ({kind: 'approval' as const, referenceId: 'approval-42', url: 'https://tracker.example.test/approvals/42', version: 'v1'})),
  ...overrides
});
const trustedPorts = (): TrustedConversationCapabilityPorts => ({
  ...ports(),
  agentDelivery: {submit: vi.fn(async () => ({deliveryReference: 'delivery-42', sessionReference: 'session-42'}))}
});

describe('conversation dispatcher', () => {
  it('returns bounded project facts transiently while evidence remains persistable alone', async () => {
    const dispatcher = createConversationDispatcher({contour: 'client-edge', ports: ports()});
    const result = await dispatcher.dispatch(envelope('client', {type: 'client_project_facts.read'}));
    expect(result).toMatchObject({status: 'completed', transient: {
      kind: 'client_project_facts', facts: {closed: false, itemCount: 7}
    }, evidence: {result: {kind: 'source', referenceId: 'project:external', version: 'v7'}}});
    if (result.status !== 'completed') throw new Error('expected completion');
    expect(JSON.stringify(result.evidence)).not.toContain('itemCount');
    const injected = ports({readClientProjectFacts: vi.fn(async () => ({
      evidence: {kind: 'source' as const, referenceId: 'project:external',
        url: 'https://tracker.example.test/projects/1', version: 'v7'},
      facts: {projectUrl: 'https://tracker.example.test/projects/other', projectVersion: 'v7',
        closed: false, itemCount: 7}
    }))});
    const mismatchDispatcher = createConversationDispatcher({contour: 'client-edge', ports: injected});
    await expect(mismatchDispatcher.dispatch(envelope('client', {
      type: 'client_project_facts.read'
    }))).resolves.toEqual({status: 'failed', reason: 'invalid_external_result'});
  });

  it('dispatches a bounded client action and returns transcript-free evidence', async () => {
    const injected = ports();
    const dispatcher = createConversationDispatcher({contour: 'client-edge', ports: injected});
    const action = {
      type: 'issue_intake.create' as const,
      title: 'Observed defect', statement: 'Bounded client report',
      source: {referenceId: 'message:opaque', url: 'https://chat.example.test/messages/42'}
    };
    const result = await dispatcher.dispatch(envelope('client', action));
    expect(result).toEqual({status: 'completed', evidence: {
      projectRef: 'project:opaque', capability: 'issue_intake.create',
      actorRef: 'actor:opaque', messageRef: 'message:opaque',
      observedAt: '2026-08-13T00:00:00.000Z', correlationId: 'correlation-42',
      idempotencyKey: 'idempotency-42',
      result: {kind: 'issue', referenceId: 'issue-42', url: 'https://tracker.example.test/items/42', version: 'v1'}
    }});
    expect(injected.createIssueIntake).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: 'correlation-42', idempotencyKey: 'idempotency-42', action
    }));
    expect(JSON.stringify(result)).not.toContain('Bounded client report');
    const wrongKindPorts = ports({
      createIssueIntake: vi.fn(async () => ({kind: 'source' as const, referenceId: 'wrong'}))
    });
    const wrongKindDispatcher = createConversationDispatcher({
      contour: 'client-edge', ports: wrongKindPorts
    });
    await expect(wrongKindDispatcher.dispatch(envelope('client', {
      type: 'issue_intake.create', title: 'Defect', statement: 'Report',
      source: {referenceId: 'message:opaque', url: 'https://chat.example.test/messages/42'}
    }))).resolves.toEqual({status: 'failed', reason: 'invalid_external_result'});
  });

  it('keeps role delivery exclusive to a correlation-bound trusted-main request', async () => {
    const clientPorts = ports();
    const clientDispatcher = createConversationDispatcher({
      contour: 'client-edge', ports: clientPorts
    });
    await expect(clientDispatcher.dispatch(envelope('client', {
      type: 'agent_role_request.submit', request: roleRequest()
    }))).resolves.toEqual({status: 'denied', reason: 'capability_denied'});
    expect('agentDelivery' in clientPorts).toBe(false);

    const injected = trustedPorts();
    const dispatcher = createConversationDispatcher({contour: 'trusted-main', ports: injected});
    const request = roleRequest();
    const result = await dispatcher.dispatch(envelope('internal', {
      type: 'agent_role_request.submit', request
    }));
    expect(injected.agentDelivery.submit).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({status: 'completed', evidence: {
      capability: 'agent_role_request.submit', correlationId: request.correlationId,
      idempotencyKey: request.idempotencyKey,
      result: {kind: 'agent_delivery', referenceId: 'delivery-42', version: 'session-42'}
    }});

    const mismatched = trustedPorts();
    const mismatchedDispatcher = createConversationDispatcher({
      contour: 'trusted-main', ports: mismatched
    });
    await expect(mismatchedDispatcher.dispatch(envelope('internal', {
      type: 'agent_role_request.submit', request: roleRequest('different-correlation')
    }))).resolves.toEqual({status: 'denied', reason: 'correlation_binding_invalid'});
    expect(mismatched.agentDelivery.submit).not.toHaveBeenCalled();
  });
});
