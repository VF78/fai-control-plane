import {readFile} from 'node:fs/promises';
import {
  conversationChannelConfigurations,
  createDatabase,
  createPostgresConversationStore
} from '@fai-control-plane/db';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {
  createTelegramWebhookConfig,
  telegramKeyedIdentifier,
  type TelegramConversationBinding
} from '@fai-control-plane/integrations';
import {
  createTelegramWebhookHandler,
  type TelegramWebhookHandlerDependencies
} from './telegram-webhook-handler';
import {and, eq, inArray} from 'drizzle-orm';

const integerPattern = /^-?[1-9][0-9]{0,19}$/;
const positiveIntegerPattern = /^[1-9][0-9]{0,15}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
const optionalTelegramUserId = (name: string): number | null => {
  const value = process.env[name] || undefined;
  if (value === undefined) return null;
  if (!positiveIntegerPattern.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid Telegram user identity configuration: ${name}`);
  }
  return Number(value);
};
const launchHumanSubjects = (): Readonly<{vladimir: string; vitaliy: string}> => {
  const bootstrap = required('FCP_BOOTSTRAP_HUMAN_SUBJECT');
  const bootstrapId = bootstrap.match(/^github:user:([1-9][0-9]{0,15})$/)?.[1];
  const operatorIds = required('FCP_OPERATOR_GITHUB_USER_IDS').split(',');
  if (
    bootstrapId === undefined ||
    operatorIds.length !== 2 ||
    operatorIds.some((id) =>
      !positiveIntegerPattern.test(id) || !Number.isSafeInteger(Number(id))) ||
    new Set(operatorIds).size !== 2 ||
    !operatorIds.includes(bootstrapId)
  ) throw new Error('Launch human identity configuration is invalid.');
  return {
    vladimir: bootstrap,
    vitaliy: `github:user:${operatorIds.find((id) => id !== bootstrapId)!}`
  };
};

const optionalBinding = (
  project: 'msa' | 'ascon',
  conversationClass: 'internal' | 'client'
): TelegramConversationBinding | null => {
  const prefix = `TELEGRAM_${project.toUpperCase()}_${conversationClass.toUpperCase()}`;
  const chatIdValue = process.env[`${prefix}_CHAT_ID`] || undefined;
  const activatedAtValue = process.env[`${prefix}_ACTIVATED_AT`] || undefined;
  if (chatIdValue === undefined && activatedAtValue === undefined) return null;
  if (
    chatIdValue === undefined ||
    activatedAtValue === undefined ||
    !integerPattern.test(chatIdValue)
  ) throw new Error(`Invalid Telegram conversation binding: ${prefix}`);
  const chatId = Number(chatIdValue);
  const activatedAt = new Date(activatedAtValue);
  if (!Number.isSafeInteger(chatId) || chatId === 0 || Number.isNaN(activatedAt.getTime())) {
    throw new Error(`Invalid Telegram conversation binding: ${prefix}`);
  }
  return {project, conversationClass, chatId, activatedAt};
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
  const projectIds = Object.freeze({
    msa: requiredUuid('TELEGRAM_MSA_PROJECT_ID'),
    ascon: requiredUuid('TELEGRAM_ASCON_PROJECT_ID')
  });
  if (projectIds.msa === projectIds.ascon) {
    throw new Error('Telegram project configuration must contain distinct projects.');
  }
  const bindings = [
    optionalBinding('msa', 'internal'),
    optionalBinding('msa', 'client'),
    optionalBinding('ascon', 'internal'),
    optionalBinding('ascon', 'client')
  ].filter((binding): binding is TelegramConversationBinding => binding !== null);
  if (bindings.length === 0) throw new Error('No Telegram conversation binding is configured.');
  const {db} = createDatabase(required('DATABASE_URL'));
  const channelConfigurations = await db.select().from(conversationChannelConfigurations).where(and(
    inArray(conversationChannelConfigurations.projectId, Object.values(projectIds)),
    eq(conversationChannelConfigurations.provider, 'telegram'),
    eq(conversationChannelConfigurations.desiredState, 'active')
  ));
  const configuredBindings = bindings.map((binding) => {
    const configurationRef = `telegram:${binding.project}:${binding.conversationClass}`;
    const configuration = channelConfigurations.find((candidate) =>
      candidate.projectId === projectIds[binding.project] &&
      candidate.conversationClass === binding.conversationClass &&
      candidate.configurationRef === configurationRef);
    if (configuration === undefined) {
      throw new Error('Telegram binding is not enabled by canonical desired state.');
    }
    return {binding, configuration};
  });
  if (configuredBindings.length !== channelConfigurations.length) {
    throw new Error('Canonical Telegram binding is missing production configuration.');
  }
  const config = createTelegramWebhookConfig({
    webhookSecretRef,
    identitySecretRef,
    bindings: configuredBindings.map(({binding}) => binding)
  });
  const secrets = createTelegramFileSecretsProvider(webhookSecretRef, identitySecretRef);
  const identitySecret = (await secrets.resolve(
    identitySecretRef, 'telegram.identity.keying'
  )).value;
  const conversations = createPostgresConversationStore(db);
  const rosterSubjects = launchHumanSubjects();
  const workspaceId = requiredUuid('FCP_WORKSPACE_ID');
  const identityInputs = [
    {
      actorExternalSubject: rosterSubjects.vladimir,
      userId: optionalTelegramUserId('TELEGRAM_VLADIMIR_USER_ID')
    },
    {
      actorExternalSubject: rosterSubjects.vitaliy,
      userId: optionalTelegramUserId('TELEGRAM_VITALIY_USER_ID')
    },
    {
      actorExternalSubject: 'agent:hermes:v1',
      userId: optionalTelegramUserId('TELEGRAM_HERMES_USER_ID')
    }
  ];
  await conversations.reconcileIdentities(workspaceId, 'telegram', identityInputs.map((identity) => ({
    actorExternalSubject: identity.actorExternalSubject,
    externalSubject: identity.userId === null
      ? null
      : telegramKeyedIdentifier(identitySecret, 'user', identity.userId)
  })));
  await conversations.reconcileBindings('telegram', Object.values(projectIds), configuredBindings.map(({binding, configuration}) => ({
    configurationId: configuration.id,
    projectId: configuration.projectId,
    conversationClass: configuration.conversationClass,
    provider: 'telegram',
    configurationRef: configuration.configurationRef!,
    externalRef: telegramKeyedIdentifier(identitySecret, 'chat', binding.chatId),
    activatedAt: binding.activatedAt
  })));
  return {
    config,
    secrets,
    conversations
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
