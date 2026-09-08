import {createHash} from 'node:crypto';
import {
  addExistingProjectMember,
  addSourceArtifact,
  appendIncomingEvent,
  canApprove,
  canGovernMembership,
  createApprovalPersistence,
  createStores,
  databaseMvpReady,
  deleteProjectDocument,
  executeAgentSubmissionTransaction,
  listProjects,
  listProjectDocuments,
  projectDocumentMaxBatchBytes,
  projectDocumentMaxFileBytes,
  onboardProjectMember,
  resolveAgentSubmissionBinding,
  resolveProjectRuntimeByRepository,
  readAgentRoutingPolicy,
  readProjectProcessPolicy,
  readProjectTrackerPreparation,
  readProjectWizardProgress,
  recordProjectWizardDecision,
  readProjectAgentProfile,
  readProjectHermesRuntimeBinding,
  readProjectHermesRuntimeSetup,
  projectHermesExecutorCatalog,
  readProjectExecutionMode,
  readProjectTrackerCapabilities,
  readProjectDocumentPayload,
  readProjectArchitectureProposal,
  readActiveProjectContext,
  readApprovedProductionEvidence,
  refreshProjectContext,
  saveAgentRoutingPolicy,
  saveProjectExecutionMode,
  uploadProjectDocuments,
  subjectHash
} from '@fai-control-plane/db';
import {projectDocumentUploadCategories, type ProjectDocumentUploadCategory} from '@fai-control-plane/db';
import {defaultAgentStageInstructions,decideApproval,
  type AgentSubmissionPorts} from '@fai-control-plane/application';
import {verifyGitHubWebhook,createGitHubRepositoryReadAdapter,createGitHubTrackerMutationAdapter,
  createGitHubTrackerReadAdapter} from '@fai-control-plane/integrations';
import {assertAgentRoutingPolicyAvailable, defaultAgentRoutingPolicy, mayChangeMembership, parseAgentRoutingPolicy,
  projectPassportPaths, type AgentDeliveryPort, type ApprovalEvidence, type ApprovalKind,
  type MessengerDeliveryInput, type OpaqueSecretRef, type ProjectRole, type TrackerItemFact} from '@fai-control-plane/domain';
import {getDatabase, jsonError, requireCsrf, requireSession, secretResolver} from './runtime.ts';
import {readiness} from './http-surface.ts';
import {resolveAndRegisterProject} from './project-onboarding.ts';

const json = async (request: Request): Promise<Record<string, unknown>> => {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('media_type_invalid');
  const text = await request.text();
  if (text.length === 0 || text.length > 250_000) throw new Error('body_invalid');
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body_invalid');
  return value as Record<string, unknown>;
};
const string = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new Error('body_invalid');
  }
  return value;
};
const workerTaskCommand=async(request:Request,body?:Record<string,unknown>)=>{const endpoint=new URL(
  process.env.FCP_WORKER_INTERNAL_URL??'http://worker:3001');if(endpoint.toString()!=='http://worker:3001/')
  throw new Error('project_runtime_unavailable');const target=new URL('/project-task',endpoint);target.search=new URL(request.url).search;
  const response=await fetch(target,{method:request.method,
    headers:{'content-type':'application/json',cookie:request.headers.get('cookie')??''},...(body===undefined?{}:{body:JSON.stringify(body)}),
    signal:AbortSignal.timeout(30_000)});return new Response(await response.text(),{status:response.status,
      headers:{'content-type':'application/json','cache-control':'no-store'}});};
