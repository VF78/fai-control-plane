import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  createCodexAgentRuntime,
  readCodexStructuredSummary,
  type CodexStructuredSummary
} from './codex-agent-runtime';
import {
  createLocalAgentRunOrchestrator,
  type LocalAgentRunOrchestrator,
  type LocalAgentRunResult
} from './agent-run-orchestrator';
import type {RuntimeProfile} from './index';
import {createWorktreeManager} from './worktree-manager';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/;
const SAFE_CHECK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,_:()/-]{0,127}$/;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

type Repository = Readonly<{owner: string; name: string}>;

type RunnerClaimEnvelope = Readonly<{
  runId: string;
  attempt: number;
  packetId: string;
  packetHash: string;
  repository: Repository;
  baseCommit: string;
  runtimeProfile: RuntimeProfile;
  timeboxMinutes: number;
  prompt: string;
  leaseToken: string;
  leaseExpiresAt: string;
}>;

type FetchLike = typeof fetch;

export type WorkstationRunnerClientOptions = Readonly<{
  baseUrl: string;
  bearerToken: string;
  repository: Repository;
  orchestrator: LocalAgentRunOrchestrator;
  fetch?: FetchLike;
  heartbeatIntervalMs?: number;
}>;

export type WorkstationRunnerOnceResult =
  | Readonly<{status: 'idle'}>
  | Readonly<{status: 'completed'; result: LocalAgentRunResult}>;

export type WorkstationRunnerEnvironment = Readonly<{
  LOCAL_WORKSTATION_RUNNER_ENABLED?: string;
  LOCAL_WORKSTATION_RUNNER_BASE_URL?: string;
  LOCAL_WORKSTATION_RUNNER_TOKEN?: string;
  LOCAL_WORKSTATION_RUNNER_TOKEN_FILE?: string;
  LOCAL_WORKSTATION_RUNNER_REPOSITORY?: string;
  LOCAL_WORKSTATION_RUNNER_REPOSITORY_ROOT?: string;
  LOCAL_WORKSTATION_RUNNER_WORKTREE_ROOT?: string;
  LOCAL_WORKSTATION_RUNNER_ARTIFACT_ROOT?: string;
  LOCAL_WORKSTATION_RUNNER_CODEX_HOME?: string;
  PATH?: string;
  PATHEXT?: string;
  SYSTEMROOT?: string;
  TEMP?: string;
  TMP?: string;
}>;

export type WorkstationRunnerFromEnvironmentResult =
  | Readonly<{status: 'disabled'}>
  | WorkstationRunnerOnceResult;

