import {and, eq, gt, isNull} from 'drizzle-orm';
import {
  actors,
  createDatabase,
  oauthLoginAttempts,
  operatorSessions
} from '@fai-control-plane/db';
import {
  OPERATOR_SESSION_COOKIE,
  createOperatorAuthService,
  loadOperatorAuthConfig,
  validMutationRequest,
  type EnabledAuthConfig,
  type OperatorAuthService,
  type OperatorAuthStore,
  type OperatorSession
} from './operator-auth';

type Database = ReturnType<typeof createDatabase>['db'];
type Runtime = Readonly<{
  config: EnabledAuthConfig;
  service: OperatorAuthService;
}>;

let runtimePromise: Promise<Runtime | null> | undefined;

const createStore = (db: Database): OperatorAuthStore => ({
  async createLoginAttempt(stateHash, createdAt, expiresAt) {
    await db.insert(oauthLoginAttempts).values({stateHash, createdAt, expiresAt});
  },

  async consumeLoginAttempt(stateHash, consumedAt) {
    const consumed = await db.update(oauthLoginAttempts)
      .set({consumedAt})
      .where(and(
        eq(oauthLoginAttempts.stateHash, stateHash),
        isNull(oauthLoginAttempts.consumedAt),
        gt(oauthLoginAttempts.expiresAt, consumedAt)
      ))
      .returning({stateHash: oauthLoginAttempts.stateHash});
    return consumed.length === 1;
  },

  async findBoundOperator(workspaceId, githubUserId) {
    const [actor] = await db.select({
      actorId: actors.id,
      displayName: actors.displayName
    }).from(actors).where(and(
      eq(actors.workspaceId, workspaceId),
      eq(actors.type, 'human'),
      eq(actors.authMode, 'user'),
      eq(actors.externalSubject, `github:user:${githubUserId}`),
      isNull(actors.disabledAt)
    )).limit(1);
    return actor === undefined ? null : {...actor, githubUserId};
  },

  async createSession(input) {
    await db.insert(operatorSessions).values({
      ...input,
      lastSeenAt: input.createdAt
    });
  },

  async findActiveSession(tokenHash, workspaceId, now) {
    const [activeSession] = await db.update(operatorSessions)
      .set({lastSeenAt: now})
      .where(and(
        eq(operatorSessions.tokenHash, tokenHash),
        gt(operatorSessions.expiresAt, now),
        isNull(operatorSessions.revokedAt)
      )).returning({
        actorId: operatorSessions.actorId,
        githubUserId: operatorSessions.githubUserId,
        expiresAt: operatorSessions.expiresAt
      });
    if (activeSession === undefined) return null;
    const [actor] = await db.select({
      displayName: actors.displayName,
      externalSubject: actors.externalSubject
    }).from(actors).where(and(
      eq(actors.id, activeSession.actorId),
      eq(actors.workspaceId, workspaceId),
      eq(actors.type, 'human'),
      eq(actors.authMode, 'user'),
      isNull(actors.disabledAt)
    )).limit(1);
    if (
      actor === undefined ||
      actor.externalSubject !== `github:user:${activeSession.githubUserId}`
    ) {
      return null;
    }
    return {
      actorId: activeSession.actorId,
      displayName: actor.displayName,
      githubUserId: activeSession.githubUserId,
      expiresAt: activeSession.expiresAt
    };
  },

  async revokeSession(tokenHash, revokedAt) {
    await db.update(operatorSessions).set({revokedAt}).where(and(
      eq(operatorSessions.tokenHash, tokenHash),
      isNull(operatorSessions.revokedAt)
    ));
  }
});

export const getOperatorAuthRuntime = async (): Promise<Runtime | null> => {
  runtimePromise ??= (async () => {
    const config = await loadOperatorAuthConfig();
    if (!config.enabled) return null;
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required when AUTH_ENABLED=true');
    }
    const {db} = createDatabase(databaseUrl);
    return {config, service: createOperatorAuthService(config, createStore(db))};
  })();
  return runtimePromise;
};

export const singleCookieFromRequest = (
  request: Request,
  name: string
): string | undefined => {
  const header = request.headers.get('cookie');
  if (header === null || header.length > 8192) return undefined;
  const values = header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) return [];
    return [part.slice(separator + 1)];
  });
  return values.length === 1 ? values[0] : undefined;
};

export async function currentOperatorSession(
  sessionToken: string | undefined
): Promise<Readonly<{enabled: boolean; session: OperatorSession | null}>> {
  const runtime = await getOperatorAuthRuntime();
  if (runtime === null) return {enabled: false, session: null};
  return {enabled: true, session: await runtime.service.authenticate(sessionToken)};
}

export async function requireOperatorSession(
  request: Request,
  options: Readonly<{csrfToken?: string | null}> = {}
): Promise<
  | Readonly<{ok: true; session: OperatorSession; runtime: Runtime; sessionToken: string}>
  | Readonly<{ok: false; response: Response}>
> {
  const runtime = await getOperatorAuthRuntime();
  if (runtime === null) {
    return {ok: false, response: new Response(null, {status: 404, headers: {'Cache-Control': 'no-store'}})};
  }
  const sessionToken = singleCookieFromRequest(request, OPERATOR_SESSION_COOKIE);
  const session = await runtime.service.authenticate(sessionToken);
  if (session === null || sessionToken === undefined) {
    return {ok: false, response: new Response(null, {status: 401, headers: {'Cache-Control': 'no-store'}})};
  }
  if (
    options.csrfToken !== undefined &&
    !validMutationRequest(runtime.config, request, session.csrfToken, options.csrfToken)
  ) {
    return {ok: false, response: new Response(null, {status: 403, headers: {'Cache-Control': 'no-store'}})};
  }
  return {ok: true, session, runtime, sessionToken};
}

export async function readBoundedFormCsrfToken(request: Request): Promise<string | null> {
  const contentType = request.headers.get('content-type') ?? '';
  const contentLength = request.headers.get('content-length');
  if (
    !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded') ||
    (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > 2048)) ||
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
      if (length > 2048) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const tokens = body.getAll('_csrf');
  return tokens.length === 1 && tokens[0]!.length <= 128 ? tokens[0]! : null;
}