const optionalHttps = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const parsed = new URL(string(value, 2_048));
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') throw new Error('body_invalid');
  return parsed.toString();
};
export const effectiveAgentRouting = (routing: Awaited<ReturnType<typeof readAgentRoutingPolicy>>) => routing ?? {
  policy: defaultAgentRoutingPolicy,
  version: createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex')
};
const githubAssignment = async (database: ReturnType<typeof getDatabase>, actorId: string, projectId: string, delivery: AgentDeliveryPort) => {
  const context = await resolveAgentSubmissionBinding(database, actorId, projectId);
  if (context === null) throw new Error('task_executor_denied');
  if (!['project_owner', 'operator'].includes(context.requesterRole)) throw new Error('task_executor_denied');
  const coordinates = githubRuntimeCoordinates(context);
  if (coordinates === null) throw new Error(context.provider === 'github'
    ? 'github_binding_invalid' : 'tracker_provider_unsupported');
  const binding = {id: context.bindingId, ...coordinates,
    projectId: context.projectId, projectUrl: context.projectUrl,
    credentialRef: context.trackerCredentialRef};
  const tracker = createGitHubTrackerMutationAdapter({binding,
    credentialRef: {...context.trackerCredentialRef, purpose: 'tracker_mutate'}, secrets: secretResolver});
  const read = createGitHubTrackerReadAdapter({binding, secrets: secretResolver});
  const repository = createGitHubRepositoryReadAdapter({owner: binding.owner, repository: binding.repository,
    repositoryId: context.repositoryId, credentialRef: context.trackerCredentialRef, secrets: secretResolver});
  const stores = createStores(database, context.workspaceId);
  const routing = effectiveAgentRouting(await readAgentRoutingPolicy(database, actorId, projectId));
  const runtime = await readProjectHermesRuntimeBinding(database, actorId, projectId);
  const processPolicy = await readProjectProcessPolicy(database, actorId, projectId);
  const trackerCapabilities = await readProjectTrackerCapabilities(database, actorId, projectId);
  if (processPolicy === null || trackerCapabilities === null) {
    throw new Error('project_process_policy_unavailable');
  }
  return {context, tracker, trackerRead: read, ports: {resolveContext: async () => ({workspaceId: context.workspaceId, projectId: context.projectId,
      requesterRole: context.requesterRole, bindingId: context.bindingId, repository: {id: context.repositoryId, url: context.repositoryUrl},
      agentTrackerOwnerOptionId: trackerCapabilities.agentOwnerOptionId,
      doneStatusOptionId: trackerCapabilities.doneStatusOptionId,
      routingPolicyVersion: routing.version, routingPolicy: routing.policy,
      processPolicyVersion: processPolicy.version, processPolicy: processPolicy.policy,
      executorCatalog: projectHermesExecutorCatalog(runtime)}),
    readFreshSnapshot: () => read.readSnapshot(context.bindingId, context.cursor), persistSnapshot: stores.snapshots.replace,
    resolveActiveContext: ({actorId, projectId}: Readonly<{actorId: string; projectId: string}>) =>
      readActiveProjectContext(database, actorId, projectId),
    resolveProductionApproval: (input: Readonly<{projectId: string; itemId: string; issueId: string; version: string}>) =>
      readApprovedProductionEvidence(database, input),
    composeAcceptedNotification: async (item: TrackerItemFact, idempotencyKey: string): Promise<MessengerDeliveryInput> => ({projectId: context.projectId,
      contour: 'trusted-main', channelReference: 'telegram:internal',
      text: `ИИ-агент принял задачу: ${item.title} — ${item.url}`, idempotencyKey}),
    repository, delivery, tracker, agentInstructions: defaultAgentStageInstructions, transaction: {execute: (
      input: Parameters<AgentSubmissionPorts['transaction']['execute']>[0], submit: Parameters<AgentSubmissionPorts['transaction']['execute']>[1]
    ) => executeAgentSubmissionTransaction(database, input, submit)}}};
};

export const projects = async (request: Request): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    if(request.method==='DELETE'){
      requireCsrf(request);const body=await json(request);if(body.confirmed!==true)throw new Error('body_invalid');
      const projectId=string(body.projectId);const endpoint=new URL(process.env.FCP_WORKER_INTERNAL_URL??'http://worker:3001');
      if(endpoint.toString()!=='http://worker:3001/')throw new Error('project_runtime_unavailable');
      const response=await fetch(new URL(`/project-runtime/${encodeURIComponent(projectId)}`,endpoint),{method:'DELETE',
        headers:{cookie:request.headers.get('cookie')??''},signal:AbortSignal.timeout(30_000)});
      return new Response(await response.text(),{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
    }
    if (request.method === 'POST') {
      requireCsrf(request); const body=await json(request); const slug=string(body.slug,100);
      if(!/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/.test(slug)) throw new Error('body_invalid');
      const result=await resolveAndRegisterProject(database,{workspaceId:session.workspaceId,actorId:session.actorId,
        name:string(body.name,200),slug,projectUrl:string(body.projectUrl,2_048),repositoryUrl:string(body.repositoryUrl,2_048),
        idempotencyKey:string(body.idempotencyKey,128)});
      return Response.json(result,{status:result.created?201:200});
    }
    if (request.method !== 'GET') return new Response(null, {status: 405, headers: {allow: 'GET, POST, DELETE'}});
    return Response.json({projects: await listProjects(database, session.actorId)});
  } catch (error) { return jsonError(error); }
};

