import {createHash} from 'node:crypto';
import {
  actorForSession,createStores,executeAgentSubmissionTransaction,projectHermesExecutorCatalog,readActiveProjectContext,
  readApprovedProductionEvidence,
  readAgentRoutingPolicy,readProjectAgentProfile,readProjectHermesRuntimeBinding,readProjectProcessPolicy,
  readProjectTrackerCapabilities,resolveAgentSubmissionBinding,type Database
} from '@fai-control-plane/db';
import {assignTaskExecutor,defaultAgentStageInstructions,startProcess,type AgentSubmissionPorts} from '@fai-control-plane/application';
import {createGitHubRepositoryReadAdapter,createGitHubTrackerMutationAdapter,createGitHubTrackerReadAdapter,
  createHermesDeliveryAdapter} from '@fai-control-plane/integrations';
import {defaultAgentRoutingPolicy,type AgentDeliveryPort,type MessengerDeliveryInput,type TrackerItemFact} from '@fai-control-plane/domain';
import {projectRuntimeSecrets} from './runtime-secrets.ts';
import {persistProjectHermesPolicies} from './hermes-project-policy.ts';

const required=(value:unknown,max=256)=>{if(typeof value!=='string'||value.length===0||value.length>max||value.includes('\0'))
  throw new Error('body_invalid');return value;};
const body=async(request:Request)=>{const text=await request.text();if(text.length===0||text.length>250_000)
  throw new Error('body_invalid');const value=JSON.parse(text) as unknown;if(value===null||typeof value!=='object'||Array.isArray(value))
  throw new Error('body_invalid');return value as Record<string,unknown>;};
const session=async(database:Database,request:Request)=>{const token=/(?:^|;\s*)fai_session=([^;]+)/.exec(
  request.headers.get('cookie')??'')?.[1];if(token===undefined)throw new Error('authentication_required');
  const value=await actorForSession(database,createHash('sha256').update(decodeURIComponent(token)).digest('hex'));
  if(value===null)throw new Error('authentication_required');return value;};
const coordinates=(binding:Readonly<{provider:string;projectUrl:string;repositoryUrl:string}>)=>{if(binding.provider!=='github')return null;
  try{const project=new URL(binding.projectUrl);const repository=new URL(binding.repositoryUrl);
    const projectMatch=/^\/users\/([^/]+)\/projects\/(\d+)\/?$/.exec(project.pathname);
    const repositoryMatch=/^\/([^/]+)\/([^/]+)\/?$/.exec(repository.pathname);
    if(project.origin!=='https://github.com'||repository.origin!=='https://github.com'||projectMatch===null||repositoryMatch===null||
      projectMatch[1]!.toLowerCase()!==repositoryMatch[1]!.toLowerCase())return null;
    return {owner:repositoryMatch[1]!,repository:repositoryMatch[2]!,projectNumber:Number(projectMatch[2])};}catch{return null;}};
const unavailableDelivery:AgentDeliveryPort={submit:async()=>{throw new Error('agent_provider_unavailable');},
  observe:async()=>({status:'unknown'})};
