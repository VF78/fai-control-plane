import {readFile} from 'node:fs/promises';
import {createDatabase, createStores, type Database} from '@fai-control-plane/db';
import {deliverPending, reconcileTracker} from '@fai-control-plane/application';
import {
  createGitHubTrackerReadAdapter,
  createHermesDeliveryAdapter,
  createTelegramDeliveryAdapter
} from '@fai-control-plane/integrations';
import type {
  AgentRole,
  AgentRoleRequest,
  MessengerDeliveryInput,
  OpaqueSecretRef,
  SecretResolverPort,
  TrackerItemFact
} from '@fai-control-plane/domain';

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
  const agent = createHermesDeliveryAdapter({endpoint: env('HERMES_ROLE_REQUEST_URL'),
    credentialRef: secret('hermes', 'agent_delivery', 'HERMES_TOKEN_FILE'), secrets});
  const clientMessenger = {async send() {
    throw new Error('client_messenger_not_configured');
  }};
  const telegram = createTelegramDeliveryAdapter({config: {projectId, chatId: env('TELEGRAM_INTERNAL_CHAT_ID'),
    tokenRef: secret('telegram', 'messenger_delivery', 'TELEGRAM_BOT_TOKEN_FILE')}, secrets});
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
  return {
    async reconcile() {
      const cursor = await database.query<{cursor: string | null}>('select cursor from tracker_bindings where id=$1', [bindingId]);
      await reconcileTracker({bindingId, workspaceId, projectId, cursor: cursor.rows[0]?.cursor ?? null,
        statusMap: {backlog: env('STATUS_BACKLOG_ID'), ready: env('STATUS_READY_ID'),
          development: env('STATUS_DEVELOPMENT_ID'), qa: env('STATUS_QA_ID'),
          acceptance: env('STATUS_ACCEPTANCE_ID'), done: env('STATUS_DONE_ID')},
        ports: {tracker, snapshots: stores.snapshots, outbox: stores.outbox, audit: stores.audit,
          compose: {agentRequest, notification}}});
    },
    async retry() {
      return deliverPending({limit: 20, ports: {agent, internalMessenger: telegram,
        clientMessenger, outbox: stores.outbox, now: () => new Date()}});
    },
    close: () => database.end()
  };
};
