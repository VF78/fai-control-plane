import {NextResponse} from 'next/server';
import {
  OAUTH_TRANSIENT_COOKIE,
  OPERATOR_SESSION_COOKIE,
  OperatorAuthError,
  cookieOptions
} from '../../../../../src/operator-auth';
import {
  getOperatorAuthRuntime,
  singleCookieFromRequest
} from '../../../../../src/operator-auth-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const failedResponse = (status: number): NextResponse => NextResponse.json(
  {status: 'authentication_failed'},
  {status, headers: {'Cache-Control': 'no-store'}}
);

export async function GET(request: Request): Promise<Response> {
  let response: NextResponse;
  try {
    const runtimeState = await getOperatorAuthRuntime();
    if (runtimeState === null) {
      response = failedResponse(404);
    } else {
      const authenticated = await runtimeState.service.completeLogin(
        request.url,
        singleCookieFromRequest(request, OAUTH_TRANSIENT_COOKIE)
      );
      response = NextResponse.redirect(new URL('/', runtimeState.config.publicBaseUrl), {status: 303});
      response.headers.set('Cache-Control', 'no-store');
      response.cookies.set(
        OPERATOR_SESSION_COOKIE,
        authenticated.sessionToken,
        cookieOptions(runtimeState.config, authenticated.expiresAt)
      );
    }
  } catch (error) {
    const status = error instanceof OperatorAuthError
      ? error.code === 'access_denied' ? 403 : error.code === 'invalid_request' ? 400 : 502
      : 503;
    console.error('Operator login callback could not be completed.');
    response = failedResponse(status);
  }
  response.cookies.set(OAUTH_TRANSIENT_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || new URL(request.url).protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    expires: new Date(0)
  });
  return response;
}
