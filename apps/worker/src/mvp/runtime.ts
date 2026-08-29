import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAgentAttemptStore, createAgentContinuationStore, createDatabase, createStores,
  completeProjectContextBootstrap, failProjectContextBootstrap, listProjectContextBootstrapAttempts,
  listApprovedProjectTrackerPreparations,listProjectHermesRuntimeBindings,listProjectTrackerPreparationAttempts,
  listRejectedProjectTrackerPreparations,
  listProjectRuntimeProvisioningRequests,recordProjectRuntimeProvisioningState,
  projectTrackerPreparationAssignment,recordProjectTrackerPreparationBlocker,recordProjectTrackerPreparationResult,
  recordProjectTrackerPreparationStart,recordVerifiedProjectTrackerCapabilities,
  promoteApprovedProjectArchitectures,
  executeAgentSubmissionTransaction, readActiveProjectContext, readAgentRoutingPolicy,
  readActiveProjectProcessPolicy, resolveAgentSubmissionBinding, type Database} from '@fai-control-plane/db';
import {defaultAgentStageInstructions, composeAgentTerminalNotification, continueExplicitAgentChain,
  deliverPending, reconcileActiveAgentAttempts, reconcileTracker, submitExplicitAgent,
  type AgentAttemptRecord, type AgentSubmissionPorts
} from '@fai-control-plane/application';
import {
  createHermesDeliveryAdapter,
  createGitHubRepositoryReadAdapter,
  createGitHubTrackerReadAdapter,
  createTelegramDeliveryAdapter
} from '@fai-control-plane/integrations';
import type {
  AgentExecutorCatalog,
  AgentDeliveryPort,
  MessengerDeliveryPort,
  MessengerDeliveryInput,
  SecretResolverPort,
  TrackerItemFact
} from '@fai-control-plane/domain';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {enqueueProjectFailureBlockers, githubBindingCoordinates, listWorkerProjectBindings,
  runProjectBindingsIsolated,
  type WorkerProjectBinding} from './project-runtime.ts';
