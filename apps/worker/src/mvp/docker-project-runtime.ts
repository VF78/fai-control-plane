import {request as httpRequest} from 'node:http';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
import {chmod,chown,readFile,rm,stat,writeFile} from 'node:fs/promises';
import type {ProjectHermesRuntimeBinding,ProjectRuntimeProvisioningRequest} from '@fai-control-plane/db';
import {prepareProjectHermesAssets} from './hermes-project-template.ts';

type DockerResponse=Readonly<{status:number;body:Buffer}>;
export type DockerRequest=(method:string,path:string,body?:unknown)=>Promise<DockerResponse>;
export const dockerSocketRequest=(socketPath=process.env.FCP_DOCKER_SOCKET??'/var/run/docker.sock'):DockerRequest=>
  (method,path,body)=>new Promise((resolve,reject)=>{const payload=body===undefined?null:Buffer.from(JSON.stringify(body));
    const request=httpRequest({socketPath,path:`/v1.45${path}`,method,headers:payload===null?{}:{
      'content-type':'application/json','content-length':String(payload.byteLength)}},(response)=>{
      const chunks:Buffer[]=[];response.on('data',(chunk)=>chunks.push(Buffer.from(chunk)));
      response.on('end',()=>resolve({status:response.statusCode??500,body:Buffer.concat(chunks)}));
    });request.on('error',reject);if(payload!==null)request.write(payload);request.end();});

const json=<T>(response:DockerResponse):T=>JSON.parse(response.body.toString('utf8')) as T;
const expect=(response:DockerResponse,statuses:readonly number[])=>{if(!statuses.includes(response.status))
  throw new Error('docker_engine_failed');return response;};
const namePath=(name:string)=>encodeURIComponent(name);
type ProjectRuntimeOwnershipInput=Readonly<{workspaceId:string;projectId:string;artifact:Readonly<{runtimeId:string}>}>;
export const projectRuntimeOwnership=(request:ProjectRuntimeOwnershipInput,component:string)=>({
  'fai.control-plane.managed':'true','fai.control-plane.workspace-id':request.workspaceId,
  'fai.control-plane.project-id':request.projectId,'fai.control-plane.runtime-id':request.artifact.runtimeId,
  'fai.control-plane.component':component
});
const exactLabels=(actual:unknown,expected:Record<string,string>)=>{
  if(actual===null||typeof actual!=='object')return false;const values=actual as Record<string,unknown>;
  return Object.entries(expected).every(([key,value])=>values[key]===value);
};
export const assertProjectRuntimeOwnership=(actual:unknown,request:ProjectRuntimeOwnershipInput,component:string)=>{
  if(!exactLabels(actual,projectRuntimeOwnership(request,component)))throw new Error('docker_ownership_conflict');
};
type ContainerInspect=Readonly<{Name?:unknown;Image?:unknown;Config?:Readonly<{Labels?:unknown}>;
  State?:Readonly<{Running?:unknown;Status?:unknown;ExitCode?:unknown;Health?:Readonly<{Status?:unknown}>}>}>;
const inspectContainer=async(docker:DockerRequest,name:string)=>{const response=await docker('GET',`/containers/${namePath(name)}/json`);
  return response.status===404?null:json<ContainerInspect>(expect(response,[200]));};
