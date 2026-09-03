import {describe,expect,it} from 'vitest';
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ProjectRuntimeProvisioningRequest} from '@fai-control-plane/db';
import {assertProjectRuntimeOwnership,ensureCodexConfig,parseCodexDevicePrompt,projectAuthContainerSpec,projectOAuthCached,
  projectRuntimeOwnership,projectGatewayContainerSpec,projectRuntimeResourceNames,removeProjectHermesRuntime,
  restartProjectHermesGateway} from './docker-project-runtime.ts';
import {ensureProjectWorkspace} from './hermes-project-template.ts';

const request=(projectId:string,runtimeId:string):ProjectRuntimeProvisioningRequest=>({
  projectId,workspaceId:'00000000-0000-4000-8000-000000000100',ownerActorId:'actor',slug:'project',
  repositoryUrl:'https://github.com/example/project',projectUrl:'https://github.com/users/example/projects/1',
  content:'{}',generation:'generation',
  artifact:{status:'installing',runtimeId,gatewayEndpoint:`http://${runtimeId}-gateway:8642/v1/runs`,
    dashboardEndpoint:`http://${runtimeId}-gateway:9119/`,workspacePath:`/opt/data/work/${runtimeId}`,
    telegramChatId:'-1001',telegramAllowedUserIds:['101'],imageVersion:'version',secretIds:{
      'agent-delivery':'00000000-0000-4000-8100-000000000001','dashboard-username':'00000000-0000-4000-8100-000000000002',
      'dashboard-password':'00000000-0000-4000-8100-000000000003','telegram-bot':'00000000-0000-4000-8100-000000000004',
      'inbound-actions':'00000000-0000-4000-8100-000000000005'}},secrets:{
    'agent-delivery':{id:'00000000-0000-4000-8100-000000000001',locator:'/runtime/one/secrets/agent'},
    'dashboard-username':{id:'00000000-0000-4000-8100-000000000002',locator:'/runtime/one/secrets/user'},
    'dashboard-password':{id:'00000000-0000-4000-8100-000000000003',locator:'/runtime/one/secrets/password'},
    'telegram-bot':{id:'00000000-0000-4000-8100-000000000004',locator:'/runtime/one/secrets/telegram'},
    'inbound-actions':{id:'00000000-0000-4000-8100-000000000005',locator:'/runtime/one/secrets/inbound'}}
});

describe('direct project Docker adapter boundary',()=>{
  it('derives disjoint names and exact ownership for two projects',()=>{
    const one=request('00000000-0000-4000-8000-000000000001','fai-one-00000000');
    const two=request('00000000-0000-4000-8000-000000000002','fai-two-00000000');
    expect(new Set([...Object.values(projectRuntimeResourceNames(one)),...Object.values(projectRuntimeResourceNames(two))]).size).toBe(6);
    expect(projectRuntimeOwnership(one,'gateway')).toEqual({'fai.control-plane.managed':'true',
      'fai.control-plane.workspace-id':one.workspaceId,'fai.control-plane.project-id':one.projectId,
      'fai.control-plane.runtime-id':one.artifact.runtimeId,'fai.control-plane.component':'gateway'});
  });

  it('uses upstream supervision for the only long-lived project container',()=>{
    const one=request('00000000-0000-4000-8000-000000000001','fai-one-00000000');
    const spec=projectGatewayContainerSpec(one,'fai-hermes:version','/runtime/one',
      {generated:'/runtime/one/generated',profile:'/runtime/one/generated/profile'},'project-network','internal-network');
    expect(spec).not.toHaveProperty('Entrypoint');expect(spec).not.toHaveProperty('User');
    expect(spec.Cmd).toEqual(['sleep','infinity']);
    expect(spec.Env).toContain('HERMES_DASHBOARD=1');
    expect(spec.Healthcheck.Test.join(' ')).toContain("'HOME':'/opt/data/home'");
    expect(spec.Healthcheck.Test.join(' ')).toContain("['gh','auth','status']");
    expect(spec.Env.some((value)=>value.startsWith('HERMES_GATEWAY_NO_SUPERVISE='))).toBe(false);
    expect(Object.keys(projectRuntimeResourceNames(one))).toEqual(['network','auth','gateway']);
    expect(JSON.stringify(spec)).not.toContain('management');expect(JSON.stringify(spec)).not.toContain('readiness');
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

  it('requires both Codex CLI and Hermes provider OAuth in the project root',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fai-project-oauth-'));await mkdir(join(root,'codex-home'));
    await mkdir(join(root,'data'));const tokens={access_token:'a'.repeat(64),refresh_token:'r'.repeat(64)};
    await writeFile(join(root,'codex-home','auth.json'),JSON.stringify({tokens}));
    expect(await projectOAuthCached(root)).toBe(false);
    await writeFile(join(root,'data','auth.json'),JSON.stringify({providers:{'openai-codex':{tokens}}}));
    expect(await projectOAuthCached(root)).toBe(true);await rm(root,{recursive:true});
  });

  it('uses one project-scoped device flow that persists both OAuth stores',()=>{
    const one=request('00000000-0000-4000-8000-000000000001','fai-one-00000000');
    const spec=projectAuthContainerSpec(one,'fai-hermes:version','/runtime/one','project-network');
    expect(spec.Entrypoint).toEqual(['/usr/local/bin/fai-project-device-auth']);expect(spec.Cmd).toEqual([]);
    expect(spec.HostConfig.Binds).toEqual(['/runtime/one/data:/opt/data','/runtime/one/codex-home:/opt/data/codex-home']);
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
      'GET /containers/fai-one-00000000-gateway/json','GET /containers/fai-one-00000000-codex-auth/json',
      'GET /networks/fai-one-00000000-network']);
  });

  it('restarts only the exact owned project gateway without listing containers',async()=>{
    const one=request('00000000-0000-4000-8000-000000000001','fai-one-00000000');const calls:string[]=[];
    const docker=async(method:string,path:string)=>{calls.push(`${method} ${path}`);return method==='GET'
      ?{status:200,body:Buffer.from(JSON.stringify({Name:'/fai-one-00000000-gateway',Config:{Labels:
        projectRuntimeOwnership(one,'gateway')}}))}:{status:204,body:Buffer.alloc(0)};};
    await restartProjectHermesGateway({workspaceId:one.workspaceId,projectId:one.projectId,
      runtimeId:one.artifact.runtimeId},docker);
    expect(calls).toEqual(['GET /containers/fai-one-00000000-gateway/json',
      'POST /containers/fai-one-00000000-gateway/restart?t=30']);
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
