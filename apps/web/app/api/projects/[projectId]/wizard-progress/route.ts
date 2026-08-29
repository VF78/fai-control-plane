import {projectWizardProgress} from '../../../../../src/mvp/api.ts';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=(request:Request,{params}:{params:Promise<{projectId:string}>})=>params.then(({projectId})=>
  projectWizardProgress(request,projectId));
export const POST=GET;
