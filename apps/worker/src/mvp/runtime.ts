import {createHash} from 'node:crypto';
import {createAgentAttemptStore, createAgentContinuationStore, createDatabase, createStores,
  completeProjectContextBootstrap, failProjectContextBootstrap, listProjectContextBootstrapAttempts,
  listApprovedProjectTrackerPreparations,listProjectHermesRuntimeBindings,listProjectTrackerPreparationAttempts,
  listRejectedProjectTrackerPreparations,
  listProjectRuntimeProvisioningRequests,projectHermesExecutorCatalog,recordProjectRuntimeProvisioningState,
  projectTrackerPreparationAssignment,recordProjectTrackerPreparationBlocker,recordProjectTrackerPreparationResult,
  recordProjectTrackerPreparationStart,recordVerifiedProjectTrackerCapabilities,
  promoteApprovedProjectArchitectures,
  executeAgentSubmissionTransaction, readActiveProjectContext, readAgentRoutingPolicy,
  executeAutonomousPmTransaction,finishAutonomousPmAttempt,listActiveAutonomousPmAttempts,
  claimAutonomousPmRecovery,hasActiveAgentAttempt,retryAutonomousPmTransaction,
  readActiveProjectExecutionMode,readActiveProjectProcessPolicy, resolveAgentSubmissionBinding, type Database} from '@fai-control-plane/db';
import {defaultAgentStageInstructions, composeAgentTerminalNotification, continueExplicitAgentChain,
  autonomousPmEnabled,autonomousPmKey,deliverPending,reconcileActiveAgentAttempts,reconcileTracker,
  sameAutonomousActivation,submitExplicitAgent,
  verifyAutonomousPmSelection,
  type AgentAttemptRecord, type AgentSubmissionPorts
} from '@fai-control-plane/application';
import {
  createHermesDeliveryAdapter,
  createGitHubRepositoryReadAdapter,
  createGitHubTrackerReadAdapter,
  createTelegramDeliveryAdapter
} from '@fai-control-plane/integrations';
import type {
  AgentDeliveryPort,
  AutonomousPmDeliveryPort,
  MessengerDeliveryPort,
  MessengerDeliveryInput,
  TrackerItemFact
} from '@fai-control-plane/domain';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {enqueueProjectFailureBlockers, githubBindingCoordinates, listWorkerProjectBindings,
  runProjectBindingsIsolated,
  type WorkerProjectBinding} from './project-runtime.ts';