const specFingerprintLabel='fai.control-plane.spec-sha256';
const fingerprintedSpec=(spec:unknown)=>{if(spec===null||typeof spec!=='object'||Array.isArray(spec))
  throw new Error('project_runtime_spec_invalid');
  const value=spec as Record<string,unknown>;const labels=value.Labels;
  if(labels===null||typeof labels!=='object'||Array.isArray(labels))throw new Error('project_runtime_spec_invalid');
  const fingerprint=createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  return {fingerprint,spec:{...value,Labels:{...labels as Record<string,unknown>,[specFingerprintLabel]:fingerprint}}};
};
const removeOwned=async(docker:DockerRequest,request:ProjectRuntimeProvisioningRequest,name:string,component:string,
  force=false)=>{
  const current=await inspectContainer(docker,name);if(current===null)return;
  assertProjectRuntimeOwnership(current.Config?.Labels,request,component);
  expect(await docker('DELETE',`/containers/${namePath(name)}?${force?'force=1&':''}v=1`),[204,404]);
};
export const reconcileProjectRuntimeContainer=async(docker:DockerRequest,request:ProjectRuntimeProvisioningRequest,
  name:string,component:string,imageId:string,spec:unknown)=>{
  const expected=projectRuntimeOwnership(request,component);let current=await inspectContainer(docker,name);
  const desired=fingerprintedSpec(spec);
  if(current!==null){
    if(current.Name!==`/${name}`||!exactLabels(current.Config?.Labels,expected))throw new Error('docker_ownership_conflict');
    const labels=current.Config?.Labels as Record<string,unknown>;
    if(current.Image!==imageId||labels[specFingerprintLabel]!==desired.fingerprint){
      await removeOwned(docker,request,name,component,true);current=null;
    }
  }
  if(current===null){expect(await docker('POST',`/containers/create?name=${namePath(name)}`,desired.spec),[201]);current=await inspectContainer(docker,name);}
  if(current===null||current.Name!==`/${name}`||current.Image!==imageId||
    !exactLabels(current.Config?.Labels,expected)||
    (current.Config?.Labels as Record<string,unknown>)[specFingerprintLabel]!==desired.fingerprint)
    throw new Error('docker_ownership_conflict');
  if(current.State?.Running!==true&&current.State?.Status==='created')expect(await docker('POST',`/containers/${namePath(name)}/start`),[204,304]);
  return (await inspectContainer(docker,name))!;
};
const removeOwnedForProject=async(docker:DockerRequest,request:ProjectRuntimeOwnershipInput,name:string,component:string)=>{
  const current=await inspectContainer(docker,name);if(current===null)return;
  if(!exactLabels(current.Config?.Labels,projectRuntimeOwnership(request,component)))throw new Error('docker_ownership_conflict');
  expect(await docker('DELETE',`/containers/${namePath(name)}?force=1&v=1`),[204,404]);
};
const ensureNetwork=async(docker:DockerRequest,request:ProjectRuntimeProvisioningRequest,name:string,shared=false)=>{
  let response=await docker('GET',`/networks/${namePath(name)}`);
  if(response.status===404&&!shared){expect(await docker('POST','/networks/create',{Name:name,Driver:'bridge',Internal:false,
    CheckDuplicate:true,Labels:projectRuntimeOwnership(request,'network')}),[201]);response=await docker('GET',`/networks/${namePath(name)}`);}
  const value=json<Readonly<{Internal?:unknown;Driver?:unknown;Name?:unknown;Labels?:unknown}>>(expect(response,[200]));
  if(shared){if(value.Internal!==true||value.Driver!=='bridge')throw new Error('docker_network_denied');}
  else if(value.Name!==name||value.Internal===true||!exactLabels(value.Labels,projectRuntimeOwnership(request,'network')))
    throw new Error('docker_ownership_conflict');
};
const rootFor=(request:ProjectRuntimeProvisioningRequest)=>{const roots=new Set(Object.values(request.secrets).map(({locator})=>dirname(dirname(locator))));
  if(roots.size!==1)throw new Error('project_runtime_secret_conflict');const root=[...roots][0]!;
  if(root==='/'||root.includes('..')||!root.startsWith('/'))throw new Error('project_runtime_secret_conflict');return root;};
