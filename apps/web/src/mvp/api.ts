import {createHash} from 'node:crypto';
import {
  addSourceArtifact,
  appendIncomingEvent,
  canApprove,
  canGovernMembership,
  createApprovalPersistence,
  createAgentAttemptStore,
  createStores,
  databaseMvpReady,
  executeAgentSubmissionTransaction,
  listProjects,
  onboardProjectMember,
  resolveAgentSubmissionBinding,
  readAgentRoutingPolicy,
  readProjectProcessPolicy,
  readActiveProjectContext,
  refreshProjectContext,
  saveAgentRoutingPolicy,
  subjectHash
} from '@fai-control-plane/db';
import {defaultAgentStageInstructions, assignTaskExecutor, startProcess, composeAgentTerminalNotification, decideApproval, reconcileAgentAttempt, type AgentSubmissionPorts} from '@fai-control-plane/application';
import {verifyGitHubWebhook, createGitHubRepositoryReadAdapter, createGitHubTrackerMutationAdapter, createGitHubTrackerReadAdapter, createHermesDeliveryAdapter} from '@fai-control-plane/integrations';
import {assertAgentRoutingPolicyAvailable, defaultAgentRoutingPolicy, mayChangeMembership, parseAgentRoutingPolicy, type AgentDeliveryPort, type ApprovalEvidence, type ApprovalKind, type MessengerDeliveryInput, type OpaqueSecretRef, type ProjectRole, type TrackerItemFact} from '@fai-control-plane/domain';
import {getDatabase, jsonError, requireCsrf, requireSession, secretResolver} from './runtime.ts';
import {readiness} from './http-surface.ts';
import {hermesExecutorCatalog} from './hermes-executor-readiness.ts';

const json = async (request: Request): Promise<Record<string, unknown>> => {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('media_type_invalid');
  const text = await request.text();
  if (text.length === 0 || text.length > 250_000) throw new Error('body_invalid');
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body_invalid');
  return value as Record<string, unknown>;
};
const string = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new Error('body_invalid');
  }
  return value;
};
const optionalHttps = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const parsed = new URL(string(value, 2_048));
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') throw new Error('body_invalid');
  return parsed.toString();
};
export const effectiveAgentRouting = (routing: Awaited<ReturnType<typeof readAgentRoutingPolicy>>) => routing ?? {
  policy: defaultAgentRoutingPolicy,
  version: createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex')
};
const githubAssignment = async (database: ReturnType<typeof getDatabase>, actorId: string, projectId: string, delivery: AgentDeliveryPort) => {
  const context = await resolveAgentSubmissionBinding(database, actorId, projectId);
  if (context === null) throw new Error('task_executor_denied');
  if (!['project_owner', 'operator'].includes(context.requesterRole)) throw new Error('task_executor_denied');
  if (context.provider !== 'github') throw new Error('tracker_provider_unsupported');
  const projectUrl = new URL(context.projectUrl); const repositoryUrl = new URL(context.repositoryUrl);
  const projectMatch = /^\/users\/([^/]+)\/projects\/(\d+)$/.exec(projectUrl.pathname);
  const repositoryMatch = /^\/([^/]+)\/([^/]+)\/?$/.exec(repositoryUrl.pathname);
  if (projectUrl.origin !== 'https://github.com' || repositoryUrl.origin !== 'https://github.com' ||
    projectMatch === null || repositoryMatch === null || projectMatch[1] !== repositoryMatch[1]) throw new Error('github_binding_invalid');
  const binding = {id: context.bindingId, owner: projectMatch[1]!, repository: repositoryMatch[2]!,
    projectId: context.projectId, projectNumber: Number(projectMatch[2]), projectUrl: context.projectUrl,
    credentialRef: context.trackerCredentialRef};
  const tracker = createGitHubTrackerMutationAdapter({binding,
    credentialRef: {...context.trackerCredentialRef, purpose: 'tracker_mutate'}, secrets: secretResolver});
  const read = createGitHubTrackerReadAdapter({binding, secrets: secretResolver});
  const repository = createGitHubRepositoryReadAdapter({owner: binding.owner, repository: binding.repository,
    repositoryId: context.repositoryId, credentialRef: context.trackerCredentialRef, secrets: secretResolver});
  const stores = createStores(database, context.workspaceId);
  const routing = effectiveAgentRouting(await readAgentRoutingPolicy(database, actorId, projectId));
  const processPolicy = await readProjectProcessPolicy(database, actorId, projectId);
  if (processPolicy === null) throw new Error('project_process_policy_unavailable');
  return {context, tracker, ports: {resolveContext: async () => ({workspaceId: context.workspaceId, projectId: context.projectId,
      requesterRole: context.requesterRole, bindingId: context.bindingId, repository: {id: context.repositoryId, url: context.repositoryUrl},
      agentTrackerOwnerOptionId: process.env.HERMES_TRACKER_OWNER_OPTION_ID ?? '', doneStatusOptionId: process.env.STATUS_DONE_ID ?? '',
      routingPolicyVersion: routing.version, routingPolicy: routing.policy,
      processPolicyVersion: processPolicy.version, processPolicy: processPolicy.policy,
      executorCatalog: hermesExecutorCatalog()}),
    readFreshSnapshot: () => read.readSnapshot(context.bindingId, context.cursor), persistSnapshot: stores.snapshots.replace,
    resolveActiveContext: ({actorId, projectId}: Readonly<{actorId: string; projectId: string}>) =>
      readActiveProjectContext(database, actorId, projectId),
    composeAcceptedNotification: async (item: TrackerItemFact, idempotencyKey: string): Promise<MessengerDeliveryInput> => ({projectId: context.projectId,
      contour: 'trusted-main', channelReference: 'telegram:internal',
      text: `Hermes принял задачу: ${item.title} — ${item.url}`, idempotencyKey}),
    repository, delivery, tracker, agentInstructions: defaultAgentStageInstructions, transaction: {execute: (
      input: Parameters<AgentSubmissionPorts['transaction']['execute']>[0], submit: Parameters<AgentSubmissionPorts['transaction']['execute']>[1]
    ) => executeAgentSubmissionTransaction(database, input, submit)}}};
};

