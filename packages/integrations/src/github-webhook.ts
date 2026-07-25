import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import type {
  OpaqueSecretRef,
  SecretsProvider,
  TrackerCheckConclusion,
  TrackerCheckStatus
} from '@fai-control-plane/domain';
import {trackerCheckStatuses} from '@fai-control-plane/domain';
import {
  githubCheckRunConclusions,
  githubRepositoryScopeDefinitions
} from './github-contract';

export const MAX_GITHUB_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;

const supportedActions = {
  issues: new Set([
    'opened',
    'edited',
    'closed',
    'reopened',
    'labeled',
    'unlabeled',
    'assigned',
    'unassigned',
    'milestoned',
    'demilestoned'
  ]),
  pull_request: new Set([
    'opened',
    'edited',
    'closed',
    'reopened',
    'synchronize',
    'ready_for_review',
    'converted_to_draft'
  ]),
  check_run: new Set(['created', 'completed', 'rerequested', 'requested_action']),
  installation_repositories: new Set(['added', 'removed'])
} as const;

const supportedEvents = new Set<GitHubWebhookEvent>([
  'issues',
  'pull_request',
  'check_run',
  'installation_repositories',
  'ping'
]);
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const githubDeliveryIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const githubSignaturePattern = /^sha256=([0-9a-f]{64})$/;
const githubJsonMediaTypePattern =
  /^[ \t]*application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?[ \t]*$/i;

export type GitHubWebhookEvent =
  | 'issues'
  | 'pull_request'
  | 'check_run'
  | 'installation_repositories'
  | 'ping';

export type GitHubWebhookConfigErrorCode =
  | 'github_webhook_config_invalid'
  | 'github_webhook_config_missing_scope'
  | 'github_webhook_config_duplicate_scope'
  | 'github_webhook_config_unexpected_scope';

export class GitHubWebhookConfigError extends Error {
  readonly name = 'GitHubWebhookConfigError';

  constructor(readonly code: GitHubWebhookConfigErrorCode) {
    super(code);
  }
}

export type GitHubWebhookRejectionCode =
  | 'github_headers_invalid'
  | 'github_media_type_invalid'
  | 'github_event_unsupported'
  | 'github_project_event_unsupported'
  | 'github_body_too_large'
  | 'github_body_stream_invalid'
  | 'github_signature_missing'
  | 'github_signature_malformed'
  | 'github_signature_invalid'
  | 'github_secret_unavailable'
  | 'github_json_invalid'
  | 'github_payload_invalid'
  | 'github_action_unsupported'
  | 'github_installation_unauthorized'
  | 'github_repository_unauthorized';

type GitHubWebhookScope = Readonly<{
  repositoryId: number;
  fullName: string;
  ownerId: number;
  installationId: number;
  projectId: string;
  projectNumber: number;
  projectNodeId: string;
}>;

export type GitHubAppWebhookConfig = Readonly<{
  webhookSecretRef: OpaqueSecretRef;
  scopes: readonly GitHubWebhookScope[];
}>;

export type GitHubWebhookHeaders = Readonly<Record<string, string | undefined>>;

type RepositoryIdentity = Readonly<{
  repositoryId: number;
  fullName: string;
  ownerId: number;
}>;

type ProjectIdentity = Readonly<{
  projectId: string;
  projectNumber: number;
  projectNodeId: string;
}>;

type EventIdentity = Readonly<{
  provider: 'github';
  deliveryId: string;
  eventType: Exclude<GitHubWebhookEvent, 'ping'>;
  action: string;
  installationId: number;
  repository: RepositoryIdentity;
  project: ProjectIdentity;
  payloadSha256: string;
}>;

type InstallationEventIdentity = Omit<EventIdentity, 'repository' | 'project'>;

