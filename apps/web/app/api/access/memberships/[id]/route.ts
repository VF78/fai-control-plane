import {membership} from '../../../../../src/mvp/api.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = async (request: Request, context: {params: Promise<{id: string}>}): Promise<Response> =>
  membership(request, (await context.params).id);