export const projectAgentProfile = async (request:Request,projectId:string):Promise<Response>=>{
  try { const database=getDatabase(); const session=await requireSession();
    if(request.method==='GET') return Response.json(await readProjectAgentProfile(database,session.actorId,projectId),
      {headers:{'cache-control':'no-store'}});
    if(request.method!=='POST') return new Response(null,{status:405,headers:{allow:'GET, POST'}});
    requireCsrf(request);const endpoint=new URL(process.env.FCP_WORKER_INTERNAL_URL??'http://worker:3001');
    if(endpoint.toString()!=='http://worker:3001/')throw new Error('project_runtime_unavailable');
    const response=await fetch(new URL(`/project-agent-profile/${encodeURIComponent(projectId)}`,endpoint),{method:'POST',
      headers:{'content-type':request.headers.get('content-type')??'',cookie:request.headers.get('cookie')??''},
      body:await request.text(),signal:AbortSignal.timeout(30_000)});
    return new Response(await response.text(),{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  } catch(error){return jsonError(error);}
};

export const projectTrackerPreparation=async(request:Request,projectId:string):Promise<Response>=>{
  try{const database=getDatabase();const session=await requireSession();
    if(request.method==='GET')return Response.json(await readProjectTrackerPreparation(database,session.actorId,projectId),
      {headers:{'cache-control':'no-store'}});
    if(request.method!=='POST')return new Response(null,{status:405,headers:{allow:'GET, POST'}});
    requireCsrf(request);const endpoint=new URL(process.env.FCP_WORKER_INTERNAL_URL??'http://worker:3001');
    if(endpoint.toString()!=='http://worker:3001/')throw new Error('project_runtime_unavailable');
    const response=await fetch(new URL(`/project-tracker-preparation/${encodeURIComponent(projectId)}`,endpoint),{method:'POST',
      headers:{'content-type':request.headers.get('content-type')??'',cookie:request.headers.get('cookie')??''},
      body:await request.text(),signal:AbortSignal.timeout(30_000)});
    return new Response(await response.text(),{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  }catch(error){return jsonError(error);}
};

export const projectWizardProgress=async(request:Request,projectId:string):Promise<Response>=>{
  try{const database=getDatabase();const session=await requireSession();if(request.method==='GET')return Response.json(
    await readProjectWizardProgress(database,session.actorId,projectId),{headers:{'cache-control':'no-store'}});
    if(request.method!=='POST')return new Response(null,{status:405,headers:{allow:'GET, POST'}});requireCsrf(request);const body=await json(request);
    const action=string(body.action,32);const decision=action==='confirm_process'?'project.wizard.process-confirm':action==='skip_team'?
      'project.wizard.team-skip':action==='skip_communications'?'project.wizard.communications-skip':null;if(decision===null)throw new Error('body_invalid');
    return Response.json(await recordProjectWizardDecision(database,{workspaceId:session.workspaceId,projectId,actorId:session.actorId,
      decision,idempotencyKey:string(body.idempotencyKey,128),occurredAt:new Date().toISOString()}),{headers:{'cache-control':'no-store'}});
  }catch(error){return jsonError(error);}
};

export const projectRuntimeSetup=async(request:Request,projectId:string):Promise<Response>=>{
  try{const database=getDatabase();const session=await requireSession();
    if(request.method==='GET')return Response.json(await readProjectHermesRuntimeSetup(database,session.actorId,projectId),
      {headers:{'cache-control':'no-store'}});
    if(request.method!=='POST')return new Response(null,{status:405,headers:{allow:'GET, POST'}});
    requireCsrf(request);const body=await json(request);const action=string(body.action,32);
    if(!['connect_messenger','install','configure_devops'].includes(action))throw new Error('body_invalid');
    const endpoint=new URL(process.env.FCP_WORKER_INTERNAL_URL??'http://worker:3001');
    if(endpoint.toString()!=='http://worker:3001/')throw new Error('project_runtime_unavailable');
    const response=await fetch(new URL(`/project-runtime/${encodeURIComponent(projectId)}`,endpoint),{method:'POST',
      headers:{'content-type':'application/json',cookie:request.headers.get('cookie')??''},body:JSON.stringify(body),
      signal:AbortSignal.timeout(30_000)});
    return new Response(await response.text(),{status:response.status,headers:{'content-type':'application/json',
      'cache-control':'no-store'}});
  }catch(error){return jsonError(error);}
};

export const projectExecutionMode = async (request: Request, projectId: string): Promise<Response> => {
  try {
    const database = getDatabase(); const session = await requireSession();
    if (request.method === 'GET') return Response.json(await readProjectExecutionMode(database, session.actorId, projectId),
      {headers: {'cache-control': 'no-store'}});
    if (request.method !== 'POST') return new Response(null, {status: 405, headers: {allow: 'GET, POST'}});
    requireCsrf(request); const body = await json(request); const mode = string(body.mode, 16);
    if (mode !== 'manual' && mode !== 'autonomous') throw new Error('body_invalid');
    return Response.json(await saveProjectExecutionMode(database, {workspaceId: session.workspaceId, projectId,
      actorId: session.actorId, mode, idempotencyKey: string(body.idempotencyKey),
      occurredAt: new Date().toISOString()}), {headers: {'cache-control': 'no-store'}});
  } catch (error) { return jsonError(error); }
};

export const onboard = async (request: Request): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    requireCsrf(request);
    const body = await json(request);
    const projectId = string(body.projectId);
    if (!await canGovernMembership(database, session.actorId, projectId)) throw new Error('onboarding_denied');
    const role = string(body.role, 32);
    if (!['operator', 'contributor', 'client'].includes(role)) throw new Error('body_invalid');
    if (body.existingActorId !== undefined) {
      const actorId=string(body.existingActorId);
      await addExistingProjectMember(database, {workspaceId: session.workspaceId, projectId, actorId,
        role: role as 'operator'|'contributor'|'client'});
      return Response.json({actorId, created: false});
    }
    const identity = (provider: 'github'|'telegram', value: unknown, numeric: boolean) => {
      if (value === undefined || value === null || value === '') return null;
      const subject = string(value, 64);
      if (numeric && !/^[1-9][0-9]*$/.test(subject)) throw new Error('body_invalid');
      return {provider, subjectHash: subjectHash(provider, subject)} as const;
    };
    const identities = [identity('github', body.githubUserId, true), identity('telegram', body.telegramUserId, true)]
      .filter((value) => value !== null);
    const result = await onboardProjectMember(database, {workspaceId: session.workspaceId, projectId,
      displayName: string(body.displayName, 200), role: role as 'operator'|'contributor'|'client', identities});
    return Response.json({actorId: result.actorId, created: result.created}, {status: result.created ? 201 : 200});
  } catch (error) { return jsonError(error); }
};

export const membership = async (request: Request, membershipId: string): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    requireCsrf(request);
    const body = await json(request);
    const current = await database.query<{projectId: string; actorId: string; role: ProjectRole}>(
      'select project_id as "projectId",actor_id as "actorId",role from project_memberships where id=$1', [membershipId]
    );
    const projectId = current.rows[0]?.projectId;
    if (projectId === undefined || !await canGovernMembership(database, session.actorId, projectId)) {
      throw new Error('membership_denied');
    }
    const role = string(body.role, 32) as ProjectRole;
    if (!['project_owner', 'operator', 'contributor', 'client'].includes(role) || typeof body.active !== 'boolean') {
      throw new Error('body_invalid');
    }
    if (!mayChangeMembership({requesterActorId: session.actorId, requesterRole: 'project_owner',
      targetActorId: current.rows[0]!.actorId, targetRole: current.rows[0]!.role,
      requestedRole: role, requestedActive: body.active})) throw new Error('membership_denied');
    await database.query('update project_memberships set role=$2,active=$3 where id=$1', [membershipId, role, body.active]);
    return Response.json({ok: true});
  } catch (error) { return jsonError(error); }
};

