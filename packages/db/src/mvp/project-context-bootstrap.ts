import {createHash,randomUUID} from 'node:crypto';
import {projectAgentProfileTemplateVersion,type ProjectAgentProfileView} from './project-registration.ts';
import type {Database} from './runtime.ts';

export type ProjectContextBootstrapAttempt=Readonly<{workspaceId:string;projectId:string;actorId:string;profile:string;
  endpointPath:string;deliveryReference:string;documentFingerprint:string;architecturePresent:boolean;
  agentSecretId:string;agentSecretLocator:string;correlationId:string}>;

const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  ?value as Record<string,unknown>:null;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const profileValue=(input:Readonly<{status:'ready'|'awaiting_architecture'|'error';profile:string;endpointPath:string;
  documentFingerprint:string;contextSha?:string;proposalSha?:string;failureCode?:string}>)=>({
  contract:'fai.project-agent-profile.v1',status:input.status,profile:input.profile,endpointPath:input.endpointPath,
  templateVersion:projectAgentProfileTemplateVersion,documentFingerprint:input.documentFingerprint,
  ...(input.contextSha===undefined?{}:{contextSha:input.contextSha}),
  ...(input.proposalSha===undefined?{}:{proposalSha:input.proposalSha}),
  ...(input.failureCode===undefined?{}:{failureCode:input.failureCode})});

export const listProjectContextBootstrapAttempts=async(database:Database,workspaceId:string,limit=20):Promise<readonly ProjectContextBootstrapAttempt[]>=>{
  const result=await database.query<{workspaceId:string;projectId:string;actorId:string;content:string;
    agentSecretId:string;agentSecretLocator:string;correlationId:string;targetReference:string}>(`select p.workspace_id as "workspaceId",p.id as "projectId",
    a.actor_id as "actorId",profile.content_text as content,secret.id as "agentSecretId",secret.locator as "agentSecretLocator",
    a.correlation_id as "correlationId",a.target_reference as "targetReference" from projects p
    join secret_refs secret on secret.workspace_id=p.workspace_id and secret.purpose='agent_delivery'
    join lateral(select content_text from project_source_artifacts where project_id=p.id and kind='project_agent_profile_v1'
      order by created_at desc,id desc limit 1)profile on true
    join lateral(select actor_id,correlation_id,target_reference from audit_events where project_id=p.id and action='project.context-bootstrap.start'
      order by occurred_at desc limit 1)a on true
    where p.workspace_id=$1 order by p.id limit $2`,[workspaceId,limit]);
  return result.rows.flatMap(row=>{let value:Record<string,unknown>|null=null;try{value=object(JSON.parse(row.content));}
    catch{return [];}
    return value?.status==='configuring'&&typeof value.profile==='string'&&typeof value.endpointPath==='string'&&typeof value.bootstrapRunId==='string'&&
      typeof value.documentFingerprint==='string'&&typeof value.architecturePresent==='boolean'&&row.agentSecretLocator.startsWith('/')
      &&row.targetReference===value.documentFingerprint
      ?[{workspaceId:row.workspaceId,projectId:row.projectId,actorId:row.actorId,profile:value.profile,
        endpointPath:value.endpointPath,deliveryReference:value.bootstrapRunId,documentFingerprint:value.documentFingerprint,
        architecturePresent:value.architecturePresent,agentSecretId:row.agentSecretId,
        agentSecretLocator:row.agentSecretLocator,correlationId:row.correlationId}]:[];});
};

const parseResult=(output:unknown,architecturePresent:boolean):Readonly<{context:string;proposal:string|null}>|null=>{
  if(typeof output!=='string'||new TextEncoder().encode(output).byteLength>65_536)return null;
  const normalized=output.startsWith('```json\n')&&output.endsWith('\n```')?output.slice(8,-4):output;
  try{const value=object(JSON.parse(normalized));const context=value?.context;const proposal=value?.architectureProposal;
    if(value?.contract!=='fai.project-context-result.v1'||typeof context!=='string'||context.length<1||
      new TextEncoder().encode(context).byteLength>49_152||
      (proposal!==null&&(typeof proposal!=='string'||proposal.length<1||new TextEncoder().encode(proposal).byteLength>16_384))||
      (architecturePresent?proposal!==null:typeof proposal!=='string'))return null;
    return {context,proposal:proposal as string|null};}catch{return null;}
};

