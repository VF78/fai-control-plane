import {projectExecutionMode} from '../../../../../src/mvp/api.ts';

type Context = Readonly<{params: Promise<{projectId: string}>}>;
export const GET = async (request: Request, context: Context) =>
  projectExecutionMode(request, (await context.params).projectId);
export const POST = async (request: Request, context: Context) =>
  projectExecutionMode(request, (await context.params).projectId);
