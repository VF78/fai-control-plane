import {createHash, randomBytes} from 'node:crypto';
import {cookies} from 'next/headers';
import {
  actorForSession,
  createDatabase,
  subjectHash,
  type Database
} from '@fai-control-plane/db';
import type {OpaqueSecretRef, SecretResolverPort} from '@fai-control-plane/domain';

let databaseInstance: Database | null = null;
export const getDatabase = (): Database => {
  databaseInstance ??= createDatabase();
  return databaseInstance;
};
export const sessionCookie = 'fai_session';
export const oauthCookie = 'fai_oauth';

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const randomToken = (): string => randomBytes(32).toString('base64url');

export const readSecretFile = async (path: string): Promise<string> => {
  if (!path.startsWith('/')) throw new Error('secret_path_must_be_absolute');
  const {readFile} = await import('node:fs/promises');
  const value = (await readFile(path, 'utf8')).trim();
  if (value.length === 0 || value.length > 65_536 || value.includes('\0')) throw new Error('secret_invalid');
  return value;
};

export const secretResolver: SecretResolverPort = {async resolve(reference: OpaqueSecretRef, expectedPurpose) {
  if (reference.purpose !== expectedPurpose) throw new Error('secret_purpose_denied');
  return {value: await readSecretFile(reference.locator)};
}};

export const requireSession = async (): Promise<Readonly<{actorId: string; workspaceId: string}>> => {
  const token = (await cookies()).get(sessionCookie)?.value;
  if (token === undefined) throw new Error('authentication_required');
  const session = await actorForSession(getDatabase(), hash(token));
  if (session === null) throw new Error('authentication_required');
  return session;
};

export const requireCsrf = (request: Request): void => {
  const configured = process.env.AUTH_PUBLIC_BASE_URL;
  const origin = request.headers.get('origin');
  if (configured === undefined || origin === null || new URL(configured).origin !== origin) {
    throw new Error('csrf_denied');
  }
};

export const identityHash = (githubUserId: string): string => subjectHash('github', githubUserId);

export const jsonError = (error: unknown): Response => {
  const code = error instanceof Error ? error.message : 'request_failed';
  const status = code === 'authentication_required' ? 401 : code.endsWith('_denied') ? 403 : 400;
  return Response.json({error: code}, {status});
};