const authJson=async(path:string):Promise<Record<string,unknown>|null>=>{try{const details=await stat(path);
  if(!details.isFile()||details.size<100||details.size>1_048_576)return null;
  const value=JSON.parse(await readFile(path,'utf8')) as unknown;
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}catch{return null;}};
const nested=(value:unknown,key:string)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  ?(value as Record<string,unknown>)[key]:undefined;
export const projectOAuthCached=async(root:string)=>{const [codex,hermes]=await Promise.all([
  authJson(`${root}/codex-home/auth.json`),authJson(`${root}/data/auth.json`)]);
  const codexTokens=nested(codex,'tokens');const hermesTokens=nested(nested(nested(hermes,'providers'),'openai-codex'),'tokens');
  return typeof nested(codexTokens,'access_token')==='string'&&typeof nested(codexTokens,'refresh_token')==='string'&&
    typeof nested(hermesTokens,'access_token')==='string'&&typeof nested(hermesTokens,'refresh_token')==='string';};
export const ensureCodexConfig=async(root:string,owner:Readonly<{uid:number;gid:number}>={uid:10000,gid:10000})=>{
  const path=`${root}/codex-home/config.toml`;
  try{await writeFile(path,'cli_auth_credentials_store = "file"\n',{mode:0o600,flag:'wx'});}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  }
  await chmod(path,0o600);await chown(path,owner.uid,owner.gid);
};
const decodeLogs=(body:Buffer)=>{const chunks:Buffer[]=[];let offset=0;while(offset+8<=body.length){const size=body.readUInt32BE(offset+4);
  if(offset+8+size>body.length)break;chunks.push(body.subarray(offset+8,offset+8+size));offset+=8+size;}return (chunks.length===0?body:Buffer.concat(chunks)).toString('utf8');};
export const parseCodexDevicePrompt=(output:string):Readonly<{verificationUrl:string;userCode:string}>|null=>{
  const plain=output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'');
  const url=/https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[^\s]+/i.exec(plain)?.[0]?.replace(/[),.;]+$/,'');
  const code=/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/.exec(plain)?.[0];return url===undefined||code===undefined?null:{verificationUrl:url,userCode:code};
};
export const projectRuntimeResourceNames=(request:ProjectRuntimeProvisioningRequest)=>({
  network:`${request.artifact.runtimeId}-network`,auth:`${request.artifact.runtimeId}-codex-auth`,
  gateway:`${request.artifact.runtimeId}-gateway`
});
export const projectAuthContainerSpec=(request:ProjectRuntimeProvisioningRequest,image:string,root:string,projectNetwork:string)=>({
  Image:image,User:'10000:10000',Entrypoint:['/usr/local/bin/fai-project-device-auth'],Cmd:[],
  Env:['HOME=/opt/data','CODEX_HOME=/opt/data/codex-home'],Labels:projectRuntimeOwnership(request,'codex-auth'),
  HostConfig:{Binds:[`${root}/data:/opt/data`,`${root}/codex-home:/opt/data/codex-home`],Memory:536_870_912,
    NanoCpus:500_000_000,PidsLimit:128,Init:true,RestartPolicy:{Name:'no'},NetworkMode:projectNetwork},
  NetworkingConfig:endpoints(projectNetwork)
});
export const removeProjectHermesRuntime=async(request:ProjectRuntimeOwnershipInput,root:string,
  docker:DockerRequest=dockerSocketRequest()):Promise<void>=>{
  if(root==='/'||!root.startsWith('/')||root.includes('..'))throw new Error('project_runtime_secret_conflict');
  const names={network:`${request.artifact.runtimeId}-network`,auth:`${request.artifact.runtimeId}-codex-auth`,
    gateway:`${request.artifact.runtimeId}-gateway`};
  for(const [component,name] of [['gateway',names.gateway],['codex-auth',names.auth]] as const)
    await removeOwnedForProject(docker,request,name,component);
  const network=await docker('GET',`/networks/${namePath(names.network)}`);
  if(network.status!==404){const value=json<Readonly<{Labels?:unknown}>>(expect(network,[200]));
    if(!exactLabels(value.Labels,projectRuntimeOwnership(request,'network')))throw new Error('docker_ownership_conflict');
    expect(await docker('DELETE',`/networks/${namePath(names.network)}`),[204,404]);}
  await rm(root,{recursive:true,force:true});
};
export const restartProjectHermesGateway=async(runtime:Pick<ProjectHermesRuntimeBinding,
  'workspaceId'|'projectId'|'runtimeId'>,docker:DockerRequest=dockerSocketRequest(),onlyIfUnhealthy=false):Promise<boolean>=>{
  const request={workspaceId:runtime.workspaceId,projectId:runtime.projectId,artifact:{runtimeId:runtime.runtimeId}};
  const name=`${runtime.runtimeId}-gateway`;const current=await inspectContainer(docker,name);
  if(current===null||current.Name!==`/${name}`)throw new Error('docker_ownership_conflict');
  assertProjectRuntimeOwnership(current.Config?.Labels,request,'gateway');
  if(onlyIfUnhealthy&&current.State?.Running!==false&&current.State?.Health?.Status!=='unhealthy')return false;
  expect(await docker('POST',`/containers/${namePath(name)}/restart?t=30`),[204]);
  return true;
};
const commonHost=(root:string,projectNetwork:string)=>({Binds:[`${root}/data:/opt/data`,
  `${root}/codex-home:/opt/data/codex-home`],Memory:1_073_741_824,NanoCpus:1_000_000_000,PidsLimit:256,
  ShmSize:1_073_741_824,RestartPolicy:{Name:'unless-stopped'},NetworkMode:projectNetwork});
