import {projectRuntimeSetup} from '../../../../../src/mvp/api.ts';

type Context={params:Promise<{projectId:string}>};
export const GET=(request:Request,context:Context)=>context.params.then(({projectId})=>projectRuntimeSetup(request,projectId));
export const POST=(request:Request,context:Context)=>context.params.then(({projectId})=>projectRuntimeSetup(request,projectId));