export type GitHubWebhookProjection =
  | (EventIdentity &
      Readonly<{
        eventType: 'issues';
        issue: Readonly<{id: number; number: number; state: 'open' | 'closed'}>;
      }>)
  | (EventIdentity &
      Readonly<{
        eventType: 'pull_request';
        pullRequest: Readonly<{
          id: number;
          number: number;
          state: 'open' | 'closed';
          merged: boolean;
          headRef: string;
          baseRef: string;
        }>;
      }>)
  | (EventIdentity &
      Readonly<{
        eventType: 'check_run';
        checkRun: Readonly<{
          id: number;
          status: TrackerCheckStatus;
          conclusion: TrackerCheckConclusion | null;
          headSha: string;
        }>;
      }>)
  | (InstallationEventIdentity &
      Readonly<{
        eventType: 'installation_repositories';
        repositoryChanges: readonly (RepositoryIdentity &
          Readonly<{project: ProjectIdentity}>)[];
      }>);

export type GitHubWebhookResult =
  | Readonly<{outcome: 'accepted'; projection: GitHubWebhookProjection}>
  | Readonly<{outcome: 'acknowledged'; code: 'github_ping_acknowledged'}>
  | Readonly<{outcome: 'rejected'; code: GitHubWebhookRejectionCode}>;

export type GitHubWebhookBodyReadResult =
  | Readonly<{ok: true; body: Uint8Array}>
  | Readonly<{
      ok: false;
      code: 'github_body_too_large' | 'github_body_stream_invalid';
    }>;

function snapshotDataObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor | undefined
    >;
    const keys = Reflect.ownKeys(descriptors);
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') return null;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor)) return null;
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: descriptor.value
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotDataArray(value: unknown, maximumLength: number): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor | undefined
    >;
    const ownKeys = Reflect.ownKeys(descriptors);
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      typeof lengthDescriptor.value !== 'number' ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximumLength ||
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
      )
    ) {
      return null;
    }

    const length = lengthDescriptor.value;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !('value' in descriptor)) return null;
      snapshot.push(descriptor.value);
    }
    if (ownKeys.length !== snapshot.length + 1) return null;
    return snapshot;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === keys.length && actualKeys.every((key, index) => key === keys[index]);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function snapshotOpaqueSecretRef(value: unknown): OpaqueSecretRef | null {
  const reference = snapshotDataObject(value);
  if (reference === null || !hasExactKeys(reference, ['provider', 'reference', 'scope'])) {
    return null;
  }
  const scope = snapshotDataArray(reference.scope, 64);
  if (
    typeof reference.provider !== 'string' ||
    reference.provider.length === 0 ||
    typeof reference.reference !== 'string' ||
    reference.reference.length === 0 ||
    scope === null ||
    !scope.every((part) => typeof part === 'string' && part.length > 0)
  ) {
    return null;
  }
  return {
    provider: reference.provider,
    reference: reference.reference,
    scope: scope as string[]
  };
}

function configError(code: GitHubWebhookConfigErrorCode): never {
  throw new GitHubWebhookConfigError(code);
}

function validateScope(value: unknown): GitHubWebhookScope {
  const scope = snapshotDataObject(value);
  if (
    scope === null ||
    !hasExactKeys(scope, [
      'fullName',
      'installationId',
      'ownerId',
      'projectId',
      'projectNodeId',
      'projectNumber',
      'repositoryId'
    ]) ||
    !isPositiveSafeInteger(scope.repositoryId) ||
    !isPositiveSafeInteger(scope.ownerId) ||
    !isPositiveSafeInteger(scope.installationId) ||
    typeof scope.fullName !== 'string' ||
    typeof scope.projectId !== 'string' ||
    !canonicalUuidPattern.test(scope.projectId) ||
    !isPositiveSafeInteger(scope.projectNumber) ||
    typeof scope.projectNodeId !== 'string'
  ) {
    return configError('github_webhook_config_invalid');
  }

  return {
    repositoryId: scope.repositoryId,
    fullName: scope.fullName,
    ownerId: scope.ownerId,
    installationId: scope.installationId,
    projectId: scope.projectId,
    projectNumber: scope.projectNumber,
    projectNodeId: scope.projectNodeId
  };
}

