import {createHash, randomUUID} from 'node:crypto';
import {
  addSourceArtifact,
  appendIncomingEvent,
  canApprove,
  canGovernMembership,
  createApprovalPersistence,
  createStores,
  databaseMvpReady,
  listProjects,
  pendingInterpretationCount,
  subjectHash
} from '@fai-control-plane/db';
import {decideApproval} from '@fai-control-plane/application';
import {verifyGitHubWebhook, createBitrix24IngressAdapter, createGitHubTrackerReadAdapter} from '@fai-control-plane/integrations';
import {mayChangeMembership, parseConversationCommand, type ApprovalEvidence, type ApprovalKind, type OpaqueSecretRef, type ProjectRole} from '@fai-control-plane/domain';
import {getDatabase, jsonError, requireCsrf, requireSession, secretResolver} from './runtime.ts';

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
const requiredHttps = (value: unknown): string => {
  const result = optionalHttps(value);
  if (result === null) throw new Error('repository_url_required');
  return result;
};

export const projects = async (request: Request): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    if (request.method === 'GET') return Response.json({projects: await listProjects(database, session.actorId)});
    requireCsrf(request);
    const body = await json(request);
    const id = randomUUID();
    await database.query(
      `insert into projects(id,workspace_id,slug,name,repository_url) values($1,$2,$3,$4,$5)`,
      [id, session.workspaceId, string(body.slug, 100), string(body.name, 200), requiredHttps(body.repositoryUrl)]
    );
    await database.query(
      `insert into project_memberships(project_id,actor_id,role) values($1,$2,'project_owner')`,
      [id, session.actorId]
    );
    return Response.json({id}, {status: 201});
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
    const githubUserId = string(body.githubUserId, 32);
    if (!/^[1-9][0-9]*$/.test(githubUserId)) throw new Error('body_invalid');
    const role = string(body.role, 32);
    if (!['operator', 'contributor', 'client'].includes(role)) throw new Error('body_invalid');
    const actorId = randomUUID();
    const client = await database.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into actors(id,workspace_id,kind,display_name) values($1,$2,'human',$3)`,
        [actorId, session.workspaceId, string(body.displayName, 200)]
      );
      await client.query(
        `insert into actor_external_identities(actor_id,provider,subject_hash) values($1,'github',$2)`,
        [actorId, subjectHash('github', githubUserId)]
      );
      if (body.telegramUserId !== undefined) await client.query(
        `insert into actor_external_identities(actor_id,provider,subject_hash) values($1,'telegram',$2)`,
        [actorId, subjectHash('telegram', string(body.telegramUserId, 32))]
      );
      if (body.bitrix24UserId !== undefined) await client.query(
        `insert into actor_external_identities(actor_id,provider,subject_hash) values($1,'bitrix24',$2)`,
        [actorId, subjectHash('bitrix24', string(body.bitrix24UserId, 32))]
      );
      await client.query(
        'insert into project_memberships(project_id,actor_id,role) values($1,$2,$3)',
        [projectId, actorId, role]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    return Response.json({actorId}, {status: 201});
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

export const bitrix24Webhook = async (request: Request): Promise<Response> => {
  try {
    const database = getDatabase();
    const projectId = string(process.env.FCP_PROJECT_ID);
    const adapter = createBitrix24IngressAdapter({config: {
      portalUrl: string(process.env.BITRIX24_PORTAL_URL, 2_048), memberId: string(process.env.BITRIX24_MEMBER_ID, 128),
      taskId: Number(process.env.BITRIX24_TASK_ID),
      projectId, allowedAuthorIds: string(process.env.BITRIX24_ALLOWED_AUTHOR_IDS).split(',').map(Number),
      applicationTokenRef: envSecret('BITRIX24_APPLICATION_TOKEN', 'messenger_webhook_verify'),
      restTokenRef: envSecret('BITRIX24_REST_TOKEN', 'messenger_delivery')
    }, secrets: secretResolver});
    const received = await adapter.receive({headers: {'content-type': request.headers.get('content-type') ?? undefined},
      body: new Uint8Array(await request.arrayBuffer())});
    if (received.status === 'rejected') throw new Error('webhook_denied');
    const action = parseConversationCommand(received.message.text);
    const result = await appendIncomingEvent(database, {projectId, provider: 'bitrix24',
      providerDeliveryId: received.message.messageReference,
      eventType: action === null ? 'conversation.pending_interpretation' : 'conversation.action',
      payloadHash: createHash('sha256').update(received.message.messageReference).digest('hex'),
      actionPayload: action === null ? {status: 'pending_interpretation', providerReference: received.message.messageReference,
        contour: received.message.contour} :
        {message: received.message, action},
      receivedAt: received.message.observedAt});
    return Response.json({status: result}, {status: result === 'recorded' ? 202 : 200});
  } catch (error) { return jsonError(error); }
};

export const health = (): Response => Response.json({status: 'ok', service: 'web'},
  {headers: {'cache-control': 'no-store'}});
export const ready = async (): Promise<Response> => {
  const database = getDatabase();
  const ok = await databaseMvpReady(database);
  const pendingInterpretation = ok ? await pendingInterpretationCount(database) : 0;
  return Response.json({status: ok ? 'ready' : 'not_ready', checks: {database: ok,
    conversationAutomation: false}, pendingInterpretation},
    {status: ok ? 200 : 503, headers: {'cache-control': 'no-store'}});
};
