import {createHash,randomUUID} from 'node:crypto';
import type {ProjectProcessPolicy} from '@fai-control-plane/domain';
import type {Database} from './runtime.ts';
import type {ProjectTrackerCapabilities} from './project-registration.ts';

export const projectTrackerPreparationKind='project_tracker_preparation_v1';
export const projectTrackerPreparationApprovalKind='project_tracker_preparation_approval_v1';
const contract='fai.project-tracker-preparation.v1' as const;
const resultContract='fai.project-tracker-preparation-result.v1' as const;

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  ?value as Record<string,unknown>:null;
const bounded=(value:unknown,max=2_000):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0');
const delta=(value:unknown):readonly string[]|null=>Array.isArray(value)&&value.length<=100&&value.every((item)=>bounded(item))&&
  new Set(value).size===value.length?value as string[]:null;

export type ProjectTrackerPreparationStatus='not_started'|'configuring'|'approval_required'|'verifying'|'ready'|'blocked';
export type ProjectTrackerPreparationView=Readonly<{status:ProjectTrackerPreparationStatus;version:string|null;
  runId:string|null;remainingDelta:readonly string[];approval:null|Readonly<{id:string;text:string;version:string}>;
  blocker:string|null}>;
export type ProjectTrackerPreparationAttempt=Readonly<{workspaceId:string;projectId:string;actorId:string;
  runId:string;correlationId:string;processVersion:string;remainingDelta:readonly string[]}>;
export type ApprovedProjectTrackerPreparation=Readonly<{workspaceId:string;projectId:string;actorId:string;
  processVersion:string;remainingDelta:readonly string[];approvalVersion:string;correlationId:string}>;

type State=Readonly<{contract:typeof contract;status:Exclude<ProjectTrackerPreparationStatus,'not_started'>;
  runId:string|null;processVersion:string;remainingDelta:readonly string[];approval?:Readonly<{id:string;text:string;version:string}>;
  blocker?:string}>;
const parseState=(content:string):State|null=>{try{const value=object(JSON.parse(content));const remaining=delta(value?.remainingDelta);
  if(value?.contract!==contract||!['configuring','approval_required','verifying','ready','blocked'].includes(String(value.status))||
    (value.runId!==null&&!bounded(value.runId,256))||!bounded(value.processVersion,64)||remaining===null)return null;
  const approvalValue=object(value.approval);const approval=approvalValue!==null&&bounded(approvalValue.id,128)&&
    bounded(approvalValue.text,8_000)&&typeof approvalValue.version==='string'&&/^[a-f0-9]{64}$/.test(approvalValue.version)
    ?{id:approvalValue.id,text:approvalValue.text,version:approvalValue.version}:undefined;
  if(value.status==='approval_required'&&approval===undefined)return null;
  const blocker=value.blocker===undefined?undefined:bounded(value.blocker,2_000)?value.blocker:undefined;
  if(value.status==='blocked'&&blocker===undefined)return null;
  return {contract,status:value.status as State['status'],runId:value.runId as string|null,
    processVersion:value.processVersion as string,remainingDelta:remaining,...(approval===undefined?{}:{approval}),
    ...(blocker===undefined?{}:{blocker})};}catch{return null;}};
const serialized=(state:State)=>{const content=JSON.stringify(state);return {content,version:sha(content)};};

export const readProjectTrackerPreparation=async(database:Database,actorId:string,projectId:string):Promise<ProjectTrackerPreparationView>=>{
  const result=await database.query<{content:string;version:string}>(`select s.content_text as content,s.sha256 as version
    from project_source_artifacts s join project_memberships m on m.project_id=s.project_id
    where s.project_id=$1 and m.actor_id=$2 and m.active=true and s.kind=$3 order by s.created_at desc,s.id desc limit 1`,
  [projectId,actorId,projectTrackerPreparationKind]);const row=result.rows[0];if(row===undefined)return {status:'not_started',version:null,
    runId:null,remainingDelta:[],approval:null,blocker:null};const state=parseState(row.content);if(state===null)return {status:'blocked',
      version:row.version,runId:null,remainingDelta:[],approval:null,blocker:'project_tracker_preparation_invalid'};
  return {status:state.status,version:row.version,runId:state.runId,remainingDelta:state.remainingDelta,
    approval:state.approval??null,blocker:state.blocker??null};};