export function createGitHubAppWebhookConfig(input: unknown): GitHubAppWebhookConfig {
  try {
    return createGitHubAppWebhookConfigUnchecked(input);
  } catch (error) {
    if (error instanceof GitHubWebhookConfigError) throw error;
    return configError('github_webhook_config_invalid');
  }
}

function createGitHubAppWebhookConfigUnchecked(input: unknown): GitHubAppWebhookConfig {
  const runtimeConfig = snapshotDataObject(input);
  if (
    runtimeConfig === null ||
    !hasExactKeys(runtimeConfig, ['scopes', 'webhookSecretRef'])
  ) {
    return configError('github_webhook_config_invalid');
  }

  const webhookSecretRef = snapshotOpaqueSecretRef(runtimeConfig.webhookSecretRef);
  const scopeValues = snapshotDataArray(runtimeConfig.scopes, 64);
  if (webhookSecretRef === null || scopeValues === null) {
    return configError('github_webhook_config_invalid');
  }
  const scopes = scopeValues.map(validateScope);
  const repositoryIds = new Set<number>();
  for (const scope of scopes) {
    if (repositoryIds.has(scope.repositoryId)) {
      return configError('github_webhook_config_duplicate_scope');
    }
    repositoryIds.add(scope.repositoryId);
  }

  for (const expected of githubRepositoryScopeDefinitions) {
    const scope = scopes.find((candidate) => candidate.repositoryId === expected.repositoryId);
    if (scope === undefined) return configError('github_webhook_config_missing_scope');
    if (
      scope.fullName !== expected.fullName ||
      scope.ownerId !== expected.ownerId ||
      scope.projectNumber !== expected.projectNumber ||
      scope.projectNodeId !== expected.projectNodeId
    ) {
      return configError('github_webhook_config_invalid');
    }
  }

  if (scopes.length !== githubRepositoryScopeDefinitions.length) {
    return configError('github_webhook_config_unexpected_scope');
  }

  return Object.freeze({
    webhookSecretRef: Object.freeze({
      provider: webhookSecretRef.provider,
      reference: webhookSecretRef.reference,
      scope: Object.freeze([...webhookSecretRef.scope])
    }),
    scopes: Object.freeze(scopes.map((scope) => Object.freeze(scope)))
  });
}

function getHeader(headers: GitHubWebhookHeaders, name: string): string | undefined {
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (matches.length !== 1) return undefined;
  const value = matches[0]?.[1];
  return typeof value === 'string' ? value : undefined;
}

function isBoundedHeader(value: string | undefined, maximumLength: number): value is string {
  return value !== undefined && value.length > 0 && value.length <= maximumLength;
}

type ValidatedHeaders = Readonly<{
  deliveryId: string;
  eventType: GitHubWebhookEvent;
  signature: string;
}>;

type HeaderValidationResult =
  | ValidatedHeaders
  | Extract<GitHubWebhookResult, {outcome: 'rejected'}>;

function validateHeaders(headers: unknown): HeaderValidationResult {
  const source = snapshotDataObject(headers);
  if (source === null) return reject('github_headers_invalid');
  if (
    Object.keys(source).length > 64 ||
    Object.entries(source).some(
      ([name, value]) =>
        name.length === 0 ||
        name.length > 128 ||
        (value !== undefined && (typeof value !== 'string' || value.length > 8192))
    )
  ) {
    return reject('github_headers_invalid');
  }
  const deliveryId = getHeader(source as GitHubWebhookHeaders, 'x-github-delivery');
  const eventType = getHeader(source as GitHubWebhookHeaders, 'x-github-event');
  const signature = getHeader(source as GitHubWebhookHeaders, 'x-hub-signature-256');
  const contentType = getHeader(source as GitHubWebhookHeaders, 'content-type');

  if (
    !isBoundedHeader(deliveryId, 128) ||
    !githubDeliveryIdPattern.test(deliveryId) ||
    !isBoundedHeader(eventType, 64) ||
    !isBoundedHeader(contentType, 256)
  ) {
    return reject('github_headers_invalid');
  }
  if (!githubJsonMediaTypePattern.test(contentType)) {
    return reject('github_media_type_invalid');
  }
  if (!isBoundedHeader(signature, 128)) return reject('github_signature_missing');
  if (!githubSignaturePattern.test(signature)) return reject('github_signature_malformed');
  if (eventType === 'projects_v2_item') return reject('github_project_event_unsupported');
  if (!supportedEvents.has(eventType as GitHubWebhookEvent)) {
    return reject('github_event_unsupported');
  }

  return {deliveryId, eventType: eventType as GitHubWebhookEvent, signature};
}

