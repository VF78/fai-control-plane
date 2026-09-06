import {createHash,randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {chmod,chown,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {readProjectProcessPolicy,readAgentRoutingPolicy,type Database} from '@fai-control-plane/db';
import {defaultAgentRoutingPolicy,type AgentRoutingPolicy,type ProjectProcessPolicy} from '@fai-control-plane/domain';
import {ensureProjectWorkspace} from './hermes-project-template.ts';

type Versioned<T> = Readonly<{version:string;policy:T}>;
type Runtime = Readonly<{runtimeId:string;workspacePath:string;agentCredentialRef:Readonly<{locator:string}>}>;
export const persistProjectHermesPolicies=async(runtime:Runtime,
  process:Versioned<ProjectProcessPolicy>,routing:Versioned<AgentRoutingPolicy>,
  owner:Readonly<{uid:number;gid:number}>={uid:10000,gid:10000})=>{
  const root=dirname(dirname(runtime.agentCredentialRef.locator));
  if(root==='/'||!root.startsWith('/')||root.includes('..')||
    !/^[a-z0-9-]+$/.test(runtime.runtimeId)||runtime.workspacePath!==`/opt/data/work/${runtime.runtimeId}`)
    throw new Error('project_runtime_workspace_invalid');
  const directory=`${root}/data/work/${runtime.runtimeId}/.fai-context`;
  let changed=0;
  for(const [name,value] of [['process',process],['routing',routing]] as const){
    const policy=JSON.stringify(value.policy);
    if(createHash('sha256').update(policy).digest('hex')!==value.version)throw new Error('project_policy_version_invalid');
    const path=`${directory}/${name}.json`;const content=JSON.stringify({version:value.version,policy:value.policy})+'\n';
    const prior=await readFile(path,'utf8').catch((error:NodeJS.ErrnoException)=>{
      if(error.code==='ENOENT')return null;throw error;});
    if(prior===content)continue;
    await ensureProjectWorkspace(root,runtime.runtimeId,owner);
    await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);await chown(directory,owner.uid,owner.gid);
    const temporary=`${path}.${randomUUID()}`;
    await writeFile(temporary,content,{mode:0o600});await chown(temporary,owner.uid,owner.gid);await rename(temporary,path);changed++;
  }
  return changed;
};

export const syncProjectHermesPolicies=async(database:Database,actorId:string,projectId:string,runtime:Runtime,
  owner:Readonly<{uid:number;gid:number}>={uid:10000,gid:10000})=>{
  const [process,configured]=await Promise.all([readProjectProcessPolicy(database,actorId,projectId),
    readAgentRoutingPolicy(database,actorId,projectId)]);
  if(process===null)throw new Error('project_process_not_configured');
  const routing=configured??{policy:defaultAgentRoutingPolicy,
    version:createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex')};
  return persistProjectHermesPolicies(runtime,process,routing,owner);
};
