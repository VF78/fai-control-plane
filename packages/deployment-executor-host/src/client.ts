import {createHash, timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath, readFile, type FileHandle} from 'node:fs/promises';
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
import {createUnixSocketJsonTransport, type DeploymentExecutorEndpoint,
  type DeploymentExecutorTransport} from './unix-socket-json-transport';
import {createLinuxAnonymousStage, preflightLinuxAnonymousStage} from './linux-anonymous-stage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const ARTIFACT_REFERENCE = /^artifact:release-package:([a-z0-9][a-z0-9._-]{0,127})$/;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

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
  sha256: string;
  sizeBytes: number;
  identity: Readonly<{device: number; inode: number}>;
  withReadFd<T>(consume: (fd: number) => Promise<T>): Promise<T>;
}>;

export type ResolvedDeploymentArtifactLease = Readonly<{
  artifact: ResolvedDeploymentArtifact;
  verify(): Promise<void>;
  cleanup(): Promise<void>;
}>;

export interface DeploymentArtifactResolver {
  preflight(): Promise<void>;
  resolve(releasePackage: DeploymentReleasePackage, job: Readonly<{jobId: string; attempt: number}>,
    signal?: AbortSignal): Promise<ResolvedDeploymentArtifactLease>;
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
  bearerToken: string;
  workspaceId: string;
  executorId: string;
  registrationId: string;
  projectId: string;
  environment: DeploymentEnvironment;
  artifacts: DeploymentArtifactResolver;
  adapter: DeploymentAdapter;
  transport: DeploymentExecutorTransport;
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

const post = (transport: DeploymentExecutorTransport, endpoint: DeploymentExecutorEndpoint, token: string,
  body?: unknown, leaseToken?: string) => transport.post(endpoint, headers(token, leaseToken),
    body === undefined ? undefined : JSON.stringify(body));

const failureObservation = (code: string): DeploymentAdapterResult => ({
  outcome: 'failed',
  smokeChecks: [{name: 'deployment executor', status: 'failed',
    reference: `deployment-executor:${SAFE_ID.test(code) ? code : 'execution_failed'}`}],
  rollback: {outcome: 'not_required', reference: null}
});

export type LocalDeploymentArtifactResolverOptions = Readonly<{
  sourceRoot: string;
  stagingRoot: string;
  expectedUid?: number;
  expectedGid?: number;
}>;

export const createLocalDeploymentArtifactResolver = (
  options: LocalDeploymentArtifactResolverOptions
): DeploymentArtifactResolver => {
  const sourceRoot = absolute(options.sourceRoot, 'artifact_root');
  const stagingRoot = absolute(options.stagingRoot, 'artifact_staging_root');
  if (sourceRoot === stagingRoot) fail('artifact_roots_not_distinct');
  const expectedUid = options.expectedUid ?? process.getuid?.();
  const expectedGid = options.expectedGid ?? process.getgid?.();
  if (expectedUid === undefined || expectedGid === undefined || !Number.isSafeInteger(expectedUid) ||
    !Number.isSafeInteger(expectedGid) || expectedUid < 0 || expectedGid < 0) fail('artifact_owner');
  const verifyDirectory = async (directory: string, code: string) => {
    const [value, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
    if (!value.isDirectory() || value.isSymbolicLink() || canonical !== directory || value.uid !== expectedUid ||
      value.gid !== expectedGid || (value.mode & 0o7777) !== 0o700) fail(code);
    return value;
  };
  const preflight = async () => {
    const [source, staging] = await Promise.all([
      verifyDirectory(sourceRoot, 'artifact_root_binding'),
      verifyDirectory(stagingRoot, 'artifact_staging_root_binding')
    ]);
    if (source.dev === staging.dev && source.ino === staging.ino) fail('artifact_roots_not_distinct');
    await preflightLinuxAnonymousStage(stagingRoot);
  };
  return {preflight, async resolve(releasePackage, job, signal) {
    const validated = validateDeploymentReleasePackage(releasePackage);
    const value = validated.ok === true ? validated.value : fail('artifact_reference');
    const match = ARTIFACT_REFERENCE.exec(value.artifactReference);
    if (match === null) throw new Error('deployment_executor_client_artifact_reference');
    if (!UUID.test(job.jobId) || !positive(job.attempt)) fail('artifact_job_binding');
    await preflight();
    const target = path.join(sourceRoot, match[1]!);
    const [targetStat, canonicalTarget] = await Promise.all([lstat(target), realpath(target)]);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || canonicalTarget !== target ||
      path.dirname(canonicalTarget) !== sourceRoot || targetStat.uid !== expectedUid || targetStat.gid !== expectedGid ||
      (targetStat.mode & 0o7777) !== 0o600 || targetStat.size < 1 || targetStat.size > MAX_ARTIFACT_BYTES) {
      fail('artifact_binding');
    }
    const source = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let writer: FileHandle | undefined;
    let reader: FileHandle | undefined;
    try {
      const anonymous = await createLinuxAnonymousStage(stagingRoot);
      writer = anonymous.writer;
      const before = await source.stat(); const digest = createHash('sha256');
      if (before.dev !== targetStat.dev || before.ino !== targetStat.ino || before.uid !== expectedUid ||
        before.gid !== expectedGid || (before.mode & 0o7777) !== 0o600) fail('artifact_binding');
      const chunk = Buffer.allocUnsafe(64 * 1024); let copied = 0;
      for (;;) {
        if (signal?.aborted) fail('artifact_cancelled');
        const {bytesRead} = await source.read(chunk, 0, chunk.byteLength);
        if (bytesRead === 0) break;
        copied += bytesRead;
        if (copied > MAX_ARTIFACT_BYTES) fail('artifact_size');
        digest.update(chunk.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await writer.write(chunk, written, bytesRead - written);
          if (result.bytesWritten < 1) fail('artifact_staging_write');
          written += result.bytesWritten;
        }
      }
      await writer.sync();
      await writer.chmod(0o400);
      await writer.sync();
      const [after, stagedStat] = await Promise.all([source.stat(), writer.stat()]);
      const stagedHash = digest.digest('hex');
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.size !== targetStat.size ||
        copied !== before.size || stagedStat.size !== before.size || stagedStat.uid !== expectedUid ||
        stagedStat.gid !== expectedGid || stagedStat.nlink !== 0 || (stagedStat.mode & 0o7777) !== 0o400 ||
        stagedHash !== value.artifactSha256) fail('artifact_hash_mismatch');
      reader = await anonymous.openReadOnly();
      const readIdentity = await reader.stat();
      if (readIdentity.dev !== stagedStat.dev || readIdentity.ino !== stagedStat.ino ||
        readIdentity.size !== copied || readIdentity.uid !== expectedUid || readIdentity.gid !== expectedGid ||
        readIdentity.nlink !== 0 || (readIdentity.mode & 0o7777) !== 0o400) fail('artifact_staging_binding');
      await writer.close(); writer = undefined;
      const retained = reader; reader = undefined;
      const identity = Object.freeze({device: stagedStat.dev, inode: stagedStat.ino});
      let closed = false; let active = false;
      const verify = async () => {
        if (closed) fail('artifact_handle_closed');
        const first = await retained.stat();
        if (first.dev !== identity.device || first.ino !== identity.inode || first.size !== copied ||
          first.uid !== expectedUid || first.gid !== expectedGid || first.nlink !== 0 ||
          (first.mode & 0o7777) !== 0o400) fail('artifact_handle_binding');
        const verified = createHash('sha256'); const verifyChunk = Buffer.allocUnsafe(64 * 1024);
        let offset = 0;
        while (offset < copied) {
          if (signal?.aborted) fail('artifact_cancelled');
          const {bytesRead} = await retained.read(verifyChunk, 0,
            Math.min(verifyChunk.byteLength, copied - offset), offset);
          if (bytesRead < 1) fail('artifact_handle_size');
          verified.update(verifyChunk.subarray(0, bytesRead)); offset += bytesRead;
        }
        const last = await retained.stat();
        if (last.dev !== first.dev || last.ino !== first.ino || last.size !== first.size ||
          last.mtimeMs !== first.mtimeMs || last.ctimeMs !== first.ctimeMs ||
          verified.digest('hex') !== value.artifactSha256) fail('artifact_handle_hash_mismatch');
      };
      const artifact: ResolvedDeploymentArtifact = Object.freeze({reference: value.artifactReference,
        sha256: value.artifactSha256, sizeBytes: copied, identity,
        async withReadFd<T>(consume: (fd: number) => Promise<T>): Promise<T> {
          if (closed || active || typeof consume !== 'function') return fail('artifact_handle_use');
          active = true;
          try { return await consume(retained.fd); } finally { active = false; }
        }});
      return Object.freeze({artifact, verify, async cleanup() {
        if (closed || active) fail('artifact_handle_cleanup');
        closed = true;
        await retained.close();
      }});
    } catch (error) {
      await reader?.close().catch(() => undefined);
      await writer?.close().catch(() => undefined);
      throw error;
    } finally { await source.close(); }
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
  const options = rawOptions;
  if (!BEARER_TOKEN.test(options.bearerToken) || !UUID.test(options.workspaceId) || !SAFE_ID.test(options.executorId) ||
    !UUID.test(options.registrationId) || !UUID.test(options.projectId) ||
    !deploymentEnvironments.includes(options.environment)) fail('invalid_configuration');
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000 || heartbeatIntervalMs > 60_000) {
    fail('invalid_heartbeat_interval');
  }
  await options.artifacts.preflight();
  await options.adapter.preflight({projectId: options.projectId, environment: options.environment});
  await options.transport.preflight();
  const claimResponse = await post(options.transport, '/api/deployment-executor/claim', options.bearerToken);
  if (claimResponse.status === 204) return {status: 'idle'};
  if (claimResponse.status !== 200) fail(`claim_${claimResponse.status}`);
  const claim = parseClaim(await claimResponse.json(), options, now());
  const controller = new AbortController();
  let heartbeatFailure: Error | undefined;
  let heartbeatPromise: Promise<void> | undefined;
  const heartbeat = async () => {
    if (heartbeatPromise !== undefined) return heartbeatPromise;
    heartbeatPromise = (async () => {
      const response = await post(options.transport, '/api/deployment-executor/heartbeat',
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
  let staged: Awaited<ReturnType<DeploymentArtifactResolver['resolve']>> | undefined;
  try {
    staged = await options.artifacts.resolve(claim.releasePackage,
      {jobId: claim.jobId, attempt: claim.attempt}, controller.signal);
    await staged.verify();
    try {
      result = await options.adapter.execute({projectId: claim.projectId, environment: claim.environment,
        sourceCommit: claim.releasePackage.sourceCommit, artifact: staged.artifact, signal: controller.signal});
    } finally {
      await staged.verify();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^deployment_executor_client_([A-Za-z0-9._:-]+)$/.exec(message)?.[1] ?? 'execution_failed';
    result = failureObservation(code);
  } finally {
    clearInterval(timer); await heartbeatPromise?.catch(() => undefined);
  }
  try {
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
      completionResponse = await post(options.transport, '/api/deployment-executor/complete',
        options.bearerToken, completionPayload, claim.leaseToken);
      if (completionResponse.status >= 500) completionResponse = await post(options.transport,
        '/api/deployment-executor/complete', options.bearerToken, completionPayload, claim.leaseToken);
    } catch {
      completionResponse = await post(options.transport, '/api/deployment-executor/complete',
        options.bearerToken, completionPayload, claim.leaseToken);
    }
    if (completionResponse.status !== 200) fail(`complete_${completionResponse.status}`);
    const completion = await completionResponse.json();
    if (!isRecord(completion) || !exact(completion, ['outcome', 'completedAt']) ||
      completion.outcome !== observed.outcome || completion.completedAt !== observed.completedAt) {
      fail('invalid_completion');
    }
    return {status: 'completed', outcome: observed.outcome};
  } finally {
    await staged?.cleanup();
  }
};

const required = (environment: DeploymentExecutorEnvironment, name: string): string => {
  const value = environment[name];
  return typeof value === 'string' && value.length > 0 ? value : fail(`missing_${name.toLowerCase()}`);
};

const requiredPositiveDecimalIdentity = (
  environment: DeploymentExecutorEnvironment,
  name: string
): number => {
  const value = required(environment, name);
  if (!/^[1-9][0-9]*$/.test(value)) fail(`invalid_${name.toLowerCase()}`);
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fail(`invalid_${name.toLowerCase()}`);
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
    (tokenStat.mode & 0o7777) !== 0o600) fail('token_file_binding');
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
  const workspaceId = required(environment, 'FAI_DEPLOYMENT_EXECUTOR_WORKSPACE_ID');
  const executorId = required(environment, 'FAI_DEPLOYMENT_EXECUTOR_ID');
  const registrationId = required(environment, 'FAI_DEPLOYMENT_EXECUTOR_REGISTRATION_ID');
  if (!UUID.test(workspaceId) || !SAFE_ID.test(executorId) || !UUID.test(registrationId) ||
    !UUID.test(projectId) || !deploymentEnvironments.includes(deploymentEnvironment)) {
    fail('invalid_configuration');
  }
  const artifacts = createLocalDeploymentArtifactResolver({
    sourceRoot: absolute(required(environment, 'FAI_DEPLOYMENT_EXECUTOR_ARTIFACT_ROOT'), 'artifact_root'),
    stagingRoot: absolute(required(environment, 'FAI_DEPLOYMENT_EXECUTOR_STAGING_ROOT'), 'artifact_staging_root')
  });
  const socketUid = requiredPositiveDecimalIdentity(environment, 'FAI_DEPLOYMENT_EXECUTOR_SOCKET_UID');
  const socketGid = requiredPositiveDecimalIdentity(environment, 'FAI_DEPLOYMENT_EXECUTOR_SOCKET_GID');
  const transportGid = requiredPositiveDecimalIdentity(environment, 'FAI_DEPLOYMENT_EXECUTOR_TRANSPORT_GID');
  if (socketGid !== transportGid) fail('socket_transport_gid_mismatch');
  const transport = createUnixSocketJsonTransport({socketPath: absolute(
    required(environment, 'FAI_DEPLOYMENT_EXECUTOR_SOCKET_PATH'), 'socket_path'),
  expectedSocketUid: socketUid, expectedSocketGid: socketGid,
  trustedDirectoryUid: 0, trustedDirectoryGid: transportGid});
  if (dryRun) {
    await artifacts.preflight();
    await adapter.preflight({projectId, environment: deploymentEnvironment});
    await transport.preflight();
    return {status: 'dry_run_ready'};
  }
  return runDeploymentExecutorOnce({
    bearerToken: token, workspaceId, executorId, registrationId,
    projectId, environment: deploymentEnvironment, artifacts,
    adapter, transport
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
