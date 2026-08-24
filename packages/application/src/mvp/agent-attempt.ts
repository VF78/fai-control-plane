import type {AgentDeliveryPort, AgentExecutorCatalog, AgentExecutorResult, AgentRoutingPolicy, MessengerDeliveryInput, TrackerItemFact} from '@fai-control-plane/domain';

export type AgentAttemptRecord = Readonly<{
  workspaceId: string; projectId: string; actorId: string; itemId: string;
  itemTitle: string | null; itemUrl: string | null;
  deliveryReference: string; correlationId: string; status: 'started'|'completed'|'failed';
  occurredAt?: string;
  observedVersion?: string; successTargetTitle?: string|null; reworkTargetTitle?: string|null;
  expectedOwnerOptionId?: string; routingPolicy?: AgentRoutingPolicy; executorCatalog?: AgentExecutorCatalog;
}>;

export type AgentAttemptStore = Readonly<{
  resolve(input: Readonly<{actorId: string; projectId: string; itemId: string; deliveryReference: string}>):
    Promise<AgentAttemptRecord|null>;
  listActive(limit: number): Promise<readonly AgentAttemptRecord[]>;
  finish(input: AgentAttemptRecord & Readonly<{status: 'completed'|'failed'; failureCode: string|null;
    result: AgentExecutorResult | null; notification: MessengerDeliveryInput}>):
    Promise<'recorded'|'duplicate'>;
}>;

export type AgentAttemptReconciliationPorts = Readonly<{delivery: AgentDeliveryPort; attempts: AgentAttemptStore;
  readFreshItem?(attempt: AgentAttemptRecord): Promise<TrackerItemFact|null>;
  composeTerminalNotification(attempt: AgentAttemptRecord, observed: Awaited<ReturnType<AgentDeliveryPort['observe']>>,
    idempotencyKey: string): Promise<MessengerDeliveryInput>}>;

export const composeAgentTerminalNotification = (
  projectId: string,
  attempt: AgentAttemptRecord,
  observed: Awaited<ReturnType<AgentDeliveryPort['observe']>>,
  idempotencyKey: string
): MessengerDeliveryInput => {
  const result = observed.result;
  const heading = observed.status === 'completed' ? 'Hermes завершил этап задачи'
    : result?.decision === 'rejected' ? 'Hermes не смог выполнить этап задачи' : 'Этап Hermes завершился ошибкой';
  const reason = result?.reason === undefined ? '' : `\n${result.reason}`;
  const deliverables = result?.deliverables.length
    ? `\nРезультат:\n${result.deliverables.map((item) => `${item.label}: ${item.url}`).join('\n')}` : '';
  const task = attempt.itemUrl === null ? (attempt.itemTitle ?? 'Задача GitHub Project')
    : `${attempt.itemTitle ?? 'Задача GitHub Project'} — ${attempt.itemUrl}`;
  return {projectId, contour: 'trusted-main', channelReference: 'telegram:internal',
    text: `${heading}\n${task}${reason}${deliverables}`, idempotencyKey};
};

