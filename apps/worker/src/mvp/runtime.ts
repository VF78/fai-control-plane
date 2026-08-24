import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAgentAttemptStore, createAgentContinuationStore, createDatabase, createStores,
  executeAgentSubmissionTransaction, readActiveProjectContext, readAgentRoutingPolicy,
  readActiveProjectProcessPolicy,
  resolveAgentSubmissionBinding, type Database} from '@fai-control-plane/db';
import {defaultAgentStageInstructions, composeAgentTerminalNotification, continueExplicitAgentChain,
  deliverPending, reconcileActiveAgentAttempts, reconcileTracker, type AgentSubmissionPorts} from '@fai-control-plane/application';
import {
  createHermesDeliveryAdapter,
  createGitHubRepositoryReadAdapter,
  createGitHubTrackerReadAdapter,
  createTelegramDeliveryAdapter
} from '@fai-control-plane/integrations';
import type {
  AgentExecutorCatalog,
  MessengerDeliveryInput,
  OpaqueSecretRef,
  SecretResolverPort,
  TrackerItemFact
} from '@fai-control-plane/domain';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';

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

export const createWorker = (database: Database = createDatabase()) => {
  const workspaceId = env('FCP_WORKSPACE_ID');
  const projectId = env('FCP_PROJECT_ID');
  const bindingId = env('GITHUB_BINDING_ID');
  const owner = env('GITHUB_OWNER');
  const repository = env('GITHUB_REPOSITORY');
  const projectNumber = Number(env('GITHUB_PROJECT_NUMBER'));
  const stores = createStores(database, workspaceId);
  const attempts = createAgentAttemptStore(database);
  const continuations = createAgentContinuationStore(database);
  const tracker = createGitHubTrackerReadAdapter({binding: {
    id: bindingId, owner, repository, projectId, projectNumber,
    projectUrl: `https://github.com/users/${owner}/projects/${projectNumber}`,
    credentialRef: secret('github-projects', 'tracker_read', 'GITHUB_PROJECTS_TOKEN_FILE')
  }, secrets});
  const repositoryRead = createGitHubRepositoryReadAdapter({owner, repository, repositoryId: env('GITHUB_REPOSITORY_ID'),
    credentialRef: secret('github-projects', 'tracker_read', 'GITHUB_PROJECTS_TOKEN_FILE'), secrets});
  const clientMessenger = {async send() {
    throw new Error('client_messenger_not_configured');
  }};
  const telegram = createTelegramDeliveryAdapter({config: {projectId, chatId: env('TELEGRAM_INTERNAL_CHAT_ID'),
    tokenRef: secret('telegram', 'messenger_delivery', 'TELEGRAM_BOT_TOKEN_FILE')}, secrets});
  const agentDelivery = createHermesDeliveryAdapter({endpoint: env('HERMES_ROLE_REQUEST_URL'),
    credentialRef: secret('hermes', 'agent_delivery', 'HERMES_TOKEN_FILE'), secrets});
  const statusChanged = async (
    prior: TrackerItemFact, item: TrackerItemFact, idempotencyKey: string
  ): Promise<MessengerDeliveryInput> => ({projectId, contour: 'trusted-main', channelReference: 'telegram:internal',
    text: `Статус задачи изменён: ${prior.statusOptionName ?? 'Не указан'} → ${item.statusOptionName ?? 'Не указан'}\n${item.title} — ${item.url}`,
    idempotencyKey});
  const executorCatalog: AgentExecutorCatalog = {'codex-cli': {available: true,
    models: ['gpt-5.6-terra','gpt-5.6-sol']}, 'claude-code-cli': {available: false, models: []}};
  const submissionPorts: AgentSubmissionPorts = {
    async resolveContext({actorId, projectId: requestedProjectId}) {
      const binding = await resolveAgentSubmissionBinding(database, actorId, requestedProjectId);
      if (binding === null || binding.bindingId !== bindingId ||
        binding.projectId !== projectId || binding.repositoryId !== env('GITHUB_REPOSITORY_ID')) return null;
      const configured = await readAgentRoutingPolicy(database, actorId, requestedProjectId);
      const processPolicy = await readActiveProjectProcessPolicy(database, requestedProjectId);
      if (processPolicy === null) return null;
      const policy = configured?.policy ?? defaultAgentRoutingPolicy;
      const version = configured?.version ?? createHash('sha256').update(JSON.stringify(policy)).digest('hex');
      return {workspaceId, projectId, requesterRole: binding.requesterRole, bindingId,
        repository: {id: binding.repositoryId, url: binding.repositoryUrl},
        agentTrackerOwnerOptionId: env('HERMES_TRACKER_OWNER_OPTION_ID'), doneStatusOptionId: env('STATUS_DONE_ID'),
        routingPolicyVersion: version, routingPolicy: policy, executorCatalog,
        processPolicyVersion: processPolicy.version, processPolicy: processPolicy.policy};
    },
    readFreshSnapshot: (context) => tracker.readSnapshot(context.bindingId, null),
    persistSnapshot: stores.snapshots.replace,
    resolveActiveContext: ({actorId, projectId: requestedProjectId}) =>
      readActiveProjectContext(database, actorId, requestedProjectId),
    repository: repositoryRead,
    delivery: agentDelivery,
    composeAcceptedNotification: async (item, idempotencyKey) => ({projectId, contour: 'trusted-main',
      channelReference: 'telegram:internal', text: `ИИ агент начал следующий этап: ${item.title} — ${item.url}`, idempotencyKey}),
    transaction: {execute: (input, submit) => executeAgentSubmissionTransaction(database, input, submit)}
  };
  return {
    async reconcile() {
      await reconcileActiveAgentAttempts(20, {delivery: agentDelivery, attempts,
        readFreshItem: async (attempt) => {
          const snapshot = await tracker.readSnapshot(bindingId, null);
          await stores.snapshots.replace(snapshot);
          return snapshot.items.find((candidate) => candidate.projectId === attempt.projectId &&
            candidate.itemId === attempt.itemId) ?? null;
        },
        composeTerminalNotification: async (attempt, observed, key) =>
          composeAgentTerminalNotification(attempt.projectId, attempt, observed, key)});
      const cursor = await database.query<{cursor: string | null}>('select cursor from tracker_bindings where id=$1', [bindingId]);
      let processPolicy: Awaited<ReturnType<typeof readActiveProjectProcessPolicy>> = null;
      try { processPolicy = await readActiveProjectProcessPolicy(database, projectId); }
      catch { processPolicy = null; }
      if (processPolicy === null) await stores.outbox.enqueue({projectId, topic: 'messenger-notification',
        idempotencyKey: `agent-chain:${projectId}:process-policy-blocker`, availableAt: new Date().toISOString(),
        payload: {message: {projectId, contour: 'trusted-main', channelReference: 'telegram:internal',
          text: 'Автоматическое продолжение ИИ агента остановлено: активные настройки процесса недоступны или некорректны.',
          idempotencyKey: `agent-chain:${projectId}:process-policy-blocker`}}});
      await reconcileTracker({bindingId, workspaceId, projectId, cursor: cursor.rows[0]?.cursor ?? null,
        ports: {tracker, snapshots: stores.snapshots, outbox: stores.outbox, audit: stores.audit,
          compose: {statusChanged}, continueAgentChain: (item) => continueExplicitAgentChain({projectId, item,
            stage: processPolicy?.policy.stages.find((stage) => stage.title === item.statusOptionName)?.automation ?? null,
            stores: continuations, ports: submissionPorts, instructions: defaultAgentStageInstructions})}});
    },
    async retry() {
      return deliverPending({limit: 20, ports: {internalMessenger: telegram,
        clientMessenger, outbox: stores.outbox, now: () => new Date()}});
    },
    close: () => database.end()
  };
};
