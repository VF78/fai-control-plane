import {createHash} from 'node:crypto';
import {
  addSourceArtifact,
  appendIncomingEvent,
  canApprove,
  canGovernMembership,
  createApprovalPersistence,
  createStores,
  databaseMvpReady,
  executeAgentSubmissionTransaction,
  listProjects,
  onboardProjectMember,
  resolveAgentSourceReferences,
  resolveAgentSubmissionBinding,
  subjectHash
} from '@fai-control-plane/db';
import {assignTaskExecutor, decideApproval, type AgentSubmissionPorts} from '@fai-control-plane/application';
import {verifyGitHubWebhook, createGitHubRepositoryReadAdapter, createGitHubTrackerMutationAdapter, createGitHubTrackerReadAdapter, createHermesDeliveryAdapter} from '@fai-control-plane/integrations';
import {mayChangeMembership, type AgentDeliveryPort, type ApprovalEvidence, type ApprovalKind, type MessengerDeliveryInput, type OpaqueSecretRef, type ProjectRole, type TrackerItemFact} from '@fai-control-plane/domain';
import {getDatabase, jsonError, requireCsrf, requireSession, secretResolver} from './runtime.ts';
import {readiness} from './http-surface.ts';

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
  return {context, tracker, ports: {resolveContext: async () => ({workspaceId: context.workspaceId, projectId: context.projectId,
      requesterRole: context.requesterRole, bindingId: context.bindingId, repository: {id: context.repositoryId, url: context.repositoryUrl},
      agentTrackerOwnerOptionId: process.env.HERMES_TRACKER_OWNER_OPTION_ID ?? '', doneStatusOptionId: process.env.STATUS_DONE_ID ?? ''}),
    readFreshSnapshot: () => read.readSnapshot(context.bindingId, context.cursor), persistSnapshot: stores.snapshots.replace,
    resolveSources: (input: Readonly<{actorId: string; projectId: string; sourceIds: readonly string[]}>) => resolveAgentSourceReferences(database, input),
    composeAcceptedNotification: async (item: TrackerItemFact, idempotencyKey: string): Promise<MessengerDeliveryInput> => ({projectId: context.projectId,
      contour: 'trusted-main', channelReference: 'telegram:internal',
      text: `Hermes принял задачу: ${item.title} — ${item.url}`, idempotencyKey}),
    repository, delivery, tracker, agentInstructions: asconHermesInstructions, transaction: {execute: (
      input: Parameters<AgentSubmissionPorts['transaction']['execute']>[0], submit: Parameters<AgentSubmissionPorts['transaction']['execute']>[1]
    ) => executeAgentSubmissionTransaction(database, input, submit)}}};
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

const unavailableDelivery: AgentDeliveryPort = {submit: async () => { throw new Error('agent_provider_unavailable'); }};

const asconHermesInstructions = (role: 'developer'|'qa') => role === 'developer'
  ? {constraints: [
    'Work only on the referenced GitHub Project item and repository.',
    'Do not merge, release, deploy, or access production.',
    'Best-effort status contract, requiring configured GitHub Project mutation capability: after implementation, move this same Project item from In Dev to QA and read it back to verify Status is QA.'
  ], acceptanceCriteria: [
    'Record delivery evidence in the referenced GitHub issue or pull request.',
    'The same Project item is confirmed in QA after development.'
  ]} : {constraints: [
    'Work only on the referenced GitHub Project item and repository.',
    'Do not merge, release, deploy, or access production.',
    'Best-effort status contract, requiring configured GitHub Project mutation capability: after QA, move this same Project item from QA to In Dev when rework is needed; otherwise QA to Acceptance. Read it back and verify Status.'
  ], acceptanceCriteria: [
    'Record QA evidence in the referenced GitHub issue or pull request.',
    'The same Project item is confirmed in In Dev or Acceptance after QA.'
  ]};

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
    const body = await json(request); const projectId = string(body.projectId); const executor = body.executor;
    if (executor === null || typeof executor !== 'object' || Array.isArray(executor)) throw new Error('body_invalid');
    const choice = executor as Record<string, unknown>;
    const kind = string(choice.kind, 16);
    if (kind !== 'human' && kind !== 'hermes') throw new Error('body_invalid');
    const candidate = kind === 'human' ? choice.candidate : undefined;
    if (kind === 'human' && (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))) throw new Error('body_invalid');
    const agent = kind === 'hermes'
      ? (() => { const credential = process.env.HERMES_ROLE_REQUEST_URL; if (credential === undefined) throw new Error('agent_provider_unavailable'); return credential; })()
      : null;
    const delivery = agent === null ? unavailableDelivery : createHermesDeliveryAdapter({endpoint: string(agent, 2_048),
      credentialRef: (await resolveAgentSubmissionBinding(database, session.actorId, projectId))?.agentCredentialRef ?? (() => { throw new Error('agent_provider_unavailable'); })(), secrets: secretResolver});
    const {ports} = await githubAssignment(database, session.actorId, projectId, delivery);
    const result = await assignTaskExecutor({actorId: session.actorId, projectId, projectItemId: string(body.projectItemId),
      executor: kind === 'hermes' ? {kind} : {kind, candidate: {id: string((candidate as Record<string, unknown>).id, 512), login: string((candidate as Record<string, unknown>).login, 256)}}}, ports);
    return Response.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'request_failed';
    if (['github_version_conflict','task_executor_conflict'].includes(code)) return Response.json({error: 'task_conflict'}, {status: 409});
    if (['github_assignee_unavailable','task_executor_candidate_unavailable'].includes(code)) return Response.json({error: 'candidate_unavailable'}, {status: 409});
    if (code === 'github_assignment_partial') return Response.json({error: 'assignment_partial'}, {status: 409});
    if (['github_owner_unavailable','task_executor_unavailable'].includes(code)) return Response.json({error: 'operation_unavailable'}, {status: 409});
    if (['agent_delivery_failed','agent_response_invalid'].includes(code)) return Response.json({error: 'delivery_failed'}, {status: 502});
    if (['tracker_provider_unsupported','github_binding_invalid','github_read_failed','github_response_invalid',
      'github_mutation_failed','github_status_unavailable','github_credential_invalid',
      'agent_endpoint_invalid','agent_provider_unavailable','agent_credential_invalid',
      'secret_purpose_denied','secret_path_must_be_absolute','secret_invalid'].includes(code)) {
      return Response.json({error: 'provider_error'}, {status: 502});
    }
    return jsonError(error);
  }
};

const envSecret = (prefix: string, purpose: string): OpaqueSecretRef => ({
  id: prefix, purpose, locator: string(process.env[`${prefix}_FILE`], 1_024)
});

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
