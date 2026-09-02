import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {chmod,chown,lstat,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {
  deleteProjectRecords,
  projectHermesRuntimeCoordinates,
  projectHermesSecretPurpose,
  readProjectHermesRuntimeArtifact,
  readProjectHermesRuntimeSetup,
  readProjectDeletionTarget,
  recordProjectMessengerSetup,
  requestProjectRuntimeInstall,
  type Database,
  type ProjectHermesSecretKind,
  type ProjectRuntimeSecretLocators
} from '@fai-control-plane/db';
import {actorForSession} from '@fai-control-plane/db';
import {removeProjectHermesRuntime} from './docker-project-runtime.ts';

const runtimeRoot=()=>{
  const value=process.env.FCP_PROJECT_RUNTIME_HOST_DIR;
  if(value===undefined||!value.startsWith('/')||value==='/'||value.includes('\0')||value.includes('..'))
    throw new Error('project_runtime_unavailable');
  return value.replace(/\/+$/,'');
};
export const projectGithubCredential=async()=>{
  const path=process.env.GITHUB_PROJECTS_TOKEN_FILE;
  if(path===undefined||!path.startsWith('/')||path.includes('\0'))throw new Error('project_runtime_unavailable');
  const value=(await readFile(path,'utf8')).trim();
  if(value.length<20||value.length>512||/\s|\0/.test(value))throw new Error('project_repository_credential_invalid');
  return value;
};
const token=()=>randomBytes(32).toString('base64url');
const safeWrite=async(path:string,value:string)=>{
  const temporary=`${path}.${randomUUID()}.tmp`;await writeFile(temporary,`${value}\n`,{mode:0o600,flag:'wx'});
  await chmod(temporary,0o600);try{await chown(temporary,10000,10000);}catch(error){
    if(process.env.NODE_ENV!=='test')throw error;
  }await rename(temporary,path);
};
const existingOrCreate=async(path:string,create:()=>string)=>{
  try{const value=(await readFile(path,'utf8')).trim();if(value.length>0&&!value.includes('\0'))return value;}catch{/* create */}
  const value=create();await safeWrite(path,value);return value;
};
const ensureOwnedDirectory=async(path:string,owner:Readonly<{uid:number;gid:number}>)=>{
  try{await mkdir(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const value=await lstat(path);
  if(!value.isDirectory()||value.isSymbolicLink())throw new Error('project_runtime_host_layout_failed');
  await chmod(path,0o700);await chown(path,owner.uid,owner.gid);
};
export const ensureProjectRuntimeDirectory=async(workspaceId:string,projectId:string,
  owner:Readonly<{uid:number;gid:number}>={uid:10000,gid:10000})=>{
  if(!/^[0-9a-f-]{36}$/i.test(workspaceId)||!/^[0-9a-f-]{36}$/i.test(projectId))throw new Error('project_runtime_invalid');
  const root=runtimeRoot();const workspace=`${root}/${workspaceId}`;const directory=`${workspace}/${projectId}`;
  try{
    await ensureOwnedDirectory(workspace,owner);await ensureOwnedDirectory(directory,owner);
    for(const name of ['secrets','data','codex-home'])await ensureOwnedDirectory(`${directory}/${name}`,owner);
    return directory;
  }catch(error){if(error instanceof Error&&error.message==='project_runtime_host_layout_failed')throw error;
    throw new Error('project_runtime_host_layout_failed',{cause:error});}
};
const project=async(database:Database,actorId:string,projectId:string)=>{
  const result=await database.query<{workspaceId:string;slug:string;repositoryUrl:string;projectUrl:string}>(`select
    p.workspace_id as "workspaceId",p.slug,p.repository_url as "repositoryUrl",b.project_url as "projectUrl"
    from projects p join project_memberships m on m.project_id=p.id and m.actor_id=$1 and m.role='project_owner' and m.active=true
    join tracker_bindings b on b.project_id=p.id and b.enabled=true where p.id=$2`,[actorId,projectId]);
  const value=result.rows[0];if(value===undefined)throw new Error('project_runtime_denied');return value;
};
const secretFiles:Record<ProjectHermesSecretKind,string>={
  'agent-delivery':'agent-delivery','dashboard-username':'dashboard-username',
  'dashboard-password':'dashboard-password','telegram-bot':'telegram-bot','inbound-actions':'inbound-actions'
};
const refs=async(database:Database,workspaceId:string,projectId:string,directory:string):Promise<ProjectRuntimeSecretLocators>=>{
  const purposes=(Object.keys(secretFiles) as ProjectHermesSecretKind[]).map((kind)=>projectHermesSecretPurpose(projectId,kind));
  const stored=await database.query<{id:string;purpose:string}>(`select id,purpose from secret_refs where workspace_id=$1 and purpose=any($2::text[])`,
  [workspaceId,purposes]);const ids=new Map(stored.rows.map((value)=>[value.purpose,value.id]));
  return Object.fromEntries((Object.keys(secretFiles) as ProjectHermesSecretKind[]).map((kind)=>[kind,{id:ids.get(projectHermesSecretPurpose(projectId,kind))??randomUUID(),
    locator:`${directory}/secrets/${secretFiles[kind]}`}])) as ProjectRuntimeSecretLocators;
};

const telegramRequest=async(botToken:string,method:string,payload:Record<string,unknown>)=>{
  const response=await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/${method}`,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15_000)});
  const value=await response.json().catch(()=>null) as {ok?:unknown;result?:unknown}|null;
  if(!response.ok||value?.ok!==true)throw new Error('project_messenger_verification_failed');return value.result;
};
const idempotentCommand=async<T>(database:Database,input:Readonly<{projectId:string;actorId:string;
  idempotencyKey:string;commandType:string}>,current:()=>Promise<T>,execute:()=>Promise<T>):Promise<T>=>{
  const client=await database.connect();try{await client.query('select pg_advisory_lock(hashtextextended($1,0))',[input.idempotencyKey]);
    const prior=await client.query(`select 1 from command_receipts where project_id=$1 and actor_id=$2
      and idempotency_key=$3 and command_type=$4`,[input.projectId,input.actorId,input.idempotencyKey,input.commandType]);
    return prior.rowCount===1?current():execute();
  }finally{await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[input.idempotencyKey]).catch(()=>undefined);client.release();}
};

export const connectProjectMessenger=async(database:Database,input:Readonly<{workspaceId:string;actorId:string;
  projectId:string;botToken:string;chatId:string;allowedUserIds:readonly string[];idempotencyKey:string;
}>)=>{
  if(!/^\d{6,12}:[A-Za-z0-9_-]{20,100}$/.test(input.botToken)||!/^-?[1-9][0-9]{0,19}$/.test(input.chatId)||
    input.allowedUserIds.length===0||input.allowedUserIds.length>100||input.allowedUserIds.some((id)=>!/^[1-9][0-9]{0,19}$/.test(id)))
    throw new Error('project_messenger_invalid');
  const bound=await project(database,input.actorId,input.projectId);if(bound.workspaceId!==input.workspaceId)
    throw new Error('project_runtime_denied');
  return idempotentCommand(database,{...input,commandType:'project.messenger.connect'},
    ()=>readProjectHermesRuntimeSetup(database,input.actorId,input.projectId),async()=>{
      const setup=await readProjectHermesRuntimeSetup(database,input.actorId,input.projectId);
      if(!['not_configured','messenger_ready'].includes(setup.status))throw new Error('project_runtime_unavailable');
      await telegramRequest(input.botToken,'getMe',{});await telegramRequest(input.botToken,'getChat',{chat_id:input.chatId});
      await telegramRequest(input.botToken,'sendMessage',{chat_id:input.chatId,
        text:'f(AI) Control подтвердил отдельный рабочий канал проекта. Настройка ИИ-агента продолжится в интерфейсе.'});
      const directory=await ensureProjectRuntimeDirectory(input.workspaceId,input.projectId);const secretRefs=await refs(database,input.workspaceId,input.projectId,directory);
      const coordinates=projectHermesRuntimeCoordinates(bound.slug,input.projectId);
      await safeWrite(secretRefs['telegram-bot'].locator,input.botToken);
      await existingOrCreate(secretRefs['agent-delivery'].locator,token);
      await existingOrCreate(secretRefs['dashboard-username'].locator,()=>`operator-${coordinates.runtimeId}`);
      await existingOrCreate(secretRefs['dashboard-password'].locator,token);
      await existingOrCreate(secretRefs['inbound-actions'].locator,token);
      await existingOrCreate(`${directory}/secrets/dashboard-signing`,token);
      await recordProjectMessengerSetup(database,{...input,telegramChatId:input.chatId,
        telegramAllowedUserIds:[...new Set(input.allowedUserIds)],secrets:secretRefs,occurredAt:new Date().toISOString()});
      return readProjectHermesRuntimeSetup(database,input.actorId,input.projectId);
    });
};

const githubHeaders=(credential:string)=>({accept:'application/vnd.github+json',authorization:`Bearer ${credential}`,
  'content-type':'application/json','x-github-api-version':'2022-11-28'});
const verifyProjectCredential=async(credential:string,repositoryUrl:string,projectUrl:string)=>{
  const repository=new URL(repositoryUrl);const tracker=new URL(projectUrl);
  const repo=/^\/([^/]+)\/([^/]+)\/?$/.exec(repository.pathname);const project=/^\/users\/([^/]+)\/projects\/(\d+)\/?$/.exec(tracker.pathname);
  if(repository.origin!=='https://github.com'||tracker.origin!=='https://github.com'||repo===null||project===null||
    repo[1]!.toLowerCase()!==project[1]!.toLowerCase())throw new Error('project_runtime_invalid');
  const response=await fetch(`https://api.github.com/repos/${repo[1]}/${repo[2]}`,{headers:githubHeaders(credential),signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error('project_repository_verification_failed');
  const graph=await fetch('https://api.github.com/graphql',{method:'POST',headers:githubHeaders(credential),
    body:JSON.stringify({query:'query($owner:String!,$number:Int!){user(login:$owner){projectV2(number:$number){url}}}',
      variables:{owner:project[1],number:Number(project[2])}}),signal:AbortSignal.timeout(15_000)});
  const value=await graph.json().catch(()=>null) as {data?:{user?:{projectV2?:{url?:unknown}}};errors?:unknown}|null;
  if(!graph.ok||value?.data?.user?.projectV2?.url!==projectUrl.replace(/\/$/,'')||Array.isArray(value?.errors))
    throw new Error('project_tracker_verification_failed');
};

export const installProjectRuntime=async(database:Database,input:Readonly<{workspaceId:string;actorId:string;
  projectId:string;idempotencyKey:string;}>)=>{
  const bound=await project(database,input.actorId,input.projectId);if(bound.workspaceId!==input.workspaceId)
    throw new Error('project_runtime_denied');
  return idempotentCommand(database,{...input,commandType:'project.runtime.install'},
    ()=>readProjectHermesRuntimeSetup(database,input.actorId,input.projectId),async()=>{
      const setup=await readProjectHermesRuntimeSetup(database,input.actorId,input.projectId);
      const existingRuntime=await readProjectHermesRuntimeArtifact(database,input.actorId,input.projectId);
      if(!['not_configured','messenger_ready','error'].includes(setup.status))throw new Error('project_runtime_unavailable');
      const githubCredential=await projectGithubCredential();
      await verifyProjectCredential(githubCredential,bound.repositoryUrl,bound.projectUrl);
      const directory=await ensureProjectRuntimeDirectory(input.workspaceId,input.projectId);await safeWrite(`${directory}/secrets/github-token`,githubCredential);
      if(setup.status==='not_configured'){
        const secretRefs=await refs(database,input.workspaceId,input.projectId,directory);
        const coordinates=projectHermesRuntimeCoordinates(bound.slug,input.projectId);
        await existingOrCreate(secretRefs['agent-delivery'].locator,token);
        await existingOrCreate(secretRefs['dashboard-username'].locator,()=>`operator-${coordinates.runtimeId}`);
        await existingOrCreate(secretRefs['dashboard-password'].locator,token);
        await existingOrCreate(secretRefs['inbound-actions'].locator,token);
        await existingOrCreate(`${directory}/secrets/dashboard-signing`,token);
        await recordProjectMessengerSetup(database,{workspaceId:input.workspaceId,actorId:input.actorId,projectId:input.projectId,
          telegramChatId:existingRuntime?.telegramChatId??null,
          telegramAllowedUserIds:existingRuntime?.telegramAllowedUserIds??[],secrets:secretRefs,
          idempotencyKey:`${input.idempotencyKey}:runtime-v2-base`,occurredAt:new Date().toISOString()});
      }
      await requestProjectRuntimeInstall(database,{workspaceId:input.workspaceId,projectId:input.projectId,actorId:input.actorId,
        idempotencyKey:input.idempotencyKey,occurredAt:new Date().toISOString()});
      return readProjectHermesRuntimeSetup(database,input.actorId,input.projectId);
    });
};

export const deleteProject=async(database:Database,input:Readonly<{actorId:string;projectId:string}>)=>{
  const target=await readProjectDeletionTarget(database,input.actorId,input.projectId);
  const coordinates=projectHermesRuntimeCoordinates(target.slug,target.projectId);
  const directory=`${runtimeRoot()}/${target.workspaceId}/${target.projectId}`;
  await removeProjectHermesRuntime({...target,artifact:{runtimeId:coordinates.runtimeId}},directory);
  await deleteProjectRecords(database,{...target,actorId:input.actorId});return {deleted:true};
};

const body=async(request:Request)=>{const text=await request.text();if(text.length===0||text.length>8_192)
  throw new Error('body_invalid');const value=JSON.parse(text) as unknown;if(value===null||typeof value!=='object'||Array.isArray(value))
    throw new Error('body_invalid');return value as Record<string,unknown>;};
const required=(value:unknown,maximum:number)=>{if(typeof value!=='string'||value.length===0||value.length>maximum||value.includes('\0'))
  throw new Error('body_invalid');return value;};
export const projectRuntimeSetupCommand=async(database:Database,request:Request,projectId:string):Promise<Response>=>{
  try{if(!['POST','DELETE'].includes(request.method))return new Response(null,{status:405});
    const cookie=request.headers.get('cookie')??'';const sessionToken=/(?:^|;\s*)fai_session=([^;]+)/.exec(cookie)?.[1];
    if(sessionToken===undefined)throw new Error('authentication_required');
    const session=await actorForSession(database,createHash('sha256').update(decodeURIComponent(sessionToken)).digest('hex'));
    if(session===null)throw new Error('authentication_required');
    if(request.method==='DELETE')return Response.json(await deleteProject(database,{actorId:session.actorId,projectId}));
    const value=await body(request);const action=required(value.action,32);
    const result=action==='connect_messenger'?await connectProjectMessenger(database,{workspaceId:session.workspaceId,
      actorId:session.actorId,projectId,botToken:required(value.botToken,256),chatId:required(value.chatId,32),
      allowedUserIds:required(value.allowedUserIds,2_400).split(',').map((item)=>item.trim()).filter(Boolean),
      idempotencyKey:required(value.idempotencyKey,128)}):action==='install'?await installProjectRuntime(database,{workspaceId:session.workspaceId,
        actorId:session.actorId,projectId,idempotencyKey:required(value.idempotencyKey,128)}):
      (()=>{throw new Error('body_invalid');})();return Response.json(result);
  }catch(error){const code=error instanceof Error?error.message:'request_failed';return Response.json({error:code},{status:
    code==='authentication_required'?401:code.endsWith('_denied')?403:code.includes('verification_failed')?502:400});}
};
