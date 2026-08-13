import {approval} from '../../../../src/mvp/api.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = async (request: Request, context: {params: Promise<{id: string}>}): Promise<Response> =>
  approval(request, (await context.params).id);
