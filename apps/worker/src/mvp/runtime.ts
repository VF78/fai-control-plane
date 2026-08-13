import {readFile} from 'node:fs/promises';
import {
  createDatabase,
  addSourceArtifact,
  appendIncomingEvent,
  completeIncomingEvent,
  createApprovalPersistence,
  createStores,
  latestTelegramUpdateId,
  readPendingIncomingEvents,
  releaseIncomingEvent,
  resolveActiveHumanMember,
  canApprove,
  type Database
} from '@fai-control-plane/db';
import {decideApproval, deliverPending, dispatchClientConversationAction, dispatchConversationAction, reconcileTracker} from '@fai-control-plane/application';
import {
  createBitrix24DeliveryAdapter,
  createGitHubTrackerMutationAdapter,
  createGitHubTrackerReadAdapter,
  createHermesDeliveryAdapter,
  createTelegramAdapter
} from '@fai-control-plane/integrations';
import type {
  AgentRole,
  AgentRoleRequest,
  MessengerDeliveryInput,
  OpaqueSecretRef,
  SecretResolverPort,
  TrackerItemFact
} from '@fai-control-plane/domain';
import {parseConversationCommand, parseConversationEnvelope} from '@fai-control-plane/domain';
import {createHash} from 'node:crypto';

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
  const tracker = createGitHubTrackerReadAdapter({binding: {
    id: bindingId, owner, repository, projectId, projectNumber,
    projectUrl: `https://github.com/users/${owner}/projects/${projectNumber}`,
    credentialRef: secret('github-projects', 'tracker_read', 'GITHUB_PROJECTS_TOKEN_FILE')
  }, secrets});
  const trackerMutation = createGitHubTrackerMutationAdapter({binding: {
    id: bindingId, owner, repository, projectId, projectNumber,
    projectUrl: `https://github.com/users/${owner}/projects/${projectNumber}`,
    credentialRef: secret('github-projects', 'tracker_read', 'GITHUB_PROJECTS_TOKEN_FILE')
  }, credentialRef: secret('github-projects-mutate', 'tracker_mutate', 'GITHUB_PROJECTS_TOKEN_FILE'), secrets});
  const agent = createHermesDeliveryAdapter({endpoint: env('HERMES_ROLE_REQUEST_URL'),
    credentialRef: secret('hermes', 'agent_delivery', 'HERMES_TOKEN_FILE'), secrets});
  const clientMessenger = createBitrix24DeliveryAdapter({config: {
    portalUrl: env('BITRIX24_PORTAL_URL'), memberId: env('BITRIX24_MEMBER_ID'), taskId: Number(env('BITRIX24_TASK_ID')), projectId,
    allowedAuthorIds: env('BITRIX24_ALLOWED_AUTHOR_IDS').split(',').map(Number),
    applicationTokenRef: secret('bitrix-app', 'messenger_webhook_verify', 'BITRIX24_APPLICATION_TOKEN_FILE'),
    restTokenRef: secret('bitrix-rest', 'messenger_delivery', 'BITRIX24_REST_TOKEN_FILE')
  }, secrets});
  const telegram = createTelegramAdapter({config: {projectId, chatId: env('TELEGRAM_INTERNAL_CHAT_ID'),
    allowedUserIds: env('TELEGRAM_INTERNAL_ALLOWED_USER_IDS').split(','),
    tokenRef: secret('telegram', 'messenger_delivery', 'TELEGRAM_BOT_TOKEN_FILE')}, secrets});
  const persistence = createApprovalPersistence(database);
  const agentRequest = async (
    item: TrackerItemFact, role: AgentRole, idempotencyKey: string
  ): Promise<AgentRoleRequest> => {
    const sources = await database.query<{id: string; sha256: string; kind: string; provenance: string}>(
      'select id,sha256,kind,provenance from project_source_artifacts where project_id=$1 order by created_at limit 20',
      [projectId]
    );
    return {role, repository: {id: `${owner}/${repository}`, url: `https://github.com/${owner}/${repository}`},
      projectItem: {id: item.itemId, projectId: item.projectId, issueId: item.issueId, url: item.url},
      observedVersion: item.version, sources: sources.rows,
      constraints: ['Work only on the referenced GitHub Project item.', 'Do not merge or deploy without explicit approval.'],
      acceptanceCriteria: ['Update the same GitHub item and attach provider-native evidence.'],
      approval: null, correlationId: idempotencyKey, idempotencyKey};
  };
  const notification = async (
    item: TrackerItemFact, reason: string, idempotencyKey: string
  ): Promise<MessengerDeliveryInput> => ({projectId, contour: 'trusted-main', channelReference: 'telegram:internal',
    text: `${reason}: ${item.title} — ${item.url}`, idempotencyKey});
  const conversationPorts = {
    facts: {async read(requestProjectId: string) {
      if (requestProjectId !== projectId) throw new Error('project_denied');
      const result = await database.query<{id: string}>(
        `select s.id from tracker_snapshots s join tracker_bindings b on b.id=s.binding_id
         where b.project_id=$1 order by s.observed_at desc limit 1`, [projectId]);
      if (result.rows[0] === undefined) throw new Error('tracker_snapshot_unavailable');
      return {referenceId: result.rows[0].id};
    }},
    tracker: trackerMutation,
    sources: {async add(command: Readonly<{projectId: string; actorId: string; name: string; content: string;
      messageReference: string}>) {
      if (command.projectId !== projectId) throw new Error('project_denied');
      const id = await addSourceArtifact(database, {projectId, actorId: command.actorId, kind: 'messenger_context',
        name: command.name, mediaType: 'text/plain', contentText: command.content, sourceUrl: null,
        sha256: createHash('sha256').update(command.content).digest('hex'),
        provenance: `messenger:${command.messageReference}`});
      return {referenceId: id};
    }},
    approvals: {async decide(command: Readonly<{projectId: string; actorId: string; approvalId: string;
      kind: 'plan'|'internal_operation'|'production'|'acceptance'|'client_uat'; targetReference: string;
      decision: 'approved'|'rejected'; idempotencyKey: string}>) {
      const result = await decideApproval({workspaceId, request: {id: command.approvalId, projectId: command.projectId,
        kind: command.kind, decision: command.decision, actorId: command.actorId,
        targetReference: command.targetReference, decidedAt: new Date().toISOString(),
        idempotencyKey: command.idempotencyKey}, authority: {canDecide: (actorId, targetProjectId, kind) =>
          canApprove(database, actorId, targetProjectId, kind)}, targets: {async resolve(target) {
            const snapshot = await tracker.readSnapshot(bindingId, null);
            if (snapshot.items.some((item) => item.projectId !== projectId)) throw new Error('tracker_project_mismatch');
            await stores.snapshots.replace(snapshot);
            const fact = snapshot.items.find((item) => item.itemId === target.targetReference || item.issueId === target.targetReference);
            return fact === undefined ? null : {id: target.targetReference, url: fact.url, version: fact.version};
          }}, transaction: persistence.transaction});
      if (result !== 'recorded' && result !== 'duplicate') throw new Error(`approval_${result}`);
      return {referenceId: command.approvalId};
    }},
    identities: {resolveActiveHuman: ({projectId: targetProjectId, senderReference}: Readonly<{projectId: string; senderReference: string}>) =>
      resolveActiveHumanMember(database, targetProjectId, senderReference)},
    receipts: stores.receipts, completion: stores.completion
  };
  const ingestTelegram = async (): Promise<void> => {
    const polled = await telegram.poller.poll(await latestTelegramUpdateId(database, projectId));
    for (const update of polled.messages) {
      const action = parseConversationCommand(update.message.text);
      await appendIncomingEvent(database, {projectId, provider: 'telegram', providerDeliveryId: String(update.updateId),
        eventType: action === null ? 'conversation.pending_interpretation' : 'conversation.action',
        payloadHash: createHash('sha256').update(update.message.messageReference).digest('hex'),
        actionPayload: action === null ? {status: 'pending_interpretation', providerReference: update.message.messageReference,
          contour: update.message.contour} :
          {message: update.message, action}, receivedAt: update.message.observedAt});
    }
    if (polled.highWaterUpdateId !== null) await appendIncomingEvent(database, {projectId, provider: 'telegram-cursor',
      providerDeliveryId: String(polled.highWaterUpdateId), eventType: 'provider.cursor',
      payloadHash: createHash('sha256').update(String(polled.highWaterUpdateId)).digest('hex'),
      receivedAt: new Date().toISOString()});
  };
  const consumeActions = async (): Promise<void> => {
    for (const event of await readPendingIncomingEvents(database, 20)) {
      const envelope = parseConversationEnvelope(event.actionPayload);
      try {
        if (envelope === null || envelope.message.projectId !== event.projectId) throw new Error('incoming_action_invalid');
        if (envelope.message.contour === 'client-edge') {
          if (envelope.action.type === 'agent.submit') throw new Error('client_agent_denied');
          await dispatchClientConversationAction({workspaceId,
            envelope: {message: envelope.message, action: envelope.action}, ports: conversationPorts});
        } else {
          await dispatchConversationAction({workspaceId,
            envelope: {message: envelope.message, action: envelope.action}, ports: {...conversationPorts, agent}});
        }
        await completeIncomingEvent(database, event.id, new Date().toISOString());
      } catch (error) {
        await releaseIncomingEvent(database, event.id); throw error;
      }
    }
  };
  return {
    async reconcile() {
      await ingestTelegram();
      await consumeActions();
      const cursor = await database.query<{cursor: string | null}>('select cursor from tracker_bindings where id=$1', [bindingId]);
      await reconcileTracker({bindingId, workspaceId, projectId, cursor: cursor.rows[0]?.cursor ?? null,
        statusMap: {backlog: env('STATUS_BACKLOG_ID'), ready: env('STATUS_READY_ID'),
          development: env('STATUS_DEVELOPMENT_ID'), qa: env('STATUS_QA_ID'),
          acceptance: env('STATUS_ACCEPTANCE_ID'), done: env('STATUS_DONE_ID')},
        ports: {tracker, snapshots: stores.snapshots, outbox: stores.outbox, audit: stores.audit,
          compose: {agentRequest, notification}}});
    },
    async retry() {
      return deliverPending({limit: 20, ports: {agent, internalMessenger: telegram.delivery,
        clientMessenger, outbox: stores.outbox, now: () => new Date()}});
    },
    close: () => database.end()
  };
};