/** Shared UI/Telegram composition for the canonical process.start command. */
export const startGitHubProcess = async (database: ReturnType<typeof getDatabase>, input: Readonly<{
  actorId: string; projectId: string; task: Readonly<{kind: 'existing'; itemId: string}> |
    Readonly<{kind: 'create'; title: string; statement: string}>;
  sourceReference: string; idempotencyKey: string;
}>) => {
  const endpoint = process.env.HERMES_ROLE_REQUEST_URL;
  const binding = endpoint === undefined ? null : await resolveAgentSubmissionBinding(database, input.actorId, input.projectId);
  if (endpoint === undefined || binding?.agentCredentialRef == null) throw new Error('agent_provider_unavailable');
  const delivery = createHermesDeliveryAdapter({endpoint: string(endpoint, 2_048),
    credentialRef: binding.agentCredentialRef, secrets: secretResolver});
  const {ports} = await githubAssignment(database, input.actorId, input.projectId, delivery);
  return startProcess(input, ports);
};

export const projects = async (request: Request): Promise<Response> => {
  try {
    if (request.method !== 'GET') return new Response(null, {status: 405, headers: {allow: 'GET'}});
    const database = getDatabase();
    const session = await requireSession();
    return Response.json({projects: await listProjects(database, session.actorId)});
  } catch (error) { return jsonError(error); }
};