const endpoints=(projectNetwork:string,managementNetwork?:string,aliases:readonly string[]=[])=>({EndpointsConfig:{
  [projectNetwork]:{Aliases:[...aliases]},...(managementNetwork===undefined?{}:{[managementNetwork]:{Aliases:[...aliases]}})}});
export const projectGatewayContainerSpec=(request:ProjectRuntimeProvisioningRequest,image:string,root:string,
  assets:Readonly<{generated:string;profile:string;client:string}>,projectNetwork:string,managementNetwork:string)=>{
  const internal=request.messengerBindings?.internal;
  const telegram=internal?.provider==='telegram'&&internal.status==='ready'?internal:
    internal===undefined&&request.artifact.telegramChatId!==null?{allowedUserIds:request.artifact.telegramAllowedUserIds,
      telegram:{chatId:request.artifact.telegramChatId}}:null;
  const client=request.messengerBindings?.client?.status==='interactive'?request.messengerBindings.client:null;
  const env=['HOME=/opt/data','CODEX_HOME=/opt/data/codex-home','API_SERVER_ENABLED=true','API_SERVER_HOST=0.0.0.0',
    'API_SERVER_PORT=8642','HERMES_DASHBOARD=1','HERMES_PROVIDER=openai-codex',
    'HERMES_MODEL=gpt-5.6-terra','TERMINAL_MAX_FOREGROUND_TIMEOUT=1800','HERMES_GITHUB_REPOSITORY_TOKEN_FILE=/run/secrets/github-token',
    'HERMES_API_SERVER_KEY_FILE=/run/secrets/agent-delivery',
    'HERMES_DASHBOARD_USERNAME_FILE=/run/secrets/dashboard-username','HERMES_DASHBOARD_PASSWORD_FILE=/run/secrets/dashboard-password',
    'HERMES_DASHBOARD_SIGNING_SECRET_FILE=/run/secrets/dashboard-signing',
    `FCP_PROJECT_REPOSITORY_URL=${request.repositoryUrl}`,`FCP_PROJECT_TRACKER_URL=${request.projectUrl}`,
    ...(telegram===null?[]:['HERMES_TELEGRAM_BOT_TOKEN_FILE=/run/secrets/telegram-bot',
    `TELEGRAM_ALLOWED_USERS=${telegram.allowedUserIds.join(',')}`,
    `TELEGRAM_ALLOWED_CHATS=${telegram.telegram!.chatId}`,
    `TELEGRAM_GROUP_ALLOWED_USERS=${telegram.allowedUserIds.join(',')}`,
    `TELEGRAM_GROUP_ALLOWED_CHATS=${telegram.telegram!.chatId}`]),
    ...(client?.provider==='telegram'?['CLIENT_TELEGRAM_BOT_TOKEN_FILE=/run/secrets/client-telegram-bot',
      `CLIENT_TELEGRAM_ALLOWED_USERS=${[...new Set([...(telegram?.allowedUserIds??[]),...client.allowedUserIds])].join(',')}`,
      `CLIENT_TELEGRAM_ALLOWED_CHATS=${client.telegram!.chatId}`] :[]),
    ...(client?.provider==='element'?[`CLIENT_MATRIX_HOMESERVER=${client.element!.homeserver}`,
      `CLIENT_MATRIX_ALLOWED_ROOMS=${client.element!.roomReference}`,'CLIENT_MATRIX_ALLOW_ALL_USERS=true',
      'CLIENT_MATRIX_USER_ID_FILE=/run/secrets/client-element-login','CLIENT_MATRIX_PASSWORD_FILE=/run/secrets/client-element-password',
      'CLIENT_MATRIX_E2EE_MODE=optional'] :[])];
  const baseBinds=[`${root}/data:/opt/data`,`${root}/codex-home:/opt/data/codex-home`];
  const binds=[...baseBinds,`${root}/secrets/github-token:/run/secrets/github-token:ro`,
    `${request.secrets['agent-delivery'].locator}:/run/secrets/agent-delivery:ro`,
    `${request.secrets['dashboard-username'].locator}:/run/secrets/dashboard-username:ro`,
    `${request.secrets['dashboard-password'].locator}:/run/secrets/dashboard-password:ro`,
    `${root}/secrets/dashboard-signing:/run/secrets/dashboard-signing:ro`,
    ...(telegram===null?[]:[`${request.secrets['telegram-bot'].locator}:/run/secrets/telegram-bot:ro`]),
    ...(client?.provider==='telegram'&&request.messengerSecrets?.['client-telegram-bot']!==undefined?[`${request.messengerSecrets['client-telegram-bot']!.locator}:/run/secrets/client-telegram-bot:ro`]:[]),
    ...(client?.provider==='element'&&request.messengerSecrets?.['client-element-login']!==undefined&&request.messengerSecrets?.['client-element-password']!==undefined?[`${request.messengerSecrets['client-element-login']!.locator}:/run/secrets/client-element-login:ro`,`${request.messengerSecrets['client-element-password']!.locator}:/run/secrets/client-element-password:ro`]:[]),
    `${assets.generated}/config.yaml:/opt/data/config.yaml:ro`,`${assets.profile}/config.yaml:/opt/data/profiles/internal/config.yaml:ro`,
    `${assets.profile}/SOUL.md:/opt/data/profiles/internal/SOUL.md:ro`,`${assets.client}/config.yaml:/opt/data/profiles/client/config.yaml:ro`,
    `${assets.client}/SOUL.md:/opt/data/profiles/client/SOUL.md:ro`,
    `${assets.client}/plugins:/opt/data/profiles/client/plugins:ro`];
  return {Image:image,Cmd:['sleep','infinity'],WorkingDir:request.artifact.workspacePath,Env:env,
    Labels:projectRuntimeOwnership(request,'gateway'),
    Healthcheck:{Test:['CMD','python','-c',"import os,subprocess,urllib.request; urllib.request.urlopen('http://127.0.0.1:8642/health', timeout=5); urllib.request.urlopen('http://127.0.0.1:9119/api/status', timeout=5); subprocess.run(['gh','auth','status'],env={**os.environ,'HOME':'/opt/data/home'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=5)"],
      Interval:10_000_000_000,Timeout:5_000_000_000,Retries:12,StartPeriod:20_000_000_000},
    HostConfig:{...commonHost(root,projectNetwork),Binds:binds},
    NetworkingConfig:endpoints(projectNetwork,managementNetwork,[`${request.artifact.runtimeId}-gateway`])};
};

