import {createHash} from 'node:crypto';
import {
  actorForSession,projectAgentProfileTemplateVersion,
  projectTrackerPreparationAssignment,readActiveProjectDocumentSet,readLatestCompactProjectContext,
  readProjectAgentProfile,readProjectDocumentPayload,readProjectHermesRuntimeBinding,readProjectProcessPolicy,
  readProjectTrackerPreparation,recordProjectAgentBootstrapStart,recordProjectAgentProfile,
  recordProjectTrackerPreparationStart,resolveAgentSubmissionBinding,type Database,type ProjectAgentProfileView
} from '@fai-control-plane/db';
import {projectRuntimeSecrets} from './runtime-secrets.ts';

type CookieClient=Readonly<{request:(path:string,init?:RequestInit)=>Promise<Response>}>;
const dashboardClient=async(runtime:NonNullable<Awaited<ReturnType<typeof readProjectHermesRuntimeBinding>>>):Promise<CookieClient>=>{
  const endpoint=new URL(runtime.dashboardEndpoint);const gateway=new URL(runtime.gatewayEndpoint);
  if(endpoint.toString()!==`http://${runtime.runtimeId}-gateway:9119/`||
    gateway.toString()!==`http://${runtime.runtimeId}-gateway:8642/v1/runs`)throw new Error('agent_profile_unavailable');
  const username=(await projectRuntimeSecrets.resolve(runtime.dashboardUsernameRef,'hermes_dashboard_username')).value;
  const password=(await projectRuntimeSecrets.resolve(runtime.dashboardPasswordRef,'hermes_dashboard_password')).value;
  const login=await fetch(new URL('/auth/password-login',endpoint),{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({provider:'basic',username,password}),signal:AbortSignal.timeout(10_000)});
  if(!login.ok)throw new Error('agent_profile_unavailable');
  const values=typeof login.headers.getSetCookie==='function'?login.headers.getSetCookie():[login.headers.get('set-cookie')??''];
  const cookie=values.map((value)=>value.split(';',1)[0]).filter(Boolean).join('; ');
  return {request:(path,init)=>fetch(new URL(path,endpoint),{...init,headers:{cookie,...(init?.headers??{})},
    signal:AbortSignal.timeout(10_000)})};
};
const expectJson=async<T>(response:Response):Promise<T>=>{
  if(!response.ok)throw new Error('agent_profile_unavailable');return response.json() as Promise<T>;
};
const capabilities=async(endpoint:string,token:string)=>{
  const response=await fetch(new URL('/v1/capabilities',new URL(endpoint)),{headers:{authorization:`Bearer ${token}`},
    signal:AbortSignal.timeout(2_000)}).catch(()=>null);
  if(!response?.ok)return false;const value=await response.json().catch(()=>null) as {object?:unknown}|null;
  return value?.object==='hermes.api_server.capabilities';
};
const stagingName=(index:number,name:string)=>{
  const extension=/\.(docx|pdf|md|txt)$/i.exec(name)?.[0].toLowerCase();
  if(extension===undefined)throw new Error('project_document_invalid');return `${String(index+1).padStart(2,'0')}${extension}`;
};
export const stageProjectDocuments=async(client:CookieClient,database:Database,input:Readonly<{actorId:string;projectId:string;
  workDirectory:string;documents:Awaited<ReturnType<typeof readActiveProjectDocumentSet>>['documents']}>)=>{
  const root=`${input.workDirectory}/.fai-context/source`;
  const removed=await client.request('/api/files',{method:'DELETE',headers:{'content-type':'application/json'},
    body:JSON.stringify({path:root,recursive:true})});
  if(!removed.ok&&removed.status!==404)await expectJson(removed);
  await expectJson(await client.request('/api/files/mkdir',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({path:root})}));const paths:string[]=[];
  const documents=input.documents.slice().sort((left,right)=>left.artifactKind.localeCompare(right.artifactKind)||
    left.sha256.localeCompare(right.sha256));
  for(const [index,document] of documents.entries()){
    const payload=await readProjectDocumentPayload(database,input.actorId,input.projectId,document.id);
    if(payload===null)throw new Error('project_document_unavailable');const path=`${root}/${stagingName(index,payload.name)}`;
    const form=new FormData();form.set('path',path);form.set('overwrite','true');
    form.set('file',new Blob([new Uint8Array(payload.bytes)],{type:payload.mediaType}),payload.name);
    await expectJson(await client.request('/api/files/upload-stream',{method:'POST',body:form}));paths.push(path);
  }return paths;
};
const restoreContext=async(client:CookieClient,database:Database,input:Readonly<{actorId:string;projectId:string;
  workDirectory:string;fingerprint:string}>)=>{
  const compact=await readLatestCompactProjectContext(database,input.actorId,input.projectId,input.fingerprint);
  if(compact===null)throw new Error('project_context_not_configured');const form=new FormData();
  form.set('path',`${input.workDirectory}/PROJECT_CONTEXT.md`);form.set('overwrite','true');
  form.set('file',new Blob([compact.content],{type:'text/markdown'}),'PROJECT_CONTEXT.md');
  await expectJson(await client.request('/api/files/upload-stream',{method:'POST',body:form}));
};
const startBootstrap=async(input:Readonly<{endpoint:string;token:string;slug:string;repositoryUrl:string;projectUrl:string;
  workDirectory:string;fingerprint:string;architecturePresent:boolean;paths:readonly string[];reason:string}>)=>{
  const response=await fetch(input.endpoint,{method:'POST',headers:{accept:'application/json',authorization:`Bearer ${input.token}`,
    'content-type':'application/json'},body:JSON.stringify({input:JSON.stringify({contract:'fai.project-context-bootstrap.v1',
      repository:input.repositoryUrl,githubProject:input.projectUrl,documentFingerprint:input.fingerprint,
      stagedDocuments:input.paths,architectureOriginalPresent:input.architecturePresent,
      contextFile:`${input.workDirectory}/PROJECT_CONTEXT.md`}),instructions:'Read the staged exact project documents, repository and the bound GitHub Project natively. Produce a compact project context and write exactly that context to the contextFile from the input before returning. Then return only compact JSON (max 65536 UTF-8 bytes): {contract:"fai.project-context-result.v1",context:string,architectureProposal:string|null}. Never copy full source documents. When an Architecture original is absent, include the proposed architecture in the context and return the same bounded proposal separately; otherwise architectureProposal must be null. Do not mutate tasks, repository, deployment or production.',
      session_id:`project-context-${input.slug}-${input.fingerprint.slice(0,16)}`,provider:'openai-codex',
      model:input.architecturePresent?'gpt-5.6-terra':'gpt-5.6-sol',model_options:{reasoning_effort:'medium'},
      orchestration:{kind:'project-context-bootstrap',attempts:1,reason:input.reason}}),signal:AbortSignal.timeout(15_000)});
  if(response.status!==202)throw new Error('agent_profile_unavailable');const value=await response.json().catch(()=>null) as
    {run_id?:unknown;status?:unknown}|null;
  if(typeof value?.run_id!=='string'||!/^run_[A-Za-z0-9_-]{1,250}$/.test(value.run_id)||value.status!=='started')
    throw new Error('agent_profile_unavailable');return value.run_id;
};
const activate=async(database:Database,input:Readonly<{workspaceId:string;actorId:string;projectId:string;
  idempotencyKey:string;force?:boolean}>):Promise<ProjectAgentProfileView>=>{
  const [binding,runtime,stored,documentSet]=await Promise.all([resolveAgentSubmissionBinding(database,input.actorId,input.projectId),
    readProjectHermesRuntimeBinding(database,input.actorId,input.projectId),readProjectAgentProfile(database,input.actorId,input.projectId),
    readActiveProjectDocumentSet(database,input.actorId,input.projectId)]);
  if(binding===null||runtime===null||binding.requesterRole!=='project_owner')throw new Error('agent_profile_denied');
  if(!documentSet.configured)throw new Error('project_documents_required');
  if(['configuring','awaiting_architecture'].includes(stored.status)&&stored.documentFingerprint===documentSet.fingerprint)return stored;
  const token=(await projectRuntimeSecrets.resolve(runtime.agentCredentialRef,'agent_delivery')).value;
  const project=await database.query<{slug:string}>('select slug from projects where id=$1 and workspace_id=$2',
    [input.projectId,input.workspaceId]);const slug=project.rows[0]?.slug;if(slug===undefined)throw new Error('agent_profile_denied');
  const profile=runtime.runtimeId;const client=await dashboardClient(runtime);const changed=stored.documentFingerprint!==documentSet.fingerprint;
  const compact=changed?null:await readLatestCompactProjectContext(database,input.actorId,input.projectId,documentSet.fingerprint);
  if(!await capabilities(runtime.gatewayEndpoint,token))throw new Error('agent_profile_probe_failed');
  if(!changed&&compact!==null){if(input.force===true||stored.status!=='ready')await restoreContext(client,database,{actorId:input.actorId,
    projectId:input.projectId,workDirectory:runtime.workspacePath,fingerprint:documentSet.fingerprint});if(stored.status==='ready')return stored;
    return recordProjectAgentProfile(database,{...input,profile,endpointPath:'/v1/runs',templateVersion:projectAgentProfileTemplateVersion,
      documentFingerprint:documentSet.fingerprint,idempotencyKey:`project-context-restore:${input.projectId}:${profile}:${documentSet.fingerprint}`,
      occurredAt:new Date().toISOString()});}
  const paths=await stageProjectDocuments(client,database,{actorId:input.actorId,projectId:input.projectId,
    workDirectory:runtime.workspacePath,documents:documentSet.documents});
  const reason=stored.profile===null?'initial':stored.profile!==runtime.runtimeId?'agent_replaced':changed?'documents_changed':'manual';
  const attemptSeed=stored.status==='error'?input.idempotencyKey:'first';
  return recordProjectAgentBootstrapStart(database,{...input,idempotencyKey:`project-context:${input.projectId}:${profile}:${documentSet.fingerprint}:${attemptSeed}`,
    profile,endpointPath:'/v1/runs',documentFingerprint:documentSet.fingerprint,architecturePresent:documentSet.architecturePresent,
    reason,occurredAt:new Date().toISOString()},()=>startBootstrap({endpoint:runtime.gatewayEndpoint,token,slug,
      repositoryUrl:binding.repositoryUrl,projectUrl:binding.projectUrl,workDirectory:runtime.workspacePath,
      fingerprint:documentSet.fingerprint,architecturePresent:documentSet.architecturePresent,paths,reason}));
};
const prepareTracker=async(database:Database,input:Readonly<{workspaceId:string;actorId:string;projectId:string;
  idempotencyKey:string}>)=>{const current=await readProjectTrackerPreparation(database,input.actorId,input.projectId);
  if(['configuring','approval_required','verifying','ready'].includes(current.status))return current;
  const [binding,runtime,profile,process]=await Promise.all([resolveAgentSubmissionBinding(database,input.actorId,input.projectId),
    readProjectHermesRuntimeBinding(database,input.actorId,input.projectId),readProjectAgentProfile(database,input.actorId,input.projectId),
    readProjectProcessPolicy(database,input.actorId,input.projectId)]);
  if(binding===null||runtime===null||binding.requesterRole!=='project_owner')throw new Error('project_tracker_preparation_denied');
  if(profile.status!=='ready')throw new Error('agent_profile_not_ready');if(process===null)throw new Error('project_process_not_configured');
  const token=(await projectRuntimeSecrets.resolve(runtime.agentCredentialRef,'agent_delivery')).value;
  const remainingDelta=current.remainingDelta.length===0?[`Status: ${process.policy.stages.map((stage)=>stage.title).join(' -> ')}`,
    'Owner: Hermes','Blocked: No, Yes']:current.remainingDelta;
  const assignment=projectTrackerPreparationAssignment({repositoryUrl:binding.repositoryUrl,projectUrl:binding.projectUrl,
    process:process.policy,remainingDelta});return recordProjectTrackerPreparationStart(database,{...input,processVersion:process.version,
    remainingDelta,occurredAt:new Date().toISOString()},async()=>{const response=await fetch(runtime.gatewayEndpoint,{method:'POST',
      headers:{accept:'application/json',authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify(assignment),signal:AbortSignal.timeout(15_000)});if(response.status!==202)
      throw new Error('project_tracker_preparation_unavailable');const value=await response.json().catch(()=>null) as
      {run_id?:unknown;status?:unknown}|null;if(typeof value?.run_id!=='string'||value.status!=='started')
      throw new Error('project_tracker_preparation_unavailable');return value.run_id;});};

const requestBody=async(request:Request)=>{const text=await request.text();if(text.length===0||text.length>8_192)
  throw new Error('body_invalid');const value=JSON.parse(text) as unknown;if(value===null||typeof value!=='object'||Array.isArray(value))
  throw new Error('body_invalid');return value as Record<string,unknown>;};
const required=(value:unknown,max:number)=>{if(typeof value!=='string'||value.length===0||value.length>max||value.includes('\0'))
  throw new Error('body_invalid');return value;};
export const projectOnboardingCommand=async(database:Database,request:Request,projectId:string,
  kind:'agent-profile'|'tracker-preparation'):Promise<Response>=>{try{
    if(request.method!=='POST')return new Response(null,{status:405});const cookie=request.headers.get('cookie')??'';
    const sessionToken=/(?:^|;\s*)fai_session=([^;]+)/.exec(cookie)?.[1];if(sessionToken===undefined)
      throw new Error('authentication_required');const session=await actorForSession(database,
        createHash('sha256').update(decodeURIComponent(sessionToken)).digest('hex'));if(session===null)
      throw new Error('authentication_required');const value=await requestBody(request);const idempotencyKey=required(value.idempotencyKey,128);
    const result=kind==='agent-profile'?await activate(database,{workspaceId:session.workspaceId,actorId:session.actorId,
      projectId,idempotencyKey,force:value.force===true}):await prepareTracker(database,{workspaceId:session.workspaceId,
        actorId:session.actorId,projectId,idempotencyKey});return Response.json(result);
  }catch(error){const code=error instanceof Error?error.message:'request_failed';return Response.json({error:code},{status:
    code==='authentication_required'?401:code.endsWith('_denied')?403:code.includes('unavailable')||code.includes('probe_failed')?502:400});}};
