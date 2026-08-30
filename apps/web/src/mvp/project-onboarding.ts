import {
  readProjectAgentProfile,
  readLatestCompactProjectContext,
  readActiveProjectDocumentSet,
  readProjectDocumentPayload,
  readProjectHermesRuntimeBinding,
  readProjectProcessPolicy,
  readProjectTrackerPreparation,
  recordProjectAgentBootstrapStart,
  recordProjectAgentProfile,
  recordProjectTrackerPreparationStart,
  projectTrackerPreparationAssignment,
  projectAgentProfileTemplateVersion,
  registerProject,
  resolveAgentSubmissionBinding,
  type Database,
  type ProjectAgentProfileView
} from '@fai-control-plane/db';
import {type OpaqueSecretRef} from '@fai-control-plane/domain';
import {secretResolver} from './runtime.ts';

const githubUrls = (projectValue: string, repositoryValue: string) => {
  const projectUrl = new URL(projectValue);
  const repositoryUrl = new URL(repositoryValue);
  const project = /^\/users\/([^/]+)\/projects\/(\d+)\/?$/.exec(projectUrl.pathname);
  const repository = /^\/([^/]+)\/([^/]+)\/?$/.exec(repositoryUrl.pathname);
  if (projectUrl.origin !== 'https://github.com' || repositoryUrl.origin !== 'https://github.com' ||
    project === null || repository === null || project[1]!.toLowerCase() !== repository[1]!.toLowerCase()) {
    throw new Error('github_binding_invalid');
  }
  return {
    projectUrl: projectUrl.toString().replace(/\/$/, ''), repositoryUrl: repositoryUrl.toString().replace(/\/$/, ''), owner: project[1]!,
    projectNumber: Number(project[2]), repository: repository[2]!
  };
};
const githubTokenRef = (): OpaqueSecretRef => ({id: 'GITHUB_PROJECTS_TOKEN', purpose: 'tracker_read',
  locator: process.env.GITHUB_PROJECTS_TOKEN_FILE ?? ''});
const githubRequest = async (url: string, token: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(url, {...init, headers: {accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', ...(init?.headers ?? {})},
  signal: AbortSignal.timeout(15_000)});
  if (!response.ok) throw new Error('github_read_failed');
  return response;
};

export const resolveAndRegisterProject = async (database: Database, input: Readonly<{
  workspaceId: string; actorId: string; name: string; slug: string; projectUrl: string;
  repositoryUrl: string; idempotencyKey: string;
}>) => {
  const urls = githubUrls(input.projectUrl, input.repositoryUrl);
  const token = (await secretResolver.resolve(githubTokenRef(), 'tracker_read')).value;
  const query = `query($owner:String!,$number:Int!,$repository:String!){
    user(login:$owner){projectV2(number:$number){id}} repository(owner:$owner,name:$repository){id defaultBranchRef{name}}}`;
  const graph = await githubRequest('https://api.github.com/graphql', token, {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({query, variables: {
      owner: urls.owner, number: urls.projectNumber, repository: urls.repository
    }})});
  const payload = await graph.json() as {data?: {user?: {projectV2?: {id?: string}},
    repository?: {id?: string; defaultBranchRef?: {name?: string}}}};
  const project = payload.data?.user?.projectV2;
  const externalProjectId = project?.id;
  const repositoryId = payload.data?.repository?.id;
  const defaultBranch = payload.data?.repository?.defaultBranchRef?.name;
  if (typeof externalProjectId !== 'string' || typeof repositoryId !== 'string' ||
    typeof defaultBranch !== 'string' || !/^[^\0\r\n]{1,256}$/.test(defaultBranch)) {
    throw new Error('github_binding_invalid');
  }
  return registerProject(database, {...input, name: input.name.trim(), slug: input.slug.trim(),
    projectUrl: urls.projectUrl, repositoryUrl: urls.repositoryUrl,
    externalProjectId, repositoryId});
};

type CookieClient = Readonly<{request: (path: string, init?: RequestInit) => Promise<Response>}>;
const managementClient = async (runtime: NonNullable<Awaited<ReturnType<typeof readProjectHermesRuntimeBinding>>>): Promise<CookieClient> => {
  const endpoint = new URL(runtime.managementEndpoint); const gateway = new URL(runtime.gatewayEndpoint);
  if (endpoint.toString() !== `http://${runtime.runtimeId}-management:9119/` ||
    gateway.toString() !== `http://${runtime.runtimeId}-gateway:8642/v1/runs`) {
    throw new Error('agent_profile_unavailable');
  }
  const username = (await secretResolver.resolve(runtime.managementUsernameRef, 'hermes_management_username')).value;
  const password = (await secretResolver.resolve(runtime.managementPasswordRef, 'hermes_management_password')).value;
  const login = await fetch(new URL('/auth/password-login', endpoint), {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({provider: 'basic', username, password}),
    signal: AbortSignal.timeout(10_000)});
  if (!login.ok) throw new Error('agent_profile_unavailable');
  const values = typeof login.headers.getSetCookie === 'function'
    ? login.headers.getSetCookie() : [login.headers.get('set-cookie') ?? ''];
  const cookie = values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
  return {request: async (path, init) => fetch(new URL(path, endpoint), {...init,
    headers: {cookie, ...(init?.headers ?? {})}, signal: AbortSignal.timeout(10_000)})};
};
const expectJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error('agent_profile_unavailable');
  return response.json() as Promise<T>;
};

