import {createHash,randomUUID} from 'node:crypto';
import {isUuid} from '@fai-control-plane/domain';
import type {Database} from './runtime.ts';
import {
  parseProjectHermesRuntimeArtifact,
  projectHermesRuntimeArtifactKind,
  projectHermesRuntimeContract,
  projectHermesRuntimeImageVersion,
  projectHermesSecretPurpose,
  type ParsedProjectHermesRuntimeArtifact,
  type ProjectHermesSecretKind
} from './project-hermes-runtime.ts';

const sha=(content:string)=>createHash('sha256').update(content).digest('hex');
const validSlug=(value:string)=>/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/.test(value);
const runtimeId=(slug:string,projectId:string)=>`fai-${slug.slice(0,32).replace(/-+$/,'')}-${projectId.slice(0,8)}`;
const workspacePath=(id:string)=>`/opt/data/work/${id}`;

type Coordinates=Readonly<{
  runtimeId:string;gatewayEndpoint:string;dashboardEndpoint:string;workspacePath:string;
}>;
export const projectHermesRuntimeCoordinates=(slug:string,projectId:string):Coordinates=>{
  if(!validSlug(slug)||!isUuid(projectId))throw new Error('project_runtime_invalid');
  const id=runtimeId(slug,projectId);
  return {runtimeId:id,gatewayEndpoint:`http://${id}-gateway:8642/v1/runs`,
    dashboardEndpoint:`http://${id}-gateway:9119/`,workspacePath:workspacePath(id)};
};

type SecretLocator=Readonly<{id:string;locator:string}>;
export type ProjectRuntimeSecretLocators=Readonly<Record<ProjectHermesSecretKind,SecretLocator>>;
const artifactValue=(input:Readonly<{
  coordinates:Coordinates;telegramChatId:string|null;telegramAllowedUserIds:readonly string[];
  secrets:ProjectRuntimeSecretLocators;status:ParsedProjectHermesRuntimeArtifact['status'];generation:string;
  auth?:Readonly<{verificationUrl:string;userCode:string}>;failure?:ParsedProjectHermesRuntimeArtifact['failure'];
}>)=>({contract:projectHermesRuntimeContract,status:input.status,imageVersion:projectHermesRuntimeImageVersion,
  ...input.coordinates,...(input.telegramChatId===null?{}:{telegram:{chatId:input.telegramChatId,allowedUserIds:input.telegramAllowedUserIds}}),
  secretRefs:{agentDelivery:input.secrets['agent-delivery'].id,
    dashboardUsername:input.secrets['dashboard-username'].id,
    dashboardPassword:input.secrets['dashboard-password'].id,
    telegramBot:input.secrets['telegram-bot'].id,inboundActions:input.secrets['inbound-actions'].id},
  generation:input.generation,...(input.auth===undefined?{}:{auth:input.auth}),
  ...(input.failure===undefined?{}:{failure:input.failure})});

const insertArtifact=async(client:Pick<Database,'query'>,input:Readonly<{projectId:string;actorId:string;value:unknown;
  provenance:string}>)=>{
  const content=JSON.stringify(input.value);const version=sha(content);
  await client.query(`insert into project_source_artifacts
    (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
    values($1,$2,$3,$4,'Project AI agent runtime','application/json',$5,$6,null,$7)
    on conflict(project_id,kind,sha256) do nothing`,[randomUUID(),input.projectId,input.actorId,
    projectHermesRuntimeArtifactKind,version,content,input.provenance]);
  return version;
};

