import {request as httpRequest} from 'node:http';
import {dirname} from 'node:path';
import {stat,writeFile} from 'node:fs/promises';
import type {ProjectRuntimeProvisioningRequest} from '@fai-control-plane/db';
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
export const projectRuntimeOwnership=(request:ProjectRuntimeProvisioningRequest,component:string)=>({
  'fai.control-plane.managed':'true','fai.control-plane.workspace-id':request.workspaceId,
  'fai.control-plane.project-id':request.projectId,'fai.control-plane.runtime-id':request.artifact.runtimeId,
  'fai.control-plane.component':component
});
const exactLabels=(actual:unknown,expected:Record<string,string>)=>{
  if(actual===null||typeof actual!=='object')return false;const values=actual as Record<string,unknown>;
  return Object.entries(expected).every(([key,value])=>values[key]===value);
};
export const assertProjectRuntimeOwnership=(actual:unknown,request:ProjectRuntimeProvisioningRequest,component:string)=>{
  if(!exactLabels(actual,projectRuntimeOwnership(request,component)))throw new Error('docker_ownership_conflict');
};
type ContainerInspect=Readonly<{Name?:unknown;Image?:unknown;Config?:Readonly<{Labels?:unknown}>;
  State?:Readonly<{Running?:unknown;Status?:unknown;ExitCode?:unknown;Health?:Readonly<{Status?:unknown}>}>}>;
const inspectContainer=async(docker:DockerRequest,name:string)=>{const response=await docker('GET',`/containers/${namePath(name)}/json`);
  return response.status===404?null:json<ContainerInspect>(expect(response,[200]));};
const ensureContainer=async(docker:DockerRequest,request:ProjectRuntimeProvisioningRequest,name:string,component:string,
  imageId:string,spec:unknown)=>{
  const expected=projectRuntimeOwnership(request,component);let current=await inspectContainer(docker,name);
  if(current===null){expect(await docker('POST',`/containers/create?name=${namePath(name)}`,spec),[201]);current=await inspectContainer(docker,name);}
  if(current===null||current.Name!==`/${name}`||current.Image!==imageId||!exactLabels(current.Config?.Labels,expected))throw new Error('docker_ownership_conflict');
  if(current.State?.Running!==true&&current.State?.Status==='created')expect(await docker('POST',`/containers/${namePath(name)}/start`),[204,304]);
  return (await inspectContainer(docker,name))!;
};
const removeOwned=async(docker:DockerRequest,request:ProjectRuntimeProvisioningRequest,name:string,component:string)=>{
  const current=await inspectContainer(docker,name);if(current===null)return;
  assertProjectRuntimeOwnership(current.Config?.Labels,request,component);
  expect(await docker('DELETE',`/containers/${namePath(name)}?v=1`),[204,404]);
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
const authCached=async(root:string)=>{try{const value=await stat(`${root}/codex-home/auth.json`);return value.isFile()&&value.size>100&&value.size<1_048_576;}catch{return false;}};
const decodeLogs=(body:Buffer)=>{const chunks:Buffer[]=[];let offset=0;while(offset+8<=body.length){const size=body.readUInt32BE(offset+4);
  if(offset+8+size>body.length)break;chunks.push(body.subarray(offset+8,offset+8+size));offset+=8+size;}return (chunks.length===0?body:Buffer.concat(chunks)).toString('utf8');};
export const parseCodexDevicePrompt=(output:string):Readonly<{verificationUrl:string;userCode:string}>|null=>{
  const url=/https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[^\s]+/i.exec(output)?.[0]?.replace(/[),.;]+$/,'');
  const code=/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/.exec(output)?.[0];return url===undefined||code===undefined?null:{verificationUrl:url,userCode:code};
};
export const projectRuntimeResourceNames=(request:ProjectRuntimeProvisioningRequest)=>({
  network:`${request.artifact.runtimeId}-network`,auth:`${request.artifact.runtimeId}-codex-auth`,
  gateway:`${request.artifact.runtimeId}-gateway`,management:`${request.artifact.runtimeId}-management`,
  readiness:`${request.artifact.runtimeId}-readiness`
});
const commonHost=(root:string,projectNetwork:string)=>({Binds:[`${root}/data:/opt/data`,
  `${root}/codex-home:/opt/data/codex-home`],Memory:1_073_741_824,NanoCpus:1_000_000_000,PidsLimit:256,
  ShmSize:1_073_741_824,Init:true,RestartPolicy:{Name:'unless-stopped'},NetworkMode:projectNetwork});
const endpoints=(projectNetwork:string,managementNetwork?:string,aliases:readonly string[]=[])=>({EndpointsConfig:{
  [projectNetwork]:{Aliases:[...aliases]},...(managementNetwork===undefined?{}:{[managementNetwork]:{Aliases:[...aliases]}})}});

