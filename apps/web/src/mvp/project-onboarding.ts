import {
  readProjectAgentProfile,
  readLatestCompactProjectContext,
  readActiveProjectDocumentSet,
  readProjectDocumentPayload,
  recordProjectAgentBootstrapStart,
  recordProjectAgentProfile,
  projectAgentProfileTemplateVersion,
  registerProject,
  resolveAgentSubmissionBinding,
  type Database,
  type ProjectAgentProfileView
} from '@fai-control-plane/db';
import {type OpaqueSecretRef} from '@fai-control-plane/domain';
import {readSecretFile, secretResolver} from './runtime.ts';

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
    projectUrl: projectUrl.toString(), repositoryUrl: repositoryUrl.toString(), owner: project[1]!,
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
  const query = `query($owner:String!,$number:Int!,$repository:String!){user(login:$owner){projectV2(number:$number){id
    fields(first:100){nodes{... on ProjectV2SingleSelectField{name options{id name}}}pageInfo{hasNextPage}}}}
    repository(owner:$owner,name:$repository){id defaultBranchRef{name}}}`;
  const graph = await githubRequest('https://api.github.com/graphql', token, {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({query, variables: {
      owner: urls.owner, number: urls.projectNumber, repository: urls.repository
    }})});
  const payload = await graph.json() as {data?: {user?: {projectV2?: {id?: string; fields?: {
    nodes?: readonly {name?: string; options?: readonly {id?: string; name?: string}[]}[];
    pageInfo?: {hasNextPage?: boolean};
  }}}, repository?: {id?: string; defaultBranchRef?: {name?: string}}}};
  const project = payload.data?.user?.projectV2;
  const externalProjectId = project?.id;
  const repositoryId = payload.data?.repository?.id;
  const defaultBranch = payload.data?.repository?.defaultBranchRef?.name;
  const fields = project?.fields;
  const single = (fieldName: string, optionName: string): string | null => {
    const field = fields?.nodes?.find((candidate) => candidate.name === fieldName);
    const option = field?.options?.find((candidate) => candidate.name === optionName);
    return typeof option?.id === 'string' && option.id.length > 0 && option.id.length <= 512
      ? option.id : null;
  };
  const agentOwnerOptionId = single('Owner', 'Hermes');
  const doneStatusOptionId = single('Status', 'Done');
  if (typeof externalProjectId !== 'string' || typeof repositoryId !== 'string' ||
    typeof defaultBranch !== 'string' || !/^[^\0\r\n]{1,256}$/.test(defaultBranch) ||
    fields?.pageInfo?.hasNextPage === true || agentOwnerOptionId === null || doneStatusOptionId === null) {
    throw new Error('github_binding_invalid');
  }
  return registerProject(database, {...input, projectUrl: urls.projectUrl, repositoryUrl: urls.repositoryUrl,
    externalProjectId, repositoryId,
    trackerCapabilities: {provider: 'github', agentOwnerOptionId, doneStatusOptionId, defaultBranch}});
};

