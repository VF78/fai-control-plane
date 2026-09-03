import {describe, expect, it, vi} from 'vitest';
import {projectHermesSecretPurpose, type Database, type ProjectHermesSecretKind} from '@fai-control-plane/db';
import {enqueueProjectFailureBlockers, githubBindingCoordinates, listWorkerProjectBindings,
  runProjectBindingsIsolated,
  type WorkerProjectBinding} from './project-runtime.ts';
import {createEndpointRecoveryGate,inspectConfirmedGitHubProject,projectContextRunFailureCode,restartHermesGateway,
  trackerPreparationDeltaShrank,trackerReadbackRetryable} from './runtime.ts';

const ids={one:'00000000-0000-4000-8000-000000000001',two:'00000000-0000-4000-8000-000000000002'} as const;
const kinds:readonly ProjectHermesSecretKind[]=['agent-delivery','dashboard-username','dashboard-password','telegram-bot','inbound-actions'];
const secretId=(project:'one'|'two',index:number)=>`00000000-0000-4000-8${project==='one'?'1':'2'}00-${String(index).padStart(12,'0')}`;
const runtimeArtifact=(project:'one'|'two')=>JSON.stringify({contract:'fai.project-hermes-runtime.v2',status:'ready',
  imageVersion:'v2026.9.2-codex-0.144.1',
  runtimeId:`runtime-${project}`,gatewayEndpoint:`http://runtime-${project}-gateway:8642/v1/runs`,
  dashboardEndpoint:`http://runtime-${project}-gateway:9119/`,workspacePath:`/opt/hermes/${project}`,
  telegram:{chatId:project==='one'?'-1001':'-1002',allowedUserIds:['42']},secretRefs:{agentDelivery:secretId(project,1),
    dashboardUsername:secretId(project,2),dashboardPassword:secretId(project,3),telegramBot:secretId(project,4),
    inboundActions:secretId(project,5)}});
const row = (project: 'one'|'two', repository: string) => ({
  projectId:ids[project],
  workspaceId: 'workspace', slug: project, bindingId: `binding-${project}`, provider: 'github',
  externalProjectId: `external-${project}`, projectUrl: `https://github.com/users/VF78/projects/${project === 'one' ? 1 : 2}`,
  repositoryId: `repository-${project}`, repositoryUrl: `https://github.com/VF78/${repository}`, cursor: null,
  trackerSecretId: 'tracker', trackerSecretPurpose: 'tracker_read', trackerSecretLocator: '/run/tracker',
  trackerCapabilitiesArtifact: JSON.stringify({contract: 'fai.project-tracker-capabilities.v1',
    provider: 'github', agentOwnerOptionId: `hermes-${project}`, doneStatusOptionId: `done-${project}`,
    defaultBranch: 'main'})
});

