import {agentRouting} from '../../../../../src/mvp/api.ts';

export const GET = async (request: Request, context: {params: Promise<{projectId: string}>}): Promise<Response> =>
  agentRouting(request, (await context.params).projectId);
export const POST = async (request: Request, context: {params: Promise<{projectId: string}>}): Promise<Response> =>
  agentRouting(request, (await context.params).projectId);
