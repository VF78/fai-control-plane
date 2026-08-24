import {hermesRouting} from '../../../../../src/mvp/api.ts';

export const dynamic = 'force-dynamic';
export const GET = async (request: Request, context: {params: Promise<{projectId: string}>}) =>
  hermesRouting(request, (await context.params).projectId);
export const POST = async (request: Request, context: {params: Promise<{projectId: string}>}) =>
  hermesRouting(request, (await context.params).projectId);
