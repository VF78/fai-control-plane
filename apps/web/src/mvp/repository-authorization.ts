import {timingSafeEqual} from 'node:crypto';

export type RepositoryAuthorization = Readonly<{
  projectId: string; receiptReference: string; repository: Readonly<{id: string; url: string}>;
  issueNumber: number; base: Readonly<{ref: string; sha: string}>;
}>;

const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const parse = async (request: Request): Promise<RepositoryAuthorization | null> => {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return null;
  const text = await request.text(); if (text.length === 0 || text.length > 8_192) return null;
  let value: unknown; try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as RepositoryAuthorization;
  return typeof input.projectId === 'string' && typeof input.receiptReference === 'string' &&
    typeof input.repository?.id === 'string' && typeof input.repository.url === 'string' &&
    Number.isSafeInteger(input.issueNumber) && typeof input.base?.ref === 'string' &&
    typeof input.base.sha === 'string' ? input : null;
};

export const createRepositoryAuthorizationHandler = (dependencies: Readonly<{
  token(): Promise<string>;
  authorize(input: RepositoryAuthorization): Promise<RepositoryAuthorization | null>;
}>) => async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return new Response(null, {status: 405, headers: {allow: 'POST'}});
  const authorization = request.headers.get('authorization');
  const expected = await dependencies.token();
  if (authorization === null || !authorization.startsWith('Bearer ') ||
    !equal(authorization.slice(7), expected)) return Response.json({error: 'authentication_denied'}, {status: 401});
  const input = await parse(request); if (input === null) return Response.json({error: 'body_invalid'}, {status: 400});
  const result = await dependencies.authorize(input);
  return result === null ? Response.json({error: 'authorization_denied'}, {status: 403})
    : Response.json(result, {status: 200, headers: {'cache-control': 'no-store'}});
};
