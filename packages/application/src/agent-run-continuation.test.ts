import {randomUUID} from 'node:crypto';
import {expect, it, vi} from 'vitest';
import {createActorContextIssuer} from '@fai-control-plane/domain';
import {
  AGENT_RUN_RETRY_CONTINUATION_COMMAND,
  createAgentRunRetryContinuationService,
  evaluateAgentRunRetryAdmission,
  type AgentRunRetryContinuationStore
} from './index';

const actor = () => {
  const actorId = randomUUID();
  const issuer = createActorContextIssuer({users: [{actorId,
    capabilities: ['write:control_plane:development']}], agents: [], systems: []});
  if (!issuer.ok) throw new Error('issuer fixture');
  const issued = issuer.value.issueUser(actorId);
  if (!issued.ok) throw new Error('actor fixture');
  return issued.value;
};

it('accepts only explicit bounded retry and stop facts and hashes stable idempotency facts', async () => {
  const execute = vi.fn(async (input: Parameters<AgentRunRetryContinuationStore['execute']>[0]) => ({status: 'rejected' as const,
    error: {code: 'NOT_FOUND' as const, message: input.requestHash}}));
  const service = createAgentRunRetryContinuationService({execute} as AgentRunRetryContinuationStore);
  const operator = actor();
  const failedRunId = randomUUID();
  const retryRunId = randomUUID();
  const command = {
    commandId: randomUUID(), workspaceId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `agent-run-retry-continuation:v1:${failedRunId}:${retryRunId}:${operator.actorId}`,
    issuedAt: '2026-08-09T12:00:00.000Z', actor: operator,
    type: AGENT_RUN_RETRY_CONTINUATION_COMMAND,
    payload: {projectId: randomUUID(), failedRunId, retryRunId, expectedExecutionVersion: 2}
  };
  await service.execute(command);
  await service.execute({...command, commandId: randomUUID(), correlationId: randomUUID(),
    issuedAt: '2026-08-09T12:01:00.000Z'});
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]![0]).toMatchObject({authorized: true,
    requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)});
  expect(execute.mock.calls[1]![0].requestHash).toBe(execute.mock.calls[0]![0].requestHash);
  await expect(service.execute({...command, payload: {...command.payload,
    maxAttempts: 0} as never})).resolves.toMatchObject({
      status: 'rejected', error: {code: 'INVALID_COMMAND'}
    });
  expect(execute.mock.calls[0]![0].policy).toMatchObject({maxAttempts: 3,
    retryUntilElapsedMinutes: 120, maxObservedPriorCostMinor: 10_000,
    currency: 'RUB', onStop: 'ask'});
});

it('treats time and prior cost as exact retry-admission thresholds while attempts remain hard-capped', () => {
  expect(evaluateAgentRunRetryAdmission({attemptsUsed: 2, elapsedMinutes: 119,
    observedPriorCostMinor: 9_999, observedPriorCostExceeded: false})).toBeNull();
  expect(evaluateAgentRunRetryAdmission({attemptsUsed: 3, elapsedMinutes: 0,
    observedPriorCostMinor: 0, observedPriorCostExceeded: false})).toBe('attempt_limit');
  expect(evaluateAgentRunRetryAdmission({attemptsUsed: 2, elapsedMinutes: 120,
    observedPriorCostMinor: 0, observedPriorCostExceeded: false})).toBe('elapsed_admission_threshold');
  expect(evaluateAgentRunRetryAdmission({attemptsUsed: 2, elapsedMinutes: 119,
    observedPriorCostMinor: 10_000, observedPriorCostExceeded: false}))
    .toBe('observed_prior_cost_admission_threshold');
  expect(evaluateAgentRunRetryAdmission({attemptsUsed: 2, elapsedMinutes: 119,
    observedPriorCostMinor: null, observedPriorCostExceeded: false})).toBe('cost_unknown');
});