export const recordProjectMessengerSetup=async(database:Database,input:Readonly<{
  workspaceId:string;projectId:string;actorId:string;telegramChatId:string|null;telegramAllowedUserIds:readonly string[];
  secrets:ProjectRuntimeSecretLocators;idempotencyKey:string;occurredAt:string;
}>):Promise<void>=>{
  if(!isUuid(input.projectId)||!isUuid(input.workspaceId)||
    (input.telegramChatId!==null&&(!/^-?[1-9][0-9]{0,19}$/.test(input.telegramChatId)||input.telegramAllowedUserIds.length===0||
    input.telegramAllowedUserIds.some((id)=>!/^[1-9][0-9]{0,19}$/.test(id))||new Set(input.telegramAllowedUserIds).size!==input.telegramAllowedUserIds.length)))throw new Error('project_runtime_invalid');
  const client=await database.connect();try{await client.query('begin');
    const allowed=await client.query<{slug:string}>(`select p.slug from projects p join project_memberships m on m.project_id=p.id
      where p.id=$1 and p.workspace_id=$2 and m.actor_id=$3 and m.role='project_owner' and m.active=true for update`,
    [input.projectId,input.workspaceId,input.actorId]);const slug=allowed.rows[0]?.slug;if(slug===undefined)throw new Error('project_runtime_denied');
    for(const kind of Object.keys(input.secrets) as ProjectHermesSecretKind[]){const secret=input.secrets[kind];
      if(!isUuid(secret.id)||!secret.locator.startsWith('/'))throw new Error('project_runtime_invalid');
      const stored=await client.query<{id:string;locator:string}>(`insert into secret_refs(id,workspace_id,purpose,locator)
        values($1,$2,$3,$4) on conflict(workspace_id,purpose) do update set purpose=excluded.purpose returning id,locator`,
      [secret.id,input.workspaceId,projectHermesSecretPurpose(input.projectId,kind),secret.locator]);
      if(stored.rows[0]?.id!==secret.id||stored.rows[0]?.locator!==secret.locator)throw new Error('project_runtime_conflict');
    }
    const coordinates=projectHermesRuntimeCoordinates(slug,input.projectId);
    await insertArtifact(client,{projectId:input.projectId,actorId:input.actorId,
      value:artifactValue({coordinates,telegramChatId:input.telegramChatId,
        telegramAllowedUserIds:input.telegramAllowedUserIds,secrets:input.secrets,status:'messenger_ready',
        generation:input.idempotencyKey}),provenance:'operator:project-messenger-connect'});
    await client.query(`insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
      values($1,$2,$3,'project.messenger.connect',$4,$5) on conflict(idempotency_key) do nothing`,
    [input.projectId,input.actorId,input.idempotencyKey,coordinates.runtimeId,input.occurredAt]);
    await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
      values($1,$2,$3,'project.messenger.connect',$4,$5,$6,$7)`,[input.workspaceId,input.projectId,input.actorId,
      coordinates.runtimeId,input.idempotencyKey,JSON.stringify({provider:input.telegramChatId===null?'none':'telegram'}),input.occurredAt]);
    await client.query('commit');
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
};

type RuntimeArtifactRow=Readonly<{projectId:string;workspaceId:string;ownerActorId:string;slug:string;
  repositoryUrl:string;projectUrl:string;content:string}>;
export type ProjectRuntimeProvisioningRequest=Readonly<RuntimeArtifactRow&{
  artifact:ParsedProjectHermesRuntimeArtifact;generation:string;secrets:ProjectRuntimeSecretLocators;
}>;

const latestRuntimeRows=async(database:Database,workspaceId:string)=>database.query<RuntimeArtifactRow>(`select
  p.id as "projectId",p.workspace_id as "workspaceId",p.slug,p.repository_url as "repositoryUrl",
  owner.actor_id as "ownerActorId",binding.project_url as "projectUrl",runtime.content_text as content
  from projects p join tracker_bindings binding on binding.project_id=p.id and binding.enabled=true
  join lateral(select actor_id from project_memberships where project_id=p.id and role='project_owner' and active=true
    order by created_at,id limit 1)owner on true
  join lateral(select content_text from project_source_artifacts where project_id=p.id and kind=$2
    order by created_at desc,id desc limit 1)runtime on true where p.workspace_id=$1`,[workspaceId,projectHermesRuntimeArtifactKind]);

export const listProjectRuntimeProvisioningRequests=async(database:Database,workspaceId:string):Promise<readonly ProjectRuntimeProvisioningRequest[]>=>{
  const rows=await latestRuntimeRows(database,workspaceId);const parsed=rows.rows.flatMap((row)=>{
    const artifact=parseProjectHermesRuntimeArtifact(row.content);let raw:Record<string,unknown>={};
    try{raw=JSON.parse(row.content) as Record<string,unknown>;}catch{return [];}
    return artifact!==null&&['installing','auth_required'].includes(artifact.status)&&typeof raw.generation==='string'
      ?[{row,artifact,generation:raw.generation}]:[];});
  const ids=[...new Set(parsed.flatMap(({artifact})=>Object.values(artifact.secretIds)))];if(ids.length===0)return [];
  const refs=await database.query<{id:string;purpose:string;locator:string}>(`select id,purpose,locator from secret_refs
    where workspace_id=$1 and id=any($2::uuid[])`,[workspaceId,ids]);const byId=new Map(refs.rows.map((value)=>[value.id,value]));
  return parsed.flatMap(({row,artifact,generation})=>{const secrets={} as Record<ProjectHermesSecretKind,SecretLocator>;
    for(const [kind,id] of Object.entries(artifact.secretIds) as [ProjectHermesSecretKind,string][]){const ref=byId.get(id);
      if(ref===undefined||ref.purpose!==projectHermesSecretPurpose(row.projectId,kind)||!ref.locator.startsWith('/'))return [];
      secrets[kind]={id,locator:ref.locator};}
    return [{...row,artifact,generation,secrets}];});
};

export const requestProjectRuntimeInstall=async(database:Database,input:Readonly<{workspaceId:string;projectId:string;
  actorId:string;idempotencyKey:string;occurredAt:string}>):Promise<void>=>{
  const client=await database.connect();try{await client.query('begin');
    const row=await client.query<{content:string}>(`select s.content_text as content from project_source_artifacts s
      join projects p on p.id=s.project_id join project_memberships m on m.project_id=s.project_id
      where s.project_id=$1 and m.actor_id=$2 and p.workspace_id=$4
      and m.role='project_owner' and m.active=true and s.kind=$3 order by s.created_at desc,s.id desc limit 1 for update`,
    [input.projectId,input.actorId,projectHermesRuntimeArtifactKind,input.workspaceId]);const current=row.rows[0]?.content;
    const artifact=current===undefined?null:parseProjectHermesRuntimeArtifact(current);
    if(artifact===null||!['messenger_ready','error'].includes(artifact.status))throw new Error('project_runtime_unavailable');
    const coordinates={runtimeId:artifact.runtimeId,gatewayEndpoint:artifact.gatewayEndpoint,
      dashboardEndpoint:artifact.dashboardEndpoint,workspacePath:artifact.workspacePath};
    const secrets=Object.fromEntries((Object.entries(artifact.secretIds) as [ProjectHermesSecretKind,string][]).map(([kind,id])=>
      [kind,{id,locator:'/'}])) as ProjectRuntimeSecretLocators;
    await insertArtifact(client,{projectId:input.projectId,actorId:input.actorId,value:artifactValue({coordinates,
      telegramChatId:artifact.telegramChatId,telegramAllowedUserIds:artifact.telegramAllowedUserIds,secrets,
      status:'installing',generation:input.idempotencyKey}),provenance:'operator:project-runtime-install'});
    await client.query(`insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
      values($1,$2,$3,'project.runtime.install',$4,$5) on conflict(idempotency_key) do nothing`,
    [input.projectId,input.actorId,input.idempotencyKey,artifact.runtimeId,input.occurredAt]);
    await client.query('commit');
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
};

export const recordProjectRuntimeProvisioningState=async(database:Database,input:Readonly<{
  request:ProjectRuntimeProvisioningRequest;status:'auth_required'|'ready'|'error';
  auth?:Readonly<{verificationUrl:string;userCode:string}>;failure?:ParsedProjectHermesRuntimeArtifact['failure'];
}>):Promise<void>=>{
  const coordinates={runtimeId:input.request.artifact.runtimeId,gatewayEndpoint:input.request.artifact.gatewayEndpoint,
    dashboardEndpoint:input.request.artifact.dashboardEndpoint,workspacePath:input.request.artifact.workspacePath};
  const value=artifactValue({coordinates,telegramChatId:input.request.artifact.telegramChatId,
    telegramAllowedUserIds:input.request.artifact.telegramAllowedUserIds,secrets:input.request.secrets,
    status:input.status,generation:input.request.generation,...(input.auth===undefined?{}:{auth:input.auth}),
    ...(input.failure===undefined?{}:{failure:input.failure})});
  await insertArtifact(database,{projectId:input.request.projectId,actorId:input.request.ownerActorId,value,
    provenance:`worker:project-runtime-${input.status}`});
};
