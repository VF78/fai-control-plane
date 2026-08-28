import {describe, expect, it, vi} from 'vitest';
import {createHermesConversationActionHandler, resolveInboundHermesRuntime,
  type HermesActionDependencies} from './hermes-actions.ts';

const internalToken = 'i'.repeat(48);
const runtime = {workspaceId:'workspace',projectId:'fd22736d-1879-47fe-9b8a-c51653a4b635',slug:'control',
  artifactVersion:'a'.repeat(64),runtimeId:'runtime-control',gatewayEndpoint:'http://runtime-control-gateway:8642/v1/runs',
  managementEndpoint:'http://runtime-control-management:9119/',workspacePath:'/opt/hermes/control',telegramChatId:'-5540760630',
  telegramAllowedUserIds:['96211907','355724486'],agentCredentialRef:{id:'1',purpose:'agent_delivery',locator:'/run/agent'},
  managementUsernameRef:{id:'2',purpose:'hermes_management_username',locator:'/run/user'},
  managementPasswordRef:{id:'3',purpose:'hermes_management_password',locator:'/run/password'},
  telegramCredentialRef:{id:'4',purpose:'messenger_delivery',locator:'/run/telegram'},
  inboundActionCredentialRef:{id:'5',purpose:'hermes_inbound_actions',locator:'/run/inbound'}} as const;
const dependencies = (): HermesActionDependencies => ({resolveRuntime: async (bearer) => bearer===internalToken?runtime:null,
  readInternalContext: vi.fn(async ({ifVersion}) => ifVersion === 'a'.repeat(64)
    ? {status: 'duplicate' as const, version: 'a'.repeat(64), sourceCount: 4,
      refreshedAt: '2026-08-14T09:00:00.000Z'}
    : {status: 'completed' as const, version: 'a'.repeat(64), capsule: 'Current project context', sourceCount: 4,
      refreshedAt: '2026-08-14T09:00:00.000Z'}),
  dispatchInternal: vi.fn(async () => ({status: 'completed' as const, referenceId: 'source-1'}))});
const request = (bearer: string, source: object, action: object) => new Request('https://app.f-ai.studio/api/hermes/conversation-actions', {
  method: 'POST', headers: {authorization: `Bearer ${bearer}`, 'content-type': 'application/json'},
  body: JSON.stringify({source, action})});

describe('Hermes conversation action HTTP boundary', () => {
  it('derives the project runtime from its bearer and never from model input', async () => {
    const deps = dependencies(); const handler = createHermesConversationActionHandler(deps);
    const response = await handler(request(internalToken, {provider: 'telegram', updateId: '77', messageId: '12',
      userId: '96211907', chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'},
    {type: 'source.add', name: 'Decision', content: 'Confirmed'}));
    expect(response.status).toBe(200); expect(deps.dispatchInternal).toHaveBeenCalledOnce();
  });
  it('serves a bounded project capsule only to the trusted Telegram contour', async () => {
    const deps = dependencies(); const handler = createHermesConversationActionHandler(deps);
    const source = {provider: 'telegram', updateId: '77', messageId: '12', userId: '96211907',
      chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'};
    const response = await handler(request(internalToken, source, {type: 'project_context.read', ifVersion: null}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({status: 'completed', version: 'a'.repeat(64),
      capsule: 'Current project context', sourceCount: 4}));
    expect(deps.readInternalContext).toHaveBeenCalledOnce();
    expect(deps.dispatchInternal).not.toHaveBeenCalled();

    const duplicate = await handler(request(internalToken, {...source, updateId: '78'},
      {type: 'project_context.read', ifVersion: 'a'.repeat(64)}));
    expect(await duplicate.json()).toEqual(expect.objectContaining({status: 'duplicate', version: 'a'.repeat(64)}));
  });
  it('fails closed for unknown tokens and caller-supplied authority fields', async () => {
    const handler = createHermesConversationActionHandler(dependencies());
    const source = {provider: 'telegram', updateId: '77', messageId: '12', userId: '96211907',
      chatId: '-5540760630', observedAt: '2026-08-14T10:00:00.000Z'};
    expect((await handler(request('x'.repeat(48), source,
      {type: 'source.add', name: 'Decision', content: 'Confirmed'}))).status).toBe(401);
    const forged = new Request('https://app.f-ai.studio/api/hermes/conversation-actions', {method: 'POST',
      headers: {authorization: `Bearer ${internalToken}`, 'content-type': 'application/json'},
      body: JSON.stringify({source, action: {type: 'source.add', name: 'Decision', content: 'Confirmed'}, actorId: 'forged'})});
    expect((await handler(forged)).status).toBe(400);
    expect((await handler(request(internalToken,{...source,chatId:'-5540760631'},
      {type:'source.add',name:'Decision',content:'Confirmed'}))).status).toBe(403);
  });
  it('fails closed when two runtime credentials resolve to the same bearer',async()=>{
    const second={...runtime,projectId:'00000000-0000-4000-8000-000000000002',runtimeId:'runtime-two',
      gatewayEndpoint:'http://runtime-two-gateway:8642/v1/runs',managementEndpoint:'http://runtime-two-management:9119/',
      workspacePath:'/opt/hermes/two',telegramChatId:'-2',
      inboundActionCredentialRef:{id:'6',purpose:'hermes_inbound_actions',locator:'/run/inbound-two'}} as const;
    const secrets={resolve:vi.fn(async()=>({value:internalToken}))};
    await expect(resolveInboundHermesRuntime([runtime,second],secrets,internalToken)).resolves.toBeNull();
  });
  it('denies removed role-run and client-provider sources before dispatch', async () => {
    const deps = dependencies(); const handler = createHermesConversationActionHandler(deps);
    for (const source of [{provider: 'agent-role-run', sessionId: `browser:${'a'.repeat(64)}`},
      {provider: 'bitrix-browser', taskId: '154312', messageId: 'dom-9', authorId: 'client-2',
        observedAt: '2026-08-14T10:00:00.000Z'}]) {
      const response = await handler(request(internalToken, source,
        {type: 'source.add', name: 'Decision', content: 'Confirmed'}));
      expect(response.status).toBe(403);
    }
    expect(deps.dispatchInternal).not.toHaveBeenCalled();
  });
});