export const onboard = async (request: Request): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    requireCsrf(request);
    const body = await json(request);
    const projectId = string(body.projectId);
    if (!await canGovernMembership(database, session.actorId, projectId)) throw new Error('onboarding_denied');
    const role = string(body.role, 32);
    if (!['operator', 'contributor', 'client'].includes(role)) throw new Error('body_invalid');
    const identity = (provider: 'github'|'telegram'|'bitrix24', value: unknown, numeric: boolean) => {
      if (value === undefined || value === null || value === '') return null;
      const subject = string(value, 64);
      if (numeric && !/^[1-9][0-9]*$/.test(subject)) throw new Error('body_invalid');
      return {provider, subjectHash: subjectHash(provider, subject)} as const;
    };
    const identities = [identity('github', body.githubUserId, true), identity('telegram', body.telegramUserId, true),
      identity('bitrix24', body.bitrix24UserId, false)].filter((value) => value !== null);
    const result = await onboardProjectMember(database, {workspaceId: session.workspaceId, projectId,
      displayName: string(body.displayName, 200), role: role as 'operator'|'contributor'|'client', identities});
    return Response.json({actorId: result.actorId, created: result.created}, {status: result.created ? 201 : 200});
  } catch (error) { return jsonError(error); }
};

export const membership = async (request: Request, membershipId: string): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    requireCsrf(request);
    const body = await json(request);
    const current = await database.query<{projectId: string; actorId: string; role: ProjectRole}>(
      'select project_id as "projectId",actor_id as "actorId",role from project_memberships where id=$1', [membershipId]
    );
    const projectId = current.rows[0]?.projectId;
    if (projectId === undefined || !await canGovernMembership(database, session.actorId, projectId)) {
      throw new Error('membership_denied');
    }
    const role = string(body.role, 32) as ProjectRole;
    if (!['project_owner', 'operator', 'contributor', 'client'].includes(role) || typeof body.active !== 'boolean') {
      throw new Error('body_invalid');
    }
    if (!mayChangeMembership({requesterActorId: session.actorId, requesterRole: 'project_owner',
      targetActorId: current.rows[0]!.actorId, targetRole: current.rows[0]!.role,
      requestedRole: role, requestedActive: body.active})) throw new Error('membership_denied');
    await database.query('update project_memberships set role=$2,active=$3 where id=$1', [membershipId, role, body.active]);
    return Response.json({ok: true});
  } catch (error) { return jsonError(error); }
};

export const source = async (request: Request, projectId: string): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    requireCsrf(request);
    const body = await json(request);
    const contentText = string(body.contentText, 200_000);
    const sourceId = await addSourceArtifact(database, {
      projectId, actorId: session.actorId, kind: string(body.kind, 64), name: string(body.name, 200),
      mediaType: string(body.mediaType, 100), contentText,
      sha256: createHash('sha256').update(contentText).digest('hex'),
      sourceUrl: optionalHttps(body.sourceUrl), provenance: string(body.provenance, 500)
    });
    return Response.json({id: sourceId}, {status: 201});
  } catch (error) { return jsonError(error); }
};

export const agentRouting = async (request: Request, projectId: string): Promise<Response> => {
  try {
    const database = getDatabase(); const session = await requireSession();
    if (request.method === 'GET') {
      return Response.json({routing: await readAgentRoutingPolicy(database, session.actorId, projectId)},
        {headers: {'cache-control': 'no-store'}});
    }
    if (request.method !== 'POST') return new Response(null, {status: 405, headers: {allow: 'GET, POST'}});
    requireCsrf(request); const body = await json(request); const policy = parseAgentRoutingPolicy(body.policy);
    if (policy === null) throw new Error('body_invalid');
    assertAgentRoutingPolicyAvailable(policy, hermesExecutorCatalog());
    const result = await saveAgentRoutingPolicy(database, {workspaceId: session.workspaceId, projectId,
      actorId: session.actorId, policy, idempotencyKey: string(body.idempotencyKey),
      occurredAt: new Date().toISOString()});
    return Response.json(result, {status: 201, headers: {'cache-control': 'no-store'}});
  } catch (error) { return jsonError(error); }
};

