import type {AgentDeliveryPort, AgentExecutorCatalog, AgentExecutorResult, AgentRole, AgentRoutingPolicy, MessengerDeliveryInput, TrackerSnapshot} from '@fai-control-plane/domain';

export type AgentAttemptRecord = Readonly<{
  workspaceId: string; projectId: string; actorId: string; itemId: string; issueId: string;
  role: AgentRole; retryOf?: string|null;
  itemTitle: string | null; itemUrl: string | null;
  deliveryReference: string; correlationId: string; status: 'started'|'completed'|'failed';
  failureCode?: string|null;
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
  readTracker(): Promise<TrackerSnapshot>;
  retryTrackerReadback?(attempt: AgentAttemptRecord, error: unknown): boolean;
  trackerReadbackSucceeded?(attempt: AgentAttemptRecord): void;
  observationSucceeded?(attempt: AgentAttemptRecord,
    observed: Awaited<ReturnType<AgentDeliveryPort['observe']>>): void;
  recoverUnavailable?(attempt: AgentAttemptRecord): Promise<Awaited<ReturnType<AgentDeliveryPort['observe']>>>;
  notifyHumanWaiting?(attempt: AgentAttemptRecord): Promise<void>;
  continueAgentChain?(attempt: AgentAttemptRecord, targetStage: string): Promise<void>;
  composeTerminalNotification(attempt: AgentAttemptRecord, observed: Awaited<ReturnType<AgentDeliveryPort['observe']>>,
    idempotencyKey: string): Promise<MessengerDeliveryInput>}>;

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
  channelReference: string,
  attempt: AgentAttemptRecord,
  observed: Awaited<ReturnType<AgentDeliveryPort['observe']>>,
  idempotencyKey: string
): MessengerDeliveryInput => {
  const result = observed.result;
  const heading = observed.status === 'completed' && attempt.failureCode === 'agent_result_invalid'
    ? 'Повторная проверка подтвердила завершение этапа ИИ-агента'
    : observed.status === 'completed' ? 'ИИ-агент завершил этап задачи'
    : result?.decision === 'rejected' ? 'ИИ-агент не смог выполнить этап задачи' : 'Этап ИИ-агента завершился ошибкой';
  const failure = observed.status === 'failed' ? ({
    provider_failed: 'ИИ-агент завершил выполнение с ошибкой.',
    provider_cancelled: 'Выполнение ИИ-агента отменено.',
    provider_unavailable: 'ИИ-агент или источник задач недоступен после двух автоматических попыток.',
    provider_timeout: 'ИИ-агент не завершил этап в установленный срок.',
    provider_blocked: 'ИИ-агент подтвердил блокер на текущем этапе.',
    agent_result_rejected: result?.reason ?? 'ИИ-агент отклонил результат этапа.',
    agent_result_invalid: 'Результат ИИ-агента не соответствует настройкам процесса.'
  } as const)[observed.failureCode ?? 'provider_failed'] : undefined;
  const reason = failure === undefined ? (result?.reason === undefined ? '' : `\n${result.reason}`) : `\n${failure}`;
  const deliverables = result?.deliverables.length
    ? `\nРезультат:\n${result.deliverables.map((item) => `${item.label}: ${item.url}`).join('\n')}` : '';
  const stage = observed.status === 'completed' && result !== undefined
    ? `\nСтатус задачи: ${result.transition.targetStage}` : '';
  const task = attempt.itemUrl === null ? (attempt.itemTitle ?? 'Задача')
    : `${attempt.itemTitle ?? 'Задача'} — ${attempt.itemUrl}`;
  return {projectId, contour: 'trusted-main', channelReference,
    text: `${heading}\n${task}${reason}${stage}${deliverables}`, idempotencyKey};
};

