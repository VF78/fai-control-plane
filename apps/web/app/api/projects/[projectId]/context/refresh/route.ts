import {refreshContext} from '../../../../../../src/mvp/api.ts';

export const POST = async (request: Request, context: {params: Promise<{projectId: string}>}): Promise<Response> =>
  refreshContext(request, (await context.params).projectId);
