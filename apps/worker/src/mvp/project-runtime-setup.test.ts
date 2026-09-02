import {afterEach,describe,expect,it} from 'vitest';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listProjectRuntimeProvisioningRequests,parseProjectHermesRuntimeArtifact,projectHermesSecretPurpose,type Database,
  type ProjectHermesSecretKind} from '@fai-control-plane/db';
import {installProjectRuntime,projectGithubCredential} from './project-runtime-setup.ts';

const previous={github:process.env.GITHUB_PROJECTS_TOKEN_FILE,root:process.env.FCP_PROJECT_RUNTIME_HOST_DIR,
  node:process.env.NODE_ENV};
afterEach(()=>{
  for(const [name,value] of [['GITHUB_PROJECTS_TOKEN_FILE',previous.github],['FCP_PROJECT_RUNTIME_HOST_DIR',previous.root],
    ['NODE_ENV',previous.node]] as const){if(value===undefined)delete process.env[name];else process.env[name]=value;}
});

describe('project runtime GitHub credential',()=>{
  it('reads the existing host-owned credential through its configured secret path',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'fai-project-credential-'));
    const path=join(directory,'github-projects-token');
    await writeFile(path,`${'x'.repeat(40)}\n`);process.env.GITHUB_PROJECTS_TOKEN_FILE=path;
    await expect(projectGithubCredential()).resolves.toBe('x'.repeat(40));
    await rm(directory,{recursive:true});
  });

  it('fails closed when the configured secret path is unavailable',async()=>{
    delete process.env.GITHUB_PROJECTS_TOKEN_FILE;
    await expect(projectGithubCredential()).rejects.toThrow('project_runtime_unavailable');
  });

  it('migrates a legacy v1 error into a provisionable dashboard-native v2 request',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fai-project-migration-'));const workspaceId='00000000-0000-4000-8000-000000000100';
    const projectId='00000000-0000-4000-8000-000000000001';const actorId='actor';
    const directory=join(root,workspaceId,projectId);const secretsDirectory=join(directory,'secrets');
    await mkdir(secretsDirectory,{recursive:true});const github=join(root,'github');await writeFile(github,'x'.repeat(40));
    process.env.GITHUB_PROJECTS_TOKEN_FILE=github;process.env.FCP_PROJECT_RUNTIME_HOST_DIR=root;process.env.NODE_ENV='test';
    const kinds:readonly ProjectHermesSecretKind[]=['agent-delivery','dashboard-username','dashboard-password','telegram-bot','inbound-actions'];
    const ids:Record<ProjectHermesSecretKind,string>={'agent-delivery':'00000000-0000-4000-8100-000000000001',
      'dashboard-username':'00000000-0000-4000-8100-000000000002','dashboard-password':'00000000-0000-4000-8100-000000000003',
      'telegram-bot':'00000000-0000-4000-8100-000000000004','inbound-actions':'00000000-0000-4000-8100-000000000005'};
    await Promise.all([writeFile(join(secretsDirectory,'agent-delivery'),'agent'),writeFile(join(secretsDirectory,'telegram-bot'),'telegram'),
      writeFile(join(secretsDirectory,'inbound-actions'),'inbound')]);
    let latest=JSON.stringify({contract:'fai.project-hermes-runtime.v1',status:'error',imageVersion:'v2026.8.29-codex-0.144.1',
      failure:'runtime_unavailable',runtimeId:'fai-control-00000000',gatewayEndpoint:'http://fai-control-00000000-gateway:8642/v1/runs',
      managementEndpoint:'http://fai-control-00000000-management:9119/',workspacePath:'/opt/data/work/fai-control-00000000',
      telegram:{chatId:'-1001',allowedUserIds:['42']},secretRefs:{agentDelivery:ids['agent-delivery'],
        managementUsername:ids['dashboard-username'],managementPassword:ids['dashboard-password'],telegramBot:ids['telegram-bot'],
        inboundActions:ids['inbound-actions']}});
    const stored=new Map<string,{id:string;purpose:string;locator:string}>([
      'agent-delivery','telegram-bot','inbound-actions'].map((kind)=>{const typed=kind as ProjectHermesSecretKind;
        const purpose=projectHermesSecretPurpose(projectId,typed);return [purpose,{id:ids[typed],purpose,locator:join(secretsDirectory,kind)}];}));
    const query=async(sql:string,parameters:readonly unknown[]=[]):Promise<{rowCount:number;rows:any[]}>=>{
      if(sql.includes('owner.actor_id as "ownerActorId"'))return {rowCount:1,rows:[{workspaceId,projectId,slug:'control',ownerActorId:actorId,
        repositoryUrl:'https://github.com/VF78/control',projectUrl:'https://github.com/users/VF78/projects/1',content:latest}]};
      if(sql.includes('p.workspace_id as "workspaceId",p.slug'))return {rowCount:1,rows:[{workspaceId,slug:'control',
        repositoryUrl:'https://github.com/VF78/control',projectUrl:'https://github.com/users/VF78/projects/1'}]};
      if(sql.includes('select s.content_text as content'))return {rowCount:1,rows:[{content:latest}]};
      if(sql.includes('select id,purpose from secret_refs'))return {rowCount:stored.size,rows:[...stored.values()]};
      if(sql.includes('select 1 from command_receipts'))return {rowCount:0,rows:[]};
      if(sql.includes('where p.id=$1 and p.workspace_id=$2'))return {rowCount:1,rows:[{slug:'control'}]};
      if(sql.startsWith('insert into secret_refs')){const id=String(parameters[0]);const purpose=String(parameters[2]);
        const locator=String(parameters[3]);
        stored.set(purpose,{id,purpose,locator});return {rowCount:1,rows:[{id,locator}]};}
      if(sql.includes('insert into project_source_artifacts')){latest=String(parameters[5]);return {rowCount:1,rows:[]};}
      if(sql.includes('id=any($2::uuid[])'))return {rowCount:stored.size,rows:[...stored.values()]};
      return {rowCount:1,rows:[]};
    };
    const client={query,release:()=>undefined};const database={query,connect:async()=>client} as unknown as Database;
    const originalFetch=globalThis.fetch;globalThis.fetch=async(input:URL|RequestInfo)=>String(input).includes('/graphql')
      ?new Response(JSON.stringify({data:{user:{projectV2:{url:'https://github.com/users/VF78/projects/1'}}}})):
      new Response('{}');
    try{await installProjectRuntime(database,{workspaceId,actorId,projectId,idempotencyKey:'install:migrate'});
      expect(parseProjectHermesRuntimeArtifact(latest)).toMatchObject({legacyV1:false,status:'installing'});
      const requests=await listProjectRuntimeProvisioningRequests(database,workspaceId);expect(requests).toHaveLength(1);
      expect(requests[0]?.artifact).toMatchObject({legacyV1:false,status:'installing',dashboardEndpoint:'http://fai-control-00000000-gateway:9119/',
        telegramChatId:'-1001',telegramAllowedUserIds:['42']});
      expect(Object.keys(requests[0]!.secrets).sort()).toEqual([...kinds].sort());
      await expect(readFile(join(secretsDirectory,'dashboard-signing'),'utf8')).resolves.toMatch(/\S/);
    }finally{globalThis.fetch=originalFetch;await rm(root,{recursive:true});}
  });
});
