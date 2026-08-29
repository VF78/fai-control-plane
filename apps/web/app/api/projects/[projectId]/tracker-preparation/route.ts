import {projectTrackerPreparation} from '../../../../../src/mvp/api.ts';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=(request:Request,{params}:{params:Promise<{projectId:string}>})=>params.then(({projectId})=>
  projectTrackerPreparation(request,projectId));
export const POST=GET;