describe('multi-project worker composition', () => {
  it('finishes missing or rejected context runs without restarting Hermes',()=>{
    expect(projectContextRunFailureCode(404)).toBe('run_not_found');
    expect(projectContextRunFailureCode(401)).toBe('provider_authentication_failed');
    expect(projectContextRunFailureCode(503)).toBeNull();
  });

  it('waits on first unknown, recovers on second, resets on progress, and never recovers twice',()=>{
    const gate=createEndpointRecoveryGate();
    expect(gate.failed('run-one')).toBe('wait');
    gate.succeeded('run-one');
    expect(gate.failed('run-one')).toBe('wait');
    expect(gate.failed('run-one')).toBe('recover');
    gate.succeeded('run-one');
    expect(gate.failed('run-one')).toBe('wait');
    expect(gate.failed('run-one')).toBe('exhausted');
    gate.succeeded('run-one',true);
    expect(gate.failed('run-one')).toBe('wait');
  });
  it('retries preparation only for an exact strict subset of the prior delta',()=>{
    expect(trackerPreparationDeltaShrank(['Status','Owner','Blocked'],['Owner','Blocked'])).toBe(true);
    expect(trackerPreparationDeltaShrank(['Status','Owner'],['Blocked'])).toBe(false);
    expect(trackerPreparationDeltaShrank(['Status'],['Status'])).toBe(false);
  });
  it('retries only temporary tracker readback failures',()=>{
    expect(trackerReadbackRetryable(new Error('tracker_read_retryable'))).toBe(true);
    expect(trackerReadbackRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(trackerReadbackRetryable(new Error('tracker_authentication_failed'))).toBe(false);
  });
  it('verifies only the bound Project fields with one read-only GraphQL request',async()=>{
    const request=vi.fn<(input:URL|RequestInfo,init?:RequestInit)=>Promise<Response>>(async()=>new Response(JSON.stringify({data:{user:{projectV2:{fields:{nodes:[
      {id:'status',name:'Status',options:['Backlog','Ready','In Dev','QA','Acceptance','Done'].map((name,index)=>({id:`s${index}`,name}))},
      {id:'owner',name:'Owner',options:[{id:'hermes',name:'Hermes'}]},
      {id:'blocked',name:'Blocked',options:[{id:'no',name:'No'},{id:'yes',name:'Yes'}]}],pageInfo:{hasNextPage:false}}}},
      repository:{defaultBranchRef:{name:'main'}}}}),{status:200}));
    const result=await inspectConfirmedGitHubProject({projectUrl:'https://github.com/users/VF78/projects/1',
      repositoryUrl:'https://github.com/VF78/control',token:'secret',stages:['Backlog','Ready','In Dev','QA','Acceptance','Done']},
    request as typeof fetch);
    expect(result).toEqual({remainingDelta:[],capabilities:{provider:'github',agentOwnerOptionId:'hermes',
      doneStatusOptionId:'s5',defaultBranch:'main'}});
    expect(request).toHaveBeenCalledTimes(1);expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
  });
  it('resolves separate repository, Project and dedicated Hermes runtime for each binding', async () => {
    const trackerRows=[row('one','control'),row('two','ascon')];
    const database = {query: vi.fn(async (sql:string) => {
      if(sql.includes('runtime.sha256'))return {rows:['one','two'].map((project)=>({workspaceId:'workspace',
        projectId:ids[project as 'one'|'two'],slug:project,artifactVersion:project.repeat(64).slice(0,64),
        content:runtimeArtifact(project as 'one'|'two')}))};
      if(sql.includes('from secret_refs'))return {rows:(['one','two'] as const).flatMap((project)=>kinds.map((kind,index)=>({
        id:secretId(project,index+1),purpose:projectHermesSecretPurpose(ids[project],kind),locator:`/run/${project}/${kind}`})))};
      return {rows:trackerRows};
    })} as unknown as Database;
    const bindings = await listWorkerProjectBindings(database, 'workspace');
    expect(bindings).toHaveLength(2);
    expect(bindings.map((binding) => ({projectId: binding.projectId, repository: binding.repositoryUrl,
      project: binding.projectUrl, endpoint: binding.runtime.gatewayEndpoint, owner: binding.agentOwnerOptionId,
      done: binding.doneStatusOptionId}))).toEqual([
      {projectId: ids.one, repository: 'https://github.com/VF78/control',
        project: 'https://github.com/users/VF78/projects/1', endpoint: 'http://runtime-one-gateway:8642/v1/runs',
        owner: 'hermes-one', done: 'done-one'},
      {projectId: ids.two, repository: 'https://github.com/VF78/ascon',
        project: 'https://github.com/users/VF78/projects/2', endpoint: 'http://runtime-two-gateway:8642/v1/runs',
        owner: 'hermes-two', done: 'done-two'}
    ]);
    expect(githubBindingCoordinates(bindings[0]!)).toEqual({owner: 'VF78', repository: 'control', projectNumber: 1});
    expect(githubBindingCoordinates(bindings[1]!)).toEqual({owner: 'VF78', repository: 'ascon', projectNumber: 2});
  });

  it('continues other projects after one project operation fails', async () => {
    const bindings = [row('one', 'control'), row('two', 'ascon')]
      .map((value) => ({...value,
        agentOwnerOptionId: JSON.parse(value.trackerCapabilitiesArtifact).agentOwnerOptionId,
        doneStatusOptionId: JSON.parse(value.trackerCapabilitiesArtifact).doneStatusOptionId,
        defaultBranch: JSON.parse(value.trackerCapabilitiesArtifact).defaultBranch,
        trackerCredentialRef: {id: 'tracker', purpose: 'tracker_read', locator: '/run/tracker'},
        runtime:{workspaceId:'workspace',projectId:value.projectId,slug:value.slug,artifactVersion:'a'.repeat(64),
          ...JSON.parse(runtimeArtifact(value.slug as 'one'|'two')),telegramChatId:value.slug==='one'?'-1001':'-1002',
          telegramAllowedUserIds:['42'],agentCredentialRef:{id:'1',purpose:'agent_delivery',locator:'/run/agent'},
          dashboardUsernameRef:{id:'2',purpose:'hermes_dashboard_username',locator:'/run/user'},
          dashboardPasswordRef:{id:'3',purpose:'hermes_dashboard_password',locator:'/run/pass'},
          telegramCredentialRef:{id:'4',purpose:'messenger_delivery',locator:'/run/tg'},
          inboundActionCredentialRef:{id:'5',purpose:'hermes_inbound_actions',locator:'/run/inbound'}}})) as WorkerProjectBinding[];
    const visited: string[] = [];
    const results = await runProjectBindingsIsolated(bindings, async (binding) => {
      visited.push(binding.projectId);
      if (binding.projectId === ids.one) throw new Error('provider_failed');
      return binding.runtime.gatewayEndpoint;
    });
    expect(visited).toEqual([ids.one, ids.two]);
    expect(results).toEqual([
      {projectId: ids.one, status: 'failed'},
      {projectId: ids.two, status: 'completed', value: 'http://runtime-two-gateway:8642/v1/runs'}
    ]);
  });

  it('persists one bounded project blocker without letting notification failure escape', async () => {
    const enqueue = vi.fn(async ({projectId}: Readonly<{projectId: string}>) => {
      if (projectId === 'one') throw new Error('outbox_unavailable');
    });
    await expect(enqueueProjectFailureBlockers('observe', [
      {projectId: 'one', status: 'failed'},
      {projectId: 'two', status: 'completed'},
      {projectId: 'three', status: 'failed'}
    ], enqueue)).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]![0]).toEqual({projectId: 'three',
      idempotencyKey: 'worker:three:observe:blocker',
      text: 'Автоматическая обработка проекта остановлена на этапе observe. Требуется проверка интеграции.'});
  });

  it('restarts only the exact bound project gateway container',async()=>{
    const runtime={workspaceId:'workspace',projectId:ids.two,slug:'two',artifactVersion:'a'.repeat(64),
      runtimeId:'runtime-two',gatewayEndpoint:'http://runtime-two-gateway:8642/v1/runs',
      dashboardEndpoint:'http://runtime-two-gateway:9119/',workspacePath:'/opt/hermes/two',telegramChatId:'-1002',
      telegramAllowedUserIds:['42'],agentCredentialRef:{id:'1',purpose:'agent_delivery',locator:'/run/agent'},
      dashboardUsernameRef:{id:'2',purpose:'hermes_dashboard_username',locator:'/run/user'},
      dashboardPasswordRef:{id:'3',purpose:'hermes_dashboard_password',locator:'/run/pass'},
      telegramCredentialRef:{id:'4',purpose:'messenger_delivery',locator:'/run/tg'},
      inboundActionCredentialRef:{id:'5',purpose:'hermes_inbound_actions',locator:'/run/inbound'}} as const;
    const calls:string[]=[];const docker=async(method:string,path:string)=>{calls.push(`${method} ${path}`);return method==='GET'
      ?{status:200,body:Buffer.from(JSON.stringify({Name:'/runtime-two-gateway',Config:{Labels:{
        'fai.control-plane.managed':'true','fai.control-plane.workspace-id':'workspace',
        'fai.control-plane.project-id':ids.two,'fai.control-plane.runtime-id':'runtime-two',
        'fai.control-plane.component':'gateway'}}}))}:{status:204,body:Buffer.alloc(0)};};
    await expect(restartHermesGateway(runtime,docker)).resolves.toBeUndefined();
    expect(calls).toEqual(['GET /containers/runtime-two-gateway/json','POST /containers/runtime-two-gateway/restart?t=30']);
  });
});