export type ProjectRuntimeProvisioningFailure='host_layout_failed'|'image_unavailable'|'authentication_expired'|'gateway_failed'|'readiness_failed';
export type ProjectRuntimeProvisioningOutcome=Readonly<{status:'installing'}|{status:'auth_required';auth:Readonly<{
  verificationUrl:string;userCode:string}>}|{status:'ready'}|{status:'error';failure:ProjectRuntimeProvisioningFailure}>;

const provisioningFailure=(error:unknown):ProjectRuntimeProvisioningFailure=>{
  const code=error instanceof Error?error.message:'';
  if(code==='project_runtime_image_invalid')return 'image_unavailable';
  if(code==='project_runtime_host_layout_failed'||code==='project_runtime_secret_conflict')return 'host_layout_failed';
  return 'gateway_failed';
};

export const provisionProjectHermesRuntime=async(request:ProjectRuntimeProvisioningRequest,
  docker:DockerRequest=dockerSocketRequest()):Promise<ProjectRuntimeProvisioningOutcome>=>{
  try{const image=process.env.FCP_PROJECT_HERMES_IMAGE;const expectedImageId=process.env.FCP_PROJECT_HERMES_IMAGE_ID;
    if(image===undefined||image.length>300||!/^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$/.test(image)||
      expectedImageId===undefined||!/^sha256:[a-f0-9]{64}$/.test(expectedImageId))
      throw new Error('project_runtime_image_invalid');
    const inspectedImage=json<{Id?:unknown}>(expect(await docker('GET',`/images/${namePath(image)}/json`),[200]));
    if(inspectedImage.Id!==expectedImageId)throw new Error('project_runtime_image_invalid');
    const root=rootFor(request);const assets=await prepareProjectHermesAssets(request,root);
    await ensureCodexConfig(root);
    const names=projectRuntimeResourceNames(request);const projectNetwork=names.network;const managementNetwork=process.env.FCP_HERMES_MANAGEMENT_NETWORK??'fai-hermes-management';
    await ensureNetwork(docker,request,managementNetwork,true);await ensureNetwork(docker,request,projectNetwork);
    if(!await projectOAuthCached(root)){const authName=names.auth;
      const priorAuth=await inspectContainer(docker,authName);
      if(priorAuth!==null&&priorAuth.State?.Running!==true&&priorAuth.State?.Status!=='created')
        await removeOwned(docker,request,authName,'codex-auth');
      const auth=await reconcileProjectRuntimeContainer(docker,request,authName,'codex-auth',expectedImageId,
        projectAuthContainerSpec(request,image,root,projectNetwork));
      if(auth.State?.Running===true){const logs=await docker('GET',`/containers/${namePath(authName)}/logs?stdout=1&stderr=1&tail=200`);
        const prompt=parseCodexDevicePrompt(decodeLogs(expect(logs,[200]).body));return prompt===null?{status:'installing'}:{status:'auth_required',auth:prompt};}
      if(auth.State?.ExitCode!==0)return {status:'error',failure:'authentication_expired'};
      if(!await projectOAuthCached(root))return {status:'error',failure:'authentication_expired'};
      await removeOwned(docker,request,authName,'codex-auth');
    }
    const gatewayName=names.gateway;const gateway=await reconcileProjectRuntimeContainer(docker,request,gatewayName,'gateway',expectedImageId,
      projectGatewayContainerSpec(request,image,root,assets,projectNetwork,managementNetwork));
    if(gateway.State?.Health?.Status==='unhealthy')return {status:'error',failure:'readiness_failed'};
    return gateway.State?.Health?.Status==='healthy'?{status:'ready'}:{status:'installing'};
  }catch(error){return {status:'error',failure:provisioningFailure(error)};}
};
