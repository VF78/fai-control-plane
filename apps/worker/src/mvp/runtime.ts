import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAgentAttemptStore, createAgentContinuationStore, createDatabase, createStores,
  executeAgentSubmissionTransaction, readActiveProjectContext, readAgentRoutingPolicy,
  readActiveProjectExecutionMode, readActiveProjectProcessPolicy, resolveAgentSubmissionBinding, type Database} from '@fai-control-plane/db';
import {defaultAgentStageInstructions, composeAgentTerminalNotification, continueExplicitAgentChain,
  assignTaskExecutor, deliverPending, reconcileActiveAgentAttempts, reconcileTracker, submitExplicitAgent,
  type AgentAttemptRecord, type AgentSubmissionPorts
} from '@fai-control-plane/application';
import {
  createHermesDeliveryAdapter,
  createGitHubRepositoryReadAdapter,
  createGitHubTrackerMutationAdapter,
  createGitHubTrackerReadAdapter,
  createTelegramDeliveryAdapter
} from '@fai-control-plane/integrations';
import type {
  AgentExecutorCatalog,
  AgentDeliveryPort,
  MessengerDeliveryPort,
  MessengerDeliveryInput,
  OpaqueSecretRef,
  SecretResolverPort,
  TrackerItemFact
} from '@fai-control-plane/domain';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {enqueueProjectFailureBlockers, githubBindingCoordinates, listWorkerProjectBindings,
  runProjectBindingsIsolated,
  type WorkerProjectBinding} from './project-runtime.ts';

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_required`);
  return value;
};
const secret = (id: string, purpose: string, variable: string): OpaqueSecretRef => ({
  id, purpose, locator: env(variable)
});
const secrets: SecretResolverPort = {async resolve(reference, expectedPurpose) {
  if (reference.purpose !== expectedPurpose || !reference.locator.startsWith('/')) {
    throw new Error('secret_reference_denied');
  }
  const value = (await readFile(reference.locator, 'utf8')).trim();
  if (value.length === 0 || value.length > 65_536 || value.includes('\0')) throw new Error('secret_invalid');
  return {value};
}};

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const restartHermesGateway = async (): Promise<void> => {
  const endpoint = new URL(env('HERMES_MANAGEMENT_URL'));
  if (!['http:', 'https:'].includes(endpoint.protocol) || (endpoint.protocol === 'http:' &&
    endpoint.hostname.includes('.') && !['127.0.0.1', 'localhost'].includes(endpoint.hostname))) {
    throw new Error('hermes_management_denied');
  }
  const username = (await readFile(env('HERMES_MANAGEMENT_USERNAME_FILE'), 'utf8')).trim();
  const password = (await readFile(env('HERMES_MANAGEMENT_PASSWORD_FILE'), 'utf8')).trim();
  const login = await fetch(new URL('/auth/password-login', endpoint), {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({provider: 'basic', username, password}),
    signal: AbortSignal.timeout(10_000)});
  if (!login.ok) throw new Error('hermes_management_unavailable');
  const values = typeof login.headers.getSetCookie === 'function'
    ? login.headers.getSetCookie() : [login.headers.get('set-cookie') ?? ''];
  const cookie = values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
  const restarted = await fetch(new URL('/api/gateway/restart', endpoint), {method: 'POST', headers: {cookie},
    signal: AbortSignal.timeout(10_000)});
  if (!restarted.ok) throw new Error('hermes_restart_failed');
};

export const createWorker = (database: Database = createDatabase()) => {
  const workspaceId = env('FCP_WORKSPACE_ID');
  const stores = createStores(database, workspaceId);
  const continuations = createAgentContinuationStore(database);
  const gatewayBase = env('HERMES_GATEWAY_INTERNAL_BASE_URL');
  const clientMessenger: MessengerDeliveryPort = {async send() {
    throw new Error('client_messenger_not_configured');
  }};
  const internalMessenger: MessengerDeliveryPort = {async send(message) {
    return createTelegramDeliveryAdapter({config: {projectId: message.projectId,
      chatId: env('TELEGRAM_INTERNAL_CHAT_ID'),
      tokenRef: secret('telegram', 'messenger_delivery', 'TELEGRAM_BOT_TOKEN_FILE')}, secrets}).send(message);
  }};
  const executorCatalog: AgentExecutorCatalog = {'codex-cli': {available: true,
    models: ['gpt-5.6-terra','gpt-5.6-sol']}, 'claude-code-cli': {available: false, models: []}};
  const agentDeliveries = new Map<string, Readonly<{signature: string; delivery: AgentDeliveryPort}>>();

  const projectRuntime = (project: WorkerProjectBinding) => {
    const coordinates = githubBindingCoordinates(project);
    if (coordinates === null) throw new Error('tracker_provider_unsupported');
    const trackerBinding = {id: project.bindingId, ...coordinates, projectId: project.projectId,
      projectUrl: project.projectUrl, credentialRef: project.trackerCredentialRef};
    const tracker = createGitHubTrackerReadAdapter({binding: trackerBinding, secrets});
    const trackerMutation = createGitHubTrackerMutationAdapter({binding: trackerBinding,
      credentialRef: {...project.trackerCredentialRef, purpose: 'tracker_mutate'}, secrets});
    const repository = createGitHubRepositoryReadAdapter({...coordinates, repositoryId: project.repositoryId,
      credentialRef: project.trackerCredentialRef, secrets});
    const agentSignature = `${project.bindingId}:${project.endpointPath}:${project.agentCredentialRef.id}`;
    const existingDelivery = agentDeliveries.get(project.projectId);
    const agentDelivery = existingDelivery?.signature === agentSignature ? existingDelivery.delivery
      : createHermesDeliveryAdapter({endpoint: new URL(project.endpointPath, gatewayBase).toString(),
        credentialRef: project.agentCredentialRef, secrets, allowPrivateHttp: true});
    if (existingDelivery?.signature !== agentSignature) {
      agentDeliveries.set(project.projectId, {signature: agentSignature, delivery: agentDelivery});
    }
    const submissionPorts: AgentSubmissionPorts = {
      async resolveContext({actorId, projectId}) {
        if (projectId !== project.projectId) return null;
        const binding = await resolveAgentSubmissionBinding(database, actorId, projectId);
        if (binding === null || binding.bindingId !== project.bindingId ||
          binding.repositoryId !== project.repositoryId || binding.repositoryUrl !== project.repositoryUrl) return null;
        const configured = await readAgentRoutingPolicy(database, actorId, projectId);
        const processPolicy = await readActiveProjectProcessPolicy(database, projectId);
        if (processPolicy === null) return null;
        const policy = configured?.policy ?? defaultAgentRoutingPolicy;
        const version = configured?.version ??
          createHash('sha256').update(JSON.stringify(policy)).digest('hex');
        return {workspaceId, projectId, requesterRole: binding.requesterRole,
          bindingId: project.bindingId, repository: {id: project.repositoryId, url: project.repositoryUrl},
          agentTrackerOwnerOptionId: project.agentOwnerOptionId,
          doneStatusOptionId: project.doneStatusOptionId,
          routingPolicyVersion: version, routingPolicy: policy, executorCatalog,
          processPolicyVersion: processPolicy.version, processPolicy: processPolicy.policy};
      },
      readFreshSnapshot: (context) => tracker.readSnapshot(context.bindingId, null),
      persistSnapshot: stores.snapshots.replace,
      resolveActiveContext: ({actorId, projectId}) => readActiveProjectContext(database, actorId, projectId),
      repository,
      delivery: agentDelivery,
      composeAcceptedNotification: async (item, idempotencyKey) => ({projectId: project.projectId,
        contour: 'trusted-main', channelReference: 'telegram:internal',
        text: `ИИ агент начал следующий этап: ${item.title} — ${item.url}`, idempotencyKey}),
      transaction: {execute: (input, submit) => executeAgentSubmissionTransaction(database, input, submit)}
    };
    const statusChanged = async (
      prior: TrackerItemFact, item: TrackerItemFact, idempotencyKey: string
    ): Promise<MessengerDeliveryInput> => ({projectId: project.projectId, contour: 'trusted-main',
      channelReference: 'telegram:internal',
      text: `Статус задачи изменён: ${prior.statusOptionName ?? 'Не указан'} → ${item.statusOptionName ?? 'Не указан'}\n${item.title} — ${item.url}`,
      idempotencyKey});
    return {project, tracker, trackerMutation, agentDelivery, submissionPorts, statusChanged};
  };

  const activeProjects = async () => {
    const projects = await listWorkerProjectBindings(database, workspaceId);
    const activeIds = new Set(projects.map((project) => project.projectId));
    for (const projectId of agentDeliveries.keys()) {
      if (!activeIds.has(projectId)) agentDeliveries.delete(projectId);
    }
    return projects;
  };
  const reportFailures = async (operation: 'observe'|'reconcile',
    results: readonly Readonly<{projectId: string; status: 'completed'|'failed'}>[]) => {
    await enqueueProjectFailureBlockers(operation, results, async ({projectId, idempotencyKey, text}) => {
      await stores.outbox.enqueue({projectId, topic: 'messenger-notification', idempotencyKey,
        availableAt: new Date().toISOString(), payload: {message: {projectId, contour: 'trusted-main',
          channelReference: 'telegram:internal', text, idempotencyKey}}});
    });
    for (const result of results) if (result.status === 'failed') {
      process.stderr.write(`worker_project_failed:${result.projectId}:${operation}\n`);
    }
  };
  const notifyRecovery = async (projectId: string, deliveryReference: string, step: string, text: string) => {
    const idempotencyKey = `agent.recovery:${deliveryReference}:${step}`;
    await stores.outbox.enqueue({projectId, topic: 'messenger-notification', idempotencyKey,
      availableAt: new Date().toISOString(), payload: {message: {projectId, contour: 'trusted-main',
        channelReference: 'telegram:internal', text, idempotencyKey}}});
  };
  const recoverAttempt = async (runtime: ReturnType<typeof projectRuntime>, attempt: AgentAttemptRecord) => {
    if (attempt.retryOf !== null && attempt.retryOf !== undefined) throw new Error('agent_recovery_exhausted');
    await notifyRecovery(attempt.projectId, attempt.deliveryReference, 'restart',
      `Hermes недоступен. Перезапускаю ИИ агента и сохраняю текущую задачу: ${attempt.itemTitle ?? attempt.itemId}${attempt.itemUrl === null ? '' : ` — ${attempt.itemUrl}`}`);
    await restartHermesGateway();
    let observed: Awaited<ReturnType<AgentDeliveryPort['observe']>> = {status: 'unknown'};
    for (let probe = 0; probe < 5; probe += 1) {
      await pause(probe === 0 ? 500 : 1_000);
      try {
        observed = await runtime.agentDelivery.observe(attempt.deliveryReference);
        if (observed.status !== 'unknown') {
          await notifyRecovery(attempt.projectId, attempt.deliveryReference, 'resumed',
            `Hermes восстановлен. Продолжаю контроль задачи: ${attempt.itemTitle ?? attempt.itemId}`);
          return observed;
        }
        break;
      } catch { /* Gateway restart is asynchronous; probe for at most 4.5 seconds. */ }
    }
    if (observed.status !== 'unknown') return observed;
    const instructions = defaultAgentStageInstructions(attempt.role);
    try {
      await submitExplicitAgent({actorId: attempt.actorId, projectId: attempt.projectId,
        projectItemId: attempt.itemId, role: attempt.role, constraints: instructions.constraints,
        acceptanceCriteria: instructions.acceptanceCriteria,
        retry: {deliveryReference: attempt.deliveryReference, nonce: 'worker-recovery-v1',
          confirmUnobservableFailure: true}}, runtime.submissionPorts);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'agent_retry_denied') throw error;
      const resumed = await runtime.agentDelivery.observe(attempt.deliveryReference);
      if (resumed.status === 'unknown') throw error;
      return resumed;
    }
    await notifyRecovery(attempt.projectId, attempt.deliveryReference, 'resubmitted',
      `Hermes восстановлен. Та же стадия задачи поставлена повторно: ${attempt.itemTitle ?? attempt.itemId}`);
    return {status: 'started' as const};
  };
  return {
    async observe() {
      const results = await runProjectBindingsIsolated(await activeProjects(), async (project) => {
        const runtime = projectRuntime(project);
        const projectAttempts = createAgentAttemptStore(database, project.projectId);
        await reconcileActiveAgentAttempts(20, {delivery: runtime.agentDelivery, attempts: projectAttempts,
          readTracker: () => runtime.tracker.readSnapshot(project.bindingId, null),
          recoverUnavailable: (attempt) => recoverAttempt(runtime, attempt),
          continueAgentChain: async (attempt, targetStage) => {
            const processPolicy = await readActiveProjectProcessPolicy(database, project.projectId);
            const stage = processPolicy?.policy.stages.find((candidate) => candidate.title === targetStage) ?? null;
            if (stage?.automation === null || stage === null) {
              await stores.snapshots.replace(await runtime.tracker.readSnapshot(project.bindingId, null));
              return;
            }
            await continueExplicitAgentChain({projectId: project.projectId,
              item: {projectId: attempt.projectId, itemId: attempt.itemId}, stage: stage.automation,
              stores: continuations, ports: runtime.submissionPorts,
              instructions: defaultAgentStageInstructions});
          },
          composeTerminalNotification: async (attempt, observed, key) =>
            composeAgentTerminalNotification(project.projectId, attempt, observed, key)});
      });
      await reportFailures('observe', results);
    },
    async reconcile() {
      const results = await runProjectBindingsIsolated(await activeProjects(), async (project) => {
        const runtime = projectRuntime(project);
        const projectAttempts = createAgentAttemptStore(database, project.projectId);
        let processPolicy: Awaited<ReturnType<typeof readActiveProjectProcessPolicy>> = null;
        try {
          processPolicy = await readActiveProjectProcessPolicy(database, project.projectId);
        } catch {
          processPolicy = null;
        }
        if (processPolicy === null) await stores.outbox.enqueue({projectId: project.projectId,
          topic: 'messenger-notification',
          idempotencyKey: `agent-chain:${project.projectId}:process-policy-blocker`,
          availableAt: new Date().toISOString(), payload: {message: {projectId: project.projectId,
            contour: 'trusted-main', channelReference: 'telegram:internal',
            text: 'Автоматическое продолжение ИИ агента остановлено: активные настройки процесса недоступны или некорректны.',
            idempotencyKey: `agent-chain:${project.projectId}:process-policy-blocker`}}});
        await reconcileTracker({bindingId: project.bindingId, workspaceId, projectId: project.projectId,
          cursor: project.cursor, ports: {tracker: runtime.tracker, snapshots: stores.snapshots,
            outbox: stores.outbox, audit: stores.audit, compose: {statusChanged: runtime.statusChanged},
            continueAgentChain: (item) => continueExplicitAgentChain({projectId: project.projectId, item,
              stage: processPolicy?.policy.stages.find((stage) => stage.title === item.statusOptionName)
                ?.automation ?? null,
              stores: continuations, ports: runtime.submissionPorts,
              instructions: defaultAgentStageInstructions})}});
        const executionMode = await readActiveProjectExecutionMode(database, project.projectId);
        if (executionMode.mode !== 'autonomous' || executionMode.actorId === null ||
          (await projectAttempts.listActive(1)).length > 0 || processPolicy === null) return;
        const snapshot = await runtime.tracker.readSnapshot(project.bindingId, null);
        await stores.snapshots.replace(snapshot);
        const stages = new Map(processPolicy.policy.stages.map((stage) => [stage.title, stage]));
        const itemsByIssue = new Map(snapshot.items.map((item) => [item.issueId, item]));
        const eligible = snapshot.items.find((item) => {
          const stage = item.statusOptionName === null ? undefined : stages.get(item.statusOptionName);
          const dependenciesReady = item.dependencyIssueIds.every((id) =>
            itemsByIssue.get(id)?.statusOptionId === project.doneStatusOptionId);
          const autonomousEntry = stage !== undefined && (stage.title === 'Ready' || stage.automation !== null);
          const available = (item.ownerOptionId === null && item.assigneeIds.length === 0) ||
            item.ownerOptionId === project.agentOwnerOptionId;
          return item.blocked === false && dependenciesReady && autonomousEntry && available;
        });
        if (eligible === undefined) {
          await notifyRecovery(project.projectId, snapshot.externalVersion, 'autonomous-idle',
            'Автономный режим: готовых задач больше нет либо следующая задача требует согласования или снятия блокера.');
          return;
        }
        const stage = eligible.statusOptionName === null ? undefined : stages.get(eligible.statusOptionName);
        if (eligible.ownerOptionId === project.agentOwnerOptionId && stage?.automation !== null && stage !== undefined) {
          const instructions = defaultAgentStageInstructions(stage.automation.agentRole);
          await submitExplicitAgent({actorId: executionMode.actorId, projectId: project.projectId,
            projectItemId: eligible.itemId, role: stage.automation.agentRole,
            constraints: instructions.constraints, acceptanceCriteria: instructions.acceptanceCriteria},
          runtime.submissionPorts);
          return;
        }
        await assignTaskExecutor({actorId: executionMode.actorId, projectId: project.projectId,
          projectItemId: eligible.itemId, executor: {kind: 'hermes'}}, {...runtime.submissionPorts,
          tracker: runtime.trackerMutation, agentInstructions: defaultAgentStageInstructions});
      });
      await reportFailures('reconcile', results);
    },
    async retry() {
      return deliverPending({limit: 20, ports: {internalMessenger,
        clientMessenger, outbox: stores.outbox, now: () => new Date()}});
    },
    close: () => database.end()
  };
};
