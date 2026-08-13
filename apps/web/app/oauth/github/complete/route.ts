import {completeGithubLogin} from '../../../../src/mvp/oauth.ts';
import {jsonError} from '../../../../src/mvp/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = async (request: Request): Promise<Response> =>
  completeGithubLogin(new URL(request.url)).catch(jsonError);