const reconcileRecord = async (attempt: AgentAttemptRecord, ports: AgentAttemptReconciliationPorts,
  supplied?: Awaited<ReturnType<AgentDeliveryPort['observe']>>) => {
  const revalidating = attempt.status === 'failed' && attempt.failureCode === 'agent_result_invalid';
  if (attempt.status !== 'started' && !revalidating) return {status: attempt.status, deliveryReference: attempt.deliveryReference};
  const observed = supplied ?? await ports.delivery.observe(attempt.deliveryReference);
  if (revalidating && observed.status !== 'completed') return {status: 'failed' as const, deliveryReference: attempt.deliveryReference};
  if (observed.status === 'started' || observed.status === 'unknown') {
    if (observed.status === 'started' && observed.waitingFor === 'human-approval')
      await ports.notifyHumanWaiting?.(attempt);
    return {status: observed.status, deliveryReference: attempt.deliveryReference,
      ...(observed.status === 'started' && observed.waitingFor !== undefined ? {waitingFor: observed.waitingFor} : {})};
  }
  let verified: Readonly<{status: 'completed'|'failed'; failureCode?: 'provider_failed'|'provider_cancelled'|
    'provider_unavailable'|'provider_timeout'|'provider_blocked'|
    'agent_result_rejected'|'agent_result_invalid'; result?: AgentExecutorResult}> = observed as typeof verified;
  if (observed.status === 'completed') {
    const result = observed.result;
    const route = result === undefined || attempt.routingPolicy === undefined ? undefined
      : attempt.routingPolicy.routes.find((candidate) => candidate.taskClass === result.execution.taskClass);
    const target = result?.outcome === 'success' ? attempt.successTargetTitle : attempt.reworkTargetTitle;
    const expectedVersion = attempt.observedVersion;
    const exact = result !== undefined && route !== undefined &&
      route.executor.kind === result.execution.executor.kind &&
      (route.executor.kind === 'direct-agent' || (result.execution.executor.kind === 'cli' &&
        route.executor.id === result.execution.executor.id)) &&
      route.model === result.execution.model && route.effort === result.execution.effort &&
      typeof expectedVersion === 'string' && result.transition.itemId === attempt.itemId &&
      result.transition.fromVersion === expectedVersion &&
      target !== null && target !== undefined && result.transition.targetStage === target &&
      result.decision === 'accepted' && validDeliverables(result) && attempt.issueId.length > 0;
    if (verified.status === 'completed' && !exact) verified = {status: 'failed', failureCode: 'agent_result_invalid',
      ...(result === undefined ? {} : {result})};
    if (verified.status === 'completed' && result !== undefined && target !== null && target !== undefined) {
      try {
        const snapshot = await ports.readTracker();
        const item = snapshot.items.find((candidate) => candidate.itemId === attempt.itemId &&
          candidate.issueId === attempt.issueId && candidate.projectId === attempt.projectId);
        ports.trackerReadbackSucceeded?.(attempt);
        if (item === undefined || item.statusOptionName !== target ||
          item.ownerOptionId !== attempt.expectedOwnerOptionId) verified = {status: 'failed', failureCode: 'agent_result_invalid', result};
        else if (item.blocked !== false) verified = {status: 'failed', failureCode: 'provider_blocked', result};
      } catch (error) {
        if (revalidating) return {status: 'failed' as const, deliveryReference: attempt.deliveryReference};
        if (ports.retryTrackerReadback?.(attempt, error) ?? true)
          return {status: 'started' as const, deliveryReference: attempt.deliveryReference};
        verified = {status: 'failed', failureCode: 'provider_unavailable', result};
      }
    }
  }
  // Revalidation corrects only a proven completion, never retries execution or
  // emits another failure notification for an already terminal receipt.
  if (revalidating && verified.status !== 'completed') return {status: 'failed' as const, deliveryReference: attempt.deliveryReference};
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
    if (attempt.status === 'failed') {
      try { results.push(await reconcileRecord(attempt, ports)); }
      catch { results.push({status: 'failed' as const, deliveryReference: attempt.deliveryReference}); }
      continue;
    }
    let observed: Awaited<ReturnType<AgentDeliveryPort['observe']>>;
    let observationFailed = false;
    try { observed = await ports.delivery.observe(attempt.deliveryReference); }
    catch {
      observationFailed = true;
      try {
        // A single endpoint error is not evidence that the run failed. The
        // composition-owned recovery policy may count repeated failures and
        // still return started without restarting the agent.
        observed = ports.recoverUnavailable === undefined ? {status: 'unknown'}
          : await ports.recoverUnavailable(attempt);
      } catch {
        observed = {status: 'unknown'};
      }
    }
    if (!observationFailed && observed.status === 'unknown' && observed.progress === undefined &&
      ports.recoverUnavailable !== undefined) {
      try { observed = await ports.recoverUnavailable(attempt); }
      catch { observed = {status: 'unknown'}; }
    } else if (!observationFailed && (observed.status !== 'unknown' || observed.progress !== undefined)) {
      ports.observationSucceeded?.(attempt, observed);
    }
    try { results.push(await reconcileRecord(attempt, ports, observed)); }
    catch { results.push({status: 'reconciliation-failed' as const, deliveryReference: attempt.deliveryReference}); }
  }
  return results;
};
