import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {readFile, stat} from 'node:fs/promises';

export const OPERATOR_SESSION_COOKIE = 'fai_operator_session';
export const OAUTH_TRANSIENT_COOKIE = 'fai_oauth_transient';
export const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
export const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const CALLBACK_PATH = '/oauth/github/complete';
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const MAX_SECRET_BYTES = 4096;
const MAX_UPSTREAM_BYTES = 32 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DisabledAuthConfig = Readonly<{enabled: false}>;

export type EnabledAuthConfig = Readonly<{
  enabled: true;
  workspaceId: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: Buffer;
  publicBaseUrl: URL;
  callbackUrl: string;
  allowedUserIds: ReadonlySet<number>;
  secureCookies: boolean;
}>;

export type OperatorAuthConfig = DisabledAuthConfig | EnabledAuthConfig;

export type OperatorSession = Readonly<{
  actorId: string;
  displayName: string;
  githubUserId: number;
  expiresAt: Date;
  csrfToken: string;
}>;

export type BoundOperator = Readonly<{
  actorId: string;
  displayName: string;
  githubUserId: number;
}>;

export type OperatorAuthStore = Readonly<{
  createLoginAttempt(stateHash: string, createdAt: Date, expiresAt: Date): Promise<void>;
  consumeLoginAttempt(stateHash: string, consumedAt: Date): Promise<boolean>;
  findBoundOperator(workspaceId: string, githubUserId: number): Promise<BoundOperator | null>;
  createSession(input: Readonly<{
    tokenHash: string;
    actorId: string;
    githubUserId: number;
    createdAt: Date;
    expiresAt: Date;
  }>): Promise<void>;
  findActiveSession(
    tokenHash: string,
    workspaceId: string,
    now: Date
  ): Promise<Omit<OperatorSession, 'csrfToken'> | null>;
  revokeSession(tokenHash: string, revokedAt: Date): Promise<void>;
}>;

export class OperatorAuthError extends Error {
  constructor(readonly code: 'invalid_request' | 'access_denied' | 'upstream_unavailable') {
    super(code);
    this.name = 'OperatorAuthError';
  }
}

const requiredValue = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (value === undefined || value.length === 0 || value !== value.trim()) {
    throw new Error(`${name} must be configured exactly when AUTH_ENABLED=true`);
  }
  return value;
};

const readSecret = async (
  env: NodeJS.ProcessEnv,
  name: string,
  minimumBytes: number
): Promise<Buffer> => {
  const reference = requiredValue(env, name);
  if (!isAbsolute(reference)) throw new Error(`${name} must be an absolute mounted file path`);
  const metadata = await stat(reference);
  if (!metadata.isFile() || metadata.size < minimumBytes || metadata.size > MAX_SECRET_BYTES) {
    throw new Error(`${name} does not reference a bounded secret file`);
  }
  const raw = await readFile(reference);
  const withoutFinalNewline = raw.toString('utf8').replace(/\r?\n$/, '');
  const secret = Buffer.from(withoutFinalNewline, 'utf8');
  if (
    secret.byteLength < minimumBytes ||
    secret.byteLength > MAX_SECRET_BYTES ||
    /[\r\n\0]/.test(withoutFinalNewline)
  ) {
    throw new Error(`${name} contains an unsafe secret value`);
  }
  return secret;
};

const parseAllowedUserIds = (value: string): ReadonlySet<number> => {
  const entries = value.split(',');
  if (entries.length !== 2) {
    throw new Error('FCP_OPERATOR_GITHUB_USER_IDS must contain exactly two numeric IDs');
  }
  const ids = entries.map((entry) => {
    if (!/^[1-9][0-9]{0,15}$/.test(entry)) {
      throw new Error('FCP_OPERATOR_GITHUB_USER_IDS must use canonical positive decimal IDs');
    }
    const id = Number(entry);
    if (!Number.isSafeInteger(id)) {
      throw new Error('FCP_OPERATOR_GITHUB_USER_IDS contains an unsafe numeric ID');
    }
    return id;
  });
  if (new Set(ids).size !== 2) {
    throw new Error('FCP_OPERATOR_GITHUB_USER_IDS must not contain duplicates');
  }
  return new Set(ids);
};

const parsePublicBaseUrl = (value: string, production: boolean): URL => {
  const url = new URL(value);
  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost && !production))
  ) {
    throw new Error('AUTH_PUBLIC_BASE_URL must be an HTTPS origin (HTTP localhost outside production only)');
  }
  return url;
};

