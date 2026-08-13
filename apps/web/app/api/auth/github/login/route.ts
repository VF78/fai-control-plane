import {beginGithubLogin} from '../../../../../src/mvp/oauth.ts';
import {jsonError} from '../../../../../src/mvp/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = async (): Promise<Response> => beginGithubLogin().catch(jsonError);
