import {projectDocumentDelete,projectDocumentDownload} from '../../../../../../src/mvp/api.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = async (_request:Request,context:{params:Promise<{projectId:string;documentId:string}>}):Promise<Response> => {
  const {projectId,documentId}=await context.params; return projectDocumentDownload(projectId,documentId);
};
export const DELETE = async (request:Request,context:{params:Promise<{projectId:string;documentId:string}>}):Promise<Response> => {
  const {projectId,documentId}=await context.params;return projectDocumentDelete(request,projectId,documentId);
};