import {provisionProjectHermesRuntime} from './docker-project-runtime.ts';

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_required`);
  return value;
};
const secrets: SecretResolverPort = {async resolve(reference, expectedPurpose) {
  if (reference.purpose !== expectedPurpose || !reference.locator.startsWith('/')) {
    throw new Error('secret_reference_denied');
  }
  const value = (await readFile(reference.locator, 'utf8')).trim();
  if (value.length === 0 || value.length > 65_536 || value.includes('\0')) throw new Error('secret_invalid');
  return {value};
}};

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
    signal:AbortSignal.timeout(15_000)});if(!response.ok)throw new Error('github_read_failed');const payload=await response.json() as {data?:{
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
  runtime: WorkerProjectBinding['runtime'],
  request: typeof fetch = fetch,
  credentialResolver: SecretResolverPort = secrets
): Promise<void> => {
  const endpoint = new URL(runtime.managementEndpoint);
  const gateway = new URL(runtime.gatewayEndpoint);
  if (endpoint.toString() !== `http://${runtime.runtimeId}-management:9119/` ||
    gateway.toString() !== `http://${runtime.runtimeId}-gateway:8642/v1/runs`) {
    throw new Error('hermes_management_denied');
  }
  const username = (await credentialResolver.resolve(runtime.managementUsernameRef, 'hermes_management_username')).value;
  const password = (await credentialResolver.resolve(runtime.managementPasswordRef, 'hermes_management_password')).value;
  const login = await request(new URL('/auth/password-login', endpoint), {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({provider: 'basic', username, password}),
    signal: AbortSignal.timeout(10_000)});
  if (!login.ok) throw new Error('hermes_management_unavailable');
  const values = typeof login.headers.getSetCookie === 'function'
    ? login.headers.getSetCookie() : [login.headers.get('set-cookie') ?? ''];
  const cookie = values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
  const restarted = await request(new URL('/api/gateway/restart', endpoint), {method: 'POST', headers: {cookie},
    signal: AbortSignal.timeout(10_000)});
  if (!restarted.ok) throw new Error('hermes_restart_failed');
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
  const executorCatalog: AgentExecutorCatalog = {'codex-cli': {available: true,
    models: ['gpt-5.6-terra','gpt-5.6-sol']}, 'claude-code-cli': {available: false, models: []}};
  const agentDeliveries = new Map<string, Readonly<{signature: string; delivery: AgentDeliveryPort}>>();

  const projectRuntime = (project: WorkerProjectBinding) => {
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
        text: `ИИ агент начал следующий этап: ${item.title} — ${item.url}`, idempotencyKey}),
      transaction: {execute: (input, submit) => executeAgentSubmissionTransaction(database, input, submit)}
    };
    const statusChanged = async (
      prior: TrackerItemFact, item: TrackerItemFact, idempotencyKey: string
    ): Promise<MessengerDeliveryInput> => ({projectId: project.projectId, contour: 'trusted-main',
      channelReference: 'telegram:internal',
      text: `Статус задачи изменён: ${prior.statusOptionName ?? 'Не указан'} → ${item.statusOptionName ?? 'Не указан'}\n${item.title} — ${item.url}`,
      idempotencyKey});
    return {project, tracker, agentDelivery, submissionPorts, statusChanged};
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
  const recoverAttempt = async (runtime: ReturnType<typeof projectRuntime>, attempt: AgentAttemptRecord) => {
    if (attempt.retryOf !== null && attempt.retryOf !== undefined) throw new Error('agent_recovery_exhausted');
    await notifyRecovery(attempt.projectId, attempt.deliveryReference, 'restart',
      `Hermes недоступен. Перезапускаю ИИ агента и сохраняю текущую задачу: ${attempt.itemTitle ?? attempt.itemId}${attempt.itemUrl === null ? '' : ` — ${attempt.itemUrl}`}`);
    await restartHermesGateway(runtime.project.runtime);
    let observed: Awaited<ReturnType<AgentDeliveryPort['observe']>> = {status: 'unknown'};
    for (let probe = 0; probe < 5; probe += 1) {
      await pause(probe === 0 ? 500 : 1_000);
      try {
        observed = await runtime.agentDelivery.observe(attempt.deliveryReference);
        if (observed.status !== 'unknown') {
          await notifyRecovery(attempt.projectId, attempt.deliveryReference, 'resumed',
            `Hermes восстановлен. Продолжаю контроль задачи: ${attempt.itemTitle ?? attempt.itemId}`);
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
    await notifyRecovery(attempt.projectId, attempt.deliveryReference, 'resubmitted',
      `Hermes восстановлен. Та же стадия задачи поставлена повторно: ${attempt.itemTitle ?? attempt.itemId}`);
    return {status: 'started' as const};
  };
  const observeContextBootstraps=async()=>{
    const projects = new Map((await activeProjects()).map((project) => [project.projectId, project]));
    for(const attempt of await listProjectContextBootstrapAttempts(database,workspaceId,20)){
      try{
        const runtime=projects.get(attempt.projectId)?.runtime;
        if(runtime===undefined)throw new Error('project_hermes_runtime_unavailable');
        const credential=await secrets.resolve(runtime.agentCredentialRef,'agent_delivery');
        const runs=new URL(runtime.gatewayEndpoint);
        const endpoint=new URL(`${runs.pathname}/${encodeURIComponent(attempt.deliveryReference)}`,runs);
        const request=()=>fetch(endpoint,{headers:{accept:'application/json',authorization:`Bearer ${credential.value}`},
          signal:AbortSignal.timeout(15_000)});
        let response=await request();
        if(response.status>=400&&response.status<500){await restartHermesGateway(runtime);response=await request();
          if(response.status>=400&&response.status<500){await failProjectContextBootstrap(database,attempt,
            response.status===404?'run_not_found':'provider_authentication_failed');continue;}}
        if(!response.ok){await notifyRecovery(attempt.projectId,attempt.deliveryReference,'bootstrap-unavailable',
          'Hermes временно недоступен во время настройки контекста. Worker продолжает контроль.');continue;}
        const value=await response.json().catch(()=>null) as {run_id?:unknown;status?:unknown;output?:unknown}|null;
        if(value?.run_id!==attempt.deliveryReference||typeof value.status!=='string')continue;
        if(value.status==='completed')await completeProjectContextBootstrap(database,attempt,value.output);
        else if(['failed','cancelled'].includes(value.status))
          await failProjectContextBootstrap(database,attempt,`provider_${value.status}`);
      }catch(error){
        if(error instanceof Error&&error.message==='project_context_result_invalid')
          await failProjectContextBootstrap(database,attempt,'project_context_result_invalid');
        else await notifyRecovery(attempt.projectId,attempt.deliveryReference,'bootstrap-unavailable',
          'Hermes временно недоступен во время настройки контекста. Worker продолжает контроль.');
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
      blocker:'Владелец проекта отклонил запрошенную Hermes операцию. Подготовка Project остановлена.',occurredAt:new Date().toISOString()});
    for(const approved of await listApprovedProjectTrackerPreparations(database,workspaceId,20)){try{await submitTrackerPreparation({
      projectId:approved.projectId,actorId:approved.actorId,remainingDelta:approved.remainingDelta,processVersion:approved.processVersion,
      idempotencyKey:`${approved.correlationId}:approved:${approved.approvalVersion}`});}catch(error){await recordProjectTrackerPreparationBlocker(database,{...approved,
        blocker:error instanceof Error?error.message:'project_tracker_preparation_unavailable',occurredAt:new Date().toISOString()});}}
    for(const attempt of await listProjectTrackerPreparationAttempts(database,workspaceId,20)){try{const binding=await trackerPreparationBinding(
      attempt.projectId,attempt.actorId);const endpoint=new URL(binding.endpoint);endpoint.pathname=`${endpoint.pathname}/${encodeURIComponent(attempt.runId)}`;
      const response=await fetch(endpoint,{headers:{accept:'application/json',authorization:`Bearer ${binding.token}`},signal:AbortSignal.timeout(15_000)});
      if(!response.ok)continue;const value=await response.json().catch(()=>null) as {run_id?:unknown;status?:unknown;output?:unknown}|null;
      if(value?.run_id!==attempt.runId||typeof value.status!=='string')continue;if(['failed','cancelled'].includes(value.status)){await recordProjectTrackerPreparationBlocker(database,{...attempt,
        blocker:`Hermes завершил подготовку Project со статусом ${value.status}.`,occurredAt:new Date().toISOString()});continue;}
      if(value.status!=='completed')continue;const result=await recordProjectTrackerPreparationResult(database,attempt,value.output);
      if(result.status!=='verifying')continue;const inspected=await inspectConfirmedGitHubProject({projectUrl:binding.projectUrl,
        repositoryUrl:binding.repositoryUrl,token:binding.token,stages:binding.process.policy.stages.map((stage)=>stage.title)});
      if(inspected.capabilities!==null){await recordVerifiedProjectTrackerCapabilities(database,{attempt,capabilities:inspected.capabilities,
        occurredAt:new Date().toISOString()});continue;}if(trackerPreparationDeltaShrank(attempt.remainingDelta,inspected.remainingDelta)){await submitTrackerPreparation({
          projectId:attempt.projectId,actorId:attempt.actorId,remainingDelta:inspected.remainingDelta,processVersion:attempt.processVersion,
          idempotencyKey:`${attempt.correlationId}:retry:${createHash('sha256').update(JSON.stringify(inspected.remainingDelta)).digest('hex')}`});continue;}
      await recordProjectTrackerPreparationBlocker(database,{...attempt,remainingDelta:inspected.remainingDelta,
        blocker:'Project по-прежнему не соответствует подтверждённому процессу; повтор Hermes не дал наблюдаемого прогресса.',
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
      const results = await runProjectBindingsIsolated(await activeProjects(), async (project) => {
        const runtime = projectRuntime(project);
        const projectAttempts = createAgentAttemptStore(database, project.projectId);
        await reconcileActiveAgentAttempts(20, {delivery: runtime.agentDelivery, attempts: projectAttempts,
          readTracker: () => runtime.tracker.readSnapshot(project.bindingId, null),
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
            composeAgentTerminalNotification(project.projectId, attempt, observed, key)});
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
            text: 'Автоматическое продолжение ИИ агента остановлено: активные настройки процесса недоступны или некорректны.',
            idempotencyKey: `agent-chain:${project.projectId}:process-policy-blocker`}}});
        await reconcileTracker({bindingId: project.bindingId, workspaceId, projectId: project.projectId,
          cursor: project.cursor, ports: {tracker: runtime.tracker, snapshots: stores.snapshots,
            outbox: stores.outbox, audit: stores.audit, compose: {statusChanged: runtime.statusChanged},
            continueAgentChain: (item) => continueExplicitAgentChain({projectId: project.projectId, item,
              stage: processPolicy?.policy.stages.find((stage) => stage.title === item.statusOptionName)
                ?.automation ?? null,
              stores: continuations, ports: runtime.submissionPorts,
              instructions: defaultAgentStageInstructions})}});
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
