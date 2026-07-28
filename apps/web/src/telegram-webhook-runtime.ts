import {readFile} from 'node:fs/promises';
import {createIncomingEventIngestionService} from '@fai-control-plane/application';
import {
  createDatabase,
  createPostgresIncomingEventInbox
} from '@fai-control-plane/db';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {createTelegramWebhookConfig} from '@fai-control-plane/integrations';
import {
  createPgBossProducer
} from './github-webhook-runtime';
import {
  createTelegramWebhookHandler,
  type TelegramWebhookHandlerDependencies
} from './telegram-webhook-handler';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positiveIntegerPattern = /^[1-9][0-9]{0,19}$/;
const secretScope = Object.freeze(['telegram:webhook:verify']);
const identitySecretScope = Object.freeze(['telegram:identity:keying']);

const required = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
};

const requiredUuid = (name: string): string => {
  const value = required(name);
  if (!uuidPattern.test(value)) throw new Error(`Invalid UUID configuration: ${name}`);
  return value;
};

const requiredAllowlist = (name: string): number[] => {
  const value = required(name);
  const entries = value.split(',');
  if (
    entries.length === 0 ||
    entries.some((entry) => !positiveIntegerPattern.test(entry))
  ) {
    throw new Error(`Invalid Telegram allowlist configuration: ${name}`);
  }
  const ids = entries.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`Invalid Telegram allowlist configuration: ${name}`);
  }
  return ids;
};

const createTelegramFileSecretsProvider = (
  webhookSecretRef: OpaqueSecretRef,
  identitySecretRef: OpaqueSecretRef
): SecretsProvider => ({
  async resolve(reference, purpose) {
    const allowed = purpose === 'telegram.webhook.verify'
      ? webhookSecretRef
      : purpose === 'telegram.identity.keying'
        ? identitySecretRef
        : undefined;
    if (
      allowed === undefined || reference.provider !== allowed.provider ||
      reference.reference !== allowed.reference || reference.scope.length !== allowed.scope.length ||
      reference.scope.some((value, index) => value !== allowed.scope[index])
    ) throw new Error('Secret reference is not allowed.');
    const value = await readFile(allowed.reference, 'utf8');
    if (value.length === 0 || value.length > 65_536 || value.includes('\0')) {
      throw new Error('Telegram secret file is invalid.');
    }
    return {value: value.trimEnd()};
  }
});

const createDependencies = async (): Promise<TelegramWebhookHandlerDependencies> => {
  if (process.env.TELEGRAM_INGRESS_ENABLED !== 'true') {
    throw new Error('Telegram ingress is disabled.');
  }
  const webhookSecretFile = required('TELEGRAM_WEBHOOK_SECRET_FILE');
  const identitySecretFile = required('TELEGRAM_IDENTITY_SECRET_FILE');
  if (!webhookSecretFile.startsWith('/') || !identitySecretFile.startsWith('/')) {
    throw new Error('Telegram secret file paths must be absolute.');
  }
  const webhookSecretRef: OpaqueSecretRef = Object.freeze({
    provider: 'file',
    reference: webhookSecretFile,
    scope: secretScope
  });
  const identitySecretRef: OpaqueSecretRef = Object.freeze({
    provider: 'file',
    reference: identitySecretFile,
    scope: identitySecretScope
  });
  const workspaceId = requiredUuid('FCP_WORKSPACE_ID');
  const projectIds = Object.freeze({
    msa: requiredUuid('TELEGRAM_MSA_PROJECT_ID'),
    ascon: requiredUuid('TELEGRAM_ASCON_PROJECT_ID')
  });
  if (projectIds.msa === projectIds.ascon) {
    throw new Error('Telegram project configuration must contain distinct projects.');
  }
  const config = createTelegramWebhookConfig({
    webhookSecretRef,
    identitySecretRef,
    allowedUserIds: requiredAllowlist('TELEGRAM_ALLOWED_USER_IDS'),
    allowedPrivateChatIds: requiredAllowlist('TELEGRAM_ALLOWED_PRIVATE_CHAT_IDS')
  });
  const {db, pool} = createDatabase(required('DATABASE_URL'));
  return {
    workspaceId,
    projectIds,
    config,
    secrets: createTelegramFileSecretsProvider(webhookSecretRef, identitySecretRef),
    ingestion: createIncomingEventIngestionService({
      inbox: createPostgresIncomingEventInbox(db, createPgBossProducer(pool))
    })
  };
};

let dependenciesPromise: Promise<TelegramWebhookHandlerDependencies> | undefined;

export const getTelegramWebhookHandler = async () => {
  dependenciesPromise ??= createDependencies().catch((error: unknown) => {
    dependenciesPromise = undefined;
    throw error;
  });
  return createTelegramWebhookHandler(await dependenciesPromise);
};