export const source = async (request: Request, projectId: string): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    if(request.method==='GET'){
      const proposalSha=new URL(request.url).searchParams.get('architectureProposal');
      if(proposalSha===null)throw new Error('body_invalid');
      const proposal=await readProjectArchitectureProposal(database,session.actorId,projectId,proposalSha);
      if(proposal===null)return new Response(null,{status:404});
      return new Response(proposal.content,{headers:{'content-type':'text/markdown; charset=utf-8',
        'content-disposition':'attachment; filename="architecture-proposal.md"','cache-control':'no-store'}});
    }
    if(request.method!=='POST')return new Response(null,{status:405,headers:{allow:'GET, POST'}});
    requireCsrf(request);
    const body = await json(request);
    const contentText = string(body.contentText, 200_000);
    const sourceId = await addSourceArtifact(database, {
      projectId, actorId: session.actorId, kind: string(body.kind, 64), name: string(body.name, 200),
      mediaType: string(body.mediaType, 100), contentText,
      sha256: createHash('sha256').update(contentText).digest('hex'),
      sourceUrl: optionalHttps(body.sourceUrl), provenance: string(body.provenance, 500)
    });
    return Response.json({id: sourceId}, {status: 201});
  } catch (error) { return jsonError(error); }
};

export const projectDocuments = async (request: Request, projectId: string): Promise<Response> => {
  try {
    const database = getDatabase(); const session = await requireSession();
    if (request.method === 'GET') return Response.json({documents: await listProjectDocuments(database,session.actorId,projectId)},
      {headers:{'cache-control':'no-store'}});
    if (request.method !== 'POST') return new Response(null,{status:405,headers:{allow:'GET, POST'}});
    requireCsrf(request);
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) throw new Error('media_type_invalid');
    const contentLength=Number(request.headers.get('content-length'));
    if(Number.isFinite(contentLength)&&contentLength>projectDocumentMaxBatchBytes+1024*1024)
      throw new Error('project_document_invalid');
    const form = await request.formData(); const entries=form.getAll('file');const categories=form.getAll('category');
    const files=entries.filter((file):file is File=>file instanceof File);
    if(files.length===0||files.length!==entries.length||files.length!==categories.length||categories.some((category)=>
      typeof category!=='string'||!projectDocumentUploadCategories.includes(category as ProjectDocumentUploadCategory))) throw new Error('project_document_invalid');
    const bytes=await Promise.all(files.map(async(file)=>Buffer.from(await file.arrayBuffer())));
    if(bytes.some((value)=>value.byteLength>projectDocumentMaxFileBytes)||bytes.reduce((total,value)=>total+value.byteLength,0)>projectDocumentMaxBatchBytes)
      throw new Error('project_document_invalid');
    const idempotencyKey=string(form.get('idempotencyKey'),128);const occurredAt=new Date().toISOString();
    const result=await uploadProjectDocuments(database,files.map((file,index)=>({workspaceId:session.workspaceId,projectId,actorId:session.actorId,
      category:categories[index] as ProjectDocumentUploadCategory,name:string(file.name,200),mediaType:string(file.type,100),bytes:bytes[index]!,
      provenance:'operator-upload',idempotencyKey,occurredAt})));
    return Response.json({documents:result},{status:201,headers:{'cache-control':'no-store'}});
  } catch(error){return jsonError(error);}
};