const runtimeCapabilitiesAvailable = async (
  endpoint: string,
  token: string,
  attempts = 1
): Promise<boolean> => {
  const runs = new URL(endpoint);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(new URL('/v1/capabilities', runs),
      {headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(2_000)}).catch(() => null);
    if (response?.ok) {
      const value = await response.json().catch(() => null) as {object?: string}|null;
      if (value?.object === 'hermes.api_server.capabilities') return true;
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

const stagingFileName = (index:number,name:string):string => {
  const extension=/\.(docx|pdf|md|txt)$/i.exec(name)?.[0].toLowerCase();
  if(extension===undefined)throw new Error('project_document_invalid');
  return `${String(index+1).padStart(2,'0')}${extension}`;
};

const stageProjectDocuments = async (client:CookieClient,database:Database,input:Readonly<{
  actorId:string;projectId:string;workDirectory:string;
  documents:Awaited<ReturnType<typeof readActiveProjectDocumentSet>>['documents'];
}>):Promise<readonly string[]> => {
  const root=`${input.workDirectory}/.fai-context/source`;
  const removed=await client.request(`/api/files?path=${encodeURIComponent(root)}&recursive=true`,{method:'DELETE'});
  if(!removed.ok&&removed.status!==404)await expectJson(removed);
  await expectJson(await client.request('/api/files/mkdir',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({path:root})}));
  const paths:string[]=[];
  for(const [index,document] of input.documents.slice().sort((left,right)=>
    left.artifactKind.localeCompare(right.artifactKind)||left.sha256.localeCompare(right.sha256)).entries()){
    const payload=await readProjectDocumentPayload(database,input.actorId,input.projectId,document.id);
    if(payload===null)throw new Error('project_document_unavailable');
    const path=`${root}/${stagingFileName(index,payload.name)}`;
    if(path.length>512)throw new Error('project_document_invalid');
    const form=new FormData();form.set('path',path);form.set('overwrite','true');
    form.set('file',new Blob([new Uint8Array(payload.bytes)],{type:payload.mediaType}),payload.name);
    await expectJson(await client.request('/api/files/upload-stream',{method:'POST',body:form}));
    paths.push(path);
  }
  return paths;
};

const restoreCompactContext=async(client:CookieClient,database:Database,input:Readonly<{actorId:string;projectId:string;
  workDirectory:string;documentFingerprint:string}>):Promise<void>=>{
  const compact=await readLatestCompactProjectContext(database,input.actorId,input.projectId,input.documentFingerprint);
  if(compact===null)throw new Error('project_context_not_configured');
  const form=new FormData();form.set('path',`${input.workDirectory}/PROJECT_CONTEXT.md`);form.set('overwrite','true');
  form.set('file',new Blob([compact.content],{type:'text/markdown'}),'PROJECT_CONTEXT.md');
  await expectJson(await client.request('/api/files/upload-stream',{method:'POST',body:form}));
};

const startContextBootstrap = async (input:Readonly<{endpoint:string;token:string;slug:string;repositoryUrl:string;
  projectUrl:string;workDirectory:string;fingerprint:string;architecturePresent:boolean;paths:readonly string[];reason:string;
}>):Promise<string> => {
  const response=await fetch(input.endpoint,{method:'POST',headers:{
    accept:'application/json',authorization:`Bearer ${input.token}`,'content-type':'application/json'},body:JSON.stringify({
      input:JSON.stringify({contract:'fai.project-context-bootstrap.v1',repository:input.repositoryUrl,
        githubProject:input.projectUrl,documentFingerprint:input.fingerprint,stagedDocuments:input.paths,
        architectureOriginalPresent:input.architecturePresent,
        contextFile:`${input.workDirectory}/PROJECT_CONTEXT.md`}),
      instructions:`Read the staged exact project documents, repository and the bound GitHub Project natively. Produce a compact project context and write exactly that context to the contextFile from the input before returning. Then return only compact JSON (max 65536 UTF-8 bytes): {contract:"fai.project-context-result.v1",context:string,architectureProposal:string|null}. Never copy full source documents. When an Architecture original is absent, include the proposed architecture in the context and return the same bounded proposal separately; otherwise architectureProposal must be null. Do not mutate tasks, repository, deployment or production.`,
      session_id:`project-context-${input.slug}-${input.fingerprint.slice(0,16)}`,provider:'openai-codex',
      model:input.architecturePresent?'gpt-5.6-terra':'gpt-5.6-sol',model_options:{reasoning_effort:'medium'},orchestration:{kind:'project-context-bootstrap',
        attempts:1,reason:input.reason}}),signal:AbortSignal.timeout(15_000)});
  if(response.status!==202)throw new Error('agent_profile_unavailable');
  const value=await response.json().catch(()=>null) as {run_id?:unknown;status?:unknown}|null;
  if(typeof value?.run_id!=='string'||!/^run_[A-Za-z0-9_-]{1,250}$/.test(value.run_id)||value.status!=='started')
    throw new Error('agent_profile_unavailable');
  return value.run_id;
};

export const activateProjectAgentProfile = async (database: Database, input: Readonly<{
  workspaceId: string; actorId: string; projectId: string; idempotencyKey: string; force?: boolean;
}>): Promise<ProjectAgentProfileView> => {
  const binding = await resolveAgentSubmissionBinding(database, input.actorId, input.projectId);
  const runtime = await readProjectHermesRuntimeBinding(database, input.actorId, input.projectId);
  if (binding === null || runtime === null || binding.requesterRole !== 'project_owner') {
    throw new Error('agent_profile_denied');
  }
  const stored = await readProjectAgentProfile(database, input.actorId, input.projectId);
  const documentSet = await readActiveProjectDocumentSet(database, input.actorId, input.projectId);
  if (!documentSet.configured) throw new Error('project_documents_required');
  if(['configuring','awaiting_architecture'].includes(stored.status)&&
    stored.documentFingerprint===documentSet.fingerprint)return stored;
  const token = (await secretResolver.resolve(runtime.agentCredentialRef, 'agent_delivery')).value;
  const project = await database.query<{slug: string}>(
    'select slug from projects where id=$1 and workspace_id=$2', [input.projectId, input.workspaceId]);
  const slug = project.rows[0]?.slug;
  if (slug === undefined) throw new Error('agent_profile_denied');
  const profile = runtime.runtimeId;
  const workDirectory = runtime.workspacePath;
  const client = await managementClient(runtime);
  const changed=stored.documentFingerprint!==documentSet.fingerprint;
  const compact=changed?null:await readLatestCompactProjectContext(database,input.actorId,input.projectId,
    documentSet.fingerprint);
  const needsBootstrap=changed||compact===null;
  const endpointPath = '/v1/runs';
  if (!await runtimeCapabilitiesAvailable(runtime.gatewayEndpoint, token)) {
    const restarted = await client.request('/api/gateway/restart', {method: 'POST'});
    if (!restarted.ok || !await runtimeCapabilitiesAvailable(runtime.gatewayEndpoint, token, 12)) {
      throw new Error('agent_profile_probe_failed');
    }
  }
  if(!needsBootstrap){
    if(input.force===true||stored.status!=='ready')await restoreCompactContext(client,database,{actorId:input.actorId,
      projectId:input.projectId,workDirectory,documentFingerprint:documentSet.fingerprint});
    if(stored.status==='ready')return stored;
    return recordProjectAgentProfile(database,{...input,profile,endpointPath,
      templateVersion:projectAgentProfileTemplateVersion,documentFingerprint:documentSet.fingerprint,
      idempotencyKey:`project-context-restore:${input.projectId}:${profile}:${documentSet.fingerprint}`,
      occurredAt:new Date().toISOString()});
  }
  const paths=await stageProjectDocuments(client,database,{actorId:input.actorId,projectId:input.projectId,
    workDirectory,documents:documentSet.documents});
  const reason=stored.profile===null?'initial':stored.profile!==runtime.runtimeId?'agent_replaced':changed?'documents_changed':'manual';
  const attemptSeed=stored.status==='error'?input.idempotencyKey:'first';
  return recordProjectAgentBootstrapStart(database,{...input,
    idempotencyKey:`project-context:${input.projectId}:${profile}:${documentSet.fingerprint}:${attemptSeed}`,profile,endpointPath,
    documentFingerprint:documentSet.fingerprint,architecturePresent:documentSet.architecturePresent,
    reason,occurredAt:new Date().toISOString()},()=>startContextBootstrap({endpoint:runtime.gatewayEndpoint,token,slug,
    repositoryUrl:binding.repositoryUrl,projectUrl:binding.projectUrl,workDirectory,fingerprint:documentSet.fingerprint,
      architecturePresent:documentSet.architecturePresent,paths,reason}));
};

export const ensureProjectAgentProfile = async (database: Database, input: Readonly<{
  workspaceId: string; actorId: string; projectId: string; idempotencyKey: string; force?: boolean;
}>): Promise<ProjectAgentProfileView> => {
  return activateProjectAgentProfile(database, input);
};

const startTrackerPreparationRun=async(input:Readonly<{endpoint:string;token:string;assignment:unknown}>):Promise<string>=>{
  const response=await fetch(input.endpoint,{method:'POST',headers:{accept:'application/json',authorization:`Bearer ${input.token}`,
    'content-type':'application/json'},body:JSON.stringify(input.assignment),signal:AbortSignal.timeout(15_000)});
  if(response.status!==202)throw new Error('project_tracker_preparation_unavailable');
  const value=await response.json().catch(()=>null) as {run_id?:unknown;status?:unknown}|null;
  if(typeof value?.run_id!=='string'||!/^run_[A-Za-z0-9_-]{1,250}$/.test(value.run_id)||value.status!=='started')
    throw new Error('project_tracker_preparation_unavailable');return value.run_id;
};

export const prepareProjectTracker=async(database:Database,input:Readonly<{workspaceId:string;actorId:string;
  projectId:string;idempotencyKey:string}>)=>{const current=await readProjectTrackerPreparation(database,input.actorId,input.projectId);
  if(['configuring','approval_required','verifying','ready'].includes(current.status))return current;
  const [binding,runtime,profile,process]=await Promise.all([resolveAgentSubmissionBinding(database,input.actorId,input.projectId),
    readProjectHermesRuntimeBinding(database,input.actorId,input.projectId),readProjectAgentProfile(database,input.actorId,input.projectId),
    readProjectProcessPolicy(database,input.actorId,input.projectId)]);
  if(binding===null||runtime===null||binding.requesterRole!=='project_owner')throw new Error('project_tracker_preparation_denied');
  if(profile.status!=='ready')throw new Error('agent_profile_not_ready');
  if(process===null)throw new Error('project_process_not_configured');
  const token=(await secretResolver.resolve(runtime.agentCredentialRef,'agent_delivery')).value;
  const remainingDelta=current.remainingDelta.length===0?[`Status: ${process.policy.stages.map((stage)=>stage.title).join(' -> ')}`,
    'Owner: Hermes','Blocked: No, Yes']:current.remainingDelta;
  const assignment=projectTrackerPreparationAssignment({repositoryUrl:binding.repositoryUrl,projectUrl:binding.projectUrl,
    process:process.policy,remainingDelta});return recordProjectTrackerPreparationStart(database,{...input,processVersion:process.version,
      remainingDelta,idempotencyKey:input.idempotencyKey,occurredAt:new Date().toISOString()},()=>startTrackerPreparationRun({
        endpoint:runtime.gatewayEndpoint,token,assignment}));};
