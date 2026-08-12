import net from 'node:net';
import {lstat, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {hashSemanticProjectPlanningContext, validateSemanticProjectPlanDefinition, type ProjectPlanSemanticPlanner, type SemanticProjectPlanRequest} from '@fai-control-plane/application';
import {canonicalJson, containsHighConfidenceSecretContent, hashProjectPlanSourceManifest, type CommandResult, type ProjectPlanDefinition} from '@fai-control-plane/domain';

const REQUEST_LIMIT_BYTES = 768 * 1024;
const RESPONSE_LIMIT_BYTES = 300 * 1024;
const TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 2_000;
const SOCKET_PATH = '/run/fai-hermes-planner/planner.sock';
const TOKEN_FILE = '/run/secrets/hermes-semantic-planning-token';
const TOKEN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const noPlan = (message: string): CommandResult<ProjectPlanDefinition> => ({ok: false, error: {code: 'INVALID_TRANSITION', message}});

export type HermesSemanticPlanningConfiguration = Readonly<{configured: boolean; remediation: string}>;
export type HermesSemanticPlanningHealth = Readonly<{healthy: boolean; remediation: string; releaseCommit: string | null}>;
export const hermesSemanticPlanningConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env
): HermesSemanticPlanningConfiguration => {
  if (environment.HERMES_SEMANTIC_PLANNING_ENABLED !== 'true') return {configured: false, remediation: 'Hermes planning transport выключен администратором.'};
  if (environment.HERMES_SEMANTIC_PLANNING_SOCKET !== SOCKET_PATH ||
    environment.HERMES_SEMANTIC_PLANNING_TOKEN_FILE !== TOKEN_FILE ||
    !/^[0-9a-f]{40}$/.test(environment.FCP_RELEASE_COMMIT ?? '')) {
    return {configured: false, remediation: 'Hermes planning transport не привязан к каноническому UDS и token file.'};
  }
  return {configured: true, remediation: 'Hermes planning transport настроен; доступность проверяется при сборке черновика.'};
};

const exchangeFramed = async (socketPath: string, body: string, timeoutMs = TIMEOUT_MS): Promise<string> => {
  if (socketPath !== SOCKET_PATH || path.normalize(socketPath) !== socketPath || path.resolve(socketPath) !== socketPath) {
    throw new Error('hermes_semantic_planning_socket');
  }
  const [stat, canonical] = await Promise.all([lstat(socketPath), realpath(socketPath)]);
  if (!stat.isSocket() || stat.isSymbolicLink() || canonical !== socketPath) throw new Error('hermes_semantic_planning_socket');
  const payload = Buffer.from(body, 'utf8');
  if (payload.byteLength < 1 || payload.byteLength > REQUEST_LIMIT_BYTES) throw new Error('hermes_semantic_planning_request_size');
  return new Promise<string>((resolve, reject) => {
    let settled = false; let expected: number | undefined; let received = Buffer.alloc(0);
    const socket = net.createConnection({path: socketPath});
    const finish = (error?: Error, value?: string) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error !== undefined) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('hermes_semantic_planning_timeout')), timeoutMs);
    timer.unref();
    socket.once('connect', () => {
      const header = Buffer.alloc(4); header.writeUInt32BE(payload.byteLength); socket.write(Buffer.concat([header, payload]));
    });
    socket.on('data', (chunk: Buffer) => {
      if (received.byteLength + chunk.byteLength > RESPONSE_LIMIT_BYTES + 4) {
        finish(new Error('hermes_semantic_planning_response_size')); return;
      }
      received = Buffer.concat([received, chunk]);
      if (expected === undefined && received.byteLength >= 4) {
        expected = received.readUInt32BE(0);
        if (expected < 1 || expected > RESPONSE_LIMIT_BYTES) {
          finish(new Error('hermes_semantic_planning_response_size')); return;
        }
      }
      if (expected !== undefined && received.byteLength === expected + 4) finish(undefined, received.subarray(4).toString('utf8'));
      else if (expected !== undefined && received.byteLength > expected + 4) finish(new Error('hermes_semantic_planning_response_frame'));
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => { if (!settled) finish(new Error('hermes_semantic_planning_response_truncated')); });
  });
};

const exactDefinition = (value: unknown): unknown | null => typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === 1 && Object.hasOwn(value, 'definition') ? (value as {definition: unknown}).definition : null;
export type HermesSemanticPlannerDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  readToken(path: string): Promise<string>;
  exchange(socketPath: string, body: string, timeoutMs?: number): Promise<string>;
}>;
const dependencies: HermesSemanticPlannerDependencies = {
  environment: process.env,
  readToken: (target) => readFile(target, 'utf8'),
  exchange: exchangeFramed
};