const assignment=async(database:Database,actorId:string,projectId:string,delivery:AgentDeliveryPort)=>{
  const context=await resolveAgentSubmissionBinding(database,actorId,projectId);if(context===null||
    !['project_owner','operator'].includes(context.requesterRole))throw new Error('task_executor_denied');
  const provider=coordinates(context);if(provider===null)throw new Error(context.provider==='github'?'github_binding_invalid':'tracker_provider_unsupported');
  const binding={id:context.bindingId,...provider,projectId:context.projectId,projectUrl:context.projectUrl,
    credentialRef:context.trackerCredentialRef};
  const tracker=createGitHubTrackerMutationAdapter({binding,credentialRef:{...context.trackerCredentialRef,purpose:'tracker_mutate'},
    secrets:projectRuntimeSecrets});const read=createGitHubTrackerReadAdapter({binding,secrets:projectRuntimeSecrets});
  const repository=createGitHubRepositoryReadAdapter({...provider,repositoryId:context.repositoryId,
    credentialRef:context.trackerCredentialRef,secrets:projectRuntimeSecrets});const stores=createStores(database,context.workspaceId);
  const [configured,runtime,processPolicy,trackerCapabilities]=await Promise.all([readAgentRoutingPolicy(database,actorId,projectId),
    readProjectHermesRuntimeBinding(database,actorId,projectId),readProjectProcessPolicy(database,actorId,projectId),
    readProjectTrackerCapabilities(database,actorId,projectId)]);
  if(processPolicy===null||trackerCapabilities===null)throw new Error('project_process_policy_unavailable');
  const routing=configured??{policy:defaultAgentRoutingPolicy,
    version:createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex')};
  const ports={resolveContext:async()=>{if(runtime!==null)await persistProjectHermesPolicies(runtime,processPolicy,routing);
    return {workspaceId:context.workspaceId,projectId:context.projectId,
    requesterRole:context.requesterRole,bindingId:context.bindingId,repository:{id:context.repositoryId,url:context.repositoryUrl},
    agentTrackerOwnerOptionId:trackerCapabilities.agentOwnerOptionId,doneStatusOptionId:trackerCapabilities.doneStatusOptionId,
    routingPolicyVersion:routing.version,routingPolicy:routing.policy,processPolicyVersion:processPolicy.version,
    processPolicy:processPolicy.policy,executorCatalog:projectHermesExecutorCatalog(runtime)};},
  readFreshSnapshot:()=>read.readSnapshot(context.bindingId,context.cursor),persistSnapshot:stores.snapshots.replace,
  resolveActiveContext:({actorId:requester,projectId:project}:Readonly<{actorId:string;projectId:string}>)=>
    readActiveProjectContext(database,requester,project),repository,delivery,
  resolveProductionApproval:(input:Readonly<{projectId:string;itemId:string;issueId:string;version:string}>)=>
    readApprovedProductionEvidence(database,input),
  composeAcceptedNotification:async(item:TrackerItemFact,idempotencyKey:string):Promise<MessengerDeliveryInput>=>({
    projectId:context.projectId,contour:'trusted-main',channelReference:'telegram:internal',
    text:`ИИ-агент принял задачу: ${item.title} — ${item.url}`,idempotencyKey}),transaction:{execute:(input:Parameters<
      AgentSubmissionPorts['transaction']['execute']>[0],submit:Parameters<AgentSubmissionPorts['transaction']['execute']>[1])=>
      executeAgentSubmissionTransaction(database,input,submit)},tracker,agentInstructions:defaultAgentStageInstructions};
  return {context,tracker,read,ports};
};
const hermesDelivery=async(database:Database,actorId:string,projectId:string)=>{const profile=await readProjectAgentProfile(
  database,actorId,projectId);if(profile.status!=='ready')throw new Error('agent_provider_unavailable');
  const runtime=await readProjectHermesRuntimeBinding(database,actorId,projectId);if(runtime===null||
    new URL(runtime.gatewayEndpoint).toString()!==`http://${runtime.runtimeId}-gateway:8642/v1/runs`)
    throw new Error('agent_provider_unavailable');return createHermesDeliveryAdapter({endpoint:runtime.gatewayEndpoint,
      credentialRef:runtime.agentCredentialRef,secrets:projectRuntimeSecrets,allowPrivateHttp:true});};

const commandError=(error:unknown):Response=>{const code=error instanceof Error?error.message:'request_failed';
  const conflict=new Map<string,string>([
    ['github_version_conflict','task_conflict'],['task_executor_conflict','task_conflict'],
    ['github_assignee_unavailable','candidate_unavailable'],['task_executor_candidate_unavailable','candidate_unavailable'],
    ['github_assignment_partial','assignment_partial'],['github_owner_unavailable','operation_unavailable'],
    ['task_executor_unavailable','operation_unavailable'],['agent_attempt_active','retry_unavailable'],
    ['agent_retry_denied','retry_unavailable'],['agent_context_unavailable','context_unavailable'],
    ['agent_submit_denied','execution_unavailable'],['agent_routing_policy_invalid','execution_unavailable'],
    ['agent_request_invalid','execution_unavailable'],['agent_profile_denied','execution_unavailable']]);
  const mappedConflict=conflict.get(code);if(mappedConflict!==undefined)return Response.json({error:mappedConflict},{status:409});
  if(['agent_profile_unavailable','agent_profile_probe_failed'].includes(code))
    return Response.json({error:'profile_unavailable'},{status:502});
  if(['agent_delivery_failed','agent_response_invalid'].includes(code))return Response.json({error:'delivery_failed'},{status:502});
  if(['tracker_provider_unsupported','github_binding_invalid','github_read_failed','github_response_invalid',
    'github_mutation_failed','github_status_unavailable','github_credential_invalid','agent_endpoint_invalid',
    'agent_provider_unavailable','agent_credential_invalid','agent_status_failed','agent_status_invalid',
    'secret_purpose_denied','secret_path_must_be_absolute','secret_invalid','secret_reference_denied'].includes(code))
    return Response.json({error:'provider_error'},{status:502});
  return Response.json({error:code},{status:code==='authentication_required'?401:code.endsWith('_denied')?403:400});};

export const projectTaskCommand=async(database:Database,request:Request):Promise<Response>=>{try{const operator=await session(database,request);
  const url=new URL(request.url);if(request.method==='GET'){const projectId=required(url.searchParams.get('projectId'));
    const {tracker}=await assignment(database,operator.actorId,projectId,unavailableDelivery);
    return Response.json({users:await tracker.listAssignableUsers()});}
  if(request.method!=='POST')return new Response(null,{status:405});const value=await body(request);const projectId=required(value.projectId);
  const action=value.action===undefined?'assign':required(value.action,32);if(!['assign','confirm_and_start','create_and_start'].includes(action))
    throw new Error('body_invalid');
  if(action==='create_and_start'){if(value.confirmed!==true)throw new Error('body_invalid');const delivery=await hermesDelivery(database,
    operator.actorId,projectId);const composed=await assignment(database,operator.actorId,projectId,delivery);
    const title=required(value.title,160);const scope=required(value.scope,1_500);const acceptance=required(value.acceptance,1_500);
    const initialStage=(await readProjectProcessPolicy(database,operator.actorId,projectId))?.policy.stages[0]?.title;
    if(initialStage===undefined)throw new Error('project_process_policy_unavailable');const key=required(value.idempotencyKey,128);
    const created=await composed.tracker.createIssue({projectId,title,statement:`## Scope\n\n${scope}\n\n## Acceptance\n\n${acceptance}`,
      initialStage,idempotencyKey:`${key}:create`});const snapshot=await composed.read.readSnapshot(composed.context.bindingId,null);
    await composed.ports.persistSnapshot(snapshot);const item=snapshot.items.find((candidate)=>candidate.url===created.url);
    if(item===undefined)throw new Error('tracker_item_unavailable');const result=await startProcess({actorId:operator.actorId,projectId,
      task:{kind:'existing',itemId:item.itemId},sourceReference:'ui:project-wizard',idempotencyKey:`${key}:start`},composed.ports);
    return Response.json({...result,itemId:item.itemId,itemUrl:item.url});}
  const itemId=required(value.projectItemId,512);
  if(action==='confirm_and_start'){if(value.confirmed!==true)throw new Error('body_invalid');const delivery=await hermesDelivery(database,
    operator.actorId,projectId);const composed=await assignment(database,operator.actorId,projectId,delivery);
    const snapshot=await composed.read.readSnapshot(composed.context.bindingId,null);await composed.ports.persistSnapshot(snapshot);
    const item=snapshot.items.find((candidate)=>candidate.itemId===itemId);const statement=value.exactStatement===null||
      value.exactStatement===undefined?null:required(value.exactStatement,20_000);
    if(item===undefined||item.version!==required(value.version,1_024)||(item.statement??null)!==statement||item.blocked===true)
      throw new Error('task_executor_conflict');const result=await startProcess({actorId:operator.actorId,projectId,
        task:{kind:'existing',itemId},sourceReference:'ui:project-wizard',idempotencyKey:required(value.idempotencyKey,128)},composed.ports);
    return Response.json({...result,itemId:item.itemId,itemUrl:item.url});}
  const executor=value.executor;if(executor===null||typeof executor!=='object'||Array.isArray(executor))throw new Error('body_invalid');
  const choice=executor as Record<string,unknown>;const kind=required(choice.kind,16);if(!['human','hermes'].includes(kind))throw new Error('body_invalid');
  const delivery=kind==='hermes'?await hermesDelivery(database,operator.actorId,projectId):unavailableDelivery;
  const composed=await assignment(database,operator.actorId,projectId,delivery);
  if(kind==='human'){const candidate=choice.candidate;if(candidate===null||typeof candidate!=='object'||Array.isArray(candidate)||
    value.retry!==undefined)throw new Error('body_invalid');const person=candidate as Record<string,unknown>;
    return Response.json(await assignTaskExecutor({actorId:operator.actorId,projectId,projectItemId:itemId,
      executor:{kind:'human',candidate:{id:required(person.id,512),login:required(person.login,256)}}},composed.ports));}
  const retryValue=value.retry;const retry=retryValue===undefined?undefined:(()=>{if(retryValue===null||typeof retryValue!=='object'||
    Array.isArray(retryValue))throw new Error('body_invalid');const retryBody=retryValue as Record<string,unknown>;return {
      deliveryReference:required(retryBody.deliveryReference,256),nonce:required(retryBody.nonce,128),
      confirmUnobservableFailure:retryBody.confirmUnobservableFailure===true};})();
  if(retry!==undefined)return Response.json(await assignTaskExecutor({actorId:operator.actorId,projectId,projectItemId:itemId,
    executor:{kind:'agent'},retry},composed.ports));
  return Response.json(await startProcess({actorId:operator.actorId,projectId,task:{kind:'existing',itemId},
    sourceReference:'ui:task-executor',idempotencyKey:`process.start:ui:${projectId}:${itemId}`},composed.ports));
}catch(error){return commandError(error);}};