export const completeProjectContextBootstrap=async(database:Database,attempt:ProjectContextBootstrapAttempt,
  output:unknown):Promise<ProjectAgentProfileView>=>{
  const result=parseResult(output,attempt.architecturePresent);if(result===null)throw new Error('project_context_result_invalid');
  const contextSha=sha(result.context);const proposalSha=result.proposal===null?undefined:sha(result.proposal);
  const status=result.proposal===null?'ready' as const:'awaiting_architecture' as const;
  const value=profileValue({status,profile:attempt.profile,endpointPath:attempt.endpointPath,
    documentFingerprint:attempt.documentFingerprint,contextSha,
    ...(proposalSha===undefined?{}:{proposalSha})});
  const content=JSON.stringify(value);const version=sha(content);const occurredAt=new Date().toISOString();
  const client=await database.connect();try{await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[attempt.correlationId]);
    const prior=await client.query(`select 1 from command_receipts where idempotency_key=$1`,[`${attempt.correlationId}:complete`]);
    if(prior.rowCount!==0){await client.query('rollback');return {status,profile:attempt.profile,
      endpointPath:attempt.endpointPath,version,documentFingerprint:attempt.documentFingerprint};}
    await client.query(`insert into project_source_artifacts(id,project_id,created_by_actor_id,kind,name,media_type,sha256,
      content_text,source_url,provenance) values($1,$2,$3,$4,'Compact project context','text/markdown',
      $5,$6,null,'hermes:context-bootstrap') on conflict(project_id,kind,sha256) do nothing`,
    [randomUUID(),attempt.projectId,attempt.actorId,`project_context_compact_v1:${attempt.documentFingerprint}`,
      contextSha,result.context]);
    if(result.proposal!==null)await client.query(`insert into project_source_artifacts(id,project_id,created_by_actor_id,kind,
      name,media_type,sha256,content_text,source_url,provenance) values($1,$2,$3,'project_architecture_proposal_v1',
      'Architecture proposal','text/markdown',$4,$5,null,'hermes:context-bootstrap')
      on conflict(project_id,kind,sha256) do nothing`,[randomUUID(),attempt.projectId,attempt.actorId,proposalSha,result.proposal]);
    await client.query(`insert into project_source_artifacts(id,project_id,created_by_actor_id,kind,name,media_type,sha256,
      content_text,source_url,provenance) values($1,$2,$3,'project_agent_profile_v1','Project AI agent profile',
      'application/json',$4,$5,null,'hermes:context-bootstrap') on conflict(project_id,kind,sha256) do nothing`,
    [randomUUID(),attempt.projectId,attempt.actorId,version,content]);
    await client.query(`insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
      values($1,$2,$3,'project.context-bootstrap.complete',$4,$5)`,
    [attempt.projectId,attempt.actorId,`${attempt.correlationId}:complete`,contextSha,occurredAt]);
    await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,
      details,occurred_at) values($1,$2,$3,'project.context-bootstrap.complete',$4,$5,$6,$7)`,
    [attempt.workspaceId,attempt.projectId,attempt.actorId,attempt.documentFingerprint,attempt.correlationId,
      JSON.stringify({status,deliveryReference:attempt.deliveryReference,contextSha,...(proposalSha===undefined?{}:{proposalSha})}),occurredAt]);
    const text=status==='ready'?'Контекст проекта настроен. ИИ агент готов к работе.':
      'Контекст проекта собран. Требуется точное согласование архитектурного предложения в настройках проекта.';
    await client.query(`insert into outbox_events(project_id,topic,idempotency_key,payload,available_at)
      values($1,'messenger-notification',$2,$3,$4) on conflict(idempotency_key) do nothing`,[attempt.projectId,
      `${attempt.correlationId}:complete:notify`,JSON.stringify({message:{projectId:attempt.projectId,contour:'trusted-main',
        channelReference:'telegram:internal',text,idempotencyKey:`${attempt.correlationId}:complete:notify`}}),occurredAt]);
    await client.query('commit');return {status,profile:attempt.profile,endpointPath:attempt.endpointPath,version,
      documentFingerprint:attempt.documentFingerprint};}catch(error){await client.query('rollback');throw error;}finally{client.release();}
};

export const readProjectArchitectureProposal=async(database:Database,actorId:string,projectId:string,
  proposalSha:string):Promise<Readonly<{content:string;sha256:string}>|null>=>{
  if(!/^[a-f0-9]{64}$/.test(proposalSha))return null;
  const result=await database.query<{content:string;sha256:string}>(`select s.content_text as content,s.sha256
    from project_source_artifacts s join project_memberships m on m.project_id=s.project_id
    where s.project_id=$1 and m.actor_id=$2 and m.active=true and s.kind='project_architecture_proposal_v1'
      and s.sha256=$3 limit 1`,[projectId,actorId,proposalSha]);
  return result.rows[0]??null;
};

export const failProjectContextBootstrap=async(database:Database,attempt:ProjectContextBootstrapAttempt,
  failureCode:string):Promise<void>=>{const value=profileValue({status:'error',profile:attempt.profile,
    endpointPath:attempt.endpointPath,documentFingerprint:attempt.documentFingerprint,failureCode});
  const content=JSON.stringify(value);const occurredAt=new Date().toISOString();const client=await database.connect();try{
    await client.query('begin');await client.query(`insert into project_source_artifacts(id,project_id,created_by_actor_id,
      kind,name,media_type,sha256,content_text,source_url,provenance) values($1,$2,$3,'project_agent_profile_v1',
      'Project AI agent profile','application/json',$4,$5,null,'hermes:context-bootstrap') on conflict(project_id,kind,sha256) do nothing`,
    [randomUUID(),attempt.projectId,attempt.actorId,sha(content),content]);
    await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,
      details,occurred_at) values($1,$2,$3,'project.context-bootstrap.failed',$4,$5,$6,$7)`,[attempt.workspaceId,
      attempt.projectId,attempt.actorId,attempt.documentFingerprint,attempt.correlationId,
      JSON.stringify({deliveryReference:attempt.deliveryReference,failureCode}),occurredAt]);
    await client.query(`insert into outbox_events(project_id,topic,idempotency_key,payload,available_at)
      values($1,'messenger-notification',$2,$3,$4) on conflict(idempotency_key) do nothing`,[attempt.projectId,
      `${attempt.correlationId}:failed:notify`,JSON.stringify({message:{projectId:attempt.projectId,contour:'trusted-main',
        channelReference:'telegram:internal',text:'Настройка контекста проекта завершилась ошибкой. Повторите настройку.',
        idempotencyKey:`${attempt.correlationId}:failed:notify`}}),occurredAt]);await client.query('commit');
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}};

