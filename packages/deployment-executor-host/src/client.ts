import {createHash, timingSafeEqual} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {lstat, open, realpath, readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  deploymentEnvironments,
  hashDeploymentReleasePackage,
  validateDeploymentObservation,
  validateDeploymentReleasePackage,
  type DeploymentEnvironment,
  type DeploymentObservation,
  type DeploymentReleasePackage
} from '@fai-control-plane/domain';
import {createLoopbackJsonFetch, isNumericLoopbackHostname} from './loopback-json-fetch';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const ARTIFACT_REFERENCE = /^artifact:release-package:([a-z0-9][a-z0-9._-]{0,127})$/;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

type FetchLike = typeof fetch;
type DeploymentClaim = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  executorId: string;
  registrationId: string;
  jobId: string;
  deploymentId: string;
  deploymentVersion: number;
  projectId: string;
  environment: DeploymentEnvironment;
  releasePackage: DeploymentReleasePackage;
  releasePackageHash: string;
  approvedByActorId: string;
  approvedAt: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
}>;

export type ResolvedDeploymentArtifact = Readonly<{
  reference: string;
  path: string;
  sha256: string;
  sizeBytes: number;
}>;

export interface DeploymentArtifactResolver {
  preflight(): Promise<void>;
  resolve(releasePackage: DeploymentReleasePackage, signal?: AbortSignal): Promise<ResolvedDeploymentArtifact>;
}

export type DeploymentAdapterTarget = Readonly<{
  projectId: string;
  environment: DeploymentEnvironment;
}>;

export type DeploymentAdapterInput = Readonly<{
  projectId: string;
  environment: DeploymentEnvironment;
  sourceCommit: string;
  artifact: ResolvedDeploymentArtifact;
  signal: AbortSignal;
}>;

export type DeploymentAdapterResult = Readonly<{
  outcome: DeploymentObservation['outcome'];
  smokeChecks: DeploymentObservation['smokeChecks'];
  rollback: DeploymentObservation['rollback'];
}>;

export interface DeploymentAdapter {
  readonly adapterId: string;
  preflight(target: DeploymentAdapterTarget): Promise<void>;
  execute(input: DeploymentAdapterInput): Promise<DeploymentAdapterResult>;
}

export type DeploymentExecutorClientOptions = Readonly<{
  baseUrl: string;
  bearerToken: string;
  workspaceId: string;
  executorId: string;
  registrationId: string;
  projectId: string;
  environment: DeploymentEnvironment;
  artifacts: DeploymentArtifactResolver;
  adapter: DeploymentAdapter;
  fetch?: FetchLike;
  heartbeatIntervalMs?: number;
  now?: () => Date;
}>;

export type DeploymentExecutorOnceResult =
  | Readonly<{status: 'idle'}>
  | Readonly<{status: 'completed'; outcome: DeploymentObservation['outcome']}>
  | Readonly<{status: 'dry_run_ready'}>;

export type DeploymentExecutorEnvironment = Readonly<Record<string, string | undefined>>;

const fail = (code: string): never => { throw new Error(`deployment_executor_client_${code}`); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const absolute = (value: string, field: string): string => {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || path.resolve(value) !== value ||
    value === path.parse(value).root || value.includes('\0')) fail(`invalid_${field}`);
  return value;
};
const loopbackBaseUrl = (value: string): string => {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail('invalid_base_url'); }
  if (parsed.protocol !== 'http:' || !isNumericLoopbackHostname(parsed.hostname) ||
    parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' ||
    parsed.search !== '' || parsed.hash !== '') fail('base_url_not_loopback');
  return parsed.origin;
};