function reject(
  code: GitHubWebhookRejectionCode
): Extract<GitHubWebhookResult, {outcome: 'rejected'}> {
  return {outcome: 'rejected', code};
}

function isRejected(
  result: HeaderValidationResult
): result is Extract<GitHubWebhookResult, {outcome: 'rejected'}> {
  return 'outcome' in result && result.outcome === 'rejected';
}

type DataMethod = (...arguments_: unknown[]) => unknown;
type MethodLookup =
  | Readonly<{status: 'found'; method: DataMethod}>
  | Readonly<{status: 'absent' | 'invalid'}>;

function lookupDataMethod(value: unknown, key: PropertyKey): MethodLookup {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return {status: 'invalid'};
  }
  try {
    const visited = new Set<object>();
    let current: object | null = value;
    for (let depth = 0; current !== null && depth < 32; depth += 1) {
      if (visited.has(current)) return {status: 'invalid'};
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
          return {status: 'invalid'};
        }
        return {status: 'found', method: descriptor.value as DataMethod};
      }
      current = Object.getPrototypeOf(current);
    }
    return current === null ? {status: 'absent'} : {status: 'invalid'};
  } catch {
    return {status: 'invalid'};
  }
}

function declaredLengthExceedsLimit(declaredContentLength: unknown): boolean {
  if (typeof declaredContentLength !== 'string' || !/^\d+$/.test(declaredContentLength)) {
    return false;
  }
  const length = Number(declaredContentLength);
  return !Number.isSafeInteger(length) || length > MAX_GITHUB_WEBHOOK_BODY_BYTES;
}

type AppendChunkResult =
  | Readonly<{status: 'ok'; size: number}>
  | Readonly<{status: 'too_large' | 'invalid'}>;

function appendChunk(chunks: Uint8Array[], chunk: unknown, size: number): AppendChunkResult {
  try {
    if (!(chunk instanceof Uint8Array)) return {status: 'invalid'};
    const byteLength = chunk.byteLength;
    const nextSize = size + byteLength;
    if (nextSize > MAX_GITHUB_WEBHOOK_BODY_BYTES) return {status: 'too_large'};
    const copy = new Uint8Array(byteLength);
    copy.set(chunk);
    chunks.push(copy);
    return {status: 'ok', size: nextSize};
  } catch {
    return {status: 'invalid'};
  }
}

function joinChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readGitHubWebhookBody(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  declaredContentLength?: unknown
): Promise<GitHubWebhookBodyReadResult> {
  if (declaredLengthExceedsLimit(declaredContentLength)) {
    return {ok: false, code: 'github_body_too_large'};
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const asyncIteratorMethod = lookupDataMethod(stream, Symbol.asyncIterator);
  if (asyncIteratorMethod.status === 'invalid') {
    return {ok: false, code: 'github_body_stream_invalid'};
  }
  if (asyncIteratorMethod.status === 'found') {
    try {
      const iterator = asyncIteratorMethod.method.call(stream);
      const nextMethod = lookupDataMethod(iterator, 'next');
      if (nextMethod.status !== 'found') {
        return {ok: false, code: 'github_body_stream_invalid'};
      }
      for (;;) {
        const iteration = snapshotDataObject(await nextMethod.method.call(iterator));
        if (iteration === null || typeof iteration.done !== 'boolean') {
          return {ok: false, code: 'github_body_stream_invalid'};
        }
        if (iteration.done) break;
        const appended = appendChunk(chunks, iteration.value, length);
        if (appended.status !== 'ok') {
          return {
            ok: false,
            code:
              appended.status === 'too_large'
                ? 'github_body_too_large'
                : 'github_body_stream_invalid'
          };
        }
        length = appended.size;
      }
    } catch {
      return {ok: false, code: 'github_body_stream_invalid'};
    }
    return {ok: true, body: joinChunks(chunks, length)};
  }

  const getReaderMethod = lookupDataMethod(stream, 'getReader');
  if (getReaderMethod.status !== 'found') {
    return {ok: false, code: 'github_body_stream_invalid'};
  }
  let reader: unknown;
  try {
    reader = getReaderMethod.method.call(stream);
  } catch {
    return {ok: false, code: 'github_body_stream_invalid'};
  }
  const readMethod = lookupDataMethod(reader, 'read');
  const releaseLockMethod = lookupDataMethod(reader, 'releaseLock');
  if (readMethod.status !== 'found' || releaseLockMethod.status !== 'found') {
    return {ok: false, code: 'github_body_stream_invalid'};
  }

  let readResult: GitHubWebhookBodyReadResult = {ok: true, body: new Uint8Array()};
  try {
    for (;;) {
      const iteration = snapshotDataObject(await readMethod.method.call(reader));
      if (iteration === null || typeof iteration.done !== 'boolean') {
        readResult = {ok: false, code: 'github_body_stream_invalid'};
        break;
      }
      if (iteration.done) {
        readResult = {ok: true, body: joinChunks(chunks, length)};
        break;
      }
      const appended = appendChunk(chunks, iteration.value, length);
      if (appended.status !== 'ok') {
        readResult = {
          ok: false,
          code:
            appended.status === 'too_large'
              ? 'github_body_too_large'
              : 'github_body_stream_invalid'
        };
        break;
      }
      length = appended.size;
    }
  } catch {
    readResult = {ok: false, code: 'github_body_stream_invalid'};
  }
  try {
    releaseLockMethod.method.call(reader);
  } catch {
    return {ok: false, code: 'github_body_stream_invalid'};
  }
  return readResult;
}

function getRequiredObject(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const nested = value[key];
  return snapshotDataObject(nested);
}

function getRequiredId(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key];
  return isPositiveSafeInteger(candidate) ? candidate : null;
}

function getRequiredString(value: Record<string, unknown>, key: string, maximumLength = 512): string | null {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= maximumLength
    ? candidate
    : null;
}

function isCheckRunConclusion(value: unknown): value is TrackerCheckConclusion {
  return typeof value === 'string' &&
    githubCheckRunConclusions.includes(value as TrackerCheckConclusion);
}

function isTrackerCheckStatus(value: unknown): value is TrackerCheckStatus {
  return typeof value === 'string' &&
    trackerCheckStatuses.includes(value as TrackerCheckStatus);
}

function getScope(
  config: GitHubAppWebhookConfig,
  installationId: number,
  repository: Record<string, unknown>
): GitHubWebhookScope | null {
  const repositoryId = getRequiredId(repository, 'id');
  const fullName = getRequiredString(repository, 'full_name');
  const owner = getRequiredObject(repository, 'owner');
  const ownerId = owner === null ? null : getRequiredId(owner, 'id');
  if (repositoryId === null || fullName === null || ownerId === null) return null;

  const scope = config.scopes.find((candidate) => candidate.repositoryId === repositoryId);
  if (
    scope === undefined ||
    scope.installationId !== installationId ||
    scope.fullName !== fullName ||
    scope.ownerId !== ownerId
  ) {
    return null;
  }
  return scope;
}