export const promoteApprovedProjectArchitectures=async(database:Database,workspaceId:string):Promise<number>=>{
  const candidates=await database.query<{projectId:string;actorId:string;content:string}>(`select p.id as "projectId",
    approval.actor_id as "actorId",profile.content_text as content from projects p
    join lateral(select content_text from project_source_artifacts where project_id=p.id and kind='project_agent_profile_v1'
      order by created_at desc,id desc limit 1)profile on (profile.content_text::jsonb->>'status')='awaiting_architecture'
    join approval_evidence approval on approval.project_id=p.id and approval.kind='plan' and approval.decision='approved'
      and approval.target_reference=profile.content_text::jsonb->>'proposalSha'
      and approval.target_version=profile.content_text::jsonb->>'proposalSha'
    where p.workspace_id=$1`,[workspaceId]);
  let promoted=0;
  for(const candidate of candidates.rows){const current=object(JSON.parse(candidate.content));
    if(typeof current?.profile!=='string'||typeof current.endpointPath!=='string'||
      typeof current.documentFingerprint!=='string'||typeof current.contextSha!=='string'||
      typeof current.proposalSha!=='string')continue;
    const value=profileValue({status:'ready',profile:current.profile,endpointPath:current.endpointPath,
      documentFingerprint:current.documentFingerprint,contextSha:current.contextSha,proposalSha:current.proposalSha});
    const content=JSON.stringify(value);const version=sha(content);const key=`project-architecture:${candidate.projectId}:${current.proposalSha}`;
    const client=await database.connect();try{await client.query('begin');
      const receipt=await client.query(`insert into command_receipts(project_id,actor_id,idempotency_key,command_type,
        result_reference,occurred_at) values($1,$2,$3,'project.architecture.approve',$4,now())
        on conflict(idempotency_key) do nothing returning id`,[candidate.projectId,candidate.actorId,key,current.proposalSha]);
      if(receipt.rowCount!==1){await client.query('rollback');continue;}
      await client.query(`insert into project_source_artifacts(id,project_id,created_by_actor_id,kind,name,media_type,
        sha256,content_text,source_url,provenance) values($1,$2,$3,'project_agent_profile_v1','Project AI agent profile',
        'application/json',$4,$5,null,'product-owner:architecture-approval')
        on conflict(project_id,kind,sha256) do nothing`,[randomUUID(),candidate.projectId,candidate.actorId,version,content]);
      await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,
        details,occurred_at) values($1,$2,$3,'project.architecture.approved',$4,$5,$6,now())`,[workspaceId,
        candidate.projectId,candidate.actorId,current.proposalSha,key,JSON.stringify({profile:current.profile,
          documentFingerprint:current.documentFingerprint})]);
      await client.query(`insert into outbox_events(project_id,topic,idempotency_key,payload,available_at)
        values($1,'messenger-notification',$2,$3,now()) on conflict(idempotency_key) do nothing`,[candidate.projectId,
        `${key}:notify`,JSON.stringify({message:{projectId:candidate.projectId,contour:'trusted-main',
          channelReference:'telegram:internal',text:'Архитектурное предложение согласовано. ИИ агент готов к работе.',
          idempotencyKey:`${key}:notify`}})]);await client.query('commit');promoted+=1;
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}}
  return promoted;
};
