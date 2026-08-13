import {createHash} from 'node:crypto';
import {
  beginOauthAttempt,
  consumeOauthAttempt,
  createSession,
  findActorByExternalIdentity,
  revokeSession
} from '@fai-control-plane/db';
import {
  getDatabase,
  hash,
  identityHash,
  oauthCookie,
  randomToken,
  readSecretFile,
  sessionCookie
  , requireCsrf
} from './runtime.ts';

const configuredOrigin = (): URL => {
  const value = process.env.AUTH_PUBLIC_BASE_URL;
  if (value === undefined) throw new Error('oauth_configuration_invalid');
  const url = new URL(value);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' ||
    (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.hostname === 'localhost'))) {
    throw new Error('oauth_configuration_invalid');
  }
  return url;
};
const secure = (): string => configuredOrigin().protocol === 'https:' ? '; Secure' : '';

export const beginGithubLogin = async (): Promise<Response> => {
  const database = getDatabase();
  const workspaceId = process.env.FCP_WORKSPACE_ID;
  const clientId = process.env.GITHUB_LOGIN_CLIENT_ID;
  if (workspaceId === undefined || clientId === undefined) throw new Error('oauth_configuration_invalid');
  const state = randomToken();
  const verifier = randomToken();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await beginOauthAttempt(database, workspaceId, hash(state), hash(verifier),
    new Date(Date.now() + 10 * 60_000).toISOString());
  const callback = new URL('/oauth/github/complete', configuredOrigin()).toString();
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', callback);
  authorize.searchParams.set('scope', 'read:user');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  const response = Response.redirect(authorize);
  response.headers.append('set-cookie', `${oauthCookie}=${state}.${verifier}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure()}`);
  return response;
};

export const completeGithubLogin = async (url: URL): Promise<Response> => {
  const database = getDatabase();
  const {cookies} = await import('next/headers');
  const cookie = (await cookies()).get(oauthCookie)?.value;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const [cookieState, verifier] = cookie?.split('.') ?? [];
  if (code === null || state === null || cookieState !== state || verifier === undefined) {
    throw new Error('oauth_callback_invalid');
  }
  const workspaceId = await consumeOauthAttempt(database, hash(state), hash(verifier));
  if (workspaceId === null) throw new Error('oauth_callback_invalid');
  const clientId = process.env.GITHUB_LOGIN_CLIENT_ID;
  const secretPath = process.env.GITHUB_LOGIN_CLIENT_SECRET_FILE;
  if (clientId === undefined || secretPath === undefined) throw new Error('oauth_configuration_invalid');
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: {accept: 'application/json', 'content-type': 'application/json'},
    body: JSON.stringify({client_id: clientId, client_secret: await readSecretFile(secretPath), code,
      code_verifier: verifier}), signal: AbortSignal.timeout(10_000)
  });
  const tokenBody = tokenResponse.ok ? await tokenResponse.json() as Record<string, unknown> : null;
  if (typeof tokenBody?.access_token !== 'string') throw new Error('oauth_provider_failed');
  const profileResponse = await fetch('https://api.github.com/user', {
    headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${tokenBody.access_token}`,
      'user-agent': 'fai-control-plane-mvp/0.1'}, signal: AbortSignal.timeout(10_000)
  });
  const profile = profileResponse.ok ? await profileResponse.json() as Record<string, unknown> : null;
  if (!Number.isSafeInteger(profile?.id)) throw new Error('oauth_profile_invalid');
  const actor = await findActorByExternalIdentity(database, 'github', identityHash(String(profile!.id)));
  if (actor === null || !actor.enabled || actor.workspaceId !== workspaceId) throw new Error('oauth_actor_denied');
  const token = randomToken();
  await createSession(database, actor.id, hash(token), new Date(Date.now() + 8 * 60 * 60_000).toISOString());
  const response = Response.redirect(new URL('/', configuredOrigin()));
  response.headers.append('set-cookie', `${sessionCookie}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure()}`);
  response.headers.append('set-cookie', `${oauthCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure()}`);
  return response;
};

export const logout = async (request: Request): Promise<Response> => {
  requireCsrf(request);
  const database = getDatabase();
  const {cookies} = await import('next/headers');
  const token = (await cookies()).get(sessionCookie)?.value;
  if (token !== undefined) await revokeSession(database, hash(token));
  const response = Response.json({ok: true});
  response.headers.append('set-cookie', `${sessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure()}`);
  return response;
};
