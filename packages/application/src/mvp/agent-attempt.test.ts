import {describe, expect, it, vi} from 'vitest';
import {composeAgentTerminalNotification, reconcileActiveAgentAttempts, reconcileAgentAttempt, type AgentAttemptStore} from './agent-attempt.ts';

const attempt = {workspaceId: 'workspace', projectId: 'project', actorId: 'actor', itemId: 'item',
  itemTitle: 'Task', itemUrl: 'https://example.test/issues/1',
  deliveryReference: 'run_ref', correlationId: 'correlation', status: 'started' as const};
const accepted = {contract: 'fai.agent-executor-result.v1' as const, decision: 'accepted' as const,
  execution: {taskClass: 'ordinary_implementation' as const, executor: {kind: 'cli' as const, id: 'codex-cli'},
    model: 'gpt-5.6-terra', effort: 'medium' as const}, outcome: 'success' as const,
  transition: {itemId: 'item', fromVersion: 'v1', targetStage: 'QA', toVersion: 'v2'}, reason: 'done',
  evidence: [{kind: 'checks', result: 'passed'}], deliverables: []};
const notification = async (_attempt: typeof attempt, _observed: unknown, idempotencyKey: string) => ({
  projectId: 'project', contour: 'trusted-main' as const, channelReference: 'telegram:internal', text: 'result', idempotencyKey
});
const store = (finish: AgentAttemptStore['finish']): AgentAttemptStore => ({
  resolve: async () => attempt, listActive: async () => [attempt], finish
});

describe('agent attempt reconciliation', () => {
  it('uses the provider-native task title and URL in Telegram instead of an opaque item id', () => {
    const message = composeAgentTerminalNotification('project', attempt, {status: 'failed',
      failureCode: 'agent_result_rejected', result: {contract: 'fai.agent-executor-result.v1', decision: 'rejected',
        execution: {taskClass: 'ordinary_implementation', executor: {kind: 'cli', id: 'codex-cli'},
          model: 'gpt-5.6-terra', effort: 'medium'}, outcome: 'rework',
        transition: {itemId: 'item', fromVersion: 'v1', targetStage: 'In Dev', toVersion: 'v2'},
        reason: 'No checkout', evidence: [{kind: 'source', result: 'missing'}], deliverables: []}}, 'key');
    expect(message.text).toContain('Task — https://example.test/issues/1');
    expect(message.text).not.toContain('Задача: item');
  });
  it('does not turn an expired provider status into a failure', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>();
    const result = await reconcileAgentAttempt({actorId: 'actor', projectId: 'project', itemId: 'item',
      deliveryReference: 'run_ref'}, {delivery: {submit: vi.fn(), observe: async () => ({status: 'unknown'})},
      attempts: store(finish), composeTerminalNotification: notification});
    expect(result.status).toBe('unknown'); expect(finish).not.toHaveBeenCalled();
  });

  it('appends one terminal lifecycle fact for a provider-confirmed failure', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    await expect(reconcileAgentAttempt({actorId: 'actor', projectId: 'project', itemId: 'item',
      deliveryReference: 'run_ref'}, {delivery: {submit: vi.fn(), observe: async () =>
        ({status: 'failed', failureCode: 'provider_failed'})}, attempts: store(finish),
      composeTerminalNotification: notification}))
      .resolves.toMatchObject({status: 'failed'});
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({status: 'failed', failureCode: 'provider_failed'}));
  });

  it('appends completion only after exact route attestation and fresh tracker readback', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    const exactAttempt = {...attempt, observedVersion: 'v1', successTargetTitle: 'QA', reworkTargetTitle: null,
      expectedOwnerOptionId: 'hermes', routingPolicy: {contract: 'fai.agent-routing.v1' as const, routes: [
        {...accepted.execution, runtimeAcceptance: 'required' as const, humanGate: 'none' as const}
      ]}, executorCatalog: {'codex-cli': {available: true, models: ['gpt-5.6-terra']}}};
    await expect(reconcileAgentAttempt({actorId: 'actor', projectId: 'project', itemId: 'item',
      deliveryReference: 'run_ref'}, {delivery: {submit: vi.fn(), observe: async () => ({status: 'completed', result: accepted})},
      attempts: {...store(finish), resolve: async () => exactAttempt}, readFreshItem: async () => ({
        itemId:'item',projectId:'project',issueId:'issue',title:'Task',body:'',url:'https://example.test/1',
        statusOptionId:'qa',statusOptionName:'QA',ownerOptionId:'hermes',ownerOptionName:'Hermes',blocked:false,
        assigneeIds:[],assignees:[],version:'v2',targetDate:null,parentIssueId:null,subIssueIds:[],dependencyIssueIds:[],
        updatedAt:'2026-08-24T00:00:00.000Z',observedAt:'2026-08-24T00:00:00.000Z'}),
      composeTerminalNotification: notification})).resolves.toMatchObject({status: 'completed'});
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({status: 'completed', failureCode: null}));
  });

  it('fails closed when Hermes attests a route not pinned by the receipt', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    const exactAttempt = {...attempt, observedVersion:'v1',successTargetTitle:'QA',reworkTargetTitle:null,
      expectedOwnerOptionId:'hermes',routingPolicy:{contract:'fai.agent-routing.v1' as const,routes:[]},executorCatalog:{}};
    await expect(reconcileAgentAttempt({actorId:'actor',projectId:'project',itemId:'item',deliveryReference:'run_ref'},
      {delivery:{submit:vi.fn(),observe:async()=>({status:'completed' as const,result:accepted})},
        attempts:{...store(finish),resolve:async()=>exactAttempt},readFreshItem:async()=>null,
        composeTerminalNotification:notification})).resolves.toMatchObject({status:'failed'});
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({failureCode:'agent_result_invalid'}));
  });

  it('isolates a transient observation failure so the worker can continue', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>();
    await expect(reconcileActiveAgentAttempts(20, {delivery: {submit: vi.fn(), observe: async () => {
      throw new Error('agent_status_failed');
    }}, attempts: store(finish), composeTerminalNotification: notification})).resolves.toEqual([
      {status: 'observation-failed', deliveryReference: 'run_ref'}
    ]);
    expect(finish).not.toHaveBeenCalled();
  });

  it('isolates one broken terminal readback and still reconciles the next item', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    const attempts = [{...attempt, itemId:'bad'}, {...attempt, itemId:'next', deliveryReference:'run_next'}];
    const result = await reconcileActiveAgentAttempts(20, {delivery:{submit:vi.fn(),observe:async()=>
      ({status:'failed' as const,failureCode:'provider_failed' as const})},
    attempts:{...store(finish),listActive:async()=>attempts,
      finish:async(value)=>{ if(value.itemId==='bad') throw new Error('db_unavailable'); return finish(value); }},
    composeTerminalNotification:notification});
    expect(result).toEqual([{status:'reconciliation-failed',deliveryReference:'run_ref'},
      {status:'failed',deliveryReference:'run_next'}]);
    expect(finish).toHaveBeenCalledOnce();
  });
});