export const refreshContext = async (request: Request, projectId: string): Promise<Response> => {
  try {
    if (request.method !== 'POST') return new Response(null, {status: 405, headers: {allow: 'POST'}});
    const database = getDatabase(); const session = await requireSession(); requireCsrf(request);
    const body = await json(request);
    const result = await refreshProjectContext(database, {workspaceId: session.workspaceId, projectId, actorId: session.actorId,
      idempotencyKey: string(body.idempotencyKey), occurredAt: new Date().toISOString()});
    return Response.json(result, {headers: {'cache-control': 'no-store'}});
  } catch (error) { return jsonError(error); }
};

export const approval = async (request: Request, approvalId: string): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    requireCsrf(request);
    const body = await json(request);
    const kind = string(body.kind, 32) as ApprovalKind;
    const persistence = createApprovalPersistence(database);
    const projectId = string(body.projectId);
    const owner = string(process.env.GITHUB_OWNER, 100); const repository = string(process.env.GITHUB_REPOSITORY, 100);
    const projectNumber = Number(string(process.env.GITHUB_PROJECT_NUMBER, 16));
    const bindingId = string(process.env.GITHUB_BINDING_ID);
    const tracker = createGitHubTrackerReadAdapter({binding: {id: bindingId, owner, repository, projectId,
      projectNumber, projectUrl: `https://github.com/users/${owner}/projects/${projectNumber}`,
      credentialRef: envSecret('GITHUB_PROJECTS_TOKEN', 'tracker_read')}, secrets: secretResolver});
    const stores = createStores(database, session.workspaceId);
    const result = await decideApproval({workspaceId: session.workspaceId, request: {
      id: approvalId, projectId, kind,
      decision: string(body.decision, 16) as ApprovalEvidence['decision'], actorId: session.actorId,
      targetReference: string(body.targetReference), decidedAt: new Date().toISOString(),
      idempotencyKey: string(body.idempotencyKey)
    }, authority: {
        canDecide: (actorId, projectId, approvalKind) => canApprove(database, actorId, projectId, approvalKind)
      }, targets: {async resolve(target) {
        const snapshot = await tracker.readSnapshot(bindingId, null);
        if (snapshot.items.some((item) => item.projectId !== projectId)) throw new Error('tracker_project_mismatch');
        await stores.snapshots.replace(snapshot);
        const fact = snapshot.items.find((item) => item.itemId === target.targetReference || item.issueId === target.targetReference);
        return fact === undefined ? null : {id: target.targetReference, url: fact.url, version: fact.version};
      }}, transaction: persistence.transaction});
    return Response.json({status: result}, {status: result === 'recorded' || result === 'duplicate' ? 200 : 409});
  } catch (error) { return jsonError(error); }
};

const unavailableDelivery: AgentDeliveryPort = {submit: async () => { throw new Error('agent_provider_unavailable'); },
  observe: async () => { throw new Error('agent_provider_unavailable'); }};

export const taskAssignableUsers = async (request: Request): Promise<Response> => {
  try {
    if (request.method !== 'GET') return new Response(null, {status: 405, headers: {allow: 'GET'}});
    const session = await requireSession(); const projectId = string(new URL(request.url).searchParams.get('projectId'));
    const {tracker} = await githubAssignment(getDatabase(), session.actorId, projectId, unavailableDelivery);
    return Response.json({users: await tracker.listAssignableUsers()});
  } catch (error) {
    const code = error instanceof Error ? error.message : 'request_failed';
    if (['tracker_provider_unsupported','github_binding_invalid','github_read_failed','github_response_invalid',
      'github_credential_invalid','secret_purpose_denied','secret_path_must_be_absolute','secret_invalid'].includes(code)) {
      return Response.json({error: 'provider_error'}, {status: 502});
    }
    return jsonError(error);
  }
};