export async function loadOperatorAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<OperatorAuthConfig> {
  const enabledValue = env.AUTH_ENABLED ?? 'false';
  if (enabledValue !== 'true' && enabledValue !== 'false') {
    throw new Error('AUTH_ENABLED must be exactly true or false');
  }
  if (enabledValue === 'false') return {enabled: false};

  const production = env.NODE_ENV === 'production';
  const publicBaseUrl = parsePublicBaseUrl(requiredValue(env, 'AUTH_PUBLIC_BASE_URL'), production);
  const callbackUrl = requiredValue(env, 'GITHUB_LOGIN_CALLBACK_URL');
  const expectedCallbackUrl = new URL(CALLBACK_PATH, publicBaseUrl).toString();
  if (callbackUrl !== expectedCallbackUrl) {
    throw new Error('GITHUB_LOGIN_CALLBACK_URL must exactly match the configured public callback');
  }
  const workspaceId = requiredValue(env, 'FCP_WORKSPACE_ID');
  if (!UUID_PATTERN.test(workspaceId)) throw new Error('FCP_WORKSPACE_ID must be a canonical UUID');
  const clientId = requiredValue(env, 'GITHUB_LOGIN_CLIENT_ID');
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(clientId)) {
    throw new Error('GITHUB_LOGIN_CLIENT_ID has an unsafe format');
  }

  const clientSecret = (await readSecret(env, 'GITHUB_LOGIN_CLIENT_SECRET_FILE', 16)).toString('utf8');
  const sessionSecret = await readSecret(env, 'AUTH_SESSION_SECRET_FILE', 32);
  return Object.freeze({
    enabled: true,
    workspaceId,
    clientId,
    clientSecret,
    sessionSecret,
    publicBaseUrl,
    callbackUrl,
    allowedUserIds: parseAllowedUserIds(requiredValue(env, 'FCP_OPERATOR_GITHUB_USER_IDS')),
    secureCookies: publicBaseUrl.protocol === 'https:'
  });
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const sha256Base64Url = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');
const randomToken = (): string => randomBytes(32).toString('base64url');
const sameValue = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
};

const encryptionKey = (secret: Buffer): Buffer =>
  createHash('sha256').update('fai-oauth-transient-v1\0').update(secret).digest();

const sealTransient = (
  config: EnabledAuthConfig,
  state: string,
  verifier: string,
  createdAt: Date,
  expiresAt: Date
): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(config.sessionSecret), iv);
  const plaintext = Buffer.from(JSON.stringify({
    version: 1,
    state,
    verifier,
    createdAt: createdAt.getTime(),
    expiresAt: expiresAt.getTime()
  }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
};

const openTransient = (
  config: EnabledAuthConfig,
  value: string,
  now: Date
): Readonly<{state: string; verifier: string}> => {
  if (value.length < 80 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new OperatorAuthError('invalid_request');
  }
  try {
    const sealed = Buffer.from(value, 'base64url');
    if (sealed.byteLength < 29) throw new Error('invalid sealed value');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(config.sessionSecret),
      sealed.subarray(0, 12)
    );
    decipher.setAuthTag(sealed.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    if (plaintext.byteLength > 512) throw new Error('oversized transient value');
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('state' in parsed) ||
      typeof parsed.state !== 'string' ||
      !TOKEN_PATTERN.test(parsed.state) ||
      !('verifier' in parsed) ||
      typeof parsed.verifier !== 'string' ||
      !TOKEN_PATTERN.test(parsed.verifier) ||
      !('createdAt' in parsed) ||
      typeof parsed.createdAt !== 'number' ||
      !('expiresAt' in parsed) ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt - parsed.createdAt !== OAUTH_ATTEMPT_TTL_MS ||
      now.getTime() < parsed.createdAt - 30_000 ||
      now.getTime() >= parsed.expiresAt
    ) {
      throw new Error('invalid transient payload');
    }
    return {state: parsed.state, verifier: parsed.verifier};
  } catch {
    throw new OperatorAuthError('invalid_request');
  }
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get('content-type') ?? '';
  const declaredLength = response.headers.get('content-length');
  if (
    !contentType.toLowerCase().startsWith('application/json') ||
    (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_UPSTREAM_BYTES)) ||
    response.body === null
  ) {
    throw new OperatorAuthError('upstream_unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_UPSTREAM_BYTES) throw new OperatorAuthError('upstream_unavailable');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new OperatorAuthError('upstream_unavailable');
  }
};

const exchangeCode = async (
  config: EnabledAuthConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch
): Promise<string> => {
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'fai-control-plane'
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.callbackUrl,
        code_verifier: verifier
      }).toString()
    });
  } catch {
    throw new OperatorAuthError('upstream_unavailable');
  }
  if (!response.ok) throw new OperatorAuthError('upstream_unavailable');
  const payload = await readBoundedJson(response);
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('access_token' in payload) ||
    typeof payload.access_token !== 'string' ||
    payload.access_token.length < 16 ||
    payload.access_token.length > 1024 ||
    /[\s\0]/.test(payload.access_token) ||
    !('token_type' in payload) ||
    typeof payload.token_type !== 'string' ||
    payload.token_type.toLowerCase() !== 'bearer' ||
    !('scope' in payload) ||
    payload.scope !== ''
  ) {
    throw new OperatorAuthError('upstream_unavailable');
  }
  return payload.access_token;
};

const fetchGitHubUserId = async (accessToken: string, fetchImpl: typeof fetch): Promise<number> => {
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_USER_URL, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'fai-control-plane',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
  } catch {
    throw new OperatorAuthError('upstream_unavailable');
  }
  if (!response.ok) throw new OperatorAuthError('upstream_unavailable');
  const payload = await readBoundedJson(response);
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('id' in payload) ||
    typeof payload.id !== 'number' ||
    !Number.isSafeInteger(payload.id) ||
    payload.id <= 0
  ) {
    throw new OperatorAuthError('upstream_unavailable');
  }
  return payload.id;
};

