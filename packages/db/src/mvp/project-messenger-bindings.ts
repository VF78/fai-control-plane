import {createHash,randomUUID} from 'node:crypto';
import type {OpaqueSecretRef} from '@fai-control-plane/domain';
import type {Database} from './runtime.ts';

export const projectMessengerBindingsArtifactKind='project_messenger_bindings_v1';
const contract='fai.project-messenger-bindings.v1';
export type MessengerProvider='telegram'|'element';
export type MessengerContour='internal'|'client';
export type ProjectMessengerChannel=Readonly<{provider:MessengerProvider;allowedUserIds:readonly string[];status:'ready'|'interactive'|'pending_verification';telegram?:Readonly<{chatId:string}>;element?:Readonly<{homeserver:string;roomReference:string}>}>;
export type ProjectMessengerBindings=Readonly<Partial<Record<MessengerContour,ProjectMessengerChannel>>>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const channel=(value:unknown,contour:MessengerContour):ProjectMessengerChannel|null=>{
  const item=object(value);const provider=item?.provider;const allowed=item?.allowedUserIds;const status=item?.status;
  const telegram=object(item?.telegram);const element=object(item?.element);
  if((provider!=='telegram'&&provider!=='element')||!Array.isArray(allowed)||(provider==='telegram'&&allowed.length===0)||
    allowed.some((id)=>typeof id!=='string'||id.length>128)||new Set(allowed).size!==allowed.length)return null;
  if(contour==='internal'&&provider!=='telegram')return null;
  if(status!=='ready'&&status!=='interactive'&&status!=='pending_verification')return null;
  if(contour==='internal'&&status!=='ready')return null;
  if(contour==='client'&&status!=='interactive'&&status!=='pending_verification')return null;
  if(provider==='telegram'&&(typeof telegram?.chatId!=='string'||!/^-?[1-9][0-9]{0,19}$/.test(telegram.chatId)))return null;
  if(provider==='element'&&(typeof element?.homeserver!=='string'||!/^https:\/\/[^\s\0]{1,2040}$/.test(element.homeserver)||
    typeof element?.roomReference!=='string'||element.roomReference.length===0||element.roomReference.length>512))return null;
  return {provider,allowedUserIds:allowed as string[],status,...(provider==='telegram'?{telegram:{chatId:telegram!.chatId as string}}:
    {element:{homeserver:element!.homeserver as string,roomReference:element!.roomReference as string}})};
};
export const parseProjectMessengerBindings=(content:string):ProjectMessengerBindings|null=>{try{const value=object(JSON.parse(content));if(value?.contract!==contract)return null;const channels=object(value.channels);const internal=channel(channels?.internal,'internal');const client=channel(channels?.client,'client');if(internal===null&&client===null)return null;return {...(internal===null?{}:{internal}),...(client===null?{}:{client})};}catch{return null;}};
export const parseProjectMessengerSecretRefs=(content:string):Readonly<Record<string,string>>=>{try{const value=object(JSON.parse(content));const refs=object(value?.secretRefs);return Object.fromEntries(Object.entries(refs??{}).filter(([key,id])=>/^(internal|client)-(telegram-bot|element-login|element-password)$/.test(key)&&typeof id==='string'&&/^[0-9a-f-]{36}$/i.test(id))) as Record<string,string>;}catch{return {};}};
export const mergeProjectMessengerSecretRefs=(content:string|undefined,next:Readonly<Record<string,string>>)=>(
  {...(content===undefined?{}:parseProjectMessengerSecretRefs(content)),...next}
);
export const readProjectMessengerBindings=async(database:Database,actorId:string,projectId:string):Promise<ProjectMessengerBindings>=>{const result=await database.query<{content:string}>(`select source.content_text as content from project_source_artifacts source join project_memberships member on member.project_id=source.project_id and member.actor_id=$2 and member.active=true where source.project_id=$1 and source.kind=$3 order by source.created_at desc,source.id desc limit 1`,[projectId,actorId,projectMessengerBindingsArtifactKind]);return result.rows[0]===undefined?{}:parseProjectMessengerBindings(result.rows[0].content)??{};};
export type ProjectMessengerDeliveryBinding=Readonly<{channel:ProjectMessengerChannel;
  credentialRefs:Readonly<Record<string,OpaqueSecretRef>>}>;