export const taskExecutor = async (request: Request): Promise<Response> => {
  try {
    if (request.method !== 'POST') return new Response(null, {status: 405, headers: {allow: 'POST'}});
    const database = getDatabase(); const session = await requireSession(); requireCsrf(request);
    const body = await json(request); const projectId = string(body.projectId);
    const action = body.action === undefined ? 'assign' : string(body.action, 32);
    const endpoint = process.env.HERMES_ROLE_REQUEST_URL;
    const binding = endpoint === undefined ? null : await resolveAgentSubmissionBinding(database, session.actorId, projectId);
    const delivery = endpoint === undefined || binding?.agentCredentialRef == null ? unavailableDelivery
      : createHermesDeliveryAdapter({endpoint: string(endpoint, 2_048), credentialRef: binding.agentCredentialRef,
        secrets: secretResolver});
    if (action === 'refresh-attempt') {
      const assignment = await githubAssignment(database, session.actorId, projectId, delivery);
      return Response.json(await reconcileAgentAttempt({actorId: session.actorId, projectId,
        itemId: string(body.projectItemId), deliveryReference: string(body.deliveryReference)},
      {delivery, attempts: createAgentAttemptStore(database), readFreshItem: async (attempt) => {
        const context = await assignment.ports.resolveContext();
        if (context === null) return null;
        const snapshot = await assignment.ports.readFreshSnapshot();
        await assignment.ports.persistSnapshot(snapshot);
        return snapshot.items.find((candidate) => candidate.itemId === attempt.itemId &&
          candidate.projectId === attempt.projectId) ?? null;
      }, composeTerminalNotification: async (attempt, observed, key) =>
        composeAgentTerminalNotification(projectId, attempt, observed, key)}));
    }
    if (action !== 'assign') throw new Error('body_invalid');
    const executor = body.executor;
    if (executor === null || typeof executor !== 'object' || Array.isArray(executor)) throw new Error('body_invalid');
    const choice = executor as Record<string, unknown>;
    const kind = string(choice.kind, 16);
    if (kind !== 'human' && kind !== 'hermes') throw new Error('body_invalid');
    const candidate = kind === 'human' ? choice.candidate : undefined;
    if (kind === 'human' && (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))) throw new Error('body_invalid');
    const {ports} = await githubAssignment(database, session.actorId, projectId, kind === 'hermes' ? delivery : unavailableDelivery);
    const retryValue = body.retry;
    const retry = retryValue === undefined ? undefined : (() => {
      if (retryValue === null || typeof retryValue !== 'object' || Array.isArray(retryValue)) throw new Error('body_invalid');
      const value = retryValue as Record<string, unknown>;
      return {deliveryReference: string(value.deliveryReference), nonce: string(value.nonce, 128),
        confirmUnobservableFailure: value.confirmUnobservableFailure === true};
    })();
    if (retry !== undefined && kind !== 'hermes') throw new Error('body_invalid');
    const projectItemId = string(body.projectItemId);
    const result = kind === 'hermes' && retry === undefined
      ? await startGitHubProcess(database, {actorId: session.actorId, projectId,
        task: {kind: 'existing', itemId: projectItemId}, sourceReference: 'ui:task-executor',
        idempotencyKey: `process.start:ui:${projectId}:${projectItemId}`})
      : await assignTaskExecutor({actorId: session.actorId, projectId, projectItemId,
        executor: kind === 'hermes' ? {kind} : {kind, candidate: {id: string((candidate as Record<string, unknown>).id, 512), login: string((candidate as Record<string, unknown>).login, 256)}},
        ...(retry === undefined ? {} : {retry})}, ports);
    return Response.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'request_failed';
    if (['github_version_conflict','task_executor_conflict'].includes(code)) return Response.json({error: 'task_conflict'}, {status: 409});
    if (['github_assignee_unavailable','task_executor_candidate_unavailable'].includes(code)) return Response.json({error: 'candidate_unavailable'}, {status: 409});
    if (code === 'github_assignment_partial') return Response.json({error: 'assignment_partial'}, {status: 409});
    if (['github_owner_unavailable','task_executor_unavailable'].includes(code)) return Response.json({error: 'operation_unavailable'}, {status: 409});
    if (['agent_attempt_active','agent_retry_denied'].includes(code)) return Response.json({error: 'retry_unavailable'}, {status: 409});
    if (code === 'agent_context_unavailable') return Response.json({error: 'context_unavailable'}, {status: 409});
    if (['agent_submit_denied','agent_routing_policy_invalid','agent_request_invalid'].includes(code)) {
      return Response.json({error: 'execution_unavailable'}, {status: 409});
    }
    if (['agent_delivery_failed','agent_response_invalid'].includes(code)) return Response.json({error: 'delivery_failed'}, {status: 502});
    if (['tracker_provider_unsupported','github_binding_invalid','github_read_failed','github_response_invalid',
      'github_mutation_failed','github_status_unavailable','github_credential_invalid',
      'agent_endpoint_invalid','agent_provider_unavailable','agent_credential_invalid','agent_status_failed','agent_status_invalid',
      'secret_purpose_denied','secret_path_must_be_absolute','secret_invalid'].includes(code)) {
      return Response.json({error: 'provider_error'}, {status: 502});
    }
    return jsonError(error);
  }
};

