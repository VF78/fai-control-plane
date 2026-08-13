import {describe, expect, it} from 'vitest';
import {
  authorizeConversationAction,
  validateConversationInboundMessage,
  validateConversationRuntimeDeliveryAcknowledgement,
  validateConversationActionEnvelope,
  validateConversationActionEvidence,
  type ConversationActionEnvelope
} from './messenger';

const origin = (visibility: 'internal' | 'client') => ({
  visibility,
  channelRef: 'channel:opaque',
  actorRef: 'actor:opaque',
  messageRef: 'message:opaque',
  observedAt: '2026-08-13T00:00:00.000Z'
});
const envelope = (
  visibility: 'internal' | 'client',
  action: ConversationActionEnvelope['action']
): ConversationActionEnvelope => ({
  projectRef: 'project:opaque',
  origin: origin(visibility),
  action,
  correlationId: 'correlation-42',
  idempotencyKey: 'message-action-42'
});
const reference = {
  referenceId: 'approval-42',
  url: 'https://tracker.example.test/items/42',
  expectedVersion: 'v7'
};

describe('runtime-neutral conversation boundary', () => {
  it('validates bounded transient transport shapes without accepting history or runtime state', () => {
    const message = {
      projectRef: 'project:opaque', origin: origin('client'), text: 'Client intake',
      correlationId: 'correlation-42', idempotencyKey: 'message-action-42'
    };
    expect(validateConversationInboundMessage(message)).toEqual(message);
    expect(validateConversationInboundMessage({...message, history: ['older message']})).toBeNull();
    expect(validateConversationInboundMessage({...message, text: 'x'.repeat(4_001)})).toBeNull();
    const acknowledgement = {
      deliveryReference: 'delivery:opaque', sessionReference: 'session:opaque'
    };
    expect(validateConversationRuntimeDeliveryAcknowledgement(acknowledgement))
      .toEqual(acknowledgement);
    expect(validateConversationRuntimeDeliveryAcknowledgement({
      ...acknowledgement, status: 'running'
    })).toBeNull();
    expect(validateConversationRuntimeDeliveryAcknowledgement({
      ...acknowledgement, sessionReference: 'session\nforged'
    })).toBeNull();
    const evidence = {
      projectRef: 'project:opaque', capability: 'issue_intake.create' as const,
      actorRef: 'actor:opaque', messageRef: 'message:opaque',
      observedAt: '2026-08-13T00:00:00.000Z', correlationId: 'correlation-42',
      idempotencyKey: 'message-action-42',
      result: {kind: 'issue' as const, referenceId: 'issue-42', url: 'https://tracker.example.test/items/42', version: 'v1'}
    };
    expect(validateConversationActionEvidence(evidence)).toEqual(evidence);
    expect(JSON.stringify(evidence)).not.toMatch(/telegram|matrix|bitrix|hermes|openclaw|transcript|body/i);
  });

  it('enforces the complete trust-contour capability boundary', () => {
    for (const action of [
      {type: 'client_project_facts.read'} as const,
      {type: 'issue_intake.create', title: 'Observed defect', statement: 'Bounded report', source: {
        referenceId: 'message:opaque', url: 'https://chat.example.test/messages/42'
      }} as const,
      {type: 'issue_intake.clarify', issueReference: reference, clarification: 'Reproduced twice', source: {
        referenceId: 'message:opaque', url: 'https://chat.example.test/messages/43'
      }} as const,
      {type: 'source_context.add', targetReference: reference, statement: 'Client-visible note', source: {
        referenceId: 'message:opaque', url: 'https://chat.example.test/messages/44'
      }} as const,
      {type: 'external_approval.request', reference} as const
    ]) {
      expect(authorizeConversationAction('client-edge', envelope('client', action)))
        .toMatchObject({decision: 'allow', capability: action.type});
    }
    const roleRequest = {
      role: 'qa' as const,
      repository: {id: 'repository-1', url: 'https://repository.example.test/repository/1'},
      projectItem: {id: 'item-1', projectId: 'project-1', issueId: 'issue-1', url: 'https://tracker.example.test/items/1'},
      observedVersion: 'v1', sourceReferences: [], constraints: ['Same item only.'],
      acceptanceCriteria: ['Report evidence.'], approval: null,
      correlationId: 'role-correlation', idempotencyKey: 'role-idempotency'
    };
    expect(authorizeConversationAction('client-edge', envelope('client', {
      type: 'agent_role_request.submit', request: roleRequest
    }))).toEqual({decision: 'deny', reason: 'capability_denied'});
    expect(authorizeConversationAction('client-edge', envelope('internal', {
      type: 'client_project_facts.read'
    }))).toEqual({decision: 'deny', reason: 'visibility_boundary'});
    expect(authorizeConversationAction('trusted-main', envelope('internal', {
      type: 'agent_role_request.submit', request: roleRequest
    }))).toMatchObject({decision: 'allow', capability: 'agent_role_request.submit'});
    for (const type of [
      'repository.checkout',
      'terminal.execute',
      'production_credentials.read',
      'project_status.mutate',
      'internal_history.read'
    ]) {
      const forged = {...envelope('client', {type: 'client_project_facts.read'}), action: {type}};
      expect(validateConversationActionEnvelope(forged)).toBeNull();
      expect(authorizeConversationAction('client-edge', forged))
        .toEqual({decision: 'deny', reason: 'invalid_envelope'});
    }
    const forged = {...envelope('client', {type: 'client_project_facts.read'}), contour: 'trusted-main'};
    expect(validateConversationActionEnvelope(forged)).toBeNull();
  });

});
