import {containsHighConfidenceSecretContent, projectMembershipRoles, projectSetupBindingModes,
  type ProjectMembershipRole} from '@fai-control-plane/domain';
import {requireOperatorSession} from './operator-auth-runtime';
import {getProjectIntakeRuntime} from './project-intake-runtime';

const MAX_BODY_BYTES = 12 * 1024;
const noStore = {'Cache-Control': 'no-store'} as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slug = /^[a-z][a-z0-9-]{1,47}$/;
const reserved = new Set(['all', 'api', 'dashboard', 'new', 'projects', 'settings']);
const slots = Array.from({length: 8}, (_, index) => index);
type OpenedRuntime = Awaited<ReturnType<typeof getProjectIntakeRuntime>>;
export type ProjectIntakeCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<OpenedRuntime>;
}>;
const dependencies: ProjectIntakeCommandDependencies = {requireSession: requireOperatorSession,
  getRuntime: getProjectIntakeRuntime};

async function readBoundedBody(request: Request): Promise<string | null> {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) return null;
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function createProjectCommand(request: Request,
  overrides: ProjectIntakeCommandDependencies = dependencies): Promise<Response> {
  const contentType = request.headers.get('content-type')?.toLowerCase();
  const length = request.headers.get('content-length');
  if (contentType === undefined || !contentType.startsWith('application/x-www-form-urlencoded') ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))) {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  const text = await readBoundedBody(request);
  if (text === null) return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  const form = new URLSearchParams(text);
  const authorization = await overrides.requireSession(request, {csrfToken: form.get('_csrf')});
  if (!authorization.ok) return authorization.response;
  const fixed = ['_csrf', 'idempotencyKey', 'name', 'slug', 'productOwnerActorId',
    'repositoryBinding', 'trackerBinding', 'internalChat', 'clientChat', 'executionMode', 'agentProfileId'];
  const allowed = new Set([...fixed, ...slots.flatMap((index) => [`memberActorId${index}`, `memberRole${index}`])]);
  if ([...form.keys()].some((key) => !allowed.has(key)) || [...form.keys()].some((key) => form.getAll(key).length !== 1) ||
    fixed.some((key) => !form.has(key)) || slots.some((index) => !form.has(`memberActorId${index}`) || !form.has(`memberRole${index}`))) {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  const name = form.get('name')!;
  const projectSlug = form.get('slug')!;
  const owner = form.get('productOwnerActorId')!;
  const idempotencyKey = form.get('idempotencyKey')!;
  const modes = ['repositoryBinding', 'trackerBinding', 'internalChat', 'clientChat'] as const;
  const executionMode = form.get('executionMode');
  const profile = form.get('agentProfileId')!;
  const members = slots.flatMap((index) => {
    const actorId = form.get(`memberActorId${index}`)!;
    const role = form.get(`memberRole${index}`)!;
    return actorId === '' ? [] : [{actorId, role}];
  });
  const invalid = !uuid.test(idempotencyKey) || !uuid.test(owner) || name.trim() !== name || name.length < 1 ||
    name.length > 120 || /[\u0000-\u001f\u007f]/.test(name) || containsHighConfidenceSecretContent(name) || !slug.test(projectSlug) || reserved.has(projectSlug) ||
    modes.some((key) => !projectSetupBindingModes.includes(form.get(key) as never)) ||
    !['manual', 'managed_agent'].includes(executionMode ?? '') ||
    (executionMode === 'manual' ? profile !== '' : !uuid.test(profile)) || members.length > 8 ||
    members.some((member) => !uuid.test(member.actorId) || !projectMembershipRoles.includes(member.role as never) ||
      ['workspace_owner', 'project_owner'].includes(member.role)) ||
    new Set(members.map(({actorId}) => actorId)).size !== members.length || members.some(({actorId}) => actorId === owner) ||
    (owner !== authorization.session.actorId && !members.some(({actorId}) => actorId === authorization.session.actorId));
  if (invalid) return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  let opened: Awaited<ReturnType<typeof getProjectIntakeRuntime>> | null = null;
  try {
    opened = await overrides.getRuntime();
    const result = await opened.runtime.create({
      workspaceId: authorization.runtime.config.workspaceId, operatorActorId: authorization.session.actorId,
      idempotencyKey, name, slug: projectSlug, productOwnerActorId: owner,
      members: members as readonly {actorId: string; role: ProjectMembershipRole}[],
      repositoryBinding: form.get('repositoryBinding') as never, trackerBinding: form.get('trackerBinding') as never,
      internalChat: form.get('internalChat') as never, clientChat: form.get('clientChat') as never,
      executionMode: executionMode as never, agentProfileId: profile === '' ? null : profile
    });
    if (result.status === 'created' || result.status === 'replayed') return new Response(null, {status: 303,
      headers: {...noStore, location: new URL(`/projects/${projectSlug}/setup`, request.url).toString()}});
    return Response.json({status: result.status}, {status: result.status === 'forbidden' ? 403 : result.status === 'conflict' ? 409 : 400, headers: noStore});
  } catch {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  } finally {
    await opened?.close().catch(() => undefined);
  }
}