const envSecret = (prefix: string, purpose: string): OpaqueSecretRef => ({
  id: prefix, purpose, locator: string(process.env[`${prefix}_FILE`], 1_024)
});

const watchedContextPaths = new Map([
  ['AGENTS.md', 'repo:agents'],
  ['docs/AI_CONTEXT.md', 'repo:ai-context'],
  ['docs/adr/0006-thin-control-plane-authority.md', 'repo:adr-0006']
]);
export const pushChangedPaths = (body: Uint8Array, expected: Readonly<{repository: string; branch: string}>):
  Readonly<{after: string; paths: readonly string[]; removed: readonly string[]}> | null => {
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(body).toString('utf8')); } catch { return null; }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>; const after = typeof value.after === 'string' ? value.after : '';
  const repository = value.repository as Record<string,unknown>|undefined;
  const expectedRepository = expected.repository; const expectedRef = `refs/heads/${expected.branch}`;
  if (!/^[a-f0-9]{40}$/i.test(after) || /^0{40}$/.test(after) || value.ref !== expectedRef ||
    repository?.full_name !== expectedRepository || !Array.isArray(value.commits)) return null;
  const paths = new Set<string>(); const removed = new Set<string>();
  for (const commit of value.commits) {
    if (commit === null || typeof commit !== 'object') continue;
    for (const field of ['added', 'modified'] as const) {
      const entries = (commit as Record<string, unknown>)[field];
      if (Array.isArray(entries)) for (const path of entries) if (typeof path === 'string' && watchedContextPaths.has(path)) {
        paths.add(path); removed.delete(path);
      }
    }
    const entries = (commit as Record<string, unknown>).removed;
    if (Array.isArray(entries)) for (const path of entries) if (typeof path === 'string' && watchedContextPaths.has(path)) {
      paths.delete(path); removed.add(path);
    }
  }
  return {after: after.toLowerCase(), paths: [...paths].sort(), removed: [...removed].sort()};
};
const refreshGitHubContextSources = async (database: ReturnType<typeof getDatabase>, projectId: string,
  after: string, paths: readonly string[]): Promise<void> => {
  const owner = string(process.env.GITHUB_OWNER, 100); const repository = string(process.env.GITHUB_REPOSITORY, 100);
  const token = (await secretResolver.resolve(envSecret('GITHUB_PROJECTS_TOKEN', 'tracker_read'), 'tracker_read')).value;
  if (token.length === 0 || token.length > 65_536 || token.includes('\0')) throw new Error('github_credential_invalid');
  for (const path of paths) {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${after}`, {
      headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28'},
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error('github_context_read_failed');
    const value = await response.json() as Record<string, unknown>;
    if (value.type !== 'file' || typeof value.content !== 'string' || value.encoding !== 'base64') throw new Error('github_context_read_invalid');
    const content = Buffer.from(value.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (content.length === 0 || content.length > 200_000 || content.includes('\0')) throw new Error('github_context_read_invalid');
    const key = watchedContextPaths.get(path);
    if (key === undefined) throw new Error('github_context_read_invalid');
    const serialized = JSON.stringify({contract:'fai.project-context-source.v1', key, content});
    await addSourceArtifact(database, {projectId, actorId: string(process.env.BOOTSTRAP_OWNER_ACTOR_ID),
      kind: 'project_context_source_v1', name: key, mediaType: 'application/json', contentText: serialized,
      sha256: createHash('sha256').update(serialized).digest('hex'), sourceUrl: `https://github.com/${owner}/${repository}/blob/${after}/${path}`,
      provenance: `repo-file:${path}@${after}`});
  }
};

