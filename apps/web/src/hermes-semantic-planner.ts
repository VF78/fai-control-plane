import {readFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {isAbsolute} from 'node:path';
import {validateSemanticProjectPlanDefinition, type ProjectPlanSemanticPlanner, type SemanticProjectPlanRequest} from '@fai-control-plane/application';
import type {CommandResult, ProjectPlanDefinition} from '@fai-control-plane/domain';

// The selected extracted corpus is capped at 512 KiB; leave bounded room for
// the manifest and JSON framing without silently truncating any source.
const REQUEST_LIMIT_BYTES = 640 * 1024;
const RESPONSE_LIMIT_BYTES = 300 * 1024;
const TIMEOUT_MS = 10_000;
const noPlan = (message: string): CommandResult<ProjectPlanDefinition> => ({ok: false, error: {code: 'INVALID_TRANSITION', message}});
const privateLiteralHost = (hostname: string) => {
  const normalized = hostname.toLowerCase();
  if (normalized === '::1' || normalized === '[::1]') return true;
  if (isIP(normalized) !== 4) return false;
  const octets = normalized.split('.').map(Number);
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31;
};
const endpoint = (value: string | undefined): URL | null => {
  if (value === undefined || value.length < 1 || value.length > 512) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' || !privateLiteralHost(parsed.hostname)) return null;
    const hostname = parsed.hostname.toLowerCase();
    const loopback = hostname.startsWith('127.') || hostname === '::1' || hostname === '[::1]';
    return (parsed.protocol === 'https:' || loopback && parsed.protocol === 'http:') ? parsed : null;
  } catch { return null; }
};
const boundedJson = async (response: Response): Promise<unknown | null> => {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT_BYTES)) { await response.body?.cancel(); return null; }
  if (response.body === null) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.byteLength; if (total > RESPONSE_LIMIT_BYTES) { await reader.cancel(); return null; } chunks.push(chunk.value); }
  } catch { return null; } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown; } catch { return null; }
};
const exactDefinition = (value: unknown): unknown | null => typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === 1 && Object.hasOwn(value, 'definition') ? (value as {definition: unknown}).definition : null;
export type HermesSemanticPlannerDependencies = Readonly<{environment: Readonly<Record<string, string | undefined>>; readToken(path: string): Promise<string>; fetch(input: string, init: RequestInit): Promise<Response>}>;
const dependencies: HermesSemanticPlannerDependencies = {environment: process.env, readToken: (path) => readFile(path, 'utf8'), fetch: (input, init) => globalThis.fetch(input, init)};

export const createHermesSemanticPlanner = (overrides: Partial<HermesSemanticPlannerDependencies> = {}): ProjectPlanSemanticPlanner => {
  const deps = {...dependencies, ...overrides};
  return {async generate(input: SemanticProjectPlanRequest) {
    if (deps.environment.HERMES_SEMANTIC_PLANNING_ENABLED !== 'true') return noPlan('Hermes semantic planning is disabled. Ask an administrator to configure and explicitly enable the private Hermes planner.');
    const url = endpoint(deps.environment.HERMES_SEMANTIC_PLANNING_URL); const tokenFile = deps.environment.HERMES_SEMANTIC_PLANNING_TOKEN_FILE;
    if (url === null || tokenFile === undefined || !isAbsolute(tokenFile)) return noPlan('Hermes semantic planning is unavailable: private endpoint or bearer token file is not configured.');
    let token: string;
    try { token = (await deps.readToken(tokenFile)).trim(); } catch { return noPlan('Hermes semantic planning is unavailable: bearer token file cannot be read.'); }
    if (token.length < 1 || token.length > 2048 || /[\u0000-\u001f\u007f\s]/u.test(token)) return noPlan('Hermes semantic planning is unavailable: bearer token file is invalid.');
    const body = JSON.stringify({schema: 'project_plan_definition_v1', idempotencyKey: input.idempotencyKey, sourceManifest: input.sourceManifest,
      sources: input.artifacts.map(({id, sourceKind, mediaType, sha256, content}) => ({id, sourceKind, mediaType, sha256, content}))});
    if (Buffer.byteLength(body, 'utf8') > REQUEST_LIMIT_BYTES) return noPlan('Hermes semantic planning request exceeds the bounded source-only corpus.');
    let response: Response;
    try { response = await deps.fetch(url.toString(), {method: 'POST', redirect: 'error', headers: {'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': input.idempotencyKey}, body, signal: AbortSignal.timeout(TIMEOUT_MS)}); }
    catch { return noPlan('Hermes semantic planning is unavailable. No draft was created.'); }
    if (!response.ok) return noPlan('Hermes semantic planning is unavailable. No draft was created.');
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') { await response.body?.cancel(); return noPlan('Hermes returned an invalid plan response media type. No draft was created.'); }
    const definition = exactDefinition(await boundedJson(response));
    if (definition === null) return noPlan('Hermes returned an invalid bounded plan response. No draft was created.');
    return validateSemanticProjectPlanDefinition(definition, input.artifacts);
  }};
};
export const hermesSemanticPlannerLimits = Object.freeze({requestBytes: REQUEST_LIMIT_BYTES, responseBytes: RESPONSE_LIMIT_BYTES, timeoutMs: TIMEOUT_MS});