function eventBase(
  headers: ValidatedHeaders,
  scope: GitHubWebhookScope,
  payloadSha256: string
): EventIdentity {
  return {
    provider: 'github',
    deliveryId: headers.deliveryId,
    eventType: headers.eventType as Exclude<GitHubWebhookEvent, 'ping'>,
    action: '',
    installationId: scope.installationId,
    repository: {
      repositoryId: scope.repositoryId,
      fullName: scope.fullName,
      ownerId: scope.ownerId
    },
    project: {
      projectId: scope.projectId,
      projectNumber: scope.projectNumber,
      projectNodeId: scope.projectNodeId
    },
    payloadSha256
  };
}

function supportedAction(eventType: Exclude<GitHubWebhookEvent, 'ping'>, payload: Record<string, unknown>): string | null {
  const action = getRequiredString(payload, 'action', 64);
  return action !== null && supportedActions[eventType].has(action as never) ? action : null;
}

function projectIssue(
  base: EventIdentity,
  payload: Record<string, unknown>
): GitHubWebhookProjection | null {
  const issue = getRequiredObject(payload, 'issue');
  if (issue === null) return null;
  const id = getRequiredId(issue, 'id');
  const number = getRequiredId(issue, 'number');
  const state = issue.state;
  if (id === null || number === null || (state !== 'open' && state !== 'closed')) return null;
  return {...base, eventType: 'issues', issue: {id, number, state}};
}

function projectPullRequest(
  base: EventIdentity,
  payload: Record<string, unknown>
): GitHubWebhookProjection | null {
  const pullRequest = getRequiredObject(payload, 'pull_request');
  if (pullRequest === null) return null;
  const id = getRequiredId(pullRequest, 'id');
  const number = getRequiredId(pullRequest, 'number');
  const state = pullRequest.state;
  const merged = pullRequest.merged;
  const head = getRequiredObject(pullRequest, 'head');
  const baseRef = getRequiredObject(pullRequest, 'base');
  const headRef = head === null ? null : getRequiredString(head, 'ref');
  const targetRef = baseRef === null ? null : getRequiredString(baseRef, 'ref');
  if (
    id === null ||
    number === null ||
    (state !== 'open' && state !== 'closed') ||
    typeof merged !== 'boolean' ||
    headRef === null ||
    targetRef === null
  ) {
    return null;
  }
  return {
    ...base,
    eventType: 'pull_request',
    pullRequest: {id, number, state, merged, headRef, baseRef: targetRef}
  };
}

function projectCheckRun(
  base: EventIdentity,
  payload: Record<string, unknown>
): GitHubWebhookProjection | null {
  const checkRun = getRequiredObject(payload, 'check_run');
  if (checkRun === null) return null;
  const id = getRequiredId(checkRun, 'id');
  const status = checkRun.status;
  const conclusion = checkRun.conclusion;
  const headSha = getRequiredString(checkRun, 'head_sha', 128);
  if (
    id === null ||
    !isTrackerCheckStatus(status) ||
    !(conclusion === null || isCheckRunConclusion(conclusion)) ||
    headSha === null
  ) {
    return null;
  }
  return {
    ...base,
    eventType: 'check_run',
    checkRun: {id, status, conclusion, headSha}
  };
}

function projectInstallationRepositories(
  base: EventIdentity,
  config: GitHubAppWebhookConfig,
  payload: Record<string, unknown>
): GitHubWebhookProjection | null {
  const changes = payload[base.action === 'added' ? 'repositories_added' : 'repositories_removed'];
  const repositories = snapshotDataArray(changes, config.scopes.length);
  if (repositories === null || repositories.length === 0) {
    return null;
  }
  const projected = repositories.map((repository) => {
    const repositoryObject = snapshotDataObject(repository);
    if (repositoryObject === null) return null;
    const scope = getScope(config, base.installationId, repositoryObject);
    if (scope === null) return null;
    return {
      repositoryId: scope.repositoryId,
      fullName: scope.fullName,
      ownerId: scope.ownerId,
      project: {
        projectId: scope.projectId,
        projectNumber: scope.projectNumber,
        projectNodeId: scope.projectNodeId
      }
    };
  });
  if (projected.some((repository) => repository === null)) return null;
  const projectedRepositories = projected as NonNullable<(typeof projected)[number]>[];
  if (
    new Set(projectedRepositories.map((repository) => repository.repositoryId)).size !==
    projectedRepositories.length
  ) {
    return null;
  }
  const installationIdentity: InstallationEventIdentity = {
    provider: base.provider,
    deliveryId: base.deliveryId,
    eventType: base.eventType,
    action: base.action,
    installationId: base.installationId,
    payloadSha256: base.payloadSha256
  };
  return {
    ...installationIdentity,
    eventType: 'installation_repositories',
    repositoryChanges: projectedRepositories
  };
}

