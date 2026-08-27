import {projectDocuments} from '../../../../../src/mvp/api.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = async (request:Request,context:{params:Promise<{projectId:string}>}):Promise<Response> =>
  projectDocuments(request,(await context.params).projectId);
export const POST = GET;
