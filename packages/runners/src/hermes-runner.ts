import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHermesDirectivePlanner} from './hermes-codex-runtime';
import {createHermesExecutorTransport} from './hermes-executor-transport';
import {runWorkstationRunnerOnce, type WorkstationRunnerOnceResult} from './workstation-runner';

const TOKEN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type HermesRunnerEnvironment = Readonly<Record<string, string | undefined>>;
type ObservationComponent = 'service' | 'scheduler' | 'delivery';

const fail = (code: string): never => { throw new Error(`hermes_runner_${code}`); };
const required = (environment: HermesRunnerEnvironment, name: string): string => {
  const value = environment[name];
  return typeof value === 'string' && value.length > 0 ? value : fail(`missing_${name.toLowerCase()}`);
};
const absolute = (value: string, name: string): string => {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || path.resolve(value) !== value ||
    value === path.parse(value).root || value.includes('\0')) fail(`invalid_${name}`);
  return value;
};
const loopback = (value: string): string => {
  let url: URL;
  try { url = new URL(value); } catch { return fail('invalid_base_url'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname) ||
    url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    fail('base_url_not_loopback');
  }
  return url.origin;
};
const tokenFrom = async (value: string): Promise<string> => {
  const token = (await readFile(absolute(value, 'token_file'), 'utf8')).replace(/\r?\n$/, '');
  return TOKEN.test(token) ? token : fail('invalid_token');
};

const publishObservation = async (input: Readonly<{
  fetcher: typeof fetch;
  baseUrl: string;
  token: string;
  registrationId: string;
  runnerId: string;
  ttlSeconds: number;
  component: ObservationComponent;
  state: 'available' | 'unavailable';
}>): Promise<void> => {
  const response = await input.fetcher(new URL('/api/runtime-observations', input.baseUrl), {
    method: 'POST', headers: {authorization: `Bearer ${input.token}`, 'content-type': 'application/json'},
    body: JSON.stringify({registrationId: input.registrationId, component: input.component,
      state: input.state, observedAt: new Date().toISOString(), ttlSeconds: input.ttlSeconds,
      evidenceReference: `fai-hermes-runner:${input.runnerId}:${input.component}:v1`})
  });
  if (response.status !== 200 && response.status !== 201) fail(`observation_${input.component}_${response.status}`);
};

export const runHermesRunnerOnceFromEnvironment = async (
  environment: HermesRunnerEnvironment = process.env,
  fetcher: typeof fetch = fetch
): Promise<WorkstationRunnerOnceResult> => {
  if (environment.FAI_HERMES_RUNNER_ENABLED !== 'true') fail('disabled');
  const baseUrl = loopback(required(environment, 'FAI_HERMES_RUNNER_BASE_URL'));
  const runnerId = required(environment, 'FAI_HERMES_RUNNER_ID');
  const registrationId = required(environment, 'FAI_HERMES_RUNNER_REGISTRATION_ID');
  const repositoryValue = required(environment, 'FAI_HERMES_RUNNER_REPOSITORY');
  if (!RUNNER_ID.test(runnerId) || !UUID.test(registrationId) || !REPOSITORY.test(repositoryValue)) {
    fail('invalid_identity');
  }
  const [owner, name] = repositoryValue.split('/') as [string, string];
  const claimToken = await tokenFrom(required(environment, 'FAI_HERMES_RUNNER_CLAIM_TOKEN_FILE'));
  const observationToken = await tokenFrom(required(environment, 'FAI_HERMES_RUNNER_OBSERVATION_TOKEN_FILE'));
  const ttlSeconds = Number(required(environment, 'FAI_HERMES_RUNNER_OBSERVATION_TTL_SECONDS'));
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3600) fail('invalid_ttl');
  const configSha256 = required(environment, 'FAI_HERMES_RUNNER_CONFIG_SHA256');
  if (!SHA256.test(configSha256)) fail('invalid_config_hash');
  const planner = createHermesDirectivePlanner({
      pythonExecutable: absolute(required(environment, 'FAI_HERMES_RUNNER_PYTHON'), 'python'),
      entrypoint: absolute(required(environment, 'FAI_HERMES_RUNNER_ENTRYPOINT'), 'entrypoint'),
      home: absolute(required(environment, 'FAI_HERMES_RUNNER_HERMES_HOME'), 'hermes_home'),
      configFile: absolute(required(environment, 'FAI_HERMES_RUNNER_CONFIG_FILE'), 'config_file'),
      configSha256, expectedVersion: '0.18.2'
  });
  const executor = createHermesExecutorTransport({planner, expectedConfigSha256: configSha256,
    socketPath: absolute(required(environment, 'FAI_HERMES_EXECUTOR_SOCKET'), 'executor_socket')});
  const observation = (component: ObservationComponent, state: 'available' | 'unavailable') =>
    publishObservation({fetcher, baseUrl, token: observationToken, registrationId, runnerId,
      ttlSeconds, component, state});
  try {
    await planner.preflight(); await executor.preflight();
    await observation('service', 'available'); await observation('scheduler', 'available');
    const result = await runWorkstationRunnerOnce({baseUrl, bearerToken: claimToken,
      repository: {owner, name}, fetch: fetcher, runtimes: new Map([['hermes', executor]])});
    await observation('delivery', 'available'); return result;
  } catch (error) {
    await Promise.all((['service', 'scheduler', 'delivery'] as const).map((component) =>
      observation(component, 'unavailable').catch(() => undefined)));
    throw error;
  }
};

export const runHermesRunnerLoop = async (
  environment: HermesRunnerEnvironment = process.env,
  signal?: AbortSignal
): Promise<never> => {
  const intervalMs = Number(required(environment, 'FAI_HERMES_RUNNER_POLL_INTERVAL_MS'));
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) fail('invalid_poll_interval');
  while (!signal?.aborted) {
    await runHermesRunnerOnceFromEnvironment(environment);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true});
    });
  }
  return fail('stopped');
};
