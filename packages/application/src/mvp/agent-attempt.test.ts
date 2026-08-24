import {describe, expect, it, vi} from 'vitest';
import {reconcileAgentAttempt, type AgentAttemptStore} from './agent-attempt.ts';

const attempt = {workspaceId: 'workspace', projectId: 'project', actorId: 'actor', itemId: 'item',
  deliveryReference: 'run_ref', correlationId: 'correlation', status: 'started' as const};

describe('agent attempt reconciliation', () => {
  it('does not turn an expired provider status into a failure', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>();
    const result = await reconcileAgentAttempt({actorId: 'actor', projectId: 'project', itemId: 'item',
      deliveryReference: 'run_ref'}, {delivery: {submit: vi.fn(), observe: async () => ({status: 'unknown'})},
      attempts: {resolve: async () => attempt, finish}});
    expect(result.status).toBe('unknown'); expect(finish).not.toHaveBeenCalled();
  });

  it('appends one terminal lifecycle fact for a provider-confirmed failure', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    await expect(reconcileAgentAttempt({actorId: 'actor', projectId: 'project', itemId: 'item',
      deliveryReference: 'run_ref'}, {delivery: {submit: vi.fn(), observe: async () =>
        ({status: 'failed', failureCode: 'provider_failed'})}, attempts: {resolve: async () => attempt, finish}}))
      .resolves.toMatchObject({status: 'failed'});
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({status: 'failed', failureCode: 'provider_failed'}));
  });

  it('appends one terminal lifecycle fact for provider-confirmed completion', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    await expect(reconcileAgentAttempt({actorId: 'actor', projectId: 'project', itemId: 'item',
      deliveryReference: 'run_ref'}, {delivery: {submit: vi.fn(), observe: async () => ({status: 'completed'})},
      attempts: {resolve: async () => attempt, finish}})).resolves.toMatchObject({status: 'completed'});
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({status: 'completed', failureCode: null}));
  });
});