const reconcileRecord = async (attempt: AgentAttemptRecord, ports: AgentAttemptReconciliationPorts,
  supplied?: Awaited<ReturnType<AgentDeliveryPort['observe']>>) => {
  if (attempt.status !== 'started') return {status: attempt.status, deliveryReference: attempt.deliveryReference};
  let observed = supplied ?? await ports.delivery.observe(attempt.deliveryReference);
  const expired = attempt.occurredAt !== undefined && Number.isFinite(Date.parse(attempt.occurredAt)) &&
    Date.now() - Date.parse(attempt.occurredAt) >= 30 * 60_000;
  if (observed.status === 'unknown' && expired) observed = {status: 'failed', failureCode: 'provider_timeout'};
  if (observed.status === 'started' || observed.status === 'unknown') {
    return {status: observed.status, deliveryReference: attempt.deliveryReference};
  }
  let verified: Readonly<{status: 'completed'|'failed'; failureCode?: 'provider_failed'|'provider_cancelled'|
    'provider_unavailable'|'provider_timeout'|
    'agent_result_rejected'|'agent_result_invalid'; result?: AgentExecutorResult}> = observed as typeof verified;
  if (observed.status === 'completed') {
    const result = observed.result;
    const route = result === undefined || attempt.routingPolicy === undefined ? undefined
      : attempt.routingPolicy.routes.find((candidate) => candidate.taskClass === result.execution.taskClass);
    const target = result?.outcome === 'success' ? attempt.successTargetTitle : attempt.reworkTargetTitle;
    let tracker: TrackerItemFact|null = null;
    if (result !== undefined && ports.readFreshItem !== undefined) {
      try { tracker = await ports.readFreshItem(attempt); }
      catch {
        if (!expired) throw new Error('agent_readback_unavailable');
        verified = {status:'failed',failureCode:'provider_unavailable',result};
      }
    }
    const exact = result !== undefined && route !== undefined &&
      JSON.stringify(route.executor) === JSON.stringify(result.execution.executor) &&
      route.model === result.execution.model && route.effort === result.execution.effort &&
      (result.execution.executor.kind !== 'cli' ||
        (result.executorReceipt?.receiptReference === attempt.correlationId &&
          result.executorReceipt.executorId === result.execution.executor.id &&
          result.executorReceipt.model === result.execution.model &&
          result.executorReceipt.effort === result.execution.effort)) &&
      result.transition.itemId === attempt.itemId && result.transition.fromVersion === attempt.observedVersion &&
      target !== null && target !== undefined && result.transition.targetStage === target &&
      tracker !== null && tracker.itemId === attempt.itemId && tracker.version === result.transition.toVersion &&
      tracker.version !== attempt.observedVersion && tracker.statusOptionName === target &&
      tracker.ownerOptionId === attempt.expectedOwnerOptionId;
    if (verified.status === 'completed' && !exact) verified = {status: 'failed', failureCode: 'agent_result_invalid',
      ...(result === undefined ? {} : {result})};
  }
  const idempotencyKey = `agent.attempt:${attempt.correlationId}:${verified.status}`;
  const notification = await ports.composeTerminalNotification(attempt, verified, idempotencyKey);
  await ports.attempts.finish({...attempt, status: verified.status, failureCode: verified.failureCode ?? null,
    result: verified.result ?? null, notification});
  return {status: verified.status, deliveryReference: attempt.deliveryReference,
    ...(verified.result === undefined ? {} : {result: verified.result})};
};

export const reconcileAgentAttempt = async (command: Readonly<{
  actorId: string; projectId: string; itemId: string; deliveryReference: string;
}>, ports: AgentAttemptReconciliationPorts) => {
  const attempt = await ports.attempts.resolve(command);
  if (attempt === null) throw new Error('agent_attempt_denied');
  return reconcileRecord(attempt, ports);
};

export const reconcileActiveAgentAttempts = async (limit: number, ports: AgentAttemptReconciliationPorts) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('agent_attempt_limit_invalid');
  const attempts = await ports.attempts.listActive(limit);
  const results = [];
  for (const attempt of attempts) {
    let observed: Awaited<ReturnType<AgentDeliveryPort['observe']>>;
    try { observed = await ports.delivery.observe(attempt.deliveryReference); }
    catch {
      const expired = attempt.occurredAt !== undefined && Number.isFinite(Date.parse(attempt.occurredAt)) &&
        Date.now() - Date.parse(attempt.occurredAt) >= 30 * 60_000;
      if (!expired) { results.push({status: 'observation-failed' as const, deliveryReference: attempt.deliveryReference}); continue; }
      observed = {status: 'failed', failureCode: 'provider_unavailable'};
    }
    try { results.push(await reconcileRecord(attempt, ports, observed)); }
    catch { results.push({status: 'reconciliation-failed' as const, deliveryReference: attempt.deliveryReference}); }
  }
  return results;
};
