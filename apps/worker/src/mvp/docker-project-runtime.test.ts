import {describe,expect,it} from 'vitest';
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ProjectRuntimeProvisioningRequest} from '@fai-control-plane/db';
import {assertProjectRuntimeOwnership,ensureCodexConfig,parseCodexDevicePrompt,projectRuntimeOwnership,
  projectRuntimeResourceNames,removeProjectHermesRuntime} from './docker-project-runtime.ts';
import {ensureProjectWorkspace} from './hermes-project-template.ts';

const request=(projectId:string,runtimeId:string):ProjectRuntimeProvisioningRequest=>({
  projectId,workspaceId:'00000000-0000-4000-8000-000000000100',ownerActorId:'actor',slug:'project',
  repositoryUrl:'https://github.com/example/project',projectUrl:'https://github.com/users/example/projects/1',
  content:'{}',generation:'generation',
  artifact:{status:'installing',runtimeId,gatewayEndpoint:`http://${runtimeId}-gateway:8642/v1/runs`,
    managementEndpoint:`http://${runtimeId}-management:9119/`,workspacePath:`/opt/data/work/${runtimeId}`,
    telegramChatId:'-1001',telegramAllowedUserIds:['101'],imageVersion:'version',secretIds:{
      'agent-delivery':'00000000-0000-4000-8100-000000000001','management-username':'00000000-0000-4000-8100-000000000002',
      'management-password':'00000000-0000-4000-8100-000000000003','telegram-bot':'00000000-0000-4000-8100-000000000004',
      'inbound-actions':'00000000-0000-4000-8100-000000000005'}},secrets:{
    'agent-delivery':{id:'00000000-0000-4000-8100-000000000001',locator:'/runtime/one/secrets/agent'},
    'management-username':{id:'00000000-0000-4000-8100-000000000002',locator:'/runtime/one/secrets/user'},
    'management-password':{id:'00000000-0000-4000-8100-000000000003',locator:'/runtime/one/secrets/password'},
    'telegram-bot':{id:'00000000-0000-4000-8100-000000000004',locator:'/runtime/one/secrets/telegram'},
    'inbound-actions':{id:'00000000-0000-4000-8100-000000000005',locator:'/runtime/one/secrets/inbound'}}
});

describe('direct project Docker adapter boundary',()=>{
  it('derives disjoint names and exact ownership for two projects',()=>{
    const one=request('00000000-0000-4000-8000-000000000001','fai-one-00000000');
    const two=request('00000000-0000-4000-8000-000000000002','fai-two-00000000');
    expect(new Set([...Object.values(projectRuntimeResourceNames(one)),...Object.values(projectRuntimeResourceNames(two))]).size).toBe(10);
    expect(projectRuntimeOwnership(one,'gateway')).toEqual({'fai.control-plane.managed':'true',
      'fai.control-plane.workspace-id':one.workspaceId,'fai.control-plane.project-id':one.projectId,
      'fai.control-plane.runtime-id':one.artifact.runtimeId,'fai.control-plane.component':'gateway'});
  });

  it('fails closed for a foreign project label',()=>{
    const one=request('00000000-0000-4000-8000-000000000001','fai-one-00000000');
    const labels={...projectRuntimeOwnership(one,'gateway'),'fai.control-plane.project-id':'00000000-0000-4000-8000-000000000002'};
    expect(()=>assertProjectRuntimeOwnership(labels,one,'gateway')).toThrow('docker_ownership_conflict');
  });

  it('extracts only the official HTTPS device prompt and one-time code',()=>{
    expect(parseCodexDevicePrompt('Open https://auth.openai.com/codex/device and enter ABCD-EFGH.')).toEqual({
      verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGH'});
    expect(parseCodexDevicePrompt('Open \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m and enter \u001b[94mABCD-EFGH\u001b[0m.')).toEqual({
      verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGH'});
    expect(parseCodexDevicePrompt('token auth.json secret')).toBeNull();
  });

  it('keeps an existing Codex config but repairs its private ownership and mode',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fai-project-auth-'));const directory=join(root,'codex-home');
    await mkdir(directory);const path=join(directory,'config.toml');await writeFile(path,'existing = true\n',{mode:0o644});
    const uid=process.getuid?.()??0;const gid=process.getgid?.()??0;await ensureCodexConfig(root,{uid,gid});
    const details=await stat(path);expect(await readFile(path,'utf8')).toBe('existing = true\n');
    expect(details.mode&0o777).toBe(0o600);expect(details.uid).toBe(uid);expect(details.gid).toBe(gid);
    await rm(root,{recursive:true});
  });

  it('makes both the shared work parent and project workspace traversable only by the runtime owner',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fai-project-workspace-'));await mkdir(join(root,'data'));
    const uid=process.getuid?.()??0;const gid=process.getgid?.()??0;
    const workspace=await ensureProjectWorkspace(root,'fai-project-00000000',{uid,gid});
    for(const path of [join(root,'data','work'),workspace]){const details=await stat(path);
      expect(details.mode&0o777).toBe(0o700);expect(details.uid).toBe(uid);expect(details.gid).toBe(gid);}
    await rm(root,{recursive:true});
  });

  it('removes only deterministic project resources and its exact root',async()=>{
    const one=request('00000000-0000-4000-8000-000000000001','fai-one-00000000');
    const root=await mkdtemp(join(tmpdir(),'fai-project-delete-'));await writeFile(join(root,'memory'),'kept until deletion');
    const calls:string[]=[];const docker=async(method:string,path:string)=>{calls.push(`${method} ${path}`);
      return {status:404,body:Buffer.from('{}')};};
    await removeProjectHermesRuntime(one,root,docker);
    await expect(stat(root)).rejects.toMatchObject({code:'ENOENT'});
    expect(calls).toEqual([
      'GET /containers/fai-one-00000000-gateway/json','GET /containers/fai-one-00000000-management/json',
      'GET /containers/fai-one-00000000-codex-auth/json','GET /containers/fai-one-00000000-readiness/json',
      'GET /networks/fai-one-00000000-network']);
  });

  it('refuses deletion when a deterministic name has foreign labels',async()=>{
    const one=request('00000000-0000-4000-8000-000000000001','fai-one-00000000');
    const root=await mkdtemp(join(tmpdir(),'fai-project-delete-'));await writeFile(join(root,'memory'),'must remain');
    const docker=async()=>({status:200,body:Buffer.from(JSON.stringify({Config:{Labels:{
      ...projectRuntimeOwnership(one,'gateway'),'fai.control-plane.project-id':'another-project'}}}))});
    await expect(removeProjectHermesRuntime(one,root,docker)).rejects.toThrow('docker_ownership_conflict');
    await expect(stat(root)).resolves.toBeDefined();
    await rm(root,{recursive:true});
  });
});
