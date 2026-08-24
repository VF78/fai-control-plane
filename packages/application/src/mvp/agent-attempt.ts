import type {AgentDeliveryPort} from '@fai-control-plane/domain';

export type AgentAttemptRecord = Readonly<{
  workspaceId: string; projectId: string; actorId: string; itemId: string;
  deliveryReference: string; correlationId: string; status: 'started'|'completed'|'failed';
}>;

export type AgentAttemptStore = Readonly<{
  resolve(input: Readonly<{actorId: string; projectId: string; itemId: string; deliveryReference: string}>):
    Promise<AgentAttemptRecord|null>;
  finish(input: AgentAttemptRecord & Readonly<{status: 'completed'|'failed'; failureCode: string|null}>):
    Promise<'recorded'|'duplicate'>;
}>;

export const reconcileAgentAttempt = async (command: Readonly<{
  actorId: string; projectId: string; itemId: string; deliveryReference: string;
}>, ports: Readonly<{delivery: AgentDeliveryPort; attempts: AgentAttemptStore}>) => {
  const attempt = await ports.attempts.resolve(command);
  if (attempt === null) throw new Error('agent_attempt_denied');
  if (attempt.status !== 'started') return {status: attempt.status, deliveryReference: attempt.deliveryReference};
  const observed = await ports.delivery.observe(attempt.deliveryReference);
  if (observed.status === 'started' || observed.status === 'unknown') {
    return {status: observed.status, deliveryReference: attempt.deliveryReference};
  }
  await ports.attempts.finish({...attempt, status: observed.status, failureCode: observed.failureCode ?? null});
  return {status: observed.status, deliveryReference: attempt.deliveryReference};
};
