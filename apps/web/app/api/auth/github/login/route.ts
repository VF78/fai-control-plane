import {NextResponse} from 'next/server';
import {
  OAUTH_TRANSIENT_COOKIE,
  cookieOptions
} from '../../../../../src/operator-auth';
import {getOperatorAuthRuntime} from '../../../../../src/operator-auth-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  try {
    const runtimeState = await getOperatorAuthRuntime();
    if (runtimeState === null) {
      return new Response(null, {status: 404, headers: {'Cache-Control': 'no-store'}});
    }
    const login = await runtimeState.service.beginLogin();
    const response = NextResponse.redirect(login.authorizeUrl, {status: 303});
    response.headers.set('Cache-Control', 'no-store');
    response.cookies.set(
      OAUTH_TRANSIENT_COOKIE,
      login.transientCookie,
      cookieOptions(runtimeState.config, login.expiresAt)
    );
    return response;
  } catch {
    console.error('Operator login could not be started.');
    return Response.json(
      {status: 'unavailable'},
      {status: 503, headers: {'Cache-Control': 'no-store'}}
    );
  }
}
