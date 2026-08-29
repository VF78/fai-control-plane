import {describe, expect, it, vi} from 'vitest';
import {projectHermesSecretPurpose, type Database, type ProjectHermesSecretKind} from '@fai-control-plane/db';
import {enqueueProjectFailureBlockers, githubBindingCoordinates, listWorkerProjectBindings,
  runProjectBindingsIsolated,
  type WorkerProjectBinding} from './project-runtime.ts';
import {restartHermesGateway} from './runtime.ts';

const ids={one:'00000000-0000-4000-8000-000000000001',two:'00000000-0000-4000-8000-000000000002'} as const;
const kinds:readonly ProjectHermesSecretKind[]=['agent-delivery','management-username','management-password','telegram-bot','inbound-actions'];
const secretId=(project:'one'|'two',index:number)=>`00000000-0000-4000-8${project==='one'?'1':'2'}00-${String(index).padStart(12,'0')}`;
const runtimeArtifact=(project:'one'|'two')=>JSON.stringify({contract:'fai.project-hermes-runtime.v1',status:'ready',
  runtimeId:`runtime-${project}`,gatewayEndpoint:`http://runtime-${project}-gateway:8642/v1/runs`,
  managementEndpoint:`http://runtime-${project}-management:9119/`,workspacePath:`/opt/hermes/${project}`,
  telegram:{chatId:project==='one'?'-1001':'-1002',allowedUserIds:['42']},secretRefs:{agentDelivery:secretId(project,1),
    managementUsername:secretId(project,2),managementPassword:secretId(project,3),telegramBot:secretId(project,4),
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
          managementUsernameRef:{id:'2',purpose:'hermes_management_username',locator:'/run/user'},
          managementPasswordRef:{id:'3',purpose:'hermes_management_password',locator:'/run/pass'},
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

  it('restarts only the bound project management endpoint',async()=>{
    const runtime={workspaceId:'workspace',projectId:ids.two,slug:'two',artifactVersion:'a'.repeat(64),
      runtimeId:'runtime-two',gatewayEndpoint:'http://runtime-two-gateway:8642/v1/runs',
      managementEndpoint:'http://runtime-two-management:9119/',workspacePath:'/opt/hermes/two',telegramChatId:'-1002',
      telegramAllowedUserIds:['42'],agentCredentialRef:{id:'1',purpose:'agent_delivery',locator:'/run/agent'},
      managementUsernameRef:{id:'2',purpose:'hermes_management_username',locator:'/run/user'},
      managementPasswordRef:{id:'3',purpose:'hermes_management_password',locator:'/run/pass'},
      telegramCredentialRef:{id:'4',purpose:'messenger_delivery',locator:'/run/tg'},
      inboundActionCredentialRef:{id:'5',purpose:'hermes_inbound_actions',locator:'/run/inbound'}} as const;
    const request=vi.fn(async(input:URL|RequestInfo,_init?:RequestInit)=>String(input).endsWith('/auth/password-login')
      ?new Response('{}',{status:200,headers:{'set-cookie':'session=two; Path=/'}}):new Response('{}',{status:200}));
    const resolver={resolve:vi.fn(async(reference:{id:string})=>({value:reference.id==='2'?'two-user':'two-pass'}))};
    await expect(restartHermesGateway(runtime,request as typeof fetch,resolver)).resolves.toBeUndefined();
    expect(request.mock.calls.map(([input])=>String(input))).toEqual([
      'http://runtime-two-management:9119/auth/password-login','http://runtime-two-management:9119/api/gateway/restart']);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({username:'two-user',password:'two-pass'});
  });
});