/** Worker-only lookup for outbound delivery through the existing messenger port. */
export const readProjectMessengerDeliveryBinding=async(database:Database,workspaceId:string,projectId:string,
  contour:MessengerContour):Promise<ProjectMessengerDeliveryBinding|null>=>{
  const artifact=await database.query<{content:string}>(`select source.content_text as content from project_source_artifacts source
    join projects project on project.id=source.project_id where source.project_id=$1 and project.workspace_id=$2 and source.kind=$3
    order by source.created_at desc,source.id desc limit 1`,[projectId,workspaceId,projectMessengerBindingsArtifactKind]);
  const content=artifact.rows[0]?.content;if(content===undefined)return null;
  const channel=parseProjectMessengerBindings(content)?.[contour];if(channel===undefined)return null;
  const keys=channel.provider==='telegram'?[`${contour}-telegram-bot`]:
    [`${contour}-element-login`,`${contour}-element-password`];const ids=parseProjectMessengerSecretRefs(content);
  if(keys.some((key)=>ids[key]===undefined))return null;
  const references=await database.query<{id:string;purpose:string;locator:string}>(`select id,purpose,locator from secret_refs
    where workspace_id=$1 and id=any($2::uuid[])`,[workspaceId,keys.map((key)=>ids[key])]);
  const byId=new Map(references.rows.map((secret)=>[secret.id,secret]));const credentials:Record<string,OpaqueSecretRef>={};
  for(const key of keys){const id=ids[key]!;const secret=byId.get(id);const messengerPurpose=`project-messenger:${projectId}:${key}`;
    const internalRuntimePurpose=`project-hermes:${projectId}:telegram-bot`;
    if(secret===undefined||!secret.locator.startsWith('/')||
      (secret.purpose!==messengerPurpose&&!(key==='internal-telegram-bot'&&secret.purpose===internalRuntimePurpose)))return null;
    credentials[key]={id:secret.id,purpose:'messenger_delivery',locator:secret.locator};}
  return {channel,credentialRefs:credentials};
};
export const recordProjectMessengerBinding=async(database:Database,input:Readonly<{
  workspaceId:string;projectId:string;actorId:string;contour:MessengerContour;channel:ProjectMessengerChannel;
  secretRefs:Readonly<Record<string,string>>;idempotencyKey:string;occurredAt:string;
}>):Promise<void>=>{
  const client=await database.connect();
  try{
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[input.idempotencyKey]);
    const receipt=await client.query(`select 1 from command_receipts where project_id=$1 and actor_id=$2
      and idempotency_key=$3 and command_type='project.messenger.bind'`,[input.projectId,input.actorId,input.idempotencyKey]);
    if(receipt.rowCount===1){await client.query('commit');return;}
    const current=await client.query<{content:string}>(`select source.content_text as content
      from project_source_artifacts source join projects project on project.id=source.project_id
      join project_memberships member on member.project_id=project.id and member.actor_id=$3
        and member.active=true and member.role='project_owner'
      where source.project_id=$1 and project.workspace_id=$2 and source.kind=$4
      order by source.created_at desc,source.id desc limit 1 for update`,
      [input.projectId,input.workspaceId,input.actorId,projectMessengerBindingsArtifactKind]);
    const prior=current.rows[0]?.content;
    const bindings=prior===undefined?{}:parseProjectMessengerBindings(prior)??{};
    const secretRefs=mergeProjectMessengerSecretRefs(prior,input.secretRefs);
    const content=JSON.stringify({contract,channels:{...bindings,[input.contour]:input.channel},secretRefs,
      generation:input.idempotencyKey});
    await client.query(`insert into project_source_artifacts(id,project_id,created_by_actor_id,kind,name,media_type,sha256,
      content_text,source_url,provenance) values($1,$2,$3,$4,'Project messenger bindings','application/json',$5,$6,null,
      'operator:project-messenger-bind') on conflict(project_id,kind,sha256) do nothing`,
      [randomUUID(),input.projectId,input.actorId,projectMessengerBindingsArtifactKind,sha(content),content]);
    await client.query(`insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
      values($1,$2,$3,'project.messenger.bind',$4,$5)`,
      [input.projectId,input.actorId,input.idempotencyKey,`${input.contour}:${input.channel.provider}`,input.occurredAt]);
    await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
      values($1,$2,$3,'project.messenger.bind',$4,$5,$6,$7)`,
      [input.workspaceId,input.projectId,input.actorId,`${input.contour}:${input.channel.provider}`,input.idempotencyKey,
        JSON.stringify({contour:input.contour,provider:input.channel.provider,status:input.channel.status}),input.occurredAt]);
    await client.query('commit');
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
};