export const projectDocumentDownload = async (projectId:string,documentId:string):Promise<Response>=>{
  try { const database=getDatabase(); const session=await requireSession();
    const document=await readProjectDocumentPayload(database,session.actorId,projectId,documentId);
    if(document===null)return new Response(null,{status:404});
    const filename=document.name.replace(/[^A-Za-z0-9._-]/g,'_')||'project-document';
    const encodedFilename=encodeURIComponent(document.name)
      .replace(/['()*]/g,(character)=>`%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(new Uint8Array(document.bytes),{headers:{'content-type':document.mediaType,
      'content-length':String(document.bytes.byteLength),
      'content-disposition':`attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`,
      'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  }catch(error){return jsonError(error);}
};

export const projectDocumentDelete = async (request:Request,projectId:string,documentId:string):Promise<Response>=>{
  try {const database=getDatabase();const session=await requireSession();if(request.method!=='DELETE')return new Response(null,{status:405,headers:{allow:'DELETE'}});
    requireCsrf(request);const body=await json(request);const deleted=await deleteProjectDocument(database,{workspaceId:session.workspaceId,projectId,actorId:session.actorId,
      documentId,idempotencyKey:string(body.idempotencyKey,128),occurredAt:new Date().toISOString()});return Response.json({deleted},{headers:{'cache-control':'no-store'}});
  }catch(error){return jsonError(error);}
};

export const agentRouting = async (request: Request, projectId: string): Promise<Response> => {
  try {
    const database = getDatabase(); const session = await requireSession();
    if (request.method === 'GET') {
      return Response.json({routing: await readAgentRoutingPolicy(database, session.actorId, projectId)},
        {headers: {'cache-control': 'no-store'}});
    }
    if (request.method !== 'POST') return new Response(null, {status: 405, headers: {allow: 'GET, POST'}});
    requireCsrf(request); const body = await json(request); const policy = parseAgentRoutingPolicy(body.policy);
    if (policy === null) throw new Error('body_invalid');
    const runtime=await readProjectHermesRuntimeBinding(database,session.actorId,projectId);
    assertAgentRoutingPolicyAvailable(policy,projectHermesExecutorCatalog(runtime));
    const result = await saveAgentRoutingPolicy(database, {workspaceId: session.workspaceId, projectId,
      actorId: session.actorId, policy, idempotencyKey: string(body.idempotencyKey),
      occurredAt: new Date().toISOString()});
    return Response.json(result, {status: 201, headers: {'cache-control': 'no-store'}});
  } catch (error) { return jsonError(error); }
};

export const refreshContext = async (request: Request, projectId: string): Promise<Response> => {
  try {
    if (request.method !== 'POST') return new Response(null, {status: 405, headers: {allow: 'POST'}});
    const database = getDatabase(); const session = await requireSession(); requireCsrf(request);
    const body = await json(request);
    await refreshBoundGitHubContextSources(database, session.actorId, projectId);
    const result = await refreshProjectContext(database, {workspaceId: session.workspaceId, projectId, actorId: session.actorId,
      idempotencyKey: string(body.idempotencyKey), occurredAt: new Date().toISOString()});
    return Response.json(result, {headers: {'cache-control': 'no-store'}});
  } catch (error) { return jsonError(error); }
};

export const approval = async (request: Request, approvalId: string): Promise<Response> => {
  try {
    const database = getDatabase();
    const session = await requireSession();
    requireCsrf(request);
    const body = await json(request);
    const kind = string(body.kind, 32) as ApprovalKind;
    const persistence = createApprovalPersistence(database);
    const projectId = string(body.projectId);
    const targetReference=string(body.targetReference);
    const artifactTarget=kind==='internal_operation'?await persistence.targets.resolve({projectId,targetReference}):null;
    const assignment=artifactTarget===null?await githubAssignment(database,session.actorId,projectId,unavailableDelivery):null;
    const stores = createStores(database, session.workspaceId);
    const result = await decideApproval({workspaceId: session.workspaceId, request: {
      id: approvalId, projectId, kind,
      decision: string(body.decision, 16) as ApprovalEvidence['decision'], actorId: session.actorId,
      targetReference, decidedAt: new Date().toISOString(),
      idempotencyKey: string(body.idempotencyKey)
    }, authority: {
        canDecide: (actorId, projectId, approvalKind) => canApprove(database, actorId, projectId, approvalKind)
      }, targets: {async resolve(target) {
        if(artifactTarget!==null)return target.targetReference===artifactTarget.id?artifactTarget:null;
        const snapshot = await assignment!.trackerRead.readSnapshot(assignment!.context.bindingId, null);
        if (snapshot.items.some((item) => item.projectId !== projectId)) throw new Error('tracker_project_mismatch');
        await stores.snapshots.replace(snapshot);
        const fact = snapshot.items.find((item) => item.itemId === target.targetReference || item.issueId === target.targetReference);
        return fact === undefined ? persistence.targets.resolve(target)
          : {id: target.targetReference, url: fact.url, version: fact.version};
      }}, transaction: persistence.transaction});
    return Response.json({status: result}, {status: result === 'recorded' || result === 'duplicate' ? 200 : 409});
  } catch (error) { return jsonError(error); }
};

const unavailableDelivery: AgentDeliveryPort = {submit: async () => { throw new Error('agent_provider_unavailable'); },
  observe: async () => { throw new Error('agent_provider_unavailable'); }};

export const taskAssignableUsers = async (request: Request): Promise<Response> => {
  try{if(request.method!=='GET')return new Response(null,{status:405,headers:{allow:'GET'}});await requireSession();
    return workerTaskCommand(request);}catch(error){return jsonError(error);}
};

export const taskExecutor = async (request: Request): Promise<Response> => {
  try{if(request.method!=='POST')return new Response(null,{status:405,headers:{allow:'POST'}});await requireSession();
    requireCsrf(request);return workerTaskCommand(request,await json(request));}catch(error){return jsonError(error);}
};

const envSecret = (prefix: string, purpose: string): OpaqueSecretRef => ({
  id: prefix, purpose, locator: string(process.env[`${prefix}_FILE`], 1_024)
});

const watchedContextPaths = new Map([
  ['AGENTS.md', 'repo:agents'],
  ...projectPassportPaths.map((path) => [path, 'repo:passport'] as const)
]);
export const pushChangedPaths = (body: Uint8Array, expected: Readonly<{repository: string; branch: string}>):
  Readonly<{after: string; paths: readonly string[]; removed: readonly string[]}> | null => {
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(body).toString('utf8')); } catch { return null; }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>; const after = typeof value.after === 'string' ? value.after : '';
  const repository = value.repository as Record<string,unknown>|undefined;
  const expectedRepository = expected.repository; const expectedRef = `refs/heads/${expected.branch}`;
  if (!/^[a-f0-9]{40}$/i.test(after) || /^0{40}$/.test(after) || value.ref !== expectedRef ||
    repository?.full_name !== expectedRepository || !Array.isArray(value.commits)) return null;
  const paths = new Set<string>(); const removed = new Set<string>();
  for (const commit of value.commits) {
    if (commit === null || typeof commit !== 'object') continue;
    for (const field of ['added', 'modified'] as const) {
      const entries = (commit as Record<string, unknown>)[field];
      if (Array.isArray(entries)) for (const path of entries) if (typeof path === 'string' && watchedContextPaths.has(path)) {
        paths.add(path); removed.delete(path);
      }
    }
    const entries = (commit as Record<string, unknown>).removed;
    if (Array.isArray(entries)) for (const path of entries) if (typeof path === 'string' && watchedContextPaths.has(path)) {
      paths.delete(path); removed.add(path);
    }
  }
  return {after: after.toLowerCase(), paths: [...paths].sort(), removed: [...removed].sort()};
};
export const githubWebhookRepository = (body: Uint8Array): string | null => {
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(body).toString('utf8')); } catch { return null; }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const fullName = (payload as {repository?: {full_name?: unknown}}).repository?.full_name;
  return typeof fullName === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) ? fullName : null;
};
export const githubRuntimeCoordinates = (binding: Readonly<{provider: string; projectUrl: string;
  repositoryUrl: string}>): Readonly<{owner: string; repository: string; projectNumber: number}> | null => {
  if (binding.provider !== 'github') return null;
  let projectUrl: URL; let repositoryUrl: URL;
  try {
    projectUrl = new URL(binding.projectUrl); repositoryUrl = new URL(binding.repositoryUrl);
  } catch {
    return null;
  }
  const project = /^\/users\/([^/]+)\/projects\/(\d+)\/?$/.exec(projectUrl.pathname);
  const repository = /^\/([^/]+)\/([^/]+)\/?$/.exec(repositoryUrl.pathname);
  if (projectUrl.origin !== 'https://github.com' || repositoryUrl.origin !== 'https://github.com' ||
    project === null || repository === null || project[1]!.toLowerCase() !== repository[1]!.toLowerCase()) return null;
  const projectNumber = Number(project[2]);
  return Number.isSafeInteger(projectNumber) && projectNumber > 0
    ? {owner: project[1]!, repository: repository[2]!, projectNumber} : null;
};
export const refreshGitHubContextSources = async (database: ReturnType<typeof getDatabase>, input: Readonly<{
  projectId: string; actorId: string; owner: string; repository: string; credentialRef: OpaqueSecretRef;
  after: string; paths: readonly string[]; requiredKeys?: readonly string[];
}>): Promise<void> => {
  const token = (await secretResolver.resolve(input.credentialRef, 'tracker_read')).value;
  if (token.length === 0 || token.length > 65_536 || token.includes('\0')) throw new Error('github_credential_invalid');
  const resolved = new Set<string>(); const missing = new Map<string, string>();
  for (const path of input.paths) {
    const key = watchedContextPaths.get(path);
    if (key === undefined) throw new Error('github_context_read_invalid');
    if (resolved.has(key)) continue;
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${input.after}`, {
      headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28'},
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 404) { missing.set(key, path); continue; }
    if (!response.ok) throw new Error('github_context_read_failed');
    const value = await response.json() as Record<string, unknown>;
    if (value.type !== 'file' || typeof value.content !== 'string' || value.encoding !== 'base64') throw new Error('github_context_read_invalid');
    const content = Buffer.from(value.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (content.length === 0 || content.length > 200_000 || content.includes('\0')) throw new Error('github_context_read_invalid');
    const serialized = JSON.stringify({contract:'fai.project-context-source.v1', key, content});
    await addSourceArtifact(database, {projectId: input.projectId, actorId: input.actorId,
      kind: 'project_context_source_v1', name: key, mediaType: 'application/json', contentText: serialized,
      sha256: createHash('sha256').update(serialized).digest('hex'),
      sourceUrl: `https://github.com/${input.owner}/${input.repository}/blob/${input.after}/${path}`,
      provenance: `repo-file:${path}@${input.after}`});
    resolved.add(key);
  }
  for (const [key, path] of missing) {
    if (resolved.has(key)) continue;
    await invalidateRemovedGitHubContextSources(database, {...input, paths: [path]});
    if (input.requiredKeys?.includes(key)) throw new Error('project_context_not_configured');
  }
};