const fail = (code: string): never => {
  throw new Error(`workstation_runner_${code}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireValue = (
  environment: WorkstationRunnerEnvironment,
  name: keyof WorkstationRunnerEnvironment
): string => {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) fail(`missing_${name.toLowerCase()}`);
  return value as string;
};

const parseRepository = (value: string): Repository => {
  const parts = value.split('/');
  if (
    parts.length !== 2 ||
    !REPOSITORY_PART_PATTERN.test(parts[0] ?? '') ||
    !REPOSITORY_PART_PATTERN.test(parts[1] ?? '')
  ) {
    fail('invalid_repository');
  }
  return {owner: parts[0]!, name: parts[1]!};
};

const parseBaseUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('invalid_base_url');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    (parsed.protocol === 'http:' &&
      parsed.hostname !== '127.0.0.1' &&
      parsed.hostname !== '::1' &&
      parsed.hostname !== 'localhost') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    fail('invalid_base_url');
  }
  return parsed.origin;
};

const absolutePath = (value: string, field: string): string => {
  if (
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.resolve(value) !== value ||
    value === path.parse(value).root
  ) {
    fail(`invalid_${field}`);
  }
  return value;
};

const readBearerToken = async (
  environment: WorkstationRunnerEnvironment
): Promise<string> => {
  const direct = environment.LOCAL_WORKSTATION_RUNNER_TOKEN;
  const tokenFile = environment.LOCAL_WORKSTATION_RUNNER_TOKEN_FILE;
  if ((direct === undefined) === (tokenFile === undefined)) {
    fail('token_source');
  }
  const token = direct ?? (await readFile(
    absolutePath(tokenFile!, 'token_file'),
    'utf8'
  )).replace(/\r?\n$/, '');
  if (!BEARER_TOKEN_PATTERN.test(token)) fail('invalid_token');
  return token;
};

const parseClaim = (value: unknown, repository: Repository): RunnerClaimEnvelope => {
  if (!isRecord(value)) fail('invalid_claim');
  const candidate = value as Record<string, unknown>;
  const runId = candidate.runId;
  const attempt = candidate.attempt;
  const packetId = candidate.packetId;
  const packetHash = candidate.packetHash;
  const claimedRepository = candidate.repository;
  const baseCommit = candidate.baseCommit;
  const runtimeProfile = candidate.runtimeProfile;
  const timeboxMinutes = candidate.timeboxMinutes;
  const prompt = candidate.prompt;
  const leaseToken = candidate.leaseToken;
  const leaseExpiresAt = candidate.leaseExpiresAt;
  if (
    typeof runId !== 'string' || !UUID_PATTERN.test(runId) ||
    typeof attempt !== 'number' || !Number.isSafeInteger(attempt) ||
    attempt < 1 || attempt > 10_000 ||
    typeof packetId !== 'string' || !UUID_PATTERN.test(packetId) ||
    typeof packetHash !== 'string' || !SHA256_PATTERN.test(packetHash) ||
    !isRecord(claimedRepository) ||
    claimedRepository.owner !== repository.owner ||
    claimedRepository.name !== repository.name ||
    typeof baseCommit !== 'string' || !COMMIT_PATTERN.test(baseCommit) ||
    (runtimeProfile !== 'read_safe' && runtimeProfile !== 'write_scoped') ||
    typeof timeboxMinutes !== 'number' ||
    !Number.isInteger(timeboxMinutes) ||
    timeboxMinutes < 1 || timeboxMinutes > 120 ||
    typeof prompt !== 'string' || prompt.length === 0 ||
    typeof leaseToken !== 'string' || !LEASE_TOKEN_PATTERN.test(leaseToken) ||
    typeof leaseExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(leaseExpiresAt))
  ) {
    fail('invalid_claim');
  }
  return {
    runId: runId as string,
    attempt: attempt as number,
    packetId: packetId as string,
    packetHash: packetHash as string,
    repository,
    baseCommit: baseCommit as string,
    runtimeProfile: runtimeProfile as RuntimeProfile,
    timeboxMinutes: timeboxMinutes as number,
    prompt: prompt as string,
    leaseToken: leaseToken as string,
    leaseExpiresAt: leaseExpiresAt as string
  };
};

const requestHeaders = (token: string): HeadersInit => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
});

const postJson = async (
  fetcher: FetchLike,
  baseUrl: string,
  endpoint: string,
  token: string,
  body?: unknown,
  leaseToken?: string
): Promise<Response> => fetcher(new URL(endpoint, baseUrl), {
  method: 'POST',
  headers: {
    ...requestHeaders(token),
    ...(leaseToken === undefined ? {} : {'x-fai-runner-lease-token': leaseToken})
  },
  ...(body === undefined ? {} : {body: JSON.stringify(body)})
});

const safeReference = (value: string): boolean =>
  SAFE_REFERENCE_PATTERN.test(value) &&
  !value.includes('//') &&
  !value.split('/').some((part) => part === '.' || part === '..');

const completionSummary = async (
  result: LocalAgentRunResult
): Promise<Readonly<{
  changedFiles: readonly string[];
  checks: readonly Readonly<{name: string; status: 'passed' | 'failed' | 'not_run'}>[];
  riskCount: number;
}>> => {
  if (result.receipt.finalStatus !== 'succeeded') {
    return {changedFiles: [], checks: [], riskCount: 0};
  }
  const artifact = result.receipt.summaryArtifact;
  if (
    artifact === undefined ||
    path.basename(artifact.name) !== artifact.name ||
    !safeReference(artifact.name)
  ) {
    fail('invalid_summary_artifact');
  }
  const summaryArtifact = artifact as NonNullable<typeof artifact>;
  const summary = await readCodexStructuredSummary(
    path.join(path.dirname(result.receiptRef), summaryArtifact.name)
  );
  if (
    summary.sha256 !== summaryArtifact.sha256 ||
    summary.sizeBytes !== summaryArtifact.sizeBytes
  ) {
    fail('summary_artifact_mismatch');
  }
  const values: CodexStructuredSummary = summary.summary;
  if (
    values.changedFiles.length > 100 ||
    values.checks.length > 24 ||
    values.risks.length > 100 ||
    values.changedFiles.some((value) => !safeReference(value)) ||
    values.checks.some((check) => !SAFE_CHECK_NAME_PATTERN.test(check.name))
  ) {
    fail('invalid_completion_summary');
  }
  return {
    changedFiles: values.changedFiles,
    checks: values.checks.map(({name, status}) => ({name, status})),
    riskCount: values.risks.length
  };
};

const completionFor = async (
  claim: RunnerClaimEnvelope,
  result: LocalAgentRunResult
): Promise<Record<string, unknown>> => {
  const summary = await completionSummary(result);
  return {
  runId: claim.runId,
  attempt: claim.attempt,
  terminal: result.receipt.finalStatus === 'succeeded' ? 'done' : 'failed',
  receiptSha256: result.receiptSha256,
  receiptSizeBytes: result.receiptSizeBytes,
  finalStatus: result.receipt.finalStatus,
  ...(result.receipt.summaryArtifact === undefined
    ? {}
    : {summaryArtifact: result.receipt.summaryArtifact}),
  changedFiles: summary.changedFiles,
  checks: summary.checks,
  riskCount: summary.riskCount,
  nextAction: result.receipt.nextAction,
  branch: result.receipt.branch
  };
};

export const runWorkstationRunnerOnce = async (
  options: WorkstationRunnerClientOptions
): Promise<WorkstationRunnerOnceResult> => {
  const baseUrl = parseBaseUrl(options.baseUrl);
  if (!BEARER_TOKEN_PATTERN.test(options.bearerToken)) fail('invalid_token');
  const repository = parseRepository(`${options.repository.owner}/${options.repository.name}`);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000) {
    fail('invalid_heartbeat_interval');
  }
  const fetcher = options.fetch ?? fetch;
  const claimResponse = await postJson(fetcher, baseUrl, '/api/runner/claim', options.bearerToken);
  if (claimResponse.status === 204) return {status: 'idle'};
  if (claimResponse.status !== 200) fail(`claim_${claimResponse.status}`);
  const claim = parseClaim(await claimResponse.json(), repository);
  const controller = new AbortController();
  let heartbeatFailure: Error | undefined;
  let heartbeatPromise: Promise<void> | undefined;
  const heartbeat = async (): Promise<void> => {
    if (heartbeatPromise !== undefined) return heartbeatPromise;
    heartbeatPromise = (async () => {
      const response = await postJson(
        fetcher,
        baseUrl,
        '/api/runner/heartbeat',
        options.bearerToken,
        {runId: claim.runId, attempt: claim.attempt},
        claim.leaseToken
      );
      if (response.status !== 200) fail(`heartbeat_${response.status}`);
    })();
    try {
      await heartbeatPromise;
    } catch (error) {
      heartbeatFailure = error instanceof Error ? error : new Error('workstation_runner_heartbeat_failed');
      controller.abort();
      throw heartbeatFailure;
    } finally {
      heartbeatPromise = undefined;
    }
  };

  await heartbeat();
  const timer = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, heartbeatIntervalMs);
  timer.unref();
  let result: LocalAgentRunResult;
  try {
    result = await options.orchestrator.run({
      runId: claim.runId,
      packetId: claim.packetId,
      packetHash: claim.packetHash,
      baseCommit: claim.baseCommit,
      prompt: claim.prompt,
      profile: claim.runtimeProfile,
      timeboxMinutes: claim.timeboxMinutes,
      signal: controller.signal
    });
  } finally {
    clearInterval(timer);
    await heartbeatPromise?.catch(() => undefined);
  }
  if (heartbeatFailure !== undefined) throw heartbeatFailure;
  const completion = await postJson(
    fetcher,
    baseUrl,
    '/api/runner/complete',
    options.bearerToken,
    await completionFor(claim, result),
    claim.leaseToken
  );
  if (completion.status !== 200) fail(`complete_${completion.status}`);
  return {status: 'completed', result};
};

export const runWorkstationRunnerFromEnvironment = async (
  environment: WorkstationRunnerEnvironment = process.env
): Promise<WorkstationRunnerFromEnvironmentResult> => {
  if (environment.LOCAL_WORKSTATION_RUNNER_ENABLED !== 'true') {
    return {status: 'disabled'};
  }
  const token = await readBearerToken(environment);
  const repositoryRoot = absolutePath(
    requireValue(environment, 'LOCAL_WORKSTATION_RUNNER_REPOSITORY_ROOT'),
    'repository_root'
  );
  const worktreeRoot = absolutePath(
    requireValue(environment, 'LOCAL_WORKSTATION_RUNNER_WORKTREE_ROOT'),
    'worktree_root'
  );
  const artifactRoot = absolutePath(
    requireValue(environment, 'LOCAL_WORKSTATION_RUNNER_ARTIFACT_ROOT'),
    'artifact_root'
  );
  const codexHome = absolutePath(
    requireValue(environment, 'LOCAL_WORKSTATION_RUNNER_CODEX_HOME'),
    'codex_home'
  );
  const runtimeEnvironment = {
    PATH: requireValue(environment, 'PATH'),
    ...(environment.PATHEXT === undefined ? {} : {PATHEXT: environment.PATHEXT}),
    ...(environment.SYSTEMROOT === undefined ? {} : {SYSTEMROOT: environment.SYSTEMROOT}),
    ...(environment.TEMP === undefined ? {} : {TEMP: environment.TEMP}),
    ...(environment.TMP === undefined ? {} : {TMP: environment.TMP})
  };
  const orchestrator = createLocalAgentRunOrchestrator({
    artifactRoot,
    worktrees: createWorktreeManager({repositoryRoot, worktreeRoot}),
    runtime: createCodexAgentRuntime({codexHome, environment: runtimeEnvironment})
  });
  return runWorkstationRunnerOnce({
    baseUrl: requireValue(environment, 'LOCAL_WORKSTATION_RUNNER_BASE_URL'),
    bearerToken: token,
    repository: parseRepository(requireValue(environment, 'LOCAL_WORKSTATION_RUNNER_REPOSITORY')),
    orchestrator
  });
};
