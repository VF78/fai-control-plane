import {createHash, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {and, eq} from 'drizzle-orm';
import {createDeploymentExecutorService, type DeploymentExecutorAuthorization,
  type DeploymentExecutorService} from '@fai-control-plane/application';
import {createActorContextIssuer, deploymentEnvironments} from '@fai-control-plane/domain';
import {actors, createDatabase, createPostgresDeploymentExecutorStore,
  deploymentExecutorRegistrations} from '@fai-control-plane/db';

type Runtime = Readonly<{
  authorization: DeploymentExecutorAuthorization;
  tokenHash: Buffer;
  service: DeploymentExecutorService;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const MAX_AUTHORIZATIONS = 32;
const deploymentCapability = (environment: 'development' | 'staging' | 'production') =>
  `deploy:runner:${environment}` as const;
const required = (name: string) => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing required configuration: ${name}`);
  return value;
};
const list = (name: string) => {
  const values = required(name).split(',').map((value) => value.trim());
  if (values.length < 1 || values.length > MAX_AUTHORIZATIONS || values.some((value) => value.length === 0) ||
    new Set(values).size !== values.length) throw new Error(`Invalid list configuration: ${name}`);
  return values;
};

const loadRuntime = async (): Promise<Runtime> => {
  const workspaceId = required('DEPLOYMENT_EXECUTOR_WORKSPACE_ID');
  const executorId = required('DEPLOYMENT_EXECUTOR_ID');
  const registrationId = required('DEPLOYMENT_EXECUTOR_REGISTRATION_ID');
  const systemActorId = required('DEPLOYMENT_EXECUTOR_SYSTEM_ACTOR_ID');
  const projectIds = list('DEPLOYMENT_EXECUTOR_ALLOWED_PROJECT_IDS');
  const environmentValues = list('DEPLOYMENT_EXECUTOR_ALLOWED_ENVIRONMENTS');
  const tokenFile = required('DEPLOYMENT_EXECUTOR_TOKEN_FILE');
  const databaseUrl = required('DATABASE_URL');
  if (![workspaceId, registrationId, systemActorId, ...projectIds].every((value) => UUID.test(value)) ||
    !SAFE_ID.test(executorId)) throw new Error('Invalid deployment executor identity or project authorization.');
  if (environmentValues.some((value) => !deploymentEnvironments.includes(value as never))) {
    throw new Error('Invalid deployment executor environment authorization.');
  }
  if (!isAbsolute(tokenFile)) throw new Error('DEPLOYMENT_EXECUTOR_TOKEN_FILE must be an absolute path.');
  if (process.env.RUNTIME_OBSERVATION_SYSTEM_ACTOR_ID === systemActorId) {
    throw new Error('Deployment executor must use a distinct system actor.');
  }
  const tokenValue = await readFile(tokenFile, 'utf8');
  const token = tokenValue.endsWith('\n') ? tokenValue.slice(0, -1) : tokenValue;
  if (!TOKEN.test(token)) throw new Error('Deployment executor token file is invalid.');
  const tokenHash = createHash('sha256').update(token).digest();
  for (const other of ['LOCAL_RUNNER_TOKEN_FILE', 'RUNTIME_OBSERVATION_TOKEN_FILE']) {
    const otherFile = process.env[other];
    if (otherFile === undefined) continue;
    if (!isAbsolute(otherFile) || otherFile === tokenFile) {
      throw new Error('Deployment executor must use a distinct bearer token file.');
    }
    const otherValue = await readFile(otherFile, 'utf8');
    const otherToken = otherValue.endsWith('\n') ? otherValue.slice(0, -1) : otherValue;
    const otherHash = createHash('sha256').update(otherToken).digest();
    if (timingSafeEqual(tokenHash, otherHash)) {
      throw new Error('Deployment executor must use a distinct bearer token value.');
    }
  }
  const {db} = createDatabase(databaseUrl);
  const [registration] = await db.select({
    id: deploymentExecutorRegistrations.id,
    workspaceId: deploymentExecutorRegistrations.workspaceId,
    projectId: deploymentExecutorRegistrations.projectId,
    systemActorId: deploymentExecutorRegistrations.systemActorId,
    environment: deploymentExecutorRegistrations.environment,
    executorKey: deploymentExecutorRegistrations.executorKey,
    enabled: deploymentExecutorRegistrations.enabled,
    actorType: actors.type,
    actorAuthMode: actors.authMode,
    actorDisabledAt: actors.disabledAt,
    actorCapabilities: actors.capabilities
  }).from(deploymentExecutorRegistrations).innerJoin(actors, and(
    eq(actors.id, deploymentExecutorRegistrations.systemActorId),
    eq(actors.workspaceId, deploymentExecutorRegistrations.workspaceId)
  )).where(and(eq(deploymentExecutorRegistrations.id, registrationId),
    eq(deploymentExecutorRegistrations.workspaceId, workspaceId))).limit(1);
  if (registration === undefined || !registration.enabled || registration.systemActorId !== systemActorId ||
    registration.executorKey !== executorId || !projectIds.includes(registration.projectId) ||
    !environmentValues.includes(registration.environment) || registration.actorType !== 'system' ||
    registration.actorAuthMode !== 'system' || registration.actorDisabledAt !== null ||
    !deploymentEnvironments.includes(registration.environment as never) ||
    registration.actorCapabilities[deploymentCapability(registration.environment as never)] !== true) {
    throw new Error('Deployment executor registration is unavailable or does not match its allowlist.');
  }
  const requiredCapability = deploymentCapability(registration.environment as 'development' | 'staging' | 'production');
  const issuer = createActorContextIssuer({users: [], agents: [], systems: [{actorId: systemActorId,
    capabilities: [requiredCapability]}]});
  if (!issuer.ok) throw new Error('Deployment executor system actor configuration is invalid.');
  const actor = issuer.value.issueSystem(systemActorId);
  if (!actor.ok) throw new Error('Deployment executor system actor cannot be issued.');
  return {
    authorization: {workspaceId, executorId, registrationId, projectIds: [registration.projectId],
      environments: [registration.environment as 'development' | 'staging' | 'production'], actor: actor.value},
    tokenHash,
    service: createDeploymentExecutorService({store: createPostgresDeploymentExecutorStore(db)})
  };
};

let runtimePromise: Promise<Runtime> | undefined;
export const getDeploymentExecutorRuntime = async (): Promise<Runtime> => {
  runtimePromise ??= loadRuntime().catch((error: unknown) => { runtimePromise = undefined; throw error; });
  return runtimePromise;
};

export const authenticateDeploymentExecutorBearer = (value: string | null, expectedHash: Buffer): boolean => {
  if (value === null || value.length > 384 || !value.startsWith('Bearer ')) return false;
  const token = value.slice('Bearer '.length);
  if (!TOKEN.test(token)) return false;
  const supplied = createHash('sha256').update(token).digest();
  return supplied.length === expectedHash.length && timingSafeEqual(supplied, expectedHash);
};
