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
import {decideApproval, submitExplicitAgent} from '@fai-control-plane/application';
import {verifyGitHubWebhook, createGitHubRepositoryReadAdapter, createGitHubTrackerReadAdapter, createHermesDeliveryAdapter} from '@fai-control-plane/integrations';
import {mayChangeMembership, type ApprovalEvidence, type ApprovalKind, type OpaqueSecretRef, type ProjectRole} from '@fai-control-plane/domain';
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
const strings = (value: unknown, maximumItems: number, maximumLength: number): readonly string[] => {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error('body_invalid');
  return value.map((item) => string(item, maximumLength));
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

export const agentSubmit = async (request: Request): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    requireCsrf(request);
    const body = await json(request);
    const projectId = string(body.projectId);
    const context = await resolveAgentSubmissionBinding(database, session.actorId, projectId);
    if (context === null) throw new Error('agent_submit_denied');
    if (!['project_owner', 'operator'].includes(context.requesterRole)) throw new Error('agent_submit_denied');
    if (context.agentCredentialRef === null) throw new Error('agent_provider_unavailable');
    if (context.provider !== 'github') throw new Error('tracker_provider_unsupported');
    const projectUrl = new URL(context.projectUrl); const repositoryUrl = new URL(context.repositoryUrl);
    const projectMatch = /^\/users\/([^/]+)\/projects\/(\d+)$/.exec(projectUrl.pathname);
    const repositoryMatch = /^\/([^/]+)\/([^/]+)\/?$/.exec(repositoryUrl.pathname);
    if (projectUrl.origin !== 'https://github.com' || repositoryUrl.origin !== 'https://github.com' ||
      projectMatch === null || repositoryMatch === null || projectMatch[1] !== repositoryMatch[1]) {
      throw new Error('github_binding_invalid');
    }
    const binding = {id: context.bindingId, owner: projectMatch[1]!, repository: repositoryMatch[2]!,
      projectId: context.projectId, projectNumber: Number(projectMatch[2]), projectUrl: context.projectUrl,
      credentialRef: context.trackerCredentialRef};
    const tracker = createGitHubTrackerReadAdapter({binding, secrets: secretResolver});
    const repository = createGitHubRepositoryReadAdapter({owner: binding.owner, repository: binding.repository,
      repositoryId: context.repositoryId, credentialRef: context.trackerCredentialRef, secrets: secretResolver});
    const stores = createStores(database, session.workspaceId);
    const delivery = createHermesDeliveryAdapter({endpoint: string(process.env.HERMES_ROLE_REQUEST_URL, 2_048),
      credentialRef: context.agentCredentialRef, secrets: secretResolver});
    const result = await submitExplicitAgent({actorId: session.actorId, projectId,
      projectItemId: string(body.projectItemId), role: string(body.role, 32) as 'manager'|'developer'|'qa'|'devops',
      sourceIds: strings(body.sourceIds ?? [], 20, 256), constraints: strings(body.constraints, 40, 2_000),
      acceptanceCriteria: strings(body.acceptanceCriteria, 40, 2_000)}, {
      resolveContext: async () => ({workspaceId: context.workspaceId, projectId: context.projectId,
        requesterRole: context.requesterRole, bindingId: context.bindingId,
        repository: {id: context.repositoryId, url: context.repositoryUrl},
        agentTrackerOwnerOptionId: string(process.env.HERMES_TRACKER_OWNER_OPTION_ID, 512),
        doneStatusOptionId: string(process.env.STATUS_DONE_ID, 512)}),
      readFreshSnapshot: () => tracker.readSnapshot(context.bindingId, context.cursor),
      persistSnapshot: stores.snapshots.replace,
      resolveSources: (input) => resolveAgentSourceReferences(database, input), repository, delivery,
      transaction: {execute: (input, submit) => executeAgentSubmissionTransaction(database, input, submit)}
    });
    return Response.json({status: result.status, deliveryReference: result.deliveryReference});
  } catch (error) {
    const code = error instanceof Error ? error.message : 'request_failed';
    if (['tracker_provider_unsupported','github_binding_invalid','github_read_failed','github_response_invalid',
      'github_snapshot_changed','github_credential_invalid','agent_endpoint_invalid','agent_provider_unavailable',
      'agent_credential_invalid','agent_delivery_failed','agent_response_invalid','secret_path_must_be_absolute',
      'secret_invalid'].includes(code)) return Response.json({error: 'provider_error'}, {status: 502});
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