type CookieClient = Readonly<{request: (path: string, init?: RequestInit) => Promise<Response>}>;
const managementClient = async (): Promise<CookieClient> => {
  const base = process.env.HERMES_MANAGEMENT_URL;
  const usernameFile = process.env.HERMES_MANAGEMENT_USERNAME_FILE;
  const passwordFile = process.env.HERMES_MANAGEMENT_PASSWORD_FILE;
  if (base === undefined || usernameFile === undefined || passwordFile === undefined) {
    throw new Error('agent_profile_unavailable');
  }
  const endpoint = new URL(base);
  if (!['http:', 'https:'].includes(endpoint.protocol) || (endpoint.protocol === 'http:' &&
    endpoint.hostname.includes('.') && !['127.0.0.1', 'localhost'].includes(endpoint.hostname))) {
    throw new Error('agent_profile_unavailable');
  }
  const username = await readSecretFile(usernameFile);
  const password = await readSecretFile(passwordFile);
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

const projectProfileMarker = (slug: string): string =>
  `<!-- fai-project-profile:${projectAgentProfileTemplateVersion}:${slug} -->`;
const projectSoul = (input: Readonly<{slug: string; repositoryUrl: string; projectUrl: string}>): string => {
  const coordinates = githubUrls(input.projectUrl, input.repositoryUrl);
  return `${projectProfileMarker(input.slug)}
# Project Hermes

You are the permanent project manager and project interface for this one project.
Repository: ${input.repositoryUrl}
GitHub Project: ${input.projectUrl} (owner ${coordinates.owner}, number ${coordinates.projectNumber})

Keep durable decisions and compact project facts in native Hermes memory. GitHub Issues and this GitHub Project are the
only task and status truth. For every task trigger, read the issue, comments, Project fields and linked PR yourself with
native git/gh access, and read repository AGENTS.md before project work. Never interpret Control Plane internal
identifiers as GitHub Project identifiers.

Original project documents and their approved compact context in f(AI) Control are the project truth. Repository documents
are execution copies or supplemental sources unless the Product Owner explicitly imports them. Read staged originals only
during initial setup, after their fingerprint changes, or for an explicit relevant question. Do not copy full originals
into memory, Telegram history or every Codex prompt.
The approved compact context is restored at PROJECT_CONTEXT.md in this project work directory; read it before project work.

Perform planning and Project operations directly. If scope or acceptance criteria are incomplete, update the same issue
and request confirmation in Telegram before execution. For implementation, documentation, QA and DevOps evidence, run
one fresh bounded Codex CLI task using the role, CLI, model and reasoning route from the trigger, with only the issue URL
and smallest necessary repository context. Preserve this Hermes profile, its memory and Telegram sessions across tasks
and restarts.

Before execution, check that the issue, repository, required credentials and target environment are reachable. If an
essential input or access is missing, do not repeat failing actions: keep the task at its current stage, record the exact
missing prerequisite, notify Telegram and return a structured blocked result. Otherwise continue until the stage has a
real result; do not stop because of an arbitrary small turn count.

Development must produce every requested artifact before moving the item to QA. QA verifies those existing artifacts and
may fix one localized issue or return the item to development with concrete findings. Update the same Project item after
each completed stage and report every stage, result and blocker in Telegram. Never create a duplicate issue, run or PR.
Never merge, release, deploy, mutate production or send customer material without Vladimir's exact approval.
`;
};
const projectProfileConfig = (workDirectory: string) => ({
  terminal: {backend: 'local', cwd: workDirectory},
  platform_toolsets: {api_server: ['terminal', 'fai_internal', 'no_mcp']},
  // Hermes' native default is 500. Keep only the emergency runaway ceiling;
  // ordinary stopping is governed by the semantic project rules in SOUL.
  agent: {max_turns: 500},
  toolsets: ['file', 'terminal', 'search', 'web', 'skills', 'todo', 'memory', 'session_search',
    'fai_internal', 'clarify']
});
const recordValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const projectConfigMatches = (value: unknown, workDirectory: string): boolean => {
  const root = recordValue(value); const config = recordValue(root?.config) ?? root;
  const terminal = recordValue(config?.terminal); const agent = recordValue(config?.agent);
  const platform = recordValue(config?.platform_toolsets);
  const apiServer = Array.isArray(platform?.api_server) ? platform.api_server : [];
  const toolsets = Array.isArray(config?.toolsets) ? config.toolsets : [];
  return terminal?.backend === 'local' && terminal.cwd === workDirectory &&
    typeof agent?.max_turns === 'number' && agent.max_turns >= 500 &&
    ['terminal', 'fai_internal', 'no_mcp'].every((item) => apiServer.includes(item)) &&
    ['terminal', 'memory', 'session_search', 'fai_internal'].every((item) => toolsets.includes(item));
};

const ensureProjectProfileConfiguration = async (client: CookieClient, input: Readonly<{
  profile: string; slug: string; repositoryUrl: string; projectUrl: string; workDirectory: string; token: string;
  force: boolean;
}>): Promise<void> => {
  const soulPath = `/api/profiles/${encodeURIComponent(input.profile)}/soul`;
  const soulValue = await expectJson<unknown>(await client.request(soulPath));
  const soul = recordValue(soulValue)?.content;
  const configValue = await expectJson<unknown>(await client.request(`/api/config?profile=${encodeURIComponent(input.profile)}`));
  const configured = typeof soul === 'string' && soul.includes(projectProfileMarker(input.slug)) &&
    soul.includes(input.repositoryUrl) && soul.includes(input.projectUrl) &&
    projectConfigMatches(configValue, input.workDirectory);
  if (configured && !input.force) return;
  await expectJson(await client.request('/api/files/mkdir', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({path: input.workDirectory})}));
  await expectJson(await client.request(`/api/env?profile=${encodeURIComponent(input.profile)}`, {method: 'PUT',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({key: 'API_SERVER_KEY',
      value: input.token, profile: input.profile})}));
  await expectJson(await client.request(`/api/config?profile=${encodeURIComponent(input.profile)}`, {method: 'PUT',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({profile: input.profile,
      config: projectProfileConfig(input.workDirectory)})}));
  await expectJson(await client.request(soulPath, {method: 'PUT', headers: {'content-type': 'application/json'},
    body: JSON.stringify({content: projectSoul(input)})}));
};