export type ProjectRuntimeProvisioningOutcome=Readonly<{status:'installing'}|{status:'auth_required';auth:Readonly<{
  verificationUrl:string;userCode:string}>}|{status:'ready'}|{status:'error';failure:'runtime_unavailable'|'authentication_expired'|'readiness_failed'}>;

export const provisionProjectHermesRuntime=async(request:ProjectRuntimeProvisioningRequest,
  docker:DockerRequest=dockerSocketRequest()):Promise<ProjectRuntimeProvisioningOutcome>=>{
  try{const image=process.env.FCP_PROJECT_HERMES_IMAGE;const expectedImageId=process.env.FCP_PROJECT_HERMES_IMAGE_ID;
    if(image===undefined||image.length>300||!/^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$/.test(image)||
      expectedImageId===undefined||!/^sha256:[a-f0-9]{64}$/.test(expectedImageId))
      throw new Error('project_runtime_image_invalid');
    const inspectedImage=json<{Id?:unknown}>(expect(await docker('GET',`/images/${namePath(image)}/json`),[200]));
    if(inspectedImage.Id!==expectedImageId)throw new Error('project_runtime_image_invalid');
    const root=rootFor(request);const assets=await prepareProjectHermesAssets(request,root);
    try{await writeFile(`${root}/codex-home/config.toml`,'cli_auth_credentials_store = "file"\n',{mode:0o600,flag:'wx'});}catch{/* preserve */}
    const names=projectRuntimeResourceNames(request);const projectNetwork=names.network;const managementNetwork=process.env.FCP_HERMES_MANAGEMENT_NETWORK??'fai-hermes-management';
    await ensureNetwork(docker,request,managementNetwork,true);await ensureNetwork(docker,request,projectNetwork);
    const baseBinds=[`${root}/data:/opt/data`,`${root}/codex-home:/opt/data/codex-home`];
    if(!await authCached(root)){const authName=names.auth;
      const priorAuth=await inspectContainer(docker,authName);
      if(priorAuth!==null&&priorAuth.State?.Running!==true&&priorAuth.State?.Status!=='created')
        await removeOwned(docker,request,authName,'codex-auth');
      const auth=await ensureContainer(docker,request,authName,'codex-auth',expectedImageId,{Image:image,User:'10000:10000',
        Entrypoint:['codex'],Cmd:['login','--device-auth'],Env:['HOME=/opt/data','CODEX_HOME=/opt/data/codex-home'],
        Labels:projectRuntimeOwnership(request,'codex-auth'),HostConfig:{Binds:baseBinds,Memory:536_870_912,NanoCpus:500_000_000,
          PidsLimit:128,Init:true,RestartPolicy:{Name:'no'},NetworkMode:projectNetwork},NetworkingConfig:endpoints(projectNetwork)});
      if(auth.State?.Running===true){const logs=await docker('GET',`/containers/${namePath(authName)}/logs?stdout=1&stderr=1&tail=200`);
        const prompt=parseCodexDevicePrompt(decodeLogs(expect(logs,[200]).body));return prompt===null?{status:'installing'}:{status:'auth_required',auth:prompt};}
      if(auth.State?.ExitCode!==0)return {status:'error',failure:'authentication_expired'};
      if(!await authCached(root))return {status:'error',failure:'authentication_expired'};await removeOwned(docker,request,authName,'codex-auth');
    }
    const env=['HOME=/opt/data','CODEX_HOME=/opt/data/codex-home','API_SERVER_ENABLED=true','API_SERVER_HOST=0.0.0.0',
      'API_SERVER_PORT=8642','HERMES_DASHBOARD=0','HERMES_GATEWAY_NO_SUPERVISE=1','HERMES_PROVIDER=openai-codex',
      'HERMES_MODEL=gpt-5.6-terra','TERMINAL_MAX_FOREGROUND_TIMEOUT=1800','HERMES_GITHUB_REPOSITORY_TOKEN_FILE=/run/secrets/github-token',
      'HERMES_API_SERVER_KEY_FILE=/run/secrets/agent-delivery',
      ...(request.artifact.telegramChatId===null?[]:['HERMES_TELEGRAM_BOT_TOKEN_FILE=/run/secrets/telegram-bot',
      `TELEGRAM_ALLOWED_USERS=${request.artifact.telegramAllowedUserIds.join(',')}`,
      `TELEGRAM_ALLOWED_CHATS=${request.artifact.telegramChatId}`,
      `TELEGRAM_GROUP_ALLOWED_USERS=${request.artifact.telegramAllowedUserIds.join(',')}`,
      `TELEGRAM_GROUP_ALLOWED_CHATS=${request.artifact.telegramChatId}`])];
    const gatewayName=names.gateway;const gatewayBinds=[...baseBinds,
      `${root}/secrets/github-token:/run/secrets/github-token:ro`,`${request.secrets['agent-delivery'].locator}:/run/secrets/agent-delivery:ro`,
      ...(request.artifact.telegramChatId===null?[]:[`${request.secrets['telegram-bot'].locator}:/run/secrets/telegram-bot:ro`]),
      `${assets.generated}/config.yaml:/opt/data/config.yaml:ro`,`${assets.profile}/config.yaml:/opt/data/profiles/internal/config.yaml:ro`,
      `${assets.profile}/SOUL.md:/opt/data/profiles/internal/SOUL.md:ro`];
    const gateway=await ensureContainer(docker,request,gatewayName,'gateway',expectedImageId,{Image:image,User:'10000:10000',
      WorkingDir:request.artifact.workspacePath,Entrypoint:['/opt/fai/native-entrypoint.sh'],Cmd:['gateway','run'],Env:env,
      Labels:projectRuntimeOwnership(request,'gateway'),Healthcheck:{Test:['CMD','python','-c',"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8642/health', timeout=5)"],
        Interval:10_000_000_000,Timeout:5_000_000_000,Retries:12,StartPeriod:20_000_000_000},
      HostConfig:{...commonHost(root,projectNetwork),Binds:gatewayBinds},
      NetworkingConfig:endpoints(projectNetwork,managementNetwork,[gatewayName])});
    const managementName=names.management;const management=await ensureContainer(docker,request,managementName,'management',expectedImageId,{Image:image,User:'10000:10000',
      WorkingDir:'/opt/data',Entrypoint:['/opt/fai/management-entrypoint.sh'],Env:['HOME=/opt/data',
        'HERMES_DASHBOARD_USERNAME_FILE=/run/secrets/management-username','HERMES_DASHBOARD_PASSWORD_FILE=/run/secrets/management-password',
        'HERMES_DASHBOARD_SIGNING_SECRET_FILE=/run/secrets/management-signing'],Labels:projectRuntimeOwnership(request,'management'),
      Healthcheck:{Test:['CMD','python','-c',"import urllib.request; urllib.request.urlopen('http://127.0.0.1:9119/api/status', timeout=5)"],
        Interval:10_000_000_000,Timeout:5_000_000_000,Retries:12,StartPeriod:20_000_000_000},
      HostConfig:{...commonHost(root,projectNetwork),Memory:402_653_184,NanoCpus:250_000_000,PidsLimit:128,
        Binds:[...baseBinds,`${assets.generated}/config.yaml:/opt/data/config.yaml:ro`,
          `${request.secrets['management-username'].locator}:/run/secrets/management-username:ro`,
          `${request.secrets['management-password'].locator}:/run/secrets/management-password:ro`,
          `${root}/secrets/management-signing:/run/secrets/management-signing:ro`]},
      NetworkingConfig:endpoints(projectNetwork,managementNetwork,[managementName])});
    if(gateway.State?.Health?.Status==='unhealthy'||management.State?.Health?.Status==='unhealthy')
      return {status:'error',failure:'readiness_failed'};
    if(gateway.State?.Health?.Status!=='healthy'||management.State?.Health?.Status!=='healthy')return {status:'installing'};
    const probeName=names.readiness;const probe=await ensureContainer(docker,request,probeName,'readiness',expectedImageId,{Image:image,User:'10000:10000',
      WorkingDir:request.artifact.workspacePath,Entrypoint:['/opt/fai/native-entrypoint.sh'],Cmd:['--exec','sh','-lc',
        'git --version >/dev/null && gh auth status >/dev/null 2>&1 && codex login status >/dev/null 2>&1 && test -w "$PWD"'],
      Env:['HOME=/opt/data','CODEX_HOME=/opt/data/codex-home','HERMES_GITHUB_REPOSITORY_TOKEN_FILE=/run/secrets/github-token'],
      Labels:projectRuntimeOwnership(request,'readiness'),HostConfig:{Binds:[...baseBinds,`${root}/secrets/github-token:/run/secrets/github-token:ro`],
        Memory:536_870_912,NanoCpus:500_000_000,PidsLimit:128,Init:true,RestartPolicy:{Name:'no'},NetworkMode:projectNetwork},
      NetworkingConfig:endpoints(projectNetwork)});
    if(probe.State?.Running===true)return {status:'installing'};const success=probe.State?.ExitCode===0;
    await removeOwned(docker,request,probeName,'readiness');return success?{status:'ready'}:{status:'error',failure:'readiness_failed'};
  }catch{return {status:'error',failure:'runtime_unavailable'};}
};
