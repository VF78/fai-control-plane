import {logout} from '../../../../src/mvp/oauth.ts';
import {jsonError} from '../../../../src/mvp/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = async (request: Request): Promise<Response> => logout(request).catch(jsonError);