import {provisionProjectHermesRuntime,restartProjectHermesGateway,type DockerRequest} from './docker-project-runtime.ts';
import {projectRuntimeSecrets as secrets} from './runtime-secrets.ts';

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_required`);
  return value;
};
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type TrackerPreparationBinding=Readonly<{projectUrl:string;repositoryUrl:string;token:string}>;
export const trackerPreparationDeltaShrank=(prior:readonly string[],next:readonly string[])=>next.length<prior.length&&
  next.every((item)=>prior.includes(item));
export const inspectConfirmedGitHubProject=async(input:Readonly<{projectUrl:string;repositoryUrl:string;token:string;
  stages:readonly string[]}>,request:typeof fetch=fetch):Promise<Readonly<{remainingDelta:readonly string[];capabilities:null|Readonly<{
    provider:'github';agentOwnerOptionId:string;doneStatusOptionId:string;defaultBranch:string}>}>>=>{let projectUrl:URL;let repositoryUrl:URL;
  try{projectUrl=new URL(input.projectUrl);repositoryUrl=new URL(input.repositoryUrl);}catch{throw new Error('github_binding_invalid');}
  const projectMatch=/^\/users\/([^/]+)\/projects\/(\d+)\/?$/.exec(projectUrl.pathname);
  const repositoryMatch=/^\/([^/]+)\/([^/]+)\/?$/.exec(repositoryUrl.pathname);
  if(projectUrl.origin!=='https://github.com'||repositoryUrl.origin!=='https://github.com'||projectMatch===null||repositoryMatch===null||
    projectMatch[1]!.toLowerCase()!==repositoryMatch[1]!.toLowerCase())
    throw new Error('github_binding_invalid');
  const query=`query($owner:String!,$number:Int!,$repositoryOwner:String!,$repository:String!){
    user(login:$owner){projectV2(number:$number){fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}pageInfo{hasNextPage}}}}
    repository(owner:$repositoryOwner,name:$repository){defaultBranchRef{name}}}`;
  const response=await request('https://api.github.com/graphql',{method:'POST',headers:{accept:'application/vnd.github+json',
    authorization:`Bearer ${input.token}`,'content-type':'application/json','x-github-api-version':'2022-11-28'},body:JSON.stringify({query,
      variables:{owner:projectMatch[1],number:Number(projectMatch[2]),repositoryOwner:repositoryMatch[1],repository:repositoryMatch[2]}}),
    signal:AbortSignal.timeout(15_000)});if(!response.ok)throw new Error(response.status===401||response.status===403
      ?'tracker_authentication_failed':response.status===429||response.status>=500?'tracker_read_retryable':'tracker_read_failed');const payload=await response.json() as {data?:{
      user?:{projectV2?:{fields?:{nodes?:readonly {id?:string;name?:string;options?:readonly {id?:string;name?:string}[]}[];pageInfo?:{hasNextPage?:boolean}}}},
      repository?:{defaultBranchRef?:{name?:string}}}};const fields=payload.data?.user?.projectV2?.fields;
  if(fields===undefined||fields.pageInfo?.hasNextPage===true)throw new Error('github_response_invalid');const nodes=fields.nodes??[];
  const field=(name:string)=>nodes.find((candidate)=>candidate.name===name);const status=field('Status');const owner=field('Owner');const blocked=field('Blocked');
  const names=(value:typeof status)=>value?.options?.map((option)=>option.name).filter((name):name is string=>typeof name==='string')??[];
  const remainingDelta:string[]=[];if(JSON.stringify(names(status))!==JSON.stringify(input.stages))remainingDelta.push(`Status: ${input.stages.join(' -> ')}`);
  const hermes=owner?.options?.find((option)=>option.name==='Hermes');if(typeof hermes?.id!=='string')remainingDelta.push('Owner: Hermes');
  if(JSON.stringify(names(blocked))!==JSON.stringify(['No','Yes']))remainingDelta.push('Blocked: No, Yes');
  const done=status?.options?.find((option)=>option.name==='Done');const defaultBranch=payload.data?.repository?.defaultBranchRef?.name;
  if(typeof defaultBranch!=='string')remainingDelta.push('Repository: default branch');
  return {remainingDelta,capabilities:remainingDelta.length===0&&typeof hermes?.id==='string'&&typeof done?.id==='string'&&
    typeof defaultBranch==='string'?{provider:'github',agentOwnerOptionId:hermes.id,doneStatusOptionId:done.id,defaultBranch}:null};};
export const restartHermesGateway = async (
  runtime: WorkerProjectBinding['runtime'],docker?:DockerRequest
): Promise<void> => {
  const gateway = new URL(runtime.gatewayEndpoint);
  if (gateway.toString() !== `http://${runtime.runtimeId}-gateway:8642/v1/runs`) throw new Error('hermes_restart_denied');
  await restartProjectHermesGateway(runtime,docker);
};

export const projectContextRunFailureCode=(status:number):string|null=>status===404?'run_not_found':
  status>=400&&status<500?'provider_authentication_failed':null;
export const trackerReadbackRetryable=(error:unknown):boolean=>error instanceof TypeError||error instanceof DOMException&&
  error.name==='TimeoutError'||error instanceof Error&&error.message==='tracker_read_retryable';

/** Process-local endpoint health only; canonical attempt state remains in the
 * existing receipts/audit tables. */
export const createEndpointRecoveryGate = (threshold = 2) => {
  if (!Number.isInteger(threshold) || threshold < 2) throw new Error('agent_recovery_threshold_invalid');
  const failures = new Map<string, number>();
  const recovered = new Set<string>();
  return {
    failed(reference: string): 'wait'|'recover'|'exhausted' {
      const count = (failures.get(reference) ?? 0) + 1;
      failures.set(reference, count);
      if (count < threshold) return 'wait';
      if (recovered.has(reference)) return 'exhausted';
      recovered.add(reference); return 'recover';
    },
    succeeded(reference: string, terminal = false): void {
      failures.delete(reference);
      if (terminal) recovered.delete(reference);
    }
  };
};