const insertState=async(client:Pick<Database,'query'>,input:Readonly<{projectId:string;actorId:string;state:State;
  provenance:string}>):Promise<string>=>{const value=serialized(input.state);await client.query(`insert into project_source_artifacts
    (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
    values($1,$2,$3,$4,'Project tracker preparation','application/json',$5,$6,null,$7)
    on conflict(project_id,kind,sha256) do nothing`,[randomUUID(),input.projectId,input.actorId,projectTrackerPreparationKind,
      value.version,value.content,input.provenance]);return value.version;};

export const recordProjectTrackerPreparationStart=async(database:Database,input:Readonly<{workspaceId:string;projectId:string;
  actorId:string;processVersion:string;remainingDelta:readonly string[];idempotencyKey:string;occurredAt:string}>,
  submit:()=>Promise<string>):Promise<ProjectTrackerPreparationView>=>{if(!/^[a-f0-9]{64}$/.test(input.processVersion)||
    delta(input.remainingDelta)===null)throw new Error('project_tracker_preparation_invalid');const client=await database.connect();try{
    await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
      [`project-tracker-preparation:${input.projectId}`]);const allowed=await client.query(`select 1 from project_memberships
      where project_id=$1 and actor_id=$2 and role='project_owner' and active=true for update`,[input.projectId,input.actorId]);
    if(allowed.rowCount!==1)throw new Error('project_tracker_preparation_denied');const prior=await client.query<{reference:string}>(
      `select result_reference as reference from command_receipts where idempotency_key=$1 and command_type='project.tracker-prepare.start'`,
    [input.idempotencyKey]);if(prior.rows[0]!==undefined){await client.query('rollback');return readProjectTrackerPreparation(database,input.actorId,input.projectId);}
    const runId=await submit();if(!/^run_[A-Za-z0-9_-]{1,250}$/.test(runId))throw new Error('project_tracker_preparation_unavailable');
    const state:State={contract,status:'configuring',runId,processVersion:input.processVersion,remainingDelta:input.remainingDelta};
    const version=await insertState(client,{projectId:input.projectId,actorId:input.actorId,state,provenance:'hermes:tracker-preparation'});
    await client.query(`insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
      values($1,$2,$3,'project.tracker-prepare.start',$4,$5)`,[input.projectId,input.actorId,input.idempotencyKey,runId,input.occurredAt]);
    await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
      values($1,$2,$3,'project.tracker-prepare.start',$4,$5,$6,$7)`,[input.workspaceId,input.projectId,input.actorId,
      input.processVersion,input.idempotencyKey,JSON.stringify({runId,remainingDelta:input.remainingDelta}),input.occurredAt]);await client.query('commit');
    return {status:'configuring',version,runId,remainingDelta:input.remainingDelta,approval:null,blocker:null};
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}};

export const listProjectTrackerPreparationAttempts=async(database:Database,workspaceId:string,limit=20):Promise<readonly ProjectTrackerPreparationAttempt[]>=>{
  const result=await database.query<{projectId:string;actorId:string;content:string;correlationId:string}>(`select p.id as "projectId",
    started.actor_id as "actorId",state.content_text as content,started.correlation_id as "correlationId" from projects p
    join lateral(select content_text from project_source_artifacts where project_id=p.id and kind=$2 order by created_at desc,id desc limit 1)state on true
    join lateral(select actor_id,correlation_id from audit_events where project_id=p.id and action='project.tracker-prepare.start'
      order by occurred_at desc,id desc limit 1)started on true where p.workspace_id=$1 order by p.id limit $3`,
  [workspaceId,projectTrackerPreparationKind,limit]);return result.rows.flatMap(row=>{const state=parseState(row.content);return state?.status==='configuring'&&
    state.runId!==null?[{workspaceId,projectId:row.projectId,actorId:row.actorId,runId:state.runId,
      correlationId:row.correlationId,processVersion:state.processVersion,remainingDelta:state.remainingDelta}]:[];});};

export const listApprovedProjectTrackerPreparations=async(database:Database,workspaceId:string,limit=20):Promise<readonly ApprovedProjectTrackerPreparation[]>=>{
  const result=await database.query<{projectId:string;actorId:string;content:string;correlationId:string}>(`select p.id as "projectId",
    approval.actor_id as "actorId",state.content_text as content,started.correlation_id as "correlationId" from projects p
    join lateral(select content_text from project_source_artifacts where project_id=p.id and kind=$2 order by created_at desc,id desc limit 1)state on true
    join lateral(select actor_id,target_reference from approval_evidence where project_id=p.id and kind='internal_operation'
      and decision='approved' order by decided_at desc,id desc limit 1)approval on approval.target_reference=state.content_text::jsonb#>>'{approval,version}'
    join lateral(select correlation_id from audit_events where project_id=p.id and action='project.tracker-prepare.start'
      order by occurred_at desc,id desc limit 1)started on true where p.workspace_id=$1 order by p.id limit $3`,
  [workspaceId,projectTrackerPreparationKind,limit]);return result.rows.flatMap(row=>{const state=parseState(row.content);return state?.status==='approval_required'&&
    state.approval!==undefined?[{workspaceId,projectId:row.projectId,actorId:row.actorId,processVersion:state.processVersion,
      remainingDelta:state.remainingDelta,approvalVersion:state.approval.version,correlationId:row.correlationId}]:[];});};

export const listRejectedProjectTrackerPreparations=async(database:Database,workspaceId:string,limit=20):Promise<readonly ApprovedProjectTrackerPreparation[]>=>{
  const result=await database.query<{projectId:string;actorId:string;content:string;correlationId:string}>(`select p.id as "projectId",
    approval.actor_id as "actorId",state.content_text as content,started.correlation_id as "correlationId" from projects p
    join lateral(select content_text from project_source_artifacts where project_id=p.id and kind=$2 order by created_at desc,id desc limit 1)state on true
    join lateral(select actor_id,target_reference from approval_evidence where project_id=p.id and kind='internal_operation'
      and decision='rejected' order by decided_at desc,id desc limit 1)approval on approval.target_reference=state.content_text::jsonb#>>'{approval,version}'
    join lateral(select correlation_id from audit_events where project_id=p.id and action='project.tracker-prepare.start'
      order by occurred_at desc,id desc limit 1)started on true where p.workspace_id=$1 order by p.id limit $3`,
  [workspaceId,projectTrackerPreparationKind,limit]);return result.rows.flatMap(row=>{const state=parseState(row.content);return state?.status==='approval_required'&&
    state.approval!==undefined?[{workspaceId,projectId:row.projectId,actorId:row.actorId,processVersion:state.processVersion,
      remainingDelta:state.remainingDelta,approvalVersion:state.approval.version,correlationId:row.correlationId}]:[];});};

export type ProjectTrackerPreparationResult=Readonly<{status:'completed';remainingDelta:readonly string[]}|
  {status:'approval_required';remainingDelta:readonly string[];approvalText:string}|
  {status:'blocked';remainingDelta:readonly string[];blocker:string}>;
export const parseProjectTrackerPreparationResult=(output:unknown):ProjectTrackerPreparationResult|null=>{if(typeof output!=='string'||
  new TextEncoder().encode(output).byteLength>16_384)return null;const normalized=output.startsWith('```json\n')&&output.endsWith('\n```')?output.slice(8,-4):output;
  try{const value=object(JSON.parse(normalized));const remaining=delta(value?.remainingDelta);if(value?.contract!==resultContract||remaining===null)return null;
    if(value.status==='completed')return {status:'completed',remainingDelta:remaining};
    if(value.status==='approval_required'&&bounded(value.approvalText,8_000))return {status:'approval_required',remainingDelta:remaining,approvalText:value.approvalText};
    if(value.status==='blocked'&&bounded(value.blocker))return {status:'blocked',remainingDelta:remaining,blocker:value.blocker};return null;}catch{return null;}};

export const recordProjectTrackerPreparationResult=async(database:Database,attempt:ProjectTrackerPreparationAttempt,
  output:unknown):Promise<ProjectTrackerPreparationView>=>{const result=parseProjectTrackerPreparationResult(output);
  if(result===null)throw new Error('project_tracker_preparation_result_invalid');const occurredAt=new Date().toISOString();
  const approval=result.status==='approval_required'?{id:randomUUID(),
    text:result.approvalText,version:sha(result.approvalText)}:undefined;const status=result.status==='completed'?'verifying':result.status;
  const state:State={contract,status,runId:null,processVersion:attempt.processVersion,remainingDelta:result.remainingDelta,
    ...(approval===undefined?{}:{approval}),...(result.status==='blocked'?{blocker:result.blocker}:{})};const client=await database.connect();try{
    await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[attempt.correlationId]);
    const key=`${attempt.correlationId}:result:${attempt.runId}`;const prior=await client.query(`select 1 from command_receipts where idempotency_key=$1`,[key]);
    if(prior.rowCount!==0){await client.query('rollback');return readProjectTrackerPreparation(database,attempt.actorId,attempt.projectId);}
    if(approval!==undefined)await client.query(`insert into project_source_artifacts(id,project_id,created_by_actor_id,kind,name,media_type,
      sha256,content_text,source_url,provenance) values($1,$2,$3,$4,'Project preparation approval','text/plain',$5,$6,null,'hermes:tracker-preparation')
      on conflict(project_id,kind,sha256) do nothing`,[randomUUID(),attempt.projectId,attempt.actorId,projectTrackerPreparationApprovalKind,
      approval.version,approval.text]);const version=await insertState(client,{projectId:attempt.projectId,actorId:attempt.actorId,state,
        provenance:'hermes:tracker-preparation'});await client.query(`insert into command_receipts(project_id,actor_id,idempotency_key,command_type,
      result_reference,occurred_at) values($1,$2,$3,'project.tracker-prepare.result',$4,$5)`,[attempt.projectId,attempt.actorId,key,
      approval?.version??version,occurredAt]);await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,
      correlation_id,details,occurred_at) values($1,$2,$3,$4,$5,$6,$7,$8)`,[attempt.workspaceId,attempt.projectId,attempt.actorId,
      `project.tracker-prepare.${status}`,approval?.version??attempt.processVersion,key,JSON.stringify({runId:attempt.runId,
        remainingDelta:result.remainingDelta}),occurredAt]);
    if(approval!==undefined)await client.query(`insert into outbox_events(project_id,topic,idempotency_key,payload,available_at)
      select $1,'messenger-notification',$2,$3,$4 where exists(select 1 from project_source_artifacts where project_id=$1
        and kind='project_hermes_runtime_v2' and content_text::jsonb ? 'telegram') on conflict(idempotency_key) do nothing`,
    [attempt.projectId,`${key}:notify`,JSON.stringify({message:{projectId:attempt.projectId,contour:'trusted-main',
      channelReference:'telegram:internal',text:approval.text,idempotencyKey:`${key}:notify`}}),occurredAt]);await client.query('commit');
    return {status,version,runId:null,remainingDelta:result.remainingDelta,approval:approval??null,
      blocker:result.status==='blocked'?result.blocker:null};}catch(error){await client.query('rollback');throw error;}finally{client.release();}};

