import {chown,cp,mkdir,readFile,writeFile} from 'node:fs/promises';
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
gateway:
  multiplex_profiles: true
  profile_routes:
    - name: ${yamlString(`${request.slug}-project`)}
      platform: telegram
      chat_id: ${yamlString(request.artifact.telegramChatId)}
      profile: internal
tool_loop_guardrails:
  hard_stop_enabled: true
  hard_stop_after:
    exact_failure: 5
    idempotent_no_progress: 5
`;

export const prepareProjectHermesAssets=async(request:ProjectRuntimeProvisioningRequest,root:string)=>{
  const generated=`${root}/generated`;const profile=`${generated}/profile`;
  const expectedWorkspace=`/opt/data/work/${request.artifact.runtimeId}`;
  if(request.artifact.workspacePath!==expectedWorkspace)throw new Error('project_runtime_workspace_invalid');
  const hostWorkspace=`${root}/data/work/${request.artifact.runtimeId}`;
  await mkdir(hostWorkspace,{recursive:true,mode:0o700});
  try{await chown(hostWorkspace,10000,10000);}catch(error){if(process.env.NODE_ENV!=='test')throw error;}
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
