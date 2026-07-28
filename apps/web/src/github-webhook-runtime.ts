import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createIncomingEventIngestionService} from '@fai-control-plane/application';
import {
  createDatabase,
  createPostgresIncomingEventInbox
} from '@fai-control-plane/db';
import type {
  OpaqueSecretRef,
  SecretsProvider
} from '@fai-control-plane/domain';
import {createGitHubAppWebhookConfig} from '@fai-control-plane/integrations';
import {PgBoss} from 'pg-boss';
import {
  createGitHubWebhookHandler,
  type GitHubWebhookHandlerDependencies
} from './github-webhook-handler';
import type {Pool} from 'pg';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positiveIntegerPattern = /^[1-9][0-9]{0,19}$/;
const secretScope = Object.freeze(['github:webhook:verify']);

const required = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
};

const requiredUuid = (name: string): string => {
  const value = required(name);
  if (!uuidPattern.test(value)) {
    throw new Error(`Invalid UUID configuration: ${name}`);
  }
  return value;
};

const requiredPositiveInteger = (name: string): number => {
  const value = required(name);
  if (!positiveIntegerPattern.test(value)) {
    throw new Error(`Invalid positive integer configuration: ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Unsafe integer configuration: ${name}`);
  }
  return parsed;
};

export const createFileSecretsProvider = (
  allowedReference: OpaqueSecretRef,
  allowedPurpose = 'github.webhook.verify'
): SecretsProvider => ({
  async resolve(reference, purpose) {
    if (
      purpose !== allowedPurpose ||
      reference.provider !== allowedReference.provider ||
      reference.reference !== allowedReference.reference ||
      reference.scope.length !== allowedReference.scope.length ||
      reference.scope.some(
        (part, index) => part !== allowedReference.scope[index]
      )
    ) {
      throw new Error('Secret reference is not allowed.');
    }
    const value = await readFile(allowedReference.reference, 'utf8');
    if (value.length === 0 || value.length > 65_536 || value.includes('\0')) {
      throw new Error('Webhook secret file is invalid.');
    }
    return {value};
  }
});

export const createPgBossProducer = (
  pool: Pick<Pool, 'query'>
): PgBoss => new PgBoss({
  db: {
    async executeSql(text: string, values?: unknown[]) {
      const result = await pool.query(text, values);
      return {rows: result.rows};
    }
  },
  schedule: false,
  supervise: false,
  migrate: false,
  createSchema: false
});

const createDependencies = async (): Promise<
  GitHubWebhookHandlerDependencies
> => {
  if (process.env.GITHUB_SYNC_ENABLED !== 'true') {
    throw new Error('GitHub synchronization is disabled.');
  }
  const databaseUrl = required('DATABASE_URL');
  const workspaceId = requiredUuid('FCP_WORKSPACE_ID');
  const webhookSecretFile = required('GITHUB_WEBHOOK_SECRET_FILE');
  if (!isAbsolute(webhookSecretFile)) {
    throw new Error('GITHUB_WEBHOOK_SECRET_FILE must be an absolute path.');
  }
  const webhookSecretRef: OpaqueSecretRef = Object.freeze({
    provider: 'file',
    reference: webhookSecretFile,
    scope: secretScope
  });
  const config = createGitHubAppWebhookConfig({
    webhookSecretRef,
    scopes: [
      {
        repositoryId: 1_278_325_372,
        fullName: 'VF78/MSA',
        ownerId: 75_837_222,
        installationId: requiredPositiveInteger(
          'GITHUB_MSA_INSTALLATION_ID'
        ),
        projectId: requiredUuid('GITHUB_MSA_PROJECT_ID'),
        projectNumber: 3,
        projectNodeId: 'PVT_kwHOBIUvJs4Bbefq'
      },
      {
        repositoryId: 1_279_114_011,
        fullName: 'VF78/ascon',
        ownerId: 75_837_222,
        installationId: requiredPositiveInteger(
          'GITHUB_ASCON_INSTALLATION_ID'
        ),
        projectId: requiredUuid('GITHUB_ASCON_PROJECT_ID'),
        projectNumber: 4,
        projectNodeId: 'PVT_kwHOBIUvJs4Bbi0Q'
      }
    ]
  });
  const {db, pool} = createDatabase(databaseUrl);
  const boss = createPgBossProducer(pool);

  return {
    workspaceId,
    config,
    secrets: createFileSecretsProvider(webhookSecretRef),
    ingestion: createIncomingEventIngestionService({
      inbox: createPostgresIncomingEventInbox(db, boss)
    })
  };
};

let dependenciesPromise:
  | Promise<GitHubWebhookHandlerDependencies>
  | undefined;

export const getGitHubWebhookHandler = async () => {
  dependenciesPromise ??= createDependencies().catch((error: unknown) => {
    dependenciesPromise = undefined;
    throw error;
  });
  return createGitHubWebhookHandler(await dependenciesPromise);
};