const callbackParameters = (
  config: EnabledAuthConfig,
  callbackUrl: string
): Readonly<{code: string; state: string}> => {
  if (callbackUrl.length > 4096) throw new OperatorAuthError('invalid_request');
  const actual = new URL(callbackUrl);
  const expected = new URL(config.callbackUrl);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.hash !== '') {
    throw new OperatorAuthError('invalid_request');
  }
  const keys = [...actual.searchParams.keys()];
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes('code') ||
    !keys.includes('state')
  ) {
    throw new OperatorAuthError('invalid_request');
  }
  const code = actual.searchParams.get('code');
  const state = actual.searchParams.get('state');
  if (
    code === null ||
    code.length < 1 ||
    code.length > 512 ||
    /[\s\0]/.test(code) ||
    state === null ||
    !TOKEN_PATTERN.test(state)
  ) {
    throw new OperatorAuthError('invalid_request');
  }
  return {code, state};
};

export function createOperatorAuthService(
  config: EnabledAuthConfig,
  store: OperatorAuthStore,
  fetchImpl: typeof fetch = fetch
) {
  const beginLogin = async (now = new Date()) => {
    const state = randomToken();
    const verifier = randomToken();
    const expiresAt = new Date(now.getTime() + OAUTH_ATTEMPT_TTL_MS);
    await store.createLoginAttempt(sha256(state), now, expiresAt);
    const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      state,
      code_challenge: sha256Base64Url(verifier),
      code_challenge_method: 'S256',
      scope: ''
    }).toString();
    return {
      authorizeUrl: authorizeUrl.toString(),
      transientCookie: sealTransient(config, state, verifier, now, expiresAt),
      expiresAt
    };
  };

  const completeLogin = async (
    callbackUrl: string,
    transientCookie: string | undefined,
    now = new Date()
  ) => {
    const parameters = callbackParameters(config, callbackUrl);
    if (transientCookie === undefined) throw new OperatorAuthError('invalid_request');
    const transient = openTransient(config, transientCookie, now);
    if (!sameValue(parameters.state, transient.state)) throw new OperatorAuthError('invalid_request');
    const consumed = await store.consumeLoginAttempt(sha256(parameters.state), now);
    if (!consumed) throw new OperatorAuthError('invalid_request');

    let accessToken: string | undefined;
    try {
      accessToken = await exchangeCode(config, parameters.code, transient.verifier, fetchImpl);
      const githubUserId = await fetchGitHubUserId(accessToken, fetchImpl);
      accessToken = undefined;
      if (!config.allowedUserIds.has(githubUserId)) throw new OperatorAuthError('access_denied');
      const operator = await store.findBoundOperator(config.workspaceId, githubUserId);
      if (operator === null) throw new OperatorAuthError('access_denied');

      const sessionToken = randomToken();
      const expiresAt = new Date(now.getTime() + OPERATOR_SESSION_TTL_MS);
      await store.createSession({
        tokenHash: sha256(sessionToken),
        actorId: operator.actorId,
        githubUserId,
        createdAt: now,
        expiresAt
      });
      return {sessionToken, expiresAt, operator};
    } finally {
      accessToken = undefined;
    }
  };

  const authenticate = async (
    sessionToken: string | undefined,
    now = new Date()
  ): Promise<OperatorSession | null> => {
    if (sessionToken === undefined || !TOKEN_PATTERN.test(sessionToken)) return null;
    const session = await store.findActiveSession(sha256(sessionToken), config.workspaceId, now);
    if (session === null || !config.allowedUserIds.has(session.githubUserId)) return null;
    return {
      ...session,
      csrfToken: createHmac('sha256', config.sessionSecret)
        .update('fai-operator-csrf-v1\0')
        .update(sessionToken)
        .digest('base64url')
    };
  };

  const revoke = async (sessionToken: string | undefined, now = new Date()): Promise<void> => {
    if (sessionToken === undefined || !TOKEN_PATTERN.test(sessionToken)) return;
    await store.revokeSession(sha256(sessionToken), now);
  };

  return {beginLogin, completeLogin, authenticate, revoke};
}

export type OperatorAuthService = ReturnType<typeof createOperatorAuthService>;

export const validMutationRequest = (
  config: EnabledAuthConfig,
  request: Request,
  expectedCsrfToken: string,
  suppliedCsrfToken: string | null
): boolean => {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  return (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.method !== 'OPTIONS' &&
    origin === config.publicBaseUrl.origin &&
    (fetchSite === null || fetchSite === 'same-origin') &&
    suppliedCsrfToken !== null &&
    sameValue(expectedCsrfToken, suppliedCsrfToken)
  );
};

export const cookieOptions = (
  config: EnabledAuthConfig,
  expiresAt: Date
): Readonly<{
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  expires: Date;
}> => ({
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: 'lax',
  path: '/',
  expires: expiresAt
});
