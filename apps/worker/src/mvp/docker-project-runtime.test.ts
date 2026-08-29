import {describe,expect,it} from 'vitest';
import type {ProjectRuntimeProvisioningRequest} from '@fai-control-plane/db';
import {assertProjectRuntimeOwnership,parseCodexDevicePrompt,projectRuntimeOwnership,
  projectRuntimeResourceNames} from './docker-project-runtime.ts';

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
    expect(parseCodexDevicePrompt('token auth.json secret')).toBeNull();
  });
});
