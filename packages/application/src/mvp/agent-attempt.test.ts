import {describe, expect, it, vi} from 'vitest';
import type {TrackerSnapshot} from '@fai-control-plane/domain';
import {composeAgentTerminalNotification, reconcileActiveAgentAttempts, reconcileAgentAttempt,
  type AgentAttemptRecord, type AgentAttemptStore} from './agent-attempt.ts';

const attempt: AgentAttemptRecord = {workspaceId: 'workspace', projectId: 'project', actorId: 'actor', itemId: 'item', issueId: 'issue', role: 'developer',
  itemTitle: 'Task', itemUrl: 'https://example.test/issues/1',
  deliveryReference: 'run_ref', correlationId: `browser:${'c'.repeat(64)}`, status: 'started' as const};
const accepted = {contract: 'fai.agent-executor-result.v1' as const, decision: 'accepted' as const,
  execution: {taskClass: 'ordinary_implementation' as const, executor: {kind: 'cli' as const, id: 'codex-cli'},
    model: 'gpt-5.6-terra', effort: 'medium' as const}, outcome: 'success' as const,
  transition: {itemId: 'item', fromVersion: 'v1', targetStage: 'QA'}, reason: 'done',
  evidence: [{kind: 'checks', result: 'passed'}], deliverables: [{label:'PR',url:'https://example.test/pull/1'}]};
const notification = async (_attempt: AgentAttemptRecord, _observed: unknown, idempotencyKey: string) => ({
  projectId: 'project', contour: 'trusted-main' as const, channelReference: 'telegram:internal', text: 'result', idempotencyKey
});
const store = (finish: AgentAttemptStore['finish']): AgentAttemptStore => ({
  resolve: async () => attempt, listActive: async () => [attempt], finish
});
const snapshot = (statusOptionName = 'QA', ownerOptionId: string|null = 'hermes', blocked = false): TrackerSnapshot => ({
  bindingId: 'binding', externalVersion: 'v2', cursor: null, observedAt: '2026-08-26T00:00:00.000Z',
  sourceUrl: 'https://github.com/users/acme/projects/1', items: [{itemId: 'item', projectId: 'project', issueId: 'issue',
    title: 'Task', url: 'https://example.test/issues/1', version: 'v2', statusOptionId: 'qa', statusOptionName,
    ownerOptionId, blocked, targetDate: null, parentIssueId: null, subIssueIds: [], dependencyIssueIds: [],
    assigneeIds: [], assignees: [], observedAt: '2026-08-26T00:00:00.000Z'}]
});
const readTracker = async () => snapshot();
const pinnedAttempt: AgentAttemptRecord = {...attempt, observedVersion:'v1',successTargetTitle:'QA',
  reworkTargetTitle:null,expectedOwnerOptionId:'hermes',routingPolicy:{contract:'fai.agent-routing.v1',routes:[
    {...accepted.execution,executor:{id:'codex-cli',kind:'cli'},runtimeAcceptance:'required',humanGate:'none'}]}};

