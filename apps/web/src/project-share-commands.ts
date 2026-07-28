import {randomUUID} from 'node:crypto';
import {isOperatorProjectSlug} from './operator-data';
import {requireOperatorSession} from './operator-auth-runtime';
import {getProjectShareOperatorRuntime} from './project-share-runtime';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_WORK_ITEMS = 100;
const MAX_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const noStore = {'Cache-Control': 'no-store'} as const;

type OperatorRuntime = Awaited<ReturnType<typeof getProjectShareOperatorRuntime>>;
type RequireSession = typeof requireOperatorSession;

export type ProjectShareCommandDependencies = Readonly<{
  requireSession: RequireSession;
  getRuntime(): Promise<OperatorRuntime>;
  now(): Date;
  nextId(): string;
}>;

const defaultDependencies: ProjectShareCommandDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getProjectShareOperatorRuntime,
  now: () => new Date(),
  nextId: randomUUID
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key) => keys.includes(key));
};

const readBoundedJson = async (request: Request): Promise<unknown> => {
  const contentType = request.headers.get('content-type')?.toLowerCase();
  const contentLength = request.headers.get('content-length');
  if (
    contentType !== 'application/json' ||
    (contentLength !== null &&
      (!/^[0-9]+$/.test(contentLength) ||
        Number(contentLength) > MAX_BODY_BYTES)) ||
    request.body === null
  ) {
    return null;
  }
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
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
};

const suppliedCsrf = (value: unknown): string | null =>
  isRecord(value) &&
  typeof value._csrf === 'string' &&
  value._csrf.length > 0 &&
  value._csrf.length <= 128
    ? value._csrf
    : null;

const parseExpiry = (value: unknown, now: Date): Date | null => {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) {
    return null;
  }
  const expiresAt = new Date(value);
  return Number.isFinite(expiresAt.getTime()) &&
    expiresAt.toISOString() === value &&
    expiresAt.getTime() > now.getTime() &&
    expiresAt.getTime() <= now.getTime() + MAX_SHARE_TTL_MS
    ? expiresAt
    : null;
};

const parseCreateInput = (value: unknown, now: Date) => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['_csrf', 'projectSlug', 'workItemIds', 'expiresAt']) ||
    suppliedCsrf(value) === null ||
    typeof value.projectSlug !== 'string' ||
    !isOperatorProjectSlug(value.projectSlug) ||
    !Array.isArray(value.workItemIds) ||
    value.workItemIds.length < 1 ||
    value.workItemIds.length > MAX_WORK_ITEMS ||
    !value.workItemIds.every(
      (id): id is string => typeof id === 'string' && UUID_PATTERN.test(id)
    ) ||
    new Set(value.workItemIds).size !== value.workItemIds.length
  ) {
    return null;
  }
  const expiresAt = parseExpiry(value.expiresAt, now);
  return expiresAt === null
    ? null
    : {
        csrfToken: value._csrf as string,
        projectSlug: value.projectSlug,
        workItemIds: value.workItemIds,
        expiresAt
      };
};

const parseRevokeInput = (value: unknown) =>
  isRecord(value) &&
  exactKeys(value, ['_csrf']) &&
  suppliedCsrf(value) !== null
    ? {csrfToken: value._csrf as string}
    : null;

const unavailable = (status = 503): Response =>
  Response.json({status: 'unavailable'}, {status, headers: noStore});

export async function createProjectShareCommand(
  request: Request,
  dependencies: ProjectShareCommandDependencies = defaultDependencies
): Promise<Response> {
  const body = await readBoundedJson(request);
  const authorization = await dependencies.requireSession(request, {
    csrfToken: suppliedCsrf(body)
  });
  if (!authorization.ok) return authorization.response;
  if (process.env.PUBLIC_SHARING_ENABLED !== 'true') return unavailable(404);

  const now = dependencies.now();
  const input = parseCreateInput(body, now);
  if (input === null) return unavailable(400);

  try {
    const runtime = await dependencies.getRuntime();
    const workspaceId = authorization.runtime.config.workspaceId;
    const projectId = await runtime.findProjectId(
      workspaceId,
      input.projectSlug
    );
    if (projectId === null) return unavailable(400);
    const issued = await runtime.service.create({
      workspaceId,
      projectId,
      createdByActorId: authorization.session.actorId,
      workItemIds: input.workItemIds,
      expiresAt: input.expiresAt,
      commandId: dependencies.nextId(),
      correlationId: dependencies.nextId()
    });
    const shareUrl = new URL(
      `/share/${encodeURIComponent(issued.token)}`,
      authorization.runtime.config.publicBaseUrl
    ).toString();
    return Response.json(
      {shareUrl, expiresAt: issued.expiresAt.toISOString()},
      {status: 201, headers: noStore}
    );
  } catch (error) {
    return error instanceof Error &&
      error.message === 'project_share_scope_invalid'
      ? unavailable(400)
      : unavailable();
  }
}

export async function revokeProjectShareCommand(
  request: Request,
  shareId: string,
  dependencies: ProjectShareCommandDependencies = defaultDependencies
): Promise<Response> {
  const body = await readBoundedJson(request);
  const authorization = await dependencies.requireSession(request, {
    csrfToken: suppliedCsrf(body)
  });
  if (!authorization.ok) return authorization.response;
  if (process.env.PUBLIC_SHARING_ENABLED !== 'true') return unavailable(404);

  const input = parseRevokeInput(body);
  if (input === null) return unavailable(400);
  if (!UUID_PATTERN.test(shareId)) {
    return new Response(null, {status: 204, headers: noStore});
  }
  try {
    const runtime = await dependencies.getRuntime();
    await runtime.service.revoke({
      workspaceId: authorization.runtime.config.workspaceId,
      shareId,
      revokedByActorId: authorization.session.actorId,
      commandId: dependencies.nextId(),
      correlationId: dependencies.nextId()
    });
    return new Response(null, {status: 204, headers: noStore});
  } catch {
    return unavailable();
  }
}
