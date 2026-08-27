import {source} from '../../../../../src/mvp/api.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = async (request: Request, context: {params: Promise<{projectId: string}>}): Promise<Response> =>
  source(request, (await context.params).projectId);
export const GET = POST;