const refreshBoundGitHubContextSources = async (database: ReturnType<typeof getDatabase>, actorId: string,
  projectId: string): Promise<void> => {
  const binding = await resolveAgentSubmissionBinding(database, actorId, projectId);
  if (binding === null) throw new Error('github_binding_invalid');
  const coordinates = githubRuntimeCoordinates(binding);
  const capabilities = await readProjectTrackerCapabilities(database, actorId, projectId);
  if (coordinates === null || capabilities?.provider !== 'github') throw new Error('github_binding_invalid');
  const token = (await secretResolver.resolve(binding.trackerCredentialRef, 'tracker_read')).value;
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repository)}/commits/${encodeURIComponent(capabilities.defaultBranch)}`, {
    headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28'}, signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error('github_context_read_failed');
  const value = await response.json() as {sha?: unknown};
  if (typeof value.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(value.sha)) throw new Error('github_context_read_invalid');
  await refreshGitHubContextSources(database, {projectId, actorId, owner: coordinates.owner,
    repository: coordinates.repository, credentialRef: binding.trackerCredentialRef, after: value.sha.toLowerCase(),
    paths: [...watchedContextPaths.keys()], requiredKeys: ['repo:agents', 'repo:passport']});
};

const invalidateRemovedGitHubContextSources = async (database: ReturnType<typeof getDatabase>, input: Readonly<{
  projectId: string; actorId: string; after: string; paths: readonly string[];
}>): Promise<void> => {
  for (const path of input.paths) {
    const key = watchedContextPaths.get(path); if (key === undefined) continue;
    const serialized = JSON.stringify({contract:'fai.project-context-source.v1',key,
      content:`Source removed from the configured repository at ${input.after}.`});
    await addSourceArtifact(database,{projectId:input.projectId,actorId:input.actorId,
      kind:'project_context_source_v1',name:key,mediaType:'application/json',contentText:serialized,
      sha256:createHash('sha256').update(serialized).digest('hex'),sourceUrl:null,
      provenance:`repo-file-removed:${path}@${input.after}`});
  }
};

export const githubWebhook = async (request: Request): Promise<Response> => {
  try {
    const database = getDatabase();
    const body = new Uint8Array(await request.arrayBuffer());
    const verified = await verifyGitHubWebhook({headers: {
      'x-hub-signature-256': request.headers.get('x-hub-signature-256') ?? undefined,
      'x-github-delivery': request.headers.get('x-github-delivery') ?? undefined,
      'x-github-event': request.headers.get('x-github-event') ?? undefined
    }, body, secretRef: envSecret('GITHUB_WEBHOOK_SECRET', 'tracker_webhook_verify'), secrets: secretResolver});
    if (verified === null) throw new Error('webhook_denied');
    const fullName = githubWebhookRepository(body);
    if (fullName === null) throw new Error('webhook_denied');
    const runtime = await resolveProjectRuntimeByRepository(database, string(process.env.FCP_WORKSPACE_ID),
      `https://github.com/${fullName}`);
    const coordinates = runtime === null ? null : githubRuntimeCoordinates(runtime);
    if (runtime === null || coordinates === null || runtime.trackerCapabilities === null) throw new Error('webhook_denied');
    const result = await appendIncomingEvent(database, {projectId: runtime.projectId, provider: 'github',
      providerDeliveryId: verified.deliveryId, eventType: verified.eventType, payloadHash: verified.payloadHash,
      receivedAt: new Date().toISOString()});
    const push = verified.eventType === 'push' ? pushChangedPaths(body,{
      repository:`${coordinates.owner}/${coordinates.repository}`,
      branch: runtime.trackerCapabilities.defaultBranch
    }) : null;
    if (push !== null && (push.paths.length > 0 || push.removed.length > 0)) {
      if (result === 'duplicate') {
        const processed = await database.query(`select 1 from command_receipts
          where project_id=$1 and idempotency_key=$2 and command_type='project.context.activate'`,
        [runtime.projectId,`project-context:webhook:${verified.deliveryId}`]);
        if (processed.rowCount === 1) return Response.json({status:'duplicate'}, {status:200});
      }
      await refreshGitHubContextSources(database, {projectId: runtime.projectId, actorId: runtime.ownerActorId,
        owner: coordinates.owner, repository: coordinates.repository, credentialRef: runtime.trackerCredentialRef,
        after: push.after, paths: [...watchedContextPaths.keys()],
        requiredKeys: ['repo:agents', 'repo:passport']});
      await refreshProjectContext(database, {workspaceId: runtime.workspaceId,
        projectId: runtime.projectId, actorId: runtime.ownerActorId,
        idempotencyKey: `project-context:webhook:${verified.deliveryId}`,
        occurredAt: new Date().toISOString()});
    }
    return Response.json({status: result}, {status: result === 'recorded' ? 202 : 200});
  } catch (error) { return jsonError(error); }
};

export const health = (): Response => Response.json({status: 'ok', service: 'web'},
  {headers: {'cache-control': 'no-store'}});
export const ready = async (): Promise<Response> => {
  const database = getDatabase();
  const ok = await databaseMvpReady(database);
  return Response.json({status: ok ? 'ready' : 'not_ready', ...readiness({database: ok})},
    {status: ok ? 200 : 503, headers: {'cache-control': 'no-store'}});
};