export const recordVerifiedProjectTrackerCapabilities=async(database:Database,input:Readonly<{attempt:ProjectTrackerPreparationAttempt;
  capabilities:ProjectTrackerCapabilities;occurredAt:string}>):Promise<void>=>{const value={contract:'fai.project-tracker-capabilities.v1',...input.capabilities};
  const content=JSON.stringify(value);const version=sha(content);const state:State={contract,status:'ready',runId:null,
    processVersion:input.attempt.processVersion,remainingDelta:[]};const client=await database.connect();try{await client.query('begin');
    await client.query(`insert into project_source_artifacts(id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,
      source_url,provenance) values($1,$2,$3,'project_tracker_capabilities_v1','Project tracker capabilities','application/json',$4,$5,null,
      'control-plane:github-readback') on conflict(project_id,kind,sha256) do nothing`,[randomUUID(),input.attempt.projectId,
      input.attempt.actorId,version,content]);await insertState(client,{projectId:input.attempt.projectId,actorId:input.attempt.actorId,state,
        provenance:'control-plane:github-readback'});const key=`${input.attempt.correlationId}:verified:${version}`;
    await client.query(`insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
      values($1,$2,$3,'project.tracker-prepare.verified',$4,$5) on conflict(idempotency_key) do nothing`,[input.attempt.projectId,
      input.attempt.actorId,key,version,input.occurredAt]);await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,
      target_reference,correlation_id,details,occurred_at) values($1,$2,$3,'project.tracker-prepare.ready',$4,$5,$6,$7)`,
    [input.attempt.workspaceId,input.attempt.projectId,input.attempt.actorId,version,key,JSON.stringify({provider:'github'}),input.occurredAt]);
    await client.query('commit');}catch(error){await client.query('rollback');throw error;}finally{client.release();}};

export const recordProjectTrackerPreparationBlocker=async(database:Database,input:Readonly<{workspaceId:string;projectId:string;
  actorId:string;processVersion:string;remainingDelta:readonly string[];correlationId:string;blocker:string;occurredAt:string}>)=>{
  if(delta(input.remainingDelta)===null||!bounded(input.blocker))throw new Error('project_tracker_preparation_invalid');
  const state:State={contract,status:'blocked',runId:null,processVersion:input.processVersion,remainingDelta:input.remainingDelta,
    blocker:input.blocker};const client=await database.connect();try{await client.query('begin');const version=await insertState(client,{projectId:input.projectId,
      actorId:input.actorId,state,provenance:'control-plane:github-readback'});const key=`${input.correlationId}:blocked:${sha(JSON.stringify(input.remainingDelta))}`;
    await client.query(`insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
      values($1,$2,$3,'project.tracker-prepare.blocked',$4,$5) on conflict(idempotency_key) do nothing`,[input.projectId,input.actorId,key,version,input.occurredAt]);
    await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
      values($1,$2,$3,'project.tracker-prepare.blocked',$4,$5,$6,$7)`,[input.workspaceId,input.projectId,input.actorId,
      input.processVersion,key,JSON.stringify({remainingDelta:input.remainingDelta,blocker:input.blocker}),input.occurredAt]);
    await client.query(`insert into outbox_events(project_id,topic,idempotency_key,payload,available_at) select $1,'messenger-notification',$2,$3,$4
      where exists(select 1 from project_source_artifacts where project_id=$1 and kind='project_hermes_runtime_v2' and content_text::jsonb ? 'telegram')
      on conflict(idempotency_key) do nothing`,[input.projectId,`${key}:notify`,JSON.stringify({message:{projectId:input.projectId,
        contour:'trusted-main',channelReference:'telegram:internal',text:input.blocker,idempotencyKey:`${key}:notify`}}),input.occurredAt]);
    await client.query('commit');return version;}catch(error){await client.query('rollback');throw error;}finally{client.release();}};

export const projectTrackerPreparationAssignment=(input:Readonly<{repositoryUrl:string;projectUrl:string;process:ProjectProcessPolicy;
  remainingDelta:readonly string[]}>)=>({input:JSON.stringify({contract:'fai.project-tracker-preparation-assignment.v1',repository:input.repositoryUrl,
    tracker:input.projectUrl,confirmedProcess:input.process,requiredFields:{Owner:['Hermes'],Blocked:['No','Yes']},
    remainingDelta:input.remainingDelta}),instructions:`Bring the bound GitHub Project to exactly the confirmed process using gh directly. Control Plane will only verify readback. Make safe idempotent additions and configuration. Before any deletion or removal of foreign repository items, return approval_required with one exact human-readable approvalText and do not perform those changes. Return only JSON: {contract:"${resultContract}",status:"completed"|"approval_required"|"blocked",remainingDelta:string[],approvalText?:string,blocker?:string}.`,
  provider:'openai-codex',model:'gpt-5.6-sol',model_options:{reasoning_effort:'medium'},orchestration:{kind:'project-tracker-preparation',attempts:1}});