const parseClaim = (value: unknown, options: DeploymentExecutorClientOptions, now: Date): DeploymentClaim => {
  if (!isRecord(value) || !exact(value, ['schemaVersion', 'workspaceId', 'executorId', 'registrationId',
    'jobId', 'deploymentId', 'deploymentVersion',
    'projectId', 'environment', 'releasePackage', 'releasePackageHash', 'approvedByActorId', 'approvedAt',
    'attempt', 'leaseToken', 'leaseExpiresAt'])) fail('invalid_claim');
  const candidate = value as Record<string, unknown>;
  const validated = validateDeploymentReleasePackage(candidate.releasePackage);
  const releasePackage = validated.ok === true ? validated.value : fail('invalid_claim');
  if (candidate.schemaVersion !== 1 || candidate.workspaceId !== options.workspaceId ||
    candidate.executorId !== options.executorId || candidate.registrationId !== options.registrationId ||
    typeof candidate.jobId !== 'string' || !UUID.test(candidate.jobId) ||
    typeof candidate.deploymentId !== 'string' || !UUID.test(candidate.deploymentId) ||
    !positive(candidate.deploymentVersion) || candidate.projectId !== options.projectId ||
    candidate.environment !== options.environment ||
    typeof candidate.releasePackageHash !== 'string' || !SHA256.test(candidate.releasePackageHash) ||
    hashDeploymentReleasePackage(releasePackage) !== candidate.releasePackageHash ||
    typeof candidate.approvedByActorId !== 'string' || !UUID.test(candidate.approvedByActorId) ||
    !timestamp(candidate.approvedAt) || Date.parse(candidate.approvedAt) > now.getTime() || !positive(candidate.attempt) ||
    typeof candidate.leaseToken !== 'string' || !LEASE_TOKEN.test(candidate.leaseToken) ||
    !timestamp(candidate.leaseExpiresAt) || Date.parse(candidate.leaseExpiresAt) <= now.getTime() ||
    Date.parse(candidate.leaseExpiresAt) > now.getTime() + 10 * 60 * 1_000) {
    fail('invalid_claim');
  }
  return Object.freeze({...candidate, releasePackage}) as DeploymentClaim;
};

const headers = (token: string, leaseToken?: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  ...(leaseToken === undefined ? {} : {'x-fai-deployment-lease-token': leaseToken})
});

const post = (fetcher: FetchLike, baseUrl: string, endpoint: string, token: string,
  body?: unknown, leaseToken?: string) => fetcher(new URL(endpoint, baseUrl), {
    method: 'POST', headers: headers(token, leaseToken),
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });

const failureObservation = (code: string): DeploymentAdapterResult => ({
  outcome: 'failed',
  smokeChecks: [{name: 'deployment executor', status: 'failed',
    reference: `deployment-executor:${SAFE_ID.test(code) ? code : 'execution_failed'}`}],
  rollback: {outcome: 'not_required', reference: null}
});

export const createLocalDeploymentArtifactResolver = (rootValue: string): DeploymentArtifactResolver => {
  const root = absolute(rootValue, 'artifact_root');
  const preflight = async () => {
    const [rootStat, canonicalRoot] = await Promise.all([lstat(root), realpath(root)]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || canonicalRoot !== root) fail('artifact_root_binding');
  };
  return {preflight, async resolve(releasePackage, signal) {
    const validated = validateDeploymentReleasePackage(releasePackage);
    const value = validated.ok === true ? validated.value : fail('artifact_reference');
    const match = ARTIFACT_REFERENCE.exec(value.artifactReference);
    if (match === null) throw new Error('deployment_executor_client_artifact_reference');
    await preflight();
    const canonicalRoot = root;
    const target = path.join(root, match[1]!);
    const [targetStat, canonicalTarget] = await Promise.all([lstat(target), realpath(target)]);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || canonicalTarget !== target ||
      path.dirname(canonicalTarget) !== canonicalRoot || targetStat.size < 1 || targetStat.size > MAX_ARTIFACT_BYTES) {
      fail('artifact_binding');
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat(); const digest = createHash('sha256');
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream('', {fd: handle.fd, autoClose: false});
        const abort = () => stream.destroy(new Error('deployment_executor_client_artifact_cancelled'));
        signal?.addEventListener('abort', abort, {once: true});
        stream.on('data', (chunk: Buffer) => digest.update(chunk));
        stream.once('error', reject); stream.once('end', resolve);
        stream.once('close', () => signal?.removeEventListener('abort', abort));
        if (signal?.aborted) abort();
      });
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.size !== targetStat.size ||
        digest.digest('hex') !== value.artifactSha256) fail('artifact_hash_mismatch');
      return Object.freeze({reference: value.artifactReference, path: target,
        sha256: value.artifactSha256, sizeBytes: before.size});
    } finally { await handle.close(); }
  }};
};

export const createUnavailableDeploymentAdapter = (): DeploymentAdapter => ({
  adapterId: 'unavailable',
  async preflight() { return fail('adapter_unavailable'); },
  async execute() { return fail('adapter_unavailable'); }
});

