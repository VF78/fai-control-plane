import {NextResponse} from 'next/server';
import {OPERATOR_SESSION_COOKIE} from '../../../../src/operator-auth';
import {
  getOperatorAuthRuntime,
  readBoundedFormCsrfToken,
  requireOperatorSession
} from '../../../../src/operator-auth-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const csrfToken = await readBoundedFormCsrfToken(request);
    const authorization = await requireOperatorSession(request, {csrfToken});
    if (!authorization.ok) return authorization.response;
    await authorization.runtime.service.revoke(authorization.sessionToken);
    const response = NextResponse.redirect(
      new URL('/', authorization.runtime.config.publicBaseUrl),
      {status: 303}
    );
    response.headers.set('Cache-Control', 'no-store');
    response.cookies.set(OPERATOR_SESSION_COOKIE, '', {
      httpOnly: true,
      secure: authorization.runtime.config.secureCookies,
      sameSite: 'lax',
      path: '/',
      expires: new Date(0)
    });
    return response;
  } catch {
    console.error('Operator logout could not be completed.');
    const runtimeState = await getOperatorAuthRuntime().catch(() => null);
    return Response.json(
      {status: runtimeState === null ? 'not_found' : 'unavailable'},
      {status: runtimeState === null ? 404 : 503, headers: {'Cache-Control': 'no-store'}}
    );
  }
}