function projectWebhook(
  config: GitHubAppWebhookConfig,
  headers: ValidatedHeaders,
  body: Uint8Array
): GitHubWebhookResult {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body));
  } catch {
    return reject('github_json_invalid');
  }
  const payloadObject = snapshotDataObject(payload);
  if (payloadObject === null) return reject('github_payload_invalid');
  if (headers.eventType === 'ping') return {outcome: 'acknowledged', code: 'github_ping_acknowledged'};

  const installation = getRequiredObject(payloadObject, 'installation');
  const installationId = installation === null ? null : getRequiredId(installation, 'id');
  if (installationId === null) return reject('github_payload_invalid');
  const action = supportedAction(headers.eventType, payloadObject);
  if (action === null) return reject('github_action_unsupported');

  const payloadSha256 = createHash('sha256').update(body).digest('hex');
  if (headers.eventType === 'installation_repositories') {
    const matchingScope = config.scopes.find((scope) => scope.installationId === installationId);
    if (matchingScope === undefined) return reject('github_installation_unauthorized');
    const base = {...eventBase(headers, matchingScope, payloadSha256), action};
    const projection = projectInstallationRepositories(base, config, payloadObject);
    return projection === null
      ? reject('github_repository_unauthorized')
      : {outcome: 'accepted', projection};
  }

  const repository = getRequiredObject(payloadObject, 'repository');
  if (repository === null) return reject('github_payload_invalid');
  const scope = getScope(config, installationId, repository);
  if (scope === null) {
    const hasKnownInstallation = config.scopes.some(
      (candidate) => candidate.installationId === installationId
    );
    return reject(
      hasKnownInstallation ? 'github_repository_unauthorized' : 'github_installation_unauthorized'
    );
  }
  const base = {...eventBase(headers, scope, payloadSha256), action};
  const projection =
    headers.eventType === 'issues'
      ? projectIssue(base, payloadObject)
      : headers.eventType === 'pull_request'
        ? projectPullRequest(base, payloadObject)
        : projectCheckRun(base, payloadObject);
  return projection === null
    ? reject('github_payload_invalid')
    : {outcome: 'accepted', projection};
}

export async function verifyAndProjectGitHubWebhook(input: Readonly<{
  config: GitHubAppWebhookConfig;
  secrets: SecretsProvider;
  headers: GitHubWebhookHeaders;
  body: Uint8Array;
}>): Promise<GitHubWebhookResult> {
  const headers = validateHeaders(input.headers);
  if (isRejected(headers)) return headers;
  if (!(input.body instanceof Uint8Array) || input.body.byteLength > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
    return reject('github_body_too_large');
  }

  let secret: string;
  try {
    secret = (await input.secrets.resolve(input.config.webhookSecretRef, 'github.webhook.verify')).value;
  } catch {
    return reject('github_secret_unavailable');
  }
  if (typeof secret !== 'string' || secret.length === 0) return reject('github_secret_unavailable');

  const signature = githubSignaturePattern.exec(headers.signature)?.[1];
  if (signature === undefined) return reject('github_signature_malformed');
  const expected = createHmac('sha256', secret).update(input.body).digest();
  const received = Buffer.from(signature, 'hex');
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(expected, received)) {
    return reject('github_signature_invalid');
  }
  return projectWebhook(input.config, headers, input.body);
}