export const runDeploymentExecutorOnce = async (
  rawOptions: DeploymentExecutorClientOptions
): Promise<DeploymentExecutorOnceResult> => {
  const now = rawOptions.now ?? (() => new Date());
  const options = {...rawOptions, baseUrl: loopbackBaseUrl(rawOptions.baseUrl)};
  if (!BEARER_TOKEN.test(options.bearerToken) || !UUID.test(options.workspaceId) || !SAFE_ID.test(options.executorId) ||
    !UUID.test(options.registrationId) || !UUID.test(options.projectId) ||
    !deploymentEnvironments.includes(options.environment)) fail('invalid_configuration');
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000 || heartbeatIntervalMs > 60_000) {
    fail('invalid_heartbeat_interval');
  }
  await options.artifacts.preflight();
  await options.adapter.preflight({projectId: options.projectId, environment: options.environment});
  const fetcher = options.fetch ?? createLoopbackJsonFetch();
  const claimResponse = await post(fetcher, options.baseUrl, '/api/deployment-executor/claim', options.bearerToken);
  if (claimResponse.status === 204) return {status: 'idle'};
  if (claimResponse.status !== 200) fail(`claim_${claimResponse.status}`);
  const claim = parseClaim(await claimResponse.json(), options, now());
  const controller = new AbortController();
  let heartbeatFailure: Error | undefined;
  let heartbeatPromise: Promise<void> | undefined;
  const heartbeat = async () => {
    if (heartbeatPromise !== undefined) return heartbeatPromise;
    heartbeatPromise = (async () => {
      const response = await post(fetcher, options.baseUrl, '/api/deployment-executor/heartbeat',
        options.bearerToken, {jobId: claim.jobId, attempt: claim.attempt}, claim.leaseToken);
      if (response.status !== 200) fail(`heartbeat_${response.status}`);
      const value = await response.json();
      if (!isRecord(value) || !exact(value, ['leaseExpiresAt']) || !timestamp(value.leaseExpiresAt)) {
        fail('invalid_heartbeat');
      }
    })();
    try { await heartbeatPromise; } catch (error) {
      heartbeatFailure = error instanceof Error ? error : new Error('deployment_executor_client_heartbeat_failed');
      controller.abort();
      throw heartbeatFailure;
    } finally { heartbeatPromise = undefined; }
  };
  await heartbeat();
  const startedAt = now().toISOString();
  const timer = setInterval(() => { void heartbeat().catch(() => undefined); }, heartbeatIntervalMs);
  timer.unref();
  let result: DeploymentAdapterResult;
  try {
    const artifact = await options.artifacts.resolve(claim.releasePackage, controller.signal);
    result = await options.adapter.execute({projectId: claim.projectId, environment: claim.environment,
      sourceCommit: claim.releasePackage.sourceCommit, artifact, signal: controller.signal});
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^deployment_executor_client_([A-Za-z0-9._:-]+)$/.exec(message)?.[1] ?? 'execution_failed';
    result = failureObservation(code);
  } finally {
    clearInterval(timer); await heartbeatPromise?.catch(() => undefined);
  }
  if (heartbeatFailure !== undefined) throw heartbeatFailure;
  const completedAt = now().toISOString();
  const observation = validateDeploymentObservation({...result,
    reference: `deployment-job:${claim.jobId}:client-validation`, startedAt, completedAt});
  const observed = observation.ok === true ? observation.value : fail('adapter_result');
  const completionPayload = {jobId: claim.jobId, deploymentId: claim.deploymentId,
      deploymentVersion: claim.deploymentVersion, attempt: claim.attempt, result: {
        outcome: observed.outcome, startedAt: observed.startedAt,
        completedAt: observed.completedAt, smokeChecks: observed.smokeChecks,
        rollback: observed.rollback
      }};
  let completionResponse: Response;
  try {
    completionResponse = await post(fetcher, options.baseUrl, '/api/deployment-executor/complete',
      options.bearerToken, completionPayload, claim.leaseToken);
    if (completionResponse.status >= 500) completionResponse = await post(fetcher, options.baseUrl,
      '/api/deployment-executor/complete', options.bearerToken, completionPayload, claim.leaseToken);
  } catch {
    completionResponse = await post(fetcher, options.baseUrl, '/api/deployment-executor/complete',
      options.bearerToken, completionPayload, claim.leaseToken);
  }
  if (completionResponse.status !== 200) fail(`complete_${completionResponse.status}`);
  const completion = await completionResponse.json();
  if (!isRecord(completion) || !exact(completion, ['outcome', 'completedAt']) ||
    completion.outcome !== observed.outcome || completion.completedAt !== observed.completedAt) fail('invalid_completion');
  return {status: 'completed', outcome: observed.outcome};
};

const required = (environment: DeploymentExecutorEnvironment, name: string): string => {
  const value = environment[name];
  return typeof value === 'string' && value.length > 0 ? value : fail(`missing_${name.toLowerCase()}`);
};