export const createWorker = (database: Database = createDatabase()) => {
  const workspaceId = env('FCP_WORKSPACE_ID');
  const stores = createStores(database, workspaceId);
  const continuations = createAgentContinuationStore(database);
  const clientMessenger: MessengerDeliveryPort = {async send() {
    throw new Error('client_messenger_not_configured');
  }};
  const internalMessenger: MessengerDeliveryPort = {async send(message) {
    const project = (await activeProjects()).find((candidate) => candidate.projectId === message.projectId);
    if (project === undefined || project.runtime.telegramChatId === null) throw new Error('telegram_config_invalid');
    return createTelegramDeliveryAdapter({config: {projectId: project.projectId,
      chatId: project.runtime.telegramChatId, tokenRef: project.runtime.telegramCredentialRef}, secrets}).send(message);
  }};
  const agentDeliveries = new Map<string, Readonly<{signature: string;
    delivery: AgentDeliveryPort&AutonomousPmDeliveryPort}>>();
  const recoveryGate = createEndpointRecoveryGate();
  const trackerReadbackGate = createEndpointRecoveryGate(3);

  const projectRuntime = (project: WorkerProjectBinding) => {
    const executorCatalog=projectHermesExecutorCatalog(project.runtime);
    const coordinates = githubBindingCoordinates(project);
    if (coordinates === null) throw new Error('tracker_provider_unsupported');
    const trackerBinding = {id: project.bindingId, ...coordinates, projectId: project.projectId,
      projectUrl: project.projectUrl, credentialRef: project.trackerCredentialRef};
    const tracker = createGitHubTrackerReadAdapter({binding: trackerBinding, secrets});
    const repository = createGitHubRepositoryReadAdapter({...coordinates, repositoryId: project.repositoryId,
      credentialRef: project.trackerCredentialRef, secrets});
    const agentSignature = `${project.bindingId}:${project.runtime.artifactVersion}`;
    const existingDelivery = agentDeliveries.get(project.projectId);
    const agentDelivery = existingDelivery?.signature === agentSignature ? existingDelivery.delivery
      : createHermesDeliveryAdapter({endpoint: project.runtime.gatewayEndpoint,
        credentialRef: project.runtime.agentCredentialRef, secrets, allowPrivateHttp: true});
    if (existingDelivery?.signature !== agentSignature) {
      agentDeliveries.set(project.projectId, {signature: agentSignature, delivery: agentDelivery});
    }
    const submissionPorts: AgentSubmissionPorts = {
      async resolveContext({actorId, projectId}) {
        if (projectId !== project.projectId) return null;
        const binding = await resolveAgentSubmissionBinding(database, actorId, projectId);
        if (binding === null || binding.bindingId !== project.bindingId ||
          binding.repositoryId !== project.repositoryId || binding.repositoryUrl !== project.repositoryUrl) return null;
        const configured = await readAgentRoutingPolicy(database, actorId, projectId);
        const processPolicy = await readActiveProjectProcessPolicy(database, projectId);
        if (processPolicy === null) return null;
        const policy = configured?.policy ?? defaultAgentRoutingPolicy;
        const version = configured?.version ??
          createHash('sha256').update(JSON.stringify(policy)).digest('hex');
        return {workspaceId, projectId, requesterRole: binding.requesterRole,
          bindingId: project.bindingId, repository: {id: project.repositoryId, url: project.repositoryUrl},
          agentTrackerOwnerOptionId: project.agentOwnerOptionId,
          doneStatusOptionId: project.doneStatusOptionId,
          routingPolicyVersion: version, routingPolicy: policy, executorCatalog,
          processPolicyVersion: processPolicy.version, processPolicy: processPolicy.policy};
      },
      readFreshSnapshot: (context) => tracker.readSnapshot(context.bindingId, null),
      persistSnapshot: stores.snapshots.replace,
      resolveActiveContext: ({actorId, projectId}) => readActiveProjectContext(database, actorId, projectId),
      repository,
      delivery: agentDelivery,
      composeAcceptedNotification: async (item, idempotencyKey) => ({projectId: project.projectId,
        contour: 'trusted-main', channelReference: 'telegram:internal',
        text: `ИИ-агент начал следующий этап: ${item.title} — ${item.url}`, idempotencyKey}),
      transaction: {execute: (input, submit) => executeAgentSubmissionTransaction(database, input, submit)}
    };
    const statusChanged = async (
      prior: TrackerItemFact, item: TrackerItemFact, idempotencyKey: string
    ): Promise<MessengerDeliveryInput> => ({projectId: project.projectId, contour: 'trusted-main',
      channelReference: 'telegram:internal',
      text: `Статус задачи изменён: ${prior.statusOptionName ?? 'Не указан'} → ${item.statusOptionName ?? 'Не указан'}\n${item.title} — ${item.url}`,
      idempotencyKey});
    return {project,tracker,agentDelivery,submissionPorts,statusChanged};
  };

  const activeProjects = async () => {
    const projects = await listWorkerProjectBindings(database, workspaceId);
    const activeIds = new Set(projects.map((project) => project.projectId));
    for (const projectId of agentDeliveries.keys()) {
      if (!activeIds.has(projectId)) agentDeliveries.delete(projectId);
    }
    return projects;
  };
  const reportFailures = async (operation: 'observe'|'reconcile',
    results: readonly Readonly<{projectId: string; status: 'completed'|'failed'}>[]) => {
    await enqueueProjectFailureBlockers(operation, results, async ({projectId, idempotencyKey, text}) => {
      await stores.outbox.enqueue({projectId, topic: 'messenger-notification', idempotencyKey,
        availableAt: new Date().toISOString(), payload: {message: {projectId, contour: 'trusted-main',
          channelReference: 'telegram:internal', text, idempotencyKey}}});
    });
    for (const result of results) if (result.status === 'failed') {
      process.stderr.write(`worker_project_failed:${result.projectId}:${operation}\n`);
    }
  };
  const notifyRecovery = async (projectId: string, deliveryReference: string, step: string, text: string) => {
    const idempotencyKey = `agent.recovery:${deliveryReference}:${step}`;
    await stores.outbox.enqueue({projectId, topic: 'messenger-notification', idempotencyKey,
      availableAt: new Date().toISOString(), payload: {message: {projectId, contour: 'trusted-main',
        channelReference: 'telegram:internal', text, idempotencyKey}}});
  };
  const autonomousNotification=(projectId:string,key:string,text:string):MessengerDeliveryInput=>({projectId,
    contour:'trusted-main',channelReference:'telegram:internal',text,idempotencyKey:key});
  const failAutonomousPm=async(attempt:Awaited<ReturnType<typeof listActiveAutonomousPmAttempts>>[number],
    suffix:string,text:string)=>finishAutonomousPmAttempt(database,attempt,{status:'failed',result:null,
      notification:autonomousNotification(attempt.projectId,`${attempt.idempotencyKey}:${suffix}`,text)});
  const recoverAutonomousPm=async(runtime:ReturnType<typeof projectRuntime>,attempt:Awaited<ReturnType<
    typeof listActiveAutonomousPmAttempts>>[number])=>{if(attempt.retryOf!==null){await failAutonomousPm(attempt,'exhausted',
      'Автономный режим остановлен: ИИ-агент недоступен после одной попытки восстановления.');return null;}
    const claim=await claimAutonomousPmRecovery(database,attempt);if(claim==='exhausted'){await failAutonomousPm(attempt,
      'exhausted','Автономный режим остановлен: ИИ-агент недоступен после одной попытки восстановления.');return null;}
    if(claim==='claimed'){await notifyRecovery(attempt.projectId,attempt.deliveryReference,'autonomous-pm',
      'ИИ-агент недоступен во время автономной сверки. Перезапускаю только ИИ-агента этого проекта.');
      try{await restartHermesGateway(runtime.project.runtime);}catch{await failAutonomousPm(attempt,'restart-failed',
        'Автономный режим остановлен: ИИ-агента не удалось восстановить.');return null;}}
    try{await stores.snapshots.replace(await runtime.tracker.readSnapshot(runtime.project.bindingId,null));}
    catch{await failAutonomousPm(attempt,'recovery-facts-failed',
      'Автономный режим остановлен: после восстановления не удалось подтвердить данные таск-трекера.');return null;}
    let observed:Awaited<ReturnType<AutonomousPmDeliveryPort['observeReconciliation']>>={status:'unknown'};
    try{observed=await runtime.agentDelivery.observeReconciliation(attempt.deliveryReference);}catch{/* retry below */}
    if(observed.status!=='unknown'){recoveryGate.succeeded(attempt.deliveryReference,
      observed.status==='completed'||observed.status==='failed');return observed;}
    const idempotencyKey=`${attempt.idempotencyKey}:retry`;const correlationId=`browser:${createHash('sha256').update(
      idempotencyKey).digest('hex')}`;
    try{const retried=await retryAutonomousPmTransaction(database,attempt,{idempotencyKey,correlationId},async()=>
      runtime.agentDelivery.submitReconciliation({contract:'fai.autonomous-pm-request.v1',project:{id:attempt.projectId,
        repositoryUrl:runtime.project.repositoryUrl,trackerUrl:runtime.project.projectUrl},versions:{
        process:attempt.processVersion,routing:attempt.routingVersion},correlationId,idempotencyKey}));
      if(retried.status==='disabled')await finishAutonomousPmAttempt(database,attempt,{status:'completed',result:null,
        notification:null});else if(retried.status==='busy')await failAutonomousPm(attempt,'retry-overlap',
        'Автономный режим остановлен: в проекте уже выполняется другая задача.');return null;
    }catch{await failAutonomousPm(attempt,'recovery-failed',
      'Автономный режим остановлен: восстановление ИИ-агента не завершилось.');return null;}}
  const observeAutonomousPm=async()=>{const projects=new Map((await activeProjects()).map((project)=>[project.projectId,project]));
    for(const attempt of await listActiveAutonomousPmAttempts(database,workspaceId,20)){const project=projects.get(attempt.projectId);
      if(project===undefined)continue;const runtime=projectRuntime(project);let observed:Awaited<ReturnType<
        AutonomousPmDeliveryPort['observeReconciliation']>>;try{observed=await runtime.agentDelivery.observeReconciliation(
        attempt.deliveryReference);}catch{observed={status:'unknown'};}
      if(observed.status==='unknown'&&observed.progress===undefined){const recovery=recoveryGate.failed(attempt.deliveryReference);
        if(recovery==='wait')continue;if(recovery==='exhausted'){await failAutonomousPm(attempt,'exhausted',
          'Автономный режим остановлен: ИИ-агент недоступен после одной попытки восстановления.');continue;}
        const recovered=await recoverAutonomousPm(runtime,attempt);if(recovered===null)continue;observed=recovered;
      }else recoveryGate.succeeded(attempt.deliveryReference,observed.status==='completed'||observed.status==='failed');
      if(observed.status==='started'||observed.status==='unknown')continue;
      if(observed.status==='failed'||observed.result===undefined){await finishAutonomousPmAttempt(database,attempt,{status:'failed',
        result:null,notification:autonomousNotification(attempt.projectId,`${attempt.idempotencyKey}:failed`,
          'Автономный режим остановлен: ИИ-агент не завершил сверку таск-трекера.')});continue;}
      const result=observed.result;if(result.outcome!=='selected'){await finishAutonomousPmAttempt(database,attempt,{status:'completed',
        result,notification:autonomousNotification(attempt.projectId,`${attempt.idempotencyKey}:${result.outcome}`,
          result.outcome==='no-eligible'?'Автономный режим: готовых задач нет.':
            'Автономный режим остановлен: ИИ-агент подтвердил блокер в таск-трекере.')});continue;}
      const mode=await readActiveProjectExecutionMode(database,attempt.projectId);
      if(!sameAutonomousActivation(mode,attempt)){await finishAutonomousPmAttempt(database,attempt,{status:'completed',
        result,notification:null});continue;}
      if(await hasActiveAgentAttempt(database,attempt.projectId))continue;
      const [processPolicy,snapshot]=await Promise.all([readActiveProjectProcessPolicy(database,attempt.projectId),
        runtime.tracker.readSnapshot(project.bindingId,null)]);const selected=processPolicy===null?null:verifyAutonomousPmSelection({
          result,snapshot,projectId:project.projectId,bindingId:project.bindingId,ownerOptionId:project.agentOwnerOptionId,
          doneStatusOptionId:project.doneStatusOptionId,process:processPolicy.policy});
      if(selected===null){await finishAutonomousPmAttempt(database,attempt,{status:'failed',result,
        notification:autonomousNotification(attempt.projectId,`${attempt.idempotencyKey}:invalid-selection`,
          'Автономный режим остановлен: выбор ИИ-агента не подтверждён актуальными данными таск-трекера.')});continue;}
      const instructions=defaultAgentStageInstructions(selected.role);const oneSnapshotPorts:AgentSubmissionPorts={
        ...runtime.submissionPorts,readFreshSnapshot:async()=>snapshot};
      try{await submitExplicitAgent({actorId:attempt.actorId,projectId:attempt.projectId,projectItemId:selected.itemId,
        role:selected.role,constraints:instructions.constraints,acceptanceCriteria:instructions.acceptanceCriteria,
        root:{chainReference:attempt.correlationId,sourceReference:`autonomous:${attempt.deliveryReference}`,
          commandIdempotencyKey:attempt.idempotencyKey}},oneSnapshotPorts);
        await finishAutonomousPmAttempt(database,attempt,{status:'completed',result,notification:null});
      }catch{await finishAutonomousPmAttempt(database,attempt,{status:'failed',result,
        notification:autonomousNotification(attempt.projectId,`${attempt.idempotencyKey}:start-blocked`,
          'Автономный режим остановлен: выбранная задача больше не доступна для безопасного запуска.')});}}
  };
  const recoverAttempt = async (runtime: ReturnType<typeof projectRuntime>, attempt: AgentAttemptRecord) => {
    const recovery = recoveryGate.failed(attempt.deliveryReference);
    if (recovery === 'wait') return {status: 'started' as const};
    if (recovery === 'exhausted') throw new Error('agent_recovery_exhausted');
    if (attempt.retryOf !== null && attempt.retryOf !== undefined) throw new Error('agent_recovery_exhausted');
    await notifyRecovery(attempt.projectId, attempt.deliveryReference, 'restart',
      `ИИ-агент недоступен. Перезапускаю ИИ-агента и сохраняю текущую задачу: ${attempt.itemTitle ?? attempt.itemId}${attempt.itemUrl === null ? '' : ` — ${attempt.itemUrl}`}`);
    await restartHermesGateway(runtime.project.runtime);
    let observed: Awaited<ReturnType<AgentDeliveryPort['observe']>> = {status: 'unknown'};
    for (let probe = 0; probe < 5; probe += 1) {
      await pause(probe === 0 ? 500 : 1_000);
      try {
        observed = await runtime.agentDelivery.observe(attempt.deliveryReference);
        if (observed.status !== 'unknown') {
          recoveryGate.succeeded(attempt.deliveryReference,
            observed.status === 'completed' || observed.status === 'failed');
          return observed;
        }
        break;
      } catch { /* Gateway restart is asynchronous; probe for at most 4.5 seconds. */ }
    }
    if (observed.status !== 'unknown') return observed;
    const instructions = defaultAgentStageInstructions(attempt.role);
    try {
      await submitExplicitAgent({actorId: attempt.actorId, projectId: attempt.projectId,
        projectItemId: attempt.itemId, role: attempt.role, constraints: instructions.constraints,
        acceptanceCriteria: instructions.acceptanceCriteria,
        retry: {deliveryReference: attempt.deliveryReference, nonce: 'worker-recovery-v1',
          confirmUnobservableFailure: true}}, runtime.submissionPorts);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'agent_retry_denied') throw error;
      const resumed = await runtime.agentDelivery.observe(attempt.deliveryReference);
      if (resumed.status === 'unknown') throw error;
      return resumed;
    }
    return {status: 'started' as const};
  };
  const observeContextBootstraps=async()=>{
    const projects=new Map((await listProjectHermesRuntimeBindings(database,workspaceId))
      .map((runtime)=>[runtime.projectId,{runtime}] as const));
    for(const attempt of await listProjectContextBootstrapAttempts(database,workspaceId,20)){
      try{
        const runtime=projects.get(attempt.projectId)?.runtime;
        if(runtime===undefined)throw new Error('project_hermes_runtime_unavailable');
        const credential=await secrets.resolve(runtime.agentCredentialRef,'agent_delivery');
        const runs=new URL(runtime.gatewayEndpoint);
        const endpoint=new URL(`${runs.pathname}/${encodeURIComponent(attempt.deliveryReference)}`,runs);
        const request=()=>fetch(endpoint,{headers:{accept:'application/json',authorization:`Bearer ${credential.value}`},
          signal:AbortSignal.timeout(15_000)});
        const response=await request();const failureCode=projectContextRunFailureCode(response.status);
        if(failureCode!==null){await failProjectContextBootstrap(database,attempt,failureCode);continue;}
        if(!response.ok){await notifyRecovery(attempt.projectId,attempt.deliveryReference,'bootstrap-unavailable',
          'ИИ-агент временно недоступен во время настройки контекста. Контроль продолжается.');continue;}
        const value=await response.json().catch(()=>null) as {run_id?:unknown;status?:unknown;output?:unknown}|null;
        if(value?.run_id!==attempt.deliveryReference||typeof value.status!=='string')continue;
        if(value.status==='completed')await completeProjectContextBootstrap(database,attempt,value.output);
        else if(['failed','cancelled'].includes(value.status))
          await failProjectContextBootstrap(database,attempt,`provider_${value.status}`);
      }catch(error){
        if(error instanceof Error&&error.message==='project_context_result_invalid')
          await failProjectContextBootstrap(database,attempt,'project_context_result_invalid');
        else await notifyRecovery(attempt.projectId,attempt.deliveryReference,'bootstrap-unavailable',
          'ИИ-агент временно недоступен во время настройки контекста. Контроль продолжается.');
      }
    }
  };
  const trackerPreparationBinding=async(projectId:string,actorId:string):Promise<TrackerPreparationBinding&Readonly<{
    endpoint:string;process:NonNullable<Awaited<ReturnType<typeof readActiveProjectProcessPolicy>>>}>>=>{
    const [binding,runtimes,process]=await Promise.all([resolveAgentSubmissionBinding(database,actorId,projectId),
      listProjectHermesRuntimeBindings(database,workspaceId),readActiveProjectProcessPolicy(database,projectId)]);
    const runtime=runtimes.find((candidate)=>candidate.projectId===projectId);
    if(binding===null||runtime===undefined||process===null)throw new Error('project_tracker_preparation_unavailable');
    const token=(await secrets.resolve(runtime.agentCredentialRef,'agent_delivery')).value;
    return {projectUrl:binding.projectUrl,repositoryUrl:binding.repositoryUrl,token,endpoint:runtime.gatewayEndpoint,process};
  };
  const submitTrackerPreparation=async(input:Readonly<{projectId:string;actorId:string;remainingDelta:readonly string[];
    processVersion:string;idempotencyKey:string}>)=>{const binding=await trackerPreparationBinding(input.projectId,input.actorId);
    if(binding.process.version!==input.processVersion)throw new Error('project_process_changed');const assignment=projectTrackerPreparationAssignment({
      repositoryUrl:binding.repositoryUrl,projectUrl:binding.projectUrl,process:binding.process.policy,remainingDelta:input.remainingDelta});
    return recordProjectTrackerPreparationStart(database,{workspaceId,projectId:input.projectId,actorId:input.actorId,
      processVersion:input.processVersion,remainingDelta:input.remainingDelta,idempotencyKey:input.idempotencyKey,
      occurredAt:new Date().toISOString()},async()=>{const response=await fetch(binding.endpoint,{method:'POST',headers:{accept:'application/json',
        authorization:`Bearer ${binding.token}`,'content-type':'application/json'},body:JSON.stringify(assignment),signal:AbortSignal.timeout(15_000)});
      if(response.status!==202)throw new Error('project_tracker_preparation_unavailable');const value=await response.json().catch(()=>null) as
        {run_id?:unknown;status?:unknown}|null;if(typeof value?.run_id!=='string'||value.status!=='started')
        throw new Error('project_tracker_preparation_unavailable');return value.run_id;});};
  const observeTrackerPreparations=async()=>{
    for(const rejected of await listRejectedProjectTrackerPreparations(database,workspaceId,20))await recordProjectTrackerPreparationBlocker(database,{...rejected,
      blocker:'Владелец проекта отклонил операцию, запрошенную ИИ-агентом. Настройка таск-трекера остановлена.',occurredAt:new Date().toISOString()});
    for(const approved of await listApprovedProjectTrackerPreparations(database,workspaceId,20)){try{await submitTrackerPreparation({
      projectId:approved.projectId,actorId:approved.actorId,remainingDelta:approved.remainingDelta,processVersion:approved.processVersion,
      idempotencyKey:`${approved.correlationId}:approved:${approved.approvalVersion}`});}catch(error){await recordProjectTrackerPreparationBlocker(database,{...approved,
        blocker:error instanceof Error?error.message:'project_tracker_preparation_unavailable',occurredAt:new Date().toISOString()});}}
    for(const attempt of await listProjectTrackerPreparationAttempts(database,workspaceId,20)){try{const binding=await trackerPreparationBinding(
      attempt.projectId,attempt.actorId);const endpoint=new URL(binding.endpoint);endpoint.pathname=`${endpoint.pathname}/${encodeURIComponent(attempt.runId)}`;
      const response=await fetch(endpoint,{headers:{accept:'application/json',authorization:`Bearer ${binding.token}`},signal:AbortSignal.timeout(15_000)});
      if(!response.ok)continue;const value=await response.json().catch(()=>null) as {run_id?:unknown;status?:unknown;output?:unknown}|null;
      if(value?.run_id!==attempt.runId||typeof value.status!=='string')continue;if(['failed','cancelled'].includes(value.status)){await recordProjectTrackerPreparationBlocker(database,{...attempt,
        blocker:`ИИ-агент завершил настройку таск-трекера со статусом ${value.status}.`,occurredAt:new Date().toISOString()});continue;}
      if(value.status!=='completed')continue;const result=await recordProjectTrackerPreparationResult(database,attempt,value.output);
      if(result.status!=='verifying')continue;let inspected:Awaited<ReturnType<typeof inspectConfirmedGitHubProject>>;try{
        inspected=await inspectConfirmedGitHubProject({projectUrl:binding.projectUrl,
          repositoryUrl:binding.repositoryUrl,token:binding.token,stages:binding.process.policy.stages.map((stage)=>stage.title)});
        trackerReadbackGate.succeeded(attempt.runId,true);
      }catch(error){if(trackerReadbackRetryable(error)&&trackerReadbackGate.failed(attempt.runId)!=='exhausted')continue;throw error;}
      if(inspected.capabilities!==null){await recordVerifiedProjectTrackerCapabilities(database,{attempt,capabilities:inspected.capabilities,
        occurredAt:new Date().toISOString()});continue;}if(trackerPreparationDeltaShrank(attempt.remainingDelta,inspected.remainingDelta)){await submitTrackerPreparation({
          projectId:attempt.projectId,actorId:attempt.actorId,remainingDelta:inspected.remainingDelta,processVersion:attempt.processVersion,
          idempotencyKey:`${attempt.correlationId}:retry:${createHash('sha256').update(JSON.stringify(inspected.remainingDelta)).digest('hex')}`});continue;}
      await recordProjectTrackerPreparationBlocker(database,{...attempt,remainingDelta:inspected.remainingDelta,
        blocker:'Таск-трекер по-прежнему не соответствует подтверждённому процессу; повтор ИИ-агента не дал наблюдаемого прогресса.',
        occurredAt:new Date().toISOString()});}catch(error){await recordProjectTrackerPreparationBlocker(database,{...attempt,
        blocker:error instanceof Error?error.message:'project_tracker_preparation_unavailable',occurredAt:new Date().toISOString()});}}
  };
  const provisionProjectRuntimes=async()=>{
    for(const request of await listProjectRuntimeProvisioningRequests(database,workspaceId)){
      const outcome=await provisionProjectHermesRuntime(request);
      if(outcome.status==='installing')continue;
      await recordProjectRuntimeProvisioningState(database,{request,...outcome});
    }
  };
  return {
    async observe() {
      await provisionProjectRuntimes();
      await promoteApprovedProjectArchitectures(database,workspaceId);
      await observeContextBootstraps();
      await observeTrackerPreparations();
      await observeAutonomousPm();
      const results = await runProjectBindingsIsolated(await activeProjects(), async (project) => {
        const runtime = projectRuntime(project);
        const projectAttempts = createAgentAttemptStore(database, project.projectId);
        await reconcileActiveAgentAttempts(20, {delivery: runtime.agentDelivery, attempts: projectAttempts,
          readTracker: () => runtime.tracker.readSnapshot(project.bindingId, null),
          observationSucceeded: (attempt, observed) => {
            recoveryGate.succeeded(attempt.deliveryReference,
              observed.status === 'completed' || observed.status === 'failed');
          },
          recoverUnavailable: (attempt) => recoverAttempt(runtime, attempt),
          continueAgentChain: async (attempt, targetStage) => {
            const processPolicy = await readActiveProjectProcessPolicy(database, project.projectId);
            const stage = processPolicy?.policy.stages.find((candidate) => candidate.title === targetStage) ?? null;
            if (stage?.automation === null || stage === null) {
              await stores.snapshots.replace(await runtime.tracker.readSnapshot(project.bindingId, null));
              return;
            }
            await continueExplicitAgentChain({projectId: project.projectId,
              item: {projectId: attempt.projectId, itemId: attempt.itemId}, stage: stage.automation,
              stores: continuations, ports: runtime.submissionPorts,
              instructions: defaultAgentStageInstructions});
          },
          composeTerminalNotification: async (attempt, observed, key) =>
            composeAgentTerminalNotification(project.projectId, 'telegram:internal', attempt, observed, key)});
      });
      await reportFailures('observe', results);
    },
    async reconcile() {
      const results = await runProjectBindingsIsolated(await activeProjects(), async (project) => {
        const runtime = projectRuntime(project);
        let processPolicy: Awaited<ReturnType<typeof readActiveProjectProcessPolicy>> = null;
        try {
          processPolicy = await readActiveProjectProcessPolicy(database, project.projectId);
        } catch {
          processPolicy = null;
        }
        if (processPolicy === null) await stores.outbox.enqueue({projectId: project.projectId,
          topic: 'messenger-notification',
          idempotencyKey: `agent-chain:${project.projectId}:process-policy-blocker`,
          availableAt: new Date().toISOString(), payload: {message: {projectId: project.projectId,
            contour: 'trusted-main', channelReference: 'telegram:internal',
            text: 'Автоматическое продолжение ИИ-агента остановлено: активные настройки процесса недоступны или некорректны.',
            idempotencyKey: `agent-chain:${project.projectId}:process-policy-blocker`}}});
        const reconciled=await reconcileTracker({bindingId: project.bindingId, workspaceId, projectId: project.projectId,
          cursor: project.cursor, ports: {tracker: runtime.tracker, snapshots: stores.snapshots,
            outbox: stores.outbox, audit: stores.audit, compose: {statusChanged: runtime.statusChanged},
            continueAgentChain: (item) => continueExplicitAgentChain({projectId: project.projectId, item,
              stage: processPolicy?.policy.stages.find((stage) => stage.title === item.statusOptionName)
                ?.automation ?? null,
              stores: continuations, ports: runtime.submissionPorts,
              instructions: defaultAgentStageInstructions})}});
        const mode=await readActiveProjectExecutionMode(database,project.projectId);
        if(autonomousPmEnabled(mode)&&processPolicy!==null){
          const configured=await readAgentRoutingPolicy(database,mode.actorId,project.projectId);
          const routingPolicy=configured?.policy??defaultAgentRoutingPolicy;const routingVersion=configured?.version??
            createHash('sha256').update(JSON.stringify(routingPolicy)).digest('hex');
          const idempotencyKey=autonomousPmKey({projectId:project.projectId,modeChangedAt:mode.changedAt,
            processVersion:processPolicy.version,routingVersion,snapshotVersion:reconciled.externalVersion});
          const correlationId=`browser:${idempotencyKey.slice('autonomous.pm:'.length)}`;
          await executeAutonomousPmTransaction(database,{workspaceId,projectId:project.projectId,actorId:mode.actorId,
            idempotencyKey,correlationId,processVersion:processPolicy.version,routingVersion,
            snapshotVersion:reconciled.externalVersion,modeChangedAt:mode.changedAt},async()=>
            runtime.agentDelivery.submitReconciliation({
              contract:'fai.autonomous-pm-request.v1',project:{id:project.projectId,repositoryUrl:project.repositoryUrl,
                trackerUrl:project.projectUrl},versions:{process:processPolicy!.version,routing:routingVersion},
              correlationId,idempotencyKey}));
        }
      });
      await reportFailures('reconcile', results);
    },
    async retry() {
      return deliverPending({limit: 20, ports: {internalMessenger,
        clientMessenger, outbox: stores.outbox, now: () => new Date()}});
    },
    close: () => database.end()
  };
};
