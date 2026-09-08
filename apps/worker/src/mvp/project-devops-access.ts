import {readProjectHermesRuntimeBinding,saveProjectDevopsAccess,type Database,type ProjectDevopsAccess,
  type ProjectHermesRuntimeBinding} from '@fai-control-plane/db';
import {assertProjectRuntimeOwnership,dockerSocketRequest,type DockerRequest} from './docker-project-runtime.ts';
import {devopsContainerDirectory,writeDevopsFiles,type DevopsInput} from './project-devops-files.ts';

const execPollIntervalMs=250;
const execPollAttempts=56;

/** Fixed setup probes, never an arbitrary command endpoint. Output (including cloud tokens) is discarded. */
export const probeDevopsAccess=async(runtime:Pick<ProjectHermesRuntimeBinding,'runtimeId'|'projectId'|'workspaceId'>,cloud:DevopsInput['cloud'],
  docker:DockerRequest=dockerSocketRequest(undefined,15_000)):Promise<Pick<ProjectDevopsAccess,'ssh'|'cloudStatus'>>=>{
  const name=`${runtime.runtimeId}-gateway`;const path=encodeURIComponent(name);
  const current=await docker('GET',`/containers/${path}/json`);
  if(current.status!==200)throw new Error('project_runtime_unavailable');
  const container=JSON.parse(current.body.toString()) as {Name:string;Config:{Labels:unknown};State:{Running:boolean}};
  assertProjectRuntimeOwnership(container.Config.Labels,{...runtime,artifact:runtime},'gateway');
  if(container.Name!==`/${name}`||!container.State.Running)throw new Error('project_runtime_unavailable');
  const probe=async(command:readonly string[])=>{
    const created=await docker('POST',`/containers/${path}/exec`,{User:'10000:10000',AttachStdout:false,AttachStderr:false,
      Env:['HOME=/opt/data/home'],Cmd:['timeout','12',...command]});
    if(created.status!==201)return false;
    const id=(JSON.parse(created.body.toString()) as {Id?:string}).Id;if(!id)return false;
    const started=await docker('POST',`/exec/${encodeURIComponent(id)}/start`,{Detach:false,Tty:false});
    if(started.status!==200)return false;
    for(let attempt=0;attempt<execPollAttempts;attempt++){
      const inspected=await docker('GET',`/exec/${encodeURIComponent(id)}/json`);
      if(inspected.status!==200)return false;
      const state=JSON.parse(inspected.body.toString()) as {Running?:boolean;ExitCode?:number};
      if(!state.Running)return state.ExitCode===0;
      if(attempt<execPollAttempts-1)await new Promise<void>(resolve=>setTimeout(resolve,execPollIntervalMs));
    }
    return false;
  };
  const ssh=await probe(['ssh','-F',`${devopsContainerDirectory}/ssh_config`,'project','true']);
  const cloudStatus=cloud==='none'?'not_selected':await probe(['yc','--config',`${devopsContainerDirectory}/yandex.yaml`,'iam','create-token'])?'configured':'error';
  return {ssh:ssh?'configured':'error',cloudStatus};
};

export const configureDevopsAccess=async(database:Database,input:DevopsInput&Readonly<{
  workspaceId:string;projectId:string;actorId:string;idempotencyKey:string;
}>,root:string)=>{
  const runtime=await readProjectHermesRuntimeBinding(database,input.actorId,input.projectId);
  if(runtime===null||runtime.workspaceId!==input.workspaceId)throw new Error('project_runtime_unavailable');
  await writeDevopsFiles(root,input);
  const result=await probeDevopsAccess(runtime,input.cloud).catch(()=>({ssh:'error' as const,
    cloudStatus:input.cloud==='none'?'not_selected' as const:'error' as const}));
  const value={host:input.host,port:input.port,user:input.user,cloud:input.cloud,...result,checkedAt:new Date().toISOString()};
  await saveProjectDevopsAccess(database,{...input,value});
  return value;
};
