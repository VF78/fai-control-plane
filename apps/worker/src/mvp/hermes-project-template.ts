import {chmod,chown,cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import type {ProjectRuntimeProvisioningRequest} from '@fai-control-plane/db';

const yamlString=(value:string)=>JSON.stringify(value);
export const renderProjectHermesConfig=(request:ProjectRuntimeProvisioningRequest)=>`_config_version: 34
model:
  provider: openai-codex
  default: gpt-5.6-terra
auxiliary:
  free_only: true
terminal:
  backend: local
  cwd: ${yamlString(request.artifact.workspacePath)}
platform_toolsets:
  api_server:
    - terminal
    - no_mcp
agent:
  max_turns: 500
toolsets:
  - file
  - terminal
  - search
  - web
  - skills
  - todo
  - memory
  - session_search
${request.artifact.telegramChatId===null?'':`gateway:
  multiplex_profiles: true
  profile_routes:
    - name: ${yamlString(`${request.slug}-project`)}
      platform: telegram
      chat_id: ${yamlString(request.artifact.telegramChatId)}
      profile: internal
`}
tool_loop_guardrails:
  hard_stop_enabled: true
  hard_stop_after:
    exact_failure: 5
    idempotent_no_progress: 5
`;

export const ensureProjectWorkspace=async(root:string,runtimeId:string,
  owner:Readonly<{uid:number;gid:number}>={uid:10000,gid:10000})=>{
  const work=`${root}/data/work`;const workspace=`${work}/${runtimeId}`;
  await mkdir(work,{recursive:true,mode:0o700});await mkdir(workspace,{recursive:true,mode:0o700});
  for(const path of [work,workspace]){await chmod(path,0o700);await chown(path,owner.uid,owner.gid);}
  return workspace;
};

export const prepareProjectHermesAssets=async(request:ProjectRuntimeProvisioningRequest,root:string)=>{
  const generated=`${root}/generated`;const profile=`${generated}/profile`;
  const expectedWorkspace=`/opt/data/work/${request.artifact.runtimeId}`;
  if(request.artifact.workspacePath!==expectedWorkspace)throw new Error('project_runtime_workspace_invalid');
  await ensureProjectWorkspace(root,request.artifact.runtimeId);
  await mkdir(profile,{recursive:true,mode:0o755});
  await writeFile(`${generated}/config.yaml`,renderProjectHermesConfig(request),{mode:0o644});
  const sharedRoot=`${process.cwd()}/infra/hermes-project`;
  await cp(`${sharedRoot}/profile-template/config.yaml`,`${profile}/config.yaml`,{force:true});
  const soul=await readFile(`${sharedRoot}/profile-template/SOUL.md`,'utf8');
  await writeFile(`${profile}/SOUL.md`,`${soul.trim()}\n\nOn every new Telegram or API session, read PROJECT_CONTEXT.md from
${request.artifact.workspacePath} when it exists. The repository and task tracker URLs are
${request.repositoryUrl} and ${request.projectUrl}. Never operate another project.\n`,{mode:0o644});
  return {generated,profile};
};
