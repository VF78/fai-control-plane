import {describe,expect,it,vi} from 'vitest';
import type {Database} from './runtime.ts';
import {listProjectHermesRuntimeBindings,parseProjectHermesRuntimeArtifact,projectHermesRuntimeImageVersion,projectHermesSecretPurpose,
  type ProjectHermesSecretKind} from './project-hermes-runtime.ts';
import {projectHermesRuntimeCoordinates} from './project-runtime-provisioning.ts';

const projects={one:'00000000-0000-4000-8000-000000000001',two:'00000000-0000-4000-8000-000000000002'} as const;
const kinds:readonly ProjectHermesSecretKind[]=['agent-delivery','dashboard-username','dashboard-password','telegram-bot','inbound-actions'];
const secret=(project:'one'|'two',index:number)=>`00000000-0000-4000-8${project==='one'?'1':'2'}00-${String(index).padStart(12,'0')}`;
const artifact=(project:'one'|'two',sharedChat=false)=>JSON.stringify({contract:'fai.project-hermes-runtime.v2',status:'ready',
  imageVersion:projectHermesRuntimeImageVersion,
  runtimeId:`runtime-${project}`,gatewayEndpoint:`http://runtime-${project}-gateway:8642/v1/runs`,
  dashboardEndpoint:`http://runtime-${project}-gateway:9119/`,workspacePath:`/srv/hermes/${project}`,
  telegram:{chatId:sharedChat?'-1001':project==='one'?'-1001':'-1002',allowedUserIds:['42']},secretRefs:{
    agentDelivery:secret(project,1),dashboardUsername:secret(project,2),dashboardPassword:secret(project,3),
    telegramBot:secret(project,4),inboundActions:secret(project,5)}});
const database=(sharedChat=false,sharedLocator=false)=>{
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes('runtime.sha256'))return {rows:(['one','two'] as const).map((project)=>({workspaceId:'workspace',
      projectId:projects[project],slug:project,artifactVersion:project.repeat(64).slice(0,64),
      content:artifact(project,sharedChat)}))};
    return {rows:(['one','two'] as const).flatMap((project)=>kinds.map((kind,index)=>({id:secret(project,index+1),
      purpose:projectHermesSecretPurpose(projects[project],kind),locator:sharedLocator&&project==='two'&&kind==='telegram-bot'
        ?'/run/secrets/one/telegram-bot':`/run/secrets/${project}/${kind}`})))};
  });
  return {query} as unknown as Database;
};

describe('dedicated project Hermes runtime binding',()=>{
  it('routes API and authenticated file access to one project gateway container',()=>{
    expect(projectHermesRuntimeCoordinates('control',projects.one)).toEqual({runtimeId:'fai-control-00000000',
      gatewayEndpoint:'http://fai-control-00000000-gateway:8642/v1/runs',
      dashboardEndpoint:'http://fai-control-00000000-gateway:9119/',
      workspacePath:'/opt/data/work/fai-control-00000000'});
  });

  it('rejects the removed split-management v1 artifact',()=>{
    const value=JSON.parse(artifact('one')) as Record<string,unknown>;const refs=value.secretRefs as Record<string,unknown>;
    value.contract='fai.project-hermes-runtime.v1';value.imageVersion='v2026.8.29-codex-0.144.1';
    value.managementEndpoint='http://runtime-one-management:9119/';delete value.dashboardEndpoint;
    refs.managementUsername=refs.dashboardUsername;refs.managementPassword=refs.dashboardPassword;
    delete refs.dashboardUsername;delete refs.dashboardPassword;
    expect(parseProjectHermesRuntimeArtifact(JSON.stringify(value))).toBeNull();
  });

  it('rejects management-shaped fields from the dashboard-native v2 contract',()=>{
    const value=JSON.parse(artifact('one')) as Record<string,unknown>;const refs=value.secretRefs as Record<string,unknown>;
    value.managementEndpoint=value.dashboardEndpoint;delete value.dashboardEndpoint;
    refs.managementUsername=refs.dashboardUsername;refs.managementPassword=refs.dashboardPassword;
    delete refs.dashboardUsername;delete refs.dashboardPassword;
    expect(parseProjectHermesRuntimeArtifact(JSON.stringify(value))).toBeNull();
  });

  it('accepts a dedicated Hermes runtime before a messenger is configured',()=>{
    const value=JSON.parse(artifact('one')) as Record<string,unknown>;
    value.imageVersion=projectHermesRuntimeImageVersion;delete value.telegram;
    expect(parseProjectHermesRuntimeArtifact(JSON.stringify(value))).toMatchObject({telegramChatId:null,telegramAllowedUserIds:[]});
  });

  it('resolves two projects to distinct endpoints, workspaces, Telegram and credentials',async()=>{
    const bindings=await listProjectHermesRuntimeBindings(database(),'workspace');
    expect(bindings.map((binding)=>({projectId:binding.projectId,gateway:binding.gatewayEndpoint,
      workspace:binding.workspacePath,chat:binding.telegramChatId,token:binding.telegramCredentialRef.id}))).toEqual([
      {projectId:projects.one,gateway:'http://runtime-one-gateway:8642/v1/runs',workspace:'/srv/hermes/one',chat:'-1001',token:secret('one',4)},
      {projectId:projects.two,gateway:'http://runtime-two-gateway:8642/v1/runs',workspace:'/srv/hermes/two',chat:'-1002',token:secret('two',4)}]);
  });

  it('fails closed when projects share a runtime coordinate',async()=>{
    await expect(listProjectHermesRuntimeBindings(database(true),'workspace'))
      .rejects.toThrow('project_hermes_runtime_conflict');
  });

  it('fails closed when distinct references share one secret locator',async()=>{
    await expect(listProjectHermesRuntimeBindings(database(false,true),'workspace'))
      .rejects.toThrow('project_hermes_runtime_conflict');
  });

  it('rejects another private service even when it has a single-label host',()=>{
    const value=JSON.parse(artifact('one')) as Record<string,unknown>;
    value.dashboardEndpoint='http://database:9119/';
    expect(parseProjectHermesRuntimeArtifact(JSON.stringify(value))).toBeNull();
  });

  it('returns only a bounded device-auth prompt for a current installing runtime',()=>{
    const value=JSON.parse(artifact('one')) as Record<string,unknown>;
    value.status='auth_required';value.imageVersion=projectHermesRuntimeImageVersion;
    value.auth={verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGH'};
    expect(parseProjectHermesRuntimeArtifact(JSON.stringify(value))).toMatchObject({status:'auth_required',
      auth:{verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGH'}});
    value.auth={verificationUrl:'http://worker:3001/auth',userCode:'ABCD-EFGH'};
    expect(parseProjectHermesRuntimeArtifact(JSON.stringify(value))).toBeNull();
  });
});