const invalidateRemovedGitHubContextSources = async (database: ReturnType<typeof getDatabase>, projectId: string,
  after: string, paths: readonly string[]): Promise<void> => {
  for (const path of paths) {
    const key = watchedContextPaths.get(path); if (key === undefined) continue;
    const serialized = JSON.stringify({contract:'fai.project-context-source.v1',key,
      content:`Source removed from the configured repository at ${after}.`});
    await addSourceArtifact(database,{projectId,actorId:string(process.env.BOOTSTRAP_OWNER_ACTOR_ID),
      kind:'project_context_source_v1',name:key,mediaType:'application/json',contentText:serialized,
      sha256:createHash('sha256').update(serialized).digest('hex'),sourceUrl:null,
      provenance:`repo-file-removed:${path}@${after}`});
  }
};

export const githubWebhook = async (request: Request): Promise<Response> => {
  try {
    const database = getDatabase();
    const body = new Uint8Array(await request.arrayBuffer());
    const verified = await verifyGitHubWebhook({headers: {
      'x-hub-signature-256': request.headers.get('x-hub-signature-256') ?? undefined,
      'x-github-delivery': request.headers.get('x-github-delivery') ?? undefined,
      'x-github-event': request.headers.get('x-github-event') ?? undefined
    }, body, secretRef: envSecret('GITHUB_WEBHOOK_SECRET', 'tracker_webhook_verify'), secrets: secretResolver});
    if (verified === null) throw new Error('webhook_denied');
    const projectId = string(process.env.FCP_PROJECT_ID);
    const result = await appendIncomingEvent(database, {projectId, provider: 'github',
      providerDeliveryId: verified.deliveryId, eventType: verified.eventType, payloadHash: verified.payloadHash,
      receivedAt: new Date().toISOString()});
    const push = verified.eventType === 'push' ? pushChangedPaths(body,{
      repository:`${string(process.env.GITHUB_OWNER,100)}/${string(process.env.GITHUB_REPOSITORY,100)}`,
      branch:string(process.env.GITHUB_DEFAULT_BRANCH,100)
    }) : null;
    if (push !== null && (push.paths.length > 0 || push.removed.length > 0)) {
      if (result === 'duplicate') {
        const processed = await database.query(`select 1 from command_receipts
          where project_id=$1 and idempotency_key=$2 and command_type='project.context.activate'`,
        [projectId,`project-context:webhook:${verified.deliveryId}`]);
        if (processed.rowCount === 1) return Response.json({status:'duplicate'}, {status:200});
      }
      await refreshGitHubContextSources(database, projectId, push.after, push.paths);
      await invalidateRemovedGitHubContextSources(database,projectId,push.after,push.removed);
      if (push.removed.length === 0) await refreshProjectContext(database, {workspaceId: string(process.env.FCP_WORKSPACE_ID), projectId,
          actorId: string(process.env.BOOTSTRAP_OWNER_ACTOR_ID), idempotencyKey: `project-context:webhook:${verified.deliveryId}`,
          occurredAt: new Date().toISOString()});
    }
    return Response.json({status: result}, {status: result === 'recorded' ? 202 : 200});
  } catch (error) { return jsonError(error); }
};

export const health = (): Response => Response.json({status: 'ok', service: 'web'},
  {headers: {'cache-control': 'no-store'}});
export const ready = async (): Promise<Response> => {
  const database = getDatabase();
  const ok = await databaseMvpReady(database);
  return Response.json({status: ok ? 'ready' : 'not_ready', ...readiness({database: ok})},
    {status: ok ? 200 : 503, headers: {'cache-control': 'no-store'}});
};
