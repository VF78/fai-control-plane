import type {AgentDeliveryPort, AgentExecutorCatalog, AgentExecutorResult, AgentRoutingPolicy, MessengerDeliveryInput, TrackerMutationPort} from '@fai-control-plane/domain';

export type AgentAttemptRecord = Readonly<{
  workspaceId: string; projectId: string; actorId: string; itemId: string; issueId: string;
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
  tracker: Pick<TrackerMutationPort, 'setProjectItemStage'>;
  continueAgentChain?(attempt: AgentAttemptRecord, targetStage: string): Promise<void>;
  composeTerminalNotification(attempt: AgentAttemptRecord, observed: Awaited<ReturnType<AgentDeliveryPort['observe']>>,
    idempotencyKey: string): Promise<MessengerDeliveryInput>}>;

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const twice = async <T>(operation: () => Promise<T>): Promise<T> => {
  try { return await operation(); }
  catch { await pause(250); return operation(); }
};

const validDeliverables = (result: AgentExecutorResult): boolean => result.deliverables.length > 0 &&
  result.deliverables.length <= 10 &&
  result.deliverables.every((deliverable) => {
    if (deliverable.label.length < 1 || deliverable.label.length > 200) return false;
    try {
      const url = new URL(deliverable.url);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch { return false; }
  });

export const composeAgentTerminalNotification = (
  projectId: string,
  attempt: AgentAttemptRecord,
  observed: Awaited<ReturnType<AgentDeliveryPort['observe']>>,
  idempotencyKey: string
): MessengerDeliveryInput => {
  const result = observed.result;
  const heading = observed.status === 'completed' ? 'Hermes завершил этап задачи'
    : result?.decision === 'rejected' ? 'Hermes не смог выполнить этап задачи' : 'Этап Hermes завершился ошибкой';
  const failure = observed.status === 'failed' ? ({
    provider_failed: 'Hermes завершил выполнение с ошибкой.',
    provider_cancelled: 'Выполнение Hermes отменено.',
    provider_unavailable: 'Hermes или GitHub недоступен после двух автоматических попыток.',
    provider_timeout: 'Hermes не завершил этап в установленный срок.',
    agent_result_rejected: result?.reason ?? 'Hermes отклонил результат этапа.',
    agent_result_invalid: 'Результат Hermes не соответствует настройкам процесса.'
  } as const)[observed.failureCode ?? 'provider_failed'] : undefined;
  const reason = failure === undefined ? (result?.reason === undefined ? '' : `\n${result.reason}`) : `\n${failure}`;
  const deliverables = result?.deliverables.length
    ? `\nРезультат:\n${result.deliverables.map((item) => `${item.label}: ${item.url}`).join('\n')}` : '';
  const stage = observed.status === 'completed' && result !== undefined
    ? `\nСтатус GitHub Project: ${result.transition.targetStage}` : '';
  const task = attempt.itemUrl === null ? (attempt.itemTitle ?? 'Задача GitHub Project')
    : `${attempt.itemTitle ?? 'Задача GitHub Project'} — ${attempt.itemUrl}`;
  return {projectId, contour: 'trusted-main', channelReference: 'telegram:internal',
    text: `${heading}\n${task}${reason}${stage}${deliverables}`, idempotencyKey};
};

const reconcileRecord = async (attempt: AgentAttemptRecord, ports: AgentAttemptReconciliationPorts,
  supplied?: Awaited<ReturnType<AgentDeliveryPort['observe']>>) => {
  if (attempt.status !== 'started') return {status: attempt.status, deliveryReference: attempt.deliveryReference};
  let observed = supplied ?? await twice(() => ports.delivery.observe(attempt.deliveryReference));
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
    const expectedVersion = attempt.observedVersion;
    const exact = result !== undefined && route !== undefined &&
      JSON.stringify(route.executor) === JSON.stringify(result.execution.executor) &&
      route.model === result.execution.model && route.effort === result.execution.effort &&
      typeof expectedVersion === 'string' && result.transition.itemId === attempt.itemId &&
      result.transition.fromVersion === expectedVersion &&
      target !== null && target !== undefined && result.transition.targetStage === target &&
      result.decision === 'accepted' && validDeliverables(result) && target !== 'Done' && attempt.issueId.length > 0;
    if (verified.status === 'completed' && !exact) verified = {status: 'failed', failureCode: 'agent_result_invalid',
      ...(result === undefined ? {} : {result})};
    if (verified.status === 'completed' && result !== undefined && target !== null && target !== undefined &&
      expectedVersion !== undefined) {
      const targetStage = target;
      try {
        const moved = await twice(() => ports.tracker.setProjectItemStage({projectId: attempt.projectId,
          itemId: attempt.itemId, issueId: attempt.issueId, expectedVersion,
          stage: targetStage, idempotencyKey: `agent.status:${attempt.correlationId}:${targetStage}`}));
        if (moved.referenceId !== attempt.itemId || moved.version === expectedVersion) {
          throw new Error('github_mutation_failed');
        }
      } catch { verified = {status: 'failed', failureCode: 'provider_unavailable', result}; }
    }
  }
  const idempotencyKey = `agent.attempt:${attempt.correlationId}:${verified.status}`;
  const notification = await ports.composeTerminalNotification(attempt, verified, idempotencyKey);
  const recorded = await ports.attempts.finish({...attempt, status: verified.status, failureCode: verified.failureCode ?? null,
    result: verified.result ?? null, notification});
  const target = verified.result?.outcome === 'success' ? attempt.successTargetTitle : attempt.reworkTargetTitle;
  if (recorded === 'recorded' && verified.status === 'completed' && target !== null && target !== undefined &&
    ports.continueAgentChain !== undefined) {
    try { await ports.continueAgentChain(attempt, target); }
    catch { /* The provider repair pass uses the same terminal receipt and continuation facts. */ }
  }
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
    try { observed = await twice(() => ports.delivery.observe(attempt.deliveryReference)); }
    catch {
      observed = {status: 'failed', failureCode: 'provider_unavailable'};
    }
    try { results.push(await reconcileRecord(attempt, ports, observed)); }
    catch { results.push({status: 'reconciliation-failed' as const, deliveryReference: attempt.deliveryReference}); }
  }
  return results;
};
