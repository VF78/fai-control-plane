import {describe, expect, it, vi} from 'vitest';
import {createActorContextIssuer} from '@fai-control-plane/domain';
import {createGovernedQaService} from './governed-qa.ts';

const ids = {command: '11111111-1111-4111-8111-111111111111', workspace: '22222222-2222-4222-8222-222222222222', correlation: '33333333-3333-4333-8333-333333333333', work: '44444444-4444-4444-8444-444444444444'};
const actor = (() => {
  const issuer = createActorContextIssuer({users: [{actorId: '55555555-5555-4555-8555-555555555555', capabilities: ['write:control_plane:development']}], agents: [], systems: []});
  if (!issuer.ok) throw new Error('issuer');
  const issued = issuer.value.issueUser('55555555-5555-4555-8555-555555555555');
  if (!issued.ok) throw new Error('actor');
  return issued.value;
})();
describe('governed QA application service', () => {
  it('uses a canonical request hash only after a human command is valid', async () => {
    const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: ids.command, workspaceId: ids.workspace, correlationId: ids.correlation, idempotencyKey: 'qa', requestHash: 'a'.repeat(64), commandType: 'qa_task_packet.prepare.v1', result: {ok: false, error: {code: 'INVALID_COMMAND', message: 'no'}}, createdAt: new Date().toISOString()}});
    const service = createGovernedQaService({execute});
    await service.execute({commandId: ids.command, workspaceId: ids.workspace, correlationId: ids.correlation, idempotencyKey: 'qa', issuedAt: new Date().toISOString(), actor, type: 'qa_task_packet.prepare.v1', payload: {workItemId: ids.work, expectedWorkItemVersion: 1, expectedJourneyVersion: 1}});
    expect(execute).toHaveBeenCalledOnce();
    await service.execute({commandId: ids.command, workspaceId: ids.workspace, correlationId: ids.correlation, idempotencyKey: 'qa', issuedAt: new Date().toISOString(), actor, type: 'qa_task_packet.prepare.v1', payload: {workItemId: 'bad', expectedWorkItemVersion: 1, expectedJourneyVersion: 1}} as never);
    expect(execute).toHaveBeenCalledOnce();
  });
});
