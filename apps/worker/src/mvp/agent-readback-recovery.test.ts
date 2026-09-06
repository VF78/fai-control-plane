import {describe,expect,it,vi} from 'vitest';
import {reconcileActiveAgentAttempts,type AgentAttemptRecord,type AgentAttemptStore} from '@fai-control-plane/application';
import {defaultAgentRoutingPolicy,type TrackerSnapshot} from '@fai-control-plane/domain';
import {createHermesDeliveryAdapter} from '@fai-control-plane/integrations';
import {createEndpointRecoveryGate} from './runtime.ts';

describe('completed stage tracker readback recovery',()=>{
  it.each(['recovers','outage','contradiction','blocker'] as const)('%s without restarting or resubmitting completed work',async(mode)=>{
    const attempt:AgentAttemptRecord={workspaceId:'workspace',projectId:'project',actorId:'actor',itemId:'item',issueId:'issue',
      role:'developer',itemTitle:'Task',itemUrl:'https://example.test/issues/1',deliveryReference:'run_done',correlationId:'correlation',
      status:'started',observedVersion:'v1',successTargetTitle:'QA',reworkTargetTitle:null,expectedOwnerOptionId:'hermes',
      routingPolicy:defaultAgentRoutingPolicy};
    const output={contract:'fai.agent-executor-result.v1',decision:'accepted',execution:{taskClass:'ordinary_implementation',
      executor:{kind:'cli',id:'codex-cli'},model:'gpt-5.6-terra',effort:'medium'},outcome:'success',
      transition:{itemId:'item',fromVersion:'v1',targetStage:'QA'},reason:'done',evidence:[{kind:'checks',result:'passed'}],
      deliverables:[{label:'PR',url:'https://example.test/pull/1'}]};
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify({run_id:'run_done',
      status:'completed',output:JSON.stringify(output)}))).mockRejectedValue(new TypeError('endpoint now unavailable'));
    const delivery=createHermesDeliveryAdapter({endpoint:'https://hermes.example/v1/runs',fetch,
      credentialRef:{id:'secret',purpose:'agent_delivery',locator:'/run/agent'},secrets:{resolve:async()=>({value:'token'})}});
    let terminal=false;const finish=vi.fn<AgentAttemptStore['finish']>(async()=>{terminal=true;return 'recorded';});
    const attempts:AgentAttemptStore={resolve:async()=>attempt,listActive:async()=>terminal?[]:[attempt],finish};
    let reads=0;const readTracker=vi.fn(async()=>{reads++;
      if(reads===1||mode==='outage')throw new TypeError('tracker timeout');
      return {bindingId:'binding',externalVersion:'v2',cursor:null,observedAt:'2026-09-06T00:00:00Z',
        sourceUrl:'https://example.test/project',items:[{projectId:'project',itemId:'item',issueId:'issue',
        title:'Task',url:'https://example.test/issues/1',version:'v2',statusOptionId:'qa',
        statusOptionName:mode==='contradiction'?'In Dev':'QA',ownerOptionId:'hermes',blocked:mode==='blocker',
        targetDate:null,parentIssueId:null,subIssueIds:[],dependencyIssueIds:[],assigneeIds:[],assignees:[],
        observedAt:'2026-09-06T00:00:00Z'}]} satisfies TrackerSnapshot;});
    const recovery=createEndpointRecoveryGate(3);const endpoint=createEndpointRecoveryGate();
    const restart=vi.fn(async()=>({status:'started' as const}));const continueAgentChain=vi.fn(async()=>{});
    const composeTerminalNotification=vi.fn(async()=>({projectId:'project',contour:'trusted-main' as const,
      channelReference:'internal',text:'result',idempotencyKey:'terminal'}));
    const ports={delivery,attempts,readTracker,recoverUnavailable:restart,continueAgentChain,composeTerminalNotification,
      observationSucceeded:()=>endpoint.succeeded('run_done',true),
      retryTrackerReadback:()=>recovery.failed('readback:run_done')!=='exhausted',
      trackerReadbackSucceeded:()=>recovery.succeeded('readback:run_done',true)};
    await reconcileActiveAgentAttempts(20,ports);
    expect(finish).not.toHaveBeenCalled();
    for(let poll=0;poll<5;poll++)await reconcileActiveAgentAttempts(20,ports);
    expect(fetch).toHaveBeenCalledOnce();expect(restart).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();expect(composeTerminalNotification).toHaveBeenCalledOnce();
    if(mode==='recovers'){
      expect(readTracker).toHaveBeenCalledTimes(2);expect(continueAgentChain).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({status:'completed',failureCode:null}));
    }else{
      expect(continueAgentChain).not.toHaveBeenCalled();
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({status:'failed',failureCode:mode==='outage'
        ?'provider_unavailable':mode==='blocker'?'provider_blocked':'agent_result_invalid'}));
      if(mode==='outage')expect(readTracker).toHaveBeenCalledTimes(4);
    }
  });
});