export const deploymentExecutorFromEnvironment = async (
  environment: DeploymentExecutorEnvironment = process.env,
  adapter: DeploymentAdapter = createUnavailableDeploymentAdapter()
): Promise<Readonly<{status: 'disabled'}> | DeploymentExecutorOnceResult> => {
  if (environment.FAI_DEPLOYMENT_EXECUTOR_ENABLED !== 'true') return {status: 'disabled'};
  const dryRunValue = required(environment, 'FAI_DEPLOYMENT_EXECUTOR_DRY_RUN');
  if (dryRunValue !== 'true' && dryRunValue !== 'false') fail('dry_run_configuration');
  const dryRun = dryRunValue === 'true';
  if (!dryRun && environment.FAI_DEPLOYMENT_EXECUTOR_CONFIRM_ACTIVATION !== 'I_APPROVE_DEPLOYMENT_EXECUTOR') {
    fail('activation_confirmation');
  }
  const configuredAdapter = required(environment, 'FAI_DEPLOYMENT_EXECUTOR_ADAPTER');
  if (!SAFE_ID.test(configuredAdapter) || adapter.adapterId === 'unavailable') fail('adapter_unavailable');
  if (configuredAdapter !== adapter.adapterId) fail('adapter_binding_mismatch');
  const tokenFile = absolute(required(environment, 'FAI_DEPLOYMENT_EXECUTOR_TOKEN_FILE'), 'token_file');
  const [tokenStat, tokenReal] = await Promise.all([lstat(tokenFile), realpath(tokenFile)]);
  const uid = process.getuid?.(); const gid = process.getgid?.();
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenReal !== tokenFile ||
    uid === undefined || gid === undefined || tokenStat.uid !== uid || tokenStat.gid !== gid ||
    (tokenStat.mode & 0o077) !== 0) fail('token_file_binding');
  for (const other of ['FAI_HERMES_RUNNER_CLAIM_TOKEN_FILE', 'LOCAL_WORKSTATION_RUNNER_TOKEN_FILE']) {
    if (environment[other] === tokenFile) fail('token_file_not_distinct');
  }
  const token = (await readFile(tokenFile, 'utf8')).replace(/\r?\n$/, '');
  if (!BEARER_TOKEN.test(token)) fail('invalid_token');
  const tokenHash = createHash('sha256').update(token).digest();
  for (const other of ['FAI_HERMES_RUNNER_CLAIM_TOKEN_FILE', 'LOCAL_WORKSTATION_RUNNER_TOKEN_FILE']) {
    const otherFile = environment[other];
    if (otherFile === undefined) continue;
    const otherToken = (await readFile(absolute(otherFile, 'other_token_file'), 'utf8')).replace(/\r?\n$/, '');
    if (timingSafeEqual(tokenHash, createHash('sha256').update(otherToken).digest())) fail('token_value_not_distinct');
  }
  const projectId = required(environment, 'FAI_DEPLOYMENT_EXECUTOR_PROJECT_ID');
  const deploymentEnvironment = required(environment,
    'FAI_DEPLOYMENT_EXECUTOR_ENVIRONMENT') as DeploymentEnvironment;
  const baseUrl = loopbackBaseUrl(required(environment, 'FAI_DEPLOYMENT_EXECUTOR_BASE_URL'));
  const workspaceId = required(environment, 'FAI_DEPLOYMENT_EXECUTOR_WORKSPACE_ID');
  const executorId = required(environment, 'FAI_DEPLOYMENT_EXECUTOR_ID');
  const registrationId = required(environment, 'FAI_DEPLOYMENT_EXECUTOR_REGISTRATION_ID');
  if (!UUID.test(workspaceId) || !SAFE_ID.test(executorId) || !UUID.test(registrationId) ||
    !UUID.test(projectId) || !deploymentEnvironments.includes(deploymentEnvironment)) {
    fail('invalid_configuration');
  }
  const artifacts = createLocalDeploymentArtifactResolver(absolute(
    required(environment, 'FAI_DEPLOYMENT_EXECUTOR_ARTIFACT_ROOT'), 'artifact_root'));
  if (dryRun) {
    await artifacts.preflight();
    await adapter.preflight({projectId, environment: deploymentEnvironment});
    return {status: 'dry_run_ready'};
  }
  return runDeploymentExecutorOnce({
    baseUrl, bearerToken: token, workspaceId, executorId, registrationId,
    projectId, environment: deploymentEnvironment, artifacts,
    adapter
  });
};

export const runDeploymentExecutorLoop = async (environment: DeploymentExecutorEnvironment = process.env,
  signal?: AbortSignal): Promise<never> => {
  const interval = Number(environment.FAI_DEPLOYMENT_EXECUTOR_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 60_000) fail('invalid_poll_interval');
  while (!signal?.aborted) {
    await deploymentExecutorFromEnvironment(environment);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, interval);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true});
    });
  }
  return fail('stopped');
};
