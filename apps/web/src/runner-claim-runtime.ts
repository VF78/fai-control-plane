import {createHash, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {
  createRunnerClaimService,
  type RunnerClaimAuthorization,
  type RunnerClaimService
} from '@fai-control-plane/application';
import {
  createDatabase,
  createPostgresRunnerClaimStore
} from '@fai-control-plane/db';

type Runtime = Readonly<{
  authorization: RunnerClaimAuthorization;
  tokenHash: Buffer;
  service: RunnerClaimService;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runnerIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const repositoryPartPattern = /^[A-Za-z0-9._-]{1,100}$/;
const bearerTokenPattern = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const MAX_AUTHORIZATIONS = 32;

const required = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
};

const uniqueList = (name: string): readonly string[] => {
  const raw = required(name);
  const values = raw.split(',').map((value) => value.trim());
  if (
    values.length < 1 ||
    values.length > MAX_AUTHORIZATIONS ||
    values.some((value) => value.length === 0) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`Invalid list configuration: ${name}`);
  }
  return values;
};

const loadRuntime = async (): Promise<Runtime> => {
  const workspaceId = required('LOCAL_RUNNER_WORKSPACE_ID');
  const runnerId = required('LOCAL_RUNNER_ID');
  const projectIds = uniqueList('LOCAL_RUNNER_ALLOWED_PROJECT_IDS');
  const repositoryValues = uniqueList(
    'LOCAL_RUNNER_ALLOWED_REPOSITORIES'
  );
  const tokenFile = required('LOCAL_RUNNER_TOKEN_FILE');
  const databaseUrl = required('DATABASE_URL');
  if (!uuidPattern.test(workspaceId)) {
    throw new Error('Invalid UUID configuration: LOCAL_RUNNER_WORKSPACE_ID');
  }
  if (!runnerIdPattern.test(runnerId)) {
    throw new Error('Invalid runner ID configuration.');
  }
  if (projectIds.some((projectId) => !uuidPattern.test(projectId))) {
    throw new Error('Invalid runner project authorization.');
  }
  const repositories = repositoryValues.map((repository) => {
    const parts = repository.split('/');
    if (
      parts.length !== 2 ||
      !repositoryPartPattern.test(parts[0] ?? '') ||
      !repositoryPartPattern.test(parts[1] ?? '')
    ) {
      throw new Error('Invalid runner repository authorization.');
    }
    return {owner: parts[0]!, name: parts[1]!};
  });
  if (!isAbsolute(tokenFile)) {
    throw new Error('LOCAL_RUNNER_TOKEN_FILE must be an absolute path.');
  }
  const tokenFileValue = await readFile(tokenFile, 'utf8');
  const token = tokenFileValue.endsWith('\n')
    ? tokenFileValue.slice(0, -1)
    : tokenFileValue;
  if (!bearerTokenPattern.test(token)) {
    throw new Error('Local runner token file is invalid.');
  }
  const {db} = createDatabase(databaseUrl);
  return {
    authorization: {workspaceId, runnerId, projectIds, repositories},
    tokenHash: createHash('sha256').update(token).digest(),
    service: createRunnerClaimService({
      store: createPostgresRunnerClaimStore(db)
    })
  };
};

let runtimePromise: Promise<Runtime> | undefined;

export const getLocalRunnerClaimRuntime = async (): Promise<Runtime> => {
  runtimePromise ??= loadRuntime().catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};

export const authenticateRunnerBearerToken = (
  authorizationHeader: string | null,
  expectedTokenHash: Buffer
): boolean => {
  if (
    authorizationHeader === null ||
    authorizationHeader.length > 384 ||
    !authorizationHeader.startsWith('Bearer ')
  ) {
    return false;
  }
  const token = authorizationHeader.slice('Bearer '.length);
  if (!bearerTokenPattern.test(token)) return false;
  const suppliedHash = createHash('sha256').update(token).digest();
  return suppliedHash.length === expectedTokenHash.length &&
    timingSafeEqual(suppliedHash, expectedTokenHash);
};
