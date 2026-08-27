import {projectDocumentDownload} from '../../../../../../src/mvp/api.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = async (_request:Request,context:{params:Promise<{projectId:string;documentId:string}>}):Promise<Response> => {
  const {projectId,documentId}=await context.params; return projectDocumentDownload(projectId,documentId);
};