describe('agent attempt reconciliation', () => {
  it('revalidates the original failed run once, using fresh tracker facts without replaying Dev', async () => {
    let current: AgentAttemptRecord = {...pinnedAttempt,status:'failed',failureCode:'agent_result_invalid'};
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => {
      if (current.status === 'completed') return 'duplicate';
      current = {...current,status:'completed',failureCode:null}; return 'recorded';
    });
    const observe = vi.fn(async () => ({status:'completed' as const,result:accepted}));
    const submit = vi.fn(); const continuation = vi.fn(async () => undefined);
    const providerReadback = vi.fn(readTracker);
    const ports = {delivery:{submit,observe},attempts:{resolve:async()=>current,
      listActive:async()=>current.status === 'completed' ? [] : [current],finish},readTracker:providerReadback,
      continueAgentChain:continuation,composeTerminalNotification:notification};
    await reconcileActiveAgentAttempts(20,ports);
    await reconcileActiveAgentAttempts(20,ports);
    await reconcileAgentAttempt({actorId:'actor',projectId:'project',itemId:'item',deliveryReference:'run_ref'},ports);
    expect(observe).toHaveBeenCalledExactlyOnceWith('run_ref');
    expect(providerReadback).toHaveBeenCalledOnce(); expect(finish).toHaveBeenCalledOnce();
    expect(continuation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({deliveryReference:'run_ref'}),'QA');
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['executor','model','effort','version','item','target','owner','blocked'])(
    'keeps a genuine %s mismatch failed without notification or continuation', async (mismatch) => {
      const result = structuredClone(accepted);
      if (mismatch === 'executor') result.execution.executor.id = 'other-cli';
      if (mismatch === 'model') result.execution.model = 'other-model';
      if (mismatch === 'effort') Object.assign(result.execution,{effort:'high'});
      if (mismatch === 'version') result.transition.fromVersion = 'other';
      if (mismatch === 'item') result.transition.itemId = 'other';
      if (mismatch === 'target') result.transition.targetStage = 'Done';
      const finish = vi.fn(); const continuation = vi.fn(); const compose = vi.fn(notification);
      const failed = {...pinnedAttempt,status:'failed' as const,failureCode:'agent_result_invalid'};
      const ports = {delivery:{submit:vi.fn(),observe:async()=>({status:'completed' as const,result})},
        attempts:{...store(finish),listActive:async()=>[failed]},
        readTracker:async()=>snapshot('QA',mismatch === 'owner' ? 'human' : 'hermes',mismatch === 'blocked'),
        continueAgentChain:continuation,composeTerminalNotification:compose};
      await reconcileActiveAgentAttempts(20,ports); await reconcileActiveAgentAttempts(20,ports);
      expect(finish).not.toHaveBeenCalled(); expect(compose).not.toHaveBeenCalled();
      expect(continuation).not.toHaveBeenCalled();
    });

  it('never restarts an unavailable validation-failed run or revalidates a provider failure', async () => {
    const finish = vi.fn(); const recoverUnavailable = vi.fn(); const observe = vi.fn(async () => {throw Error('offline');});
    await reconcileActiveAgentAttempts(20,{delivery:{submit:vi.fn(),observe},attempts:{...store(finish),
      listActive:async()=>[{...pinnedAttempt,status:'failed',failureCode:'agent_result_invalid'},
        {...pinnedAttempt,status:'failed',failureCode:'provider_failed'}]},readTracker,
      recoverUnavailable,composeTerminalNotification:notification});
    expect(observe).toHaveBeenCalledOnce(); expect(recoverUnavailable).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
  });
  it('uses the provider-native task title and URL in Telegram instead of an opaque item id', () => {
    const message = composeAgentTerminalNotification('project', 'internal', attempt, {status: 'failed',
      failureCode: 'agent_result_rejected', result: {contract: 'fai.agent-executor-result.v1', decision: 'rejected',
        execution: {taskClass: 'ordinary_implementation', executor: {kind: 'cli', id: 'codex-cli'},
          model: 'gpt-5.6-terra', effort: 'medium'}, outcome: 'rework',
        transition: {itemId: 'item', fromVersion: 'v1', targetStage: 'In Dev'},
        reason: 'No checkout', evidence: [{kind: 'source', result: 'missing'}], deliverables: []}}, 'key');
    expect(message.text).toContain('Task — https://example.test/issues/1');
    expect(message.text).not.toContain('Задача: item');
  });
  it('does not turn an old run with visible progress into a timeout', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>();
    const oldAttempt = {...attempt, occurredAt: '2020-01-01T00:00:00.000Z'};
    const result = await reconcileAgentAttempt({actorId: 'actor', projectId: 'project', itemId: 'item',
      deliveryReference: 'run_ref'}, {delivery: {submit: vi.fn(), observe: async () => ({status: 'started',
        progress: {reference: 'tool:17', observedAt: '2026-08-31T10:00:00.000Z'}})},
      attempts: {...store(finish), resolve: async () => oldAttempt}, readTracker,
      composeTerminalNotification: notification});
    expect(result.status).toBe('started'); expect(finish).not.toHaveBeenCalled();
  });

  it('appends one terminal lifecycle fact for a provider-confirmed failure', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    await expect(reconcileAgentAttempt({actorId: 'actor', projectId: 'project', itemId: 'item',
      deliveryReference: 'run_ref'}, {delivery: {submit: vi.fn(), observe: async () =>
        ({status: 'failed', failureCode: 'provider_failed'})}, attempts: store(finish), readTracker,
      composeTerminalNotification: notification}))
      .resolves.toMatchObject({status: 'failed'});
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({status: 'failed', failureCode: 'provider_failed'}));
  });

  it('appends completion only after exact route validation and provider Project readback', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    const providerReadback = vi.fn(async () => snapshot());
    const continuation = vi.fn(async () => undefined);
    const exactAttempt = {...attempt, observedVersion: 'v1', successTargetTitle: 'QA', reworkTargetTitle: null,
      expectedOwnerOptionId: 'hermes', routingPolicy: {contract: 'fai.agent-routing.v1' as const, routes: [
        {...accepted.execution, runtimeAcceptance: 'required' as const, humanGate: 'none' as const}
      ]}, executorCatalog: {'codex-cli': {available: true, models: ['gpt-5.6-terra']}}};
    await expect(reconcileAgentAttempt({actorId: 'actor', projectId: 'project', itemId: 'item',
      deliveryReference: 'run_ref'}, {delivery: {submit: vi.fn(), observe: async () => ({status: 'completed', result: accepted})},
      attempts: {...store(finish), resolve: async () => exactAttempt}, readTracker:providerReadback,
      continueAgentChain:continuation,
      composeTerminalNotification: notification})).resolves.toMatchObject({status: 'completed'});
    expect(providerReadback).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({status: 'completed', failureCode: null}));
    expect(continuation).toHaveBeenCalledOnce();
  });

  it('keeps completed work open while provider Project readback is unavailable', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    const exactAttempt = {...attempt,observedVersion:'v1',successTargetTitle:'QA',reworkTargetTitle:null,
      routingPolicy:{contract:'fai.agent-routing.v1' as const,routes:[
        {...accepted.execution,runtimeAcceptance:'required' as const,humanGate:'none' as const}
      ]},executorCatalog:{}};
    const providerReadback = vi.fn(async () => { throw new Error('github_unavailable'); });
    await expect(reconcileAgentAttempt({actorId:'actor',projectId:'project',itemId:'item',deliveryReference:'run_ref'},
      {delivery:{submit:vi.fn(),observe:async()=>({status:'completed',result:accepted})},
        attempts:{...store(finish),resolve:async()=>exactAttempt},readTracker:providerReadback,
        composeTerminalNotification:notification})).resolves.toMatchObject({status:'started'});
    expect(providerReadback).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
  });

  it('stops the chain when provider readback confirms a blocker', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    const continuation = vi.fn(async () => undefined);
    const exactAttempt = {...attempt,observedVersion:'v1',successTargetTitle:'QA',reworkTargetTitle:null,
      expectedOwnerOptionId:'hermes',routingPolicy:{contract:'fai.agent-routing.v1' as const,routes:[
        {...accepted.execution,runtimeAcceptance:'required' as const,humanGate:'none' as const}
      ]},executorCatalog:{}};
    await expect(reconcileAgentAttempt({actorId:'actor',projectId:'project',itemId:'item',deliveryReference:'run_ref'},
      {delivery:{submit:vi.fn(),observe:async()=>({status:'completed',result:accepted})},
        attempts:{...store(finish),resolve:async()=>exactAttempt},readTracker:async()=>snapshot('QA','hermes',true),
        continueAgentChain:continuation,composeTerminalNotification:notification})).resolves.toMatchObject({status:'failed'});
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({failureCode:'provider_blocked'}));
    expect(continuation).not.toHaveBeenCalled();
  });

  it('fails closed when Hermes attests a route not pinned by the receipt', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    const exactAttempt = {...attempt, observedVersion:'v1',successTargetTitle:'QA',reworkTargetTitle:null,
      expectedOwnerOptionId:'hermes',routingPolicy:{contract:'fai.agent-routing.v1' as const,routes:[]},executorCatalog:{}};
    await expect(reconcileAgentAttempt({actorId:'actor',projectId:'project',itemId:'item',deliveryReference:'run_ref'},
      {delivery:{submit:vi.fn(),observe:async()=>({status:'completed' as const,result:accepted})},
        attempts:{...store(finish),resolve:async()=>exactAttempt},readTracker,
        composeTerminalNotification:notification})).resolves.toMatchObject({status:'failed'});
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({failureCode:'agent_result_invalid'}));
  });

  it('keeps a transient observation failure open so the worker can continue', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>();
    await expect(reconcileActiveAgentAttempts(20, {delivery: {submit: vi.fn(), observe: async () => {
      throw new Error('agent_status_failed');
    }}, attempts: store(finish), readTracker, composeTerminalNotification: notification})).resolves.toEqual([
      {status: 'unknown', deliveryReference: 'run_ref'}
    ]);
    expect(finish).not.toHaveBeenCalled();
  });

  it('lets the worker recover an unavailable provider without closing the attempt', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>();
    const recoverUnavailable = vi.fn(async () => ({status: 'started' as const}));
    await expect(reconcileActiveAgentAttempts(20, {delivery: {submit: vi.fn(), observe: async () => {
      throw new Error('agent_status_failed');
    }}, attempts: store(finish), readTracker, recoverUnavailable,
    composeTerminalNotification: notification})).resolves.toEqual([{status: 'started', deliveryReference: 'run_ref'}]);
    expect(recoverUnavailable).toHaveBeenCalledWith(attempt);
    expect(finish).not.toHaveBeenCalled();
  });
  it('keeps the original run open when recovery itself is unavailable, then observes its real failure', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    const submit = vi.fn();
    const observe = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({status: 'failed', failureCode: 'provider_failed'});
    const ports = {delivery: {submit, observe}, attempts: store(finish), readTracker,
      recoverUnavailable: async () => {throw new Error('notification unavailable');},
      composeTerminalNotification: notification};
    expect(await reconcileActiveAgentAttempts(20, ports)).toEqual([{status: 'unknown', deliveryReference: 'run_ref'}]);
    expect(finish).not.toHaveBeenCalled();
    expect(await reconcileActiveAgentAttempts(20, ports)).toEqual([{status: 'failed', deliveryReference: 'run_ref'}]);
    expect(observe.mock.calls).toEqual([['run_ref'], ['run_ref']]);
    expect(submit).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
  });

  it('routes every unobservable run_not_found through recovery while leaving the attempt open', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>();
    const recoverUnavailable = vi.fn(async () => ({status: 'started' as const}));
    const observationSucceeded = vi.fn();
    const value = {delivery: {submit: vi.fn(), observe: async () => ({status: 'unknown' as const})},
      attempts: store(finish), readTracker, recoverUnavailable, observationSucceeded,
      composeTerminalNotification: notification};
    await expect(reconcileActiveAgentAttempts(20,value)).resolves.toEqual([
      {status:'started',deliveryReference:'run_ref'}]);
    await expect(reconcileActiveAgentAttempts(20,value)).resolves.toEqual([
      {status:'started',deliveryReference:'run_ref'}]);
    expect(recoverUnavailable).toHaveBeenCalledTimes(2);
    expect(observationSucceeded).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('treats visible progress as healthy observation and resets recovery streak', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>();
    const recoverUnavailable = vi.fn(async () => ({status:'started' as const}));
    const observationSucceeded = vi.fn();
    await expect(reconcileActiveAgentAttempts(20,{delivery:{submit:vi.fn(),observe:async()=>({status:'started' as const,
      progress:{reference:'tool:18',observedAt:'2026-08-31T10:01:00.000Z'}})},attempts:store(finish),readTracker,
      recoverUnavailable,observationSucceeded,composeTerminalNotification:notification})).resolves.toEqual([
        {status:'started',deliveryReference:'run_ref'}]);
    expect(observationSucceeded).toHaveBeenCalledOnce();
    expect(recoverUnavailable).not.toHaveBeenCalled();
  });

  it('isolates one broken terminal readback and still reconciles the next item', async () => {
    const finish = vi.fn<AgentAttemptStore['finish']>(async () => 'recorded');
    const attempts = [{...attempt, itemId:'bad'}, {...attempt, itemId:'next', deliveryReference:'run_next'}];
    const result = await reconcileActiveAgentAttempts(20, {delivery:{submit:vi.fn(),observe:async()=>
      ({status:'failed' as const,failureCode:'provider_failed' as const})},
    attempts:{...store(finish),listActive:async()=>attempts,
      finish:async(value)=>{ if(value.itemId==='bad') throw new Error('db_unavailable'); return finish(value); }},
    readTracker,composeTerminalNotification:notification});
    expect(result).toEqual([{status:'reconciliation-failed',deliveryReference:'run_ref'},
      {status:'failed',deliveryReference:'run_next'}]);
    expect(finish).toHaveBeenCalledOnce();
  });
});