const textLeavesAreSafe = (value: unknown): boolean => {
  if (typeof value === 'string') return !containsHighConfidenceSecretContent(value);
  if (Array.isArray(value)) return value.every(textLeavesAreSafe);
  return typeof value !== 'object' || value === null || Object.values(value).every(textLeavesAreSafe);
};
const tokenFrom = async (deps: HermesSemanticPlannerDependencies): Promise<string | null> => {
  try {
    const token = (await deps.readToken(TOKEN_FILE)).replace(/\r?\n$/, '');
    return TOKEN.test(token) ? token : null;
  } catch { return null; }
};

export const checkHermesSemanticPlannerHealth = async (
  overrides: Partial<HermesSemanticPlannerDependencies> = {}
): Promise<HermesSemanticPlanningHealth> => {
  const deps = {...dependencies, ...overrides};
  const configuration = hermesSemanticPlanningConfiguration(deps.environment);
  if (!configuration.configured) return {healthy: false, remediation: configuration.remediation, releaseCommit: null};
  const token = await tokenFrom(deps);
  if (token === null) return {healthy: false, remediation: 'Hermes planning health недоступен: token file не прошёл проверку.', releaseCommit: null};
  try {
    const nonce = crypto.randomUUID();
    const raw = await deps.exchange(SOCKET_PATH, canonicalJson({schemaVersion: 1, operation: 'health', nonce,
      authentication: {scheme: 'bearer', token}}), HEALTH_TIMEOUT_MS);
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(value).length !== 5 || value.status !== 'ready' || value.operation !== 'health' ||
      value.nonce !== nonce || typeof value.releaseCommit !== 'string' ||
      value.releaseCommit !== deps.environment.FCP_RELEASE_COMMIT ||
      typeof value.configSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.configSha256)) throw new Error('health_shape');
    return {healthy: true, remediation: 'Hermes planning service доступен и прошёл аутентифицированный preflight.', releaseCommit: value.releaseCommit};
  } catch {
    return {healthy: false, remediation: 'Hermes planning service не прошёл live health/preflight.', releaseCommit: null};
  }
};

export const createHermesSemanticPlanner = (overrides: Partial<HermesSemanticPlannerDependencies> = {}): ProjectPlanSemanticPlanner => {
  const deps = {...dependencies, ...overrides};
  return {async generate(input: SemanticProjectPlanRequest) {
    const configuration = hermesSemanticPlanningConfiguration(deps.environment);
    if (!configuration.configured) return noPlan(configuration.remediation);
    const token = await tokenFrom(deps);
    if (token === null) return noPlan('Hermes semantic planning is unavailable: token file is invalid.');
    if (hashProjectPlanSourceManifest(input.sourceManifest) !== input.sourceManifestHash ||
      hashSemanticProjectPlanningContext(input.planningContext) !== input.planningContextHash) {
      return noPlan('Hermes semantic planning CAS binding is invalid.');
    }
    const planningRequest = {schemaVersion: 1, operation: 'project_plan.draft.generate',
      idempotencyKey: input.idempotencyKey, sourceManifest: input.sourceManifest, sourceManifestHash: input.sourceManifestHash,
      planningContextHash: input.planningContextHash, planningContext: input.planningContext,
      sources: input.artifacts.map(({id, sourceKind, mediaType, sha256, content}) => ({id, sourceKind, mediaType, sha256, content}))};
    const boundedContext = canonicalJson(planningRequest as never);
    if (Buffer.byteLength(boundedContext, 'utf8') > REQUEST_LIMIT_BYTES - 512 ||
      !textLeavesAreSafe(planningRequest) || containsHighConfidenceSecretContent(boundedContext)) {
      return noPlan('Hermes semantic planning request contains forbidden or oversized content.');
    }
    const body = canonicalJson({...planningRequest, authentication: {scheme: 'bearer', token}} as never);
    if (Buffer.byteLength(body, 'utf8') > REQUEST_LIMIT_BYTES) return noPlan('Hermes semantic planning request exceeds the bounded project corpus.');
    let raw: string;
    try { raw = await deps.exchange(SOCKET_PATH, body); }
    catch { return noPlan('Hermes semantic planning is unavailable. No draft was created.'); }
    if (Buffer.byteLength(raw, 'utf8') > RESPONSE_LIMIT_BYTES) return noPlan('Hermes returned an oversized plan response. No draft was created.');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return noPlan('Hermes returned an invalid bounded plan response. No draft was created.'); }
    const definition = exactDefinition(parsed);
    if (definition === null) return noPlan('Hermes returned an invalid bounded plan response. No draft was created.');
    return validateSemanticProjectPlanDefinition(definition, input.artifacts, input.planningContext);
  }};
};

export const hermesSemanticPlannerLimits = Object.freeze({requestBytes: REQUEST_LIMIT_BYTES,
  responseBytes: RESPONSE_LIMIT_BYTES, timeoutMs: TIMEOUT_MS, healthTimeoutMs: HEALTH_TIMEOUT_MS,
  socketPath: SOCKET_PATH, tokenFile: TOKEN_FILE});
