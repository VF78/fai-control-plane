import {readFile} from 'node:fs/promises';
import {createDatabase, createStores, type Database} from '@fai-control-plane/db';
import {deliverPending, reconcileTracker} from '@fai-control-plane/application';
import {
  createGitHubTrackerReadAdapter,
  createTelegramDeliveryAdapter
} from '@fai-control-plane/integrations';
import type {
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
  const clientMessenger = {async send() {
    throw new Error('client_messenger_not_configured');
  }};
  const telegram = createTelegramDeliveryAdapter({config: {projectId, chatId: env('TELEGRAM_INTERNAL_CHAT_ID'),
    tokenRef: secret('telegram', 'messenger_delivery', 'TELEGRAM_BOT_TOKEN_FILE')}, secrets});
  const statusChanged = async (
    prior: TrackerItemFact, item: TrackerItemFact, idempotencyKey: string
  ): Promise<MessengerDeliveryInput> => ({projectId, contour: 'trusted-main', channelReference: 'telegram:internal',
    text: `Статус задачи изменён: ${prior.statusOptionName ?? 'Не указан'} → ${item.statusOptionName ?? 'Не указан'}\n${item.title} — ${item.url}`,
    idempotencyKey});
  return {
    async reconcile() {
      const cursor = await database.query<{cursor: string | null}>('select cursor from tracker_bindings where id=$1', [bindingId]);
      await reconcileTracker({bindingId, workspaceId, projectId, cursor: cursor.rows[0]?.cursor ?? null,
        ports: {tracker, snapshots: stores.snapshots, outbox: stores.outbox, audit: stores.audit,
          compose: {statusChanged}}});
    },
    async retry() {
      return deliverPending({limit: 20, ports: {internalMessenger: telegram,
        clientMessenger, outbox: stores.outbox, now: () => new Date()}});
    },
    close: () => database.end()
  };
};