const profileCapabilitiesAvailable = async (
  profile: string,
  token: string,
  attempts = 1
): Promise<boolean> => {
  const base = process.env.HERMES_GATEWAY_INTERNAL_BASE_URL;
  if (base === undefined) throw new Error('agent_profile_unavailable');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(new URL(`/p/${encodeURIComponent(profile)}/v1/capabilities`, base),
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

const startContextBootstrap = async (input:Readonly<{profile:string;token:string;slug:string;repositoryUrl:string;
  projectUrl:string;workDirectory:string;fingerprint:string;architecturePresent:boolean;paths:readonly string[];reason:string;
}>):Promise<string> => {
  const base=process.env.HERMES_GATEWAY_INTERNAL_BASE_URL;
  if(base===undefined)throw new Error('agent_profile_unavailable');
  const response=await fetch(new URL(`/p/${encodeURIComponent(input.profile)}/v1/runs`,base),{method:'POST',headers:{
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
  if (binding === null || binding.agentCredentialRef === null || binding.requesterRole !== 'project_owner') {
    throw new Error('agent_profile_denied');
  }
  const stored = await readProjectAgentProfile(database, input.actorId, input.projectId);
  const documentSet = await readActiveProjectDocumentSet(database, input.actorId, input.projectId);
  if (!documentSet.configured) throw new Error('project_documents_required');
  if(['configuring','awaiting_architecture'].includes(stored.status)&&
    stored.documentFingerprint===documentSet.fingerprint)return stored;
  const token = (await secretResolver.resolve(binding.agentCredentialRef, 'agent_delivery')).value;
  const project = await database.query<{slug: string}>(
    'select slug from projects where id=$1 and workspace_id=$2', [input.projectId, input.workspaceId]);
  const slug = project.rows[0]?.slug;
  if (slug === undefined) throw new Error('agent_profile_denied');
  const profile = stored.profile ?? `project-${slug}`;
  const template = process.env.HERMES_PROFILE_TEMPLATE ?? 'fai-project-template';
  const workDirectory = `/opt/data/work/projects/${slug}`;
  const client = await managementClient();
  const listed = await expectJson<{profiles: readonly {name?: string}[]}>(await client.request('/api/profiles'));
  const created = !listed.profiles.some((item) => item.name === profile);
  if (created) {
    await expectJson(await client.request('/api/profiles', {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({name: profile, clone_from: template,
        no_skills: false, description: `Project manager for ${slug}`})}));
  }
  const changed=stored.documentFingerprint!==documentSet.fingerprint;
  const compact=changed?null:await readLatestCompactProjectContext(database,input.actorId,input.projectId,
    documentSet.fingerprint);
  const needsBootstrap=changed||compact===null;
  const reapplyConfiguration=created||stored.status==='not_configured'||(input.force===true&&!changed);
  if(reapplyConfiguration)await ensureProjectProfileConfiguration(client, {profile, slug,
    repositoryUrl: binding.repositoryUrl,projectUrl: binding.projectUrl, workDirectory, token,force:true});
  const endpointPath = `/p/${encodeURIComponent(profile)}/v1/runs`;
  if (!await profileCapabilitiesAvailable(profile, token)) {
    const restarted = await client.request('/api/gateway/restart', {method: 'POST'});
    if (!restarted.ok || !await profileCapabilitiesAvailable(profile, token, 12)) {
      throw new Error('agent_profile_probe_failed');
    }
  }
  if(!needsBootstrap){
    if(created||input.force===true||stored.status!=='ready')await restoreCompactContext(client,database,{actorId:input.actorId,
      projectId:input.projectId,workDirectory,documentFingerprint:documentSet.fingerprint});
    if(stored.status==='ready')return stored;
    return recordProjectAgentProfile(database,{...input,profile,endpointPath,
      templateVersion:projectAgentProfileTemplateVersion,documentFingerprint:documentSet.fingerprint,
      idempotencyKey:`project-context-restore:${input.projectId}:${profile}:${documentSet.fingerprint}`,
      occurredAt:new Date().toISOString()});
  }
  const paths=await stageProjectDocuments(client,database,{actorId:input.actorId,projectId:input.projectId,
    workDirectory,documents:documentSet.documents});
  const reason=stored.profile===null?'initial':created?'agent_replaced':changed?'documents_changed':'manual';
  const attemptSeed=stored.status==='error'?input.idempotencyKey:'first';
  return recordProjectAgentBootstrapStart(database,{...input,
    idempotencyKey:`project-context:${input.projectId}:${profile}:${documentSet.fingerprint}:${attemptSeed}`,profile,endpointPath,
    documentFingerprint:documentSet.fingerprint,architecturePresent:documentSet.architecturePresent,
    reason,occurredAt:new Date().toISOString()},()=>startContextBootstrap({profile,token,slug,
    repositoryUrl:binding.repositoryUrl,projectUrl:binding.projectUrl,workDirectory,fingerprint:documentSet.fingerprint,
      architecturePresent:documentSet.architecturePresent,paths,reason}));
};

export const ensureProjectAgentProfile = async (database: Database, input: Readonly<{
  workspaceId: string; actorId: string; projectId: string; idempotencyKey: string; force?: boolean;
}>): Promise<ProjectAgentProfileView> => {
  return activateProjectAgentProfile(database, input);
};
