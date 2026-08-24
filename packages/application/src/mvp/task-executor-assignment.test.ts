import {describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {defaultAgentRoutingPolicy, projectContextSnapshotKind, projectContextSnapshotVersion, projectContextSourceKind,
  serializeProjectContextSnapshot, type TrackerSnapshot} from '@fai-control-plane/domain';
import type {TaskExecutorAssignmentPorts} from './task-executor-assignment.ts';
import {assignTaskExecutor, startProcess} from './task-executor-assignment.ts';

const base: TrackerSnapshot = {bindingId: 'binding', externalVersion: 'v1', cursor: null, observedAt: '2026-08-24T00:00:00.000Z', sourceUrl: 'https://github.com/users/acme/projects/1', items: [{itemId: 'item', projectId: 'project', issueId: '219', title: 'Assign executor', url: 'https://github.com/acme/repo/issues/219', version: 'github:updated-at:v1', statusOptionId: 'ready', statusOptionName: 'Ready', ownerOptionId: null, blocked: false, targetDate: null, parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: [], assignees: [], observedAt: '2026-08-24T00:00:00.000Z'}]};
const contextContent = serializeProjectContextSnapshot({contract:'fai.project-context.v1',
  sources:[{id:'source',key:'requirements',kind:projectContextSourceKind,version:'a'.repeat(64),provenance:'operator'}],content:'Context'});
const activeContext = {id:'context',sha256:projectContextSnapshotVersion(contextContent),
  kind:projectContextSnapshotKind,provenance:'control-plane:context',content:contextContent};
const processPolicy = {contract:'fai.project-process.v1' as const,stages:[
  {id:'backlog',title:'Backlog',responsibility:'Owner',gate:'Triage',evidence:'Task',nextStageId:'ready',automation:null},
  {id:'ready',title:'Ready',responsibility:'Owner',gate:'Explicit',evidence:'Task',nextStageId:'dev',automation:null},
  {id:'dev',title:'In Dev',responsibility:'Agent',gate:'Work',evidence:'PR',nextStageId:'qa',
    automation:{agentRole:'developer' as const,afterRoles:['qa' as const],maxStarts:2,reworkStageId:null}},
  {id:'qa',title:'QA',responsibility:'Agent',gate:'Review',evidence:'Checks',nextStageId:'acceptance',
    automation:{agentRole:'qa' as const,afterRoles:['developer' as const],maxStarts:2,reworkStageId:'dev'}},
  {id:'acceptance',title:'Acceptance',responsibility:'Owner',gate:'Accept',evidence:'Approval',nextStageId:null,automation:null}
]};

const ports = (failStart = false, initialStatus = 'Ready', initialBlocked = false, initialOwner: string|null = null) => {
  let owner: string|null = initialOwner; let assignees: readonly {id: string; login: string; name: string|null}[] = [];
  let status = initialStatus; let blocked = initialBlocked; let version = 1;
  const deliveries = new Map<string,string>();
  const snapshot = (): TrackerSnapshot => ({...base, items: [{...base.items[0]!, ownerOptionId: owner, blocked,
    assignees, assigneeIds: assignees.map((user) => user.id), statusOptionName: status, version: `github:updated-at:v${version}`}]});
  const value: TaskExecutorAssignmentPorts = {
    resolveContext: async () => ({workspaceId: 'workspace', projectId: 'project', requesterRole: 'operator', bindingId: 'binding', repository: {id: 'repo', url: 'https://github.com/acme/repo'}, agentTrackerOwnerOptionId: 'hermes', doneStatusOptionId: 'done', routingPolicyVersion: createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex'), routingPolicy: defaultAgentRoutingPolicy, executorCatalog: {'codex-cli': {available: true, models: ['gpt-5.6-terra', 'gpt-5.6-sol']}, 'claude-code-cli': {available: false, models: []}}, processPolicyVersion:'b'.repeat(64), processPolicy}),
    readFreshSnapshot: async () => snapshot(), persistSnapshot: async () => undefined,
    resolveActiveContext: async () => activeContext,
    agentInstructions: (role) => role === 'developer'
      ? {constraints: ['Do not merge, release, deploy, or access production.', 'Move this same Project item from In Dev to QA and verify it after implementation.'],
        acceptanceCriteria: ['Record delivery evidence.', 'The same Project item is confirmed in QA.']}
      : {constraints: ['Do not merge, release, deploy, or access production.', 'Move this same Project item from QA to In Dev for rework, otherwise QA to Acceptance, then verify it.'],
        acceptanceCriteria: ['Record delivery evidence.', 'The same Project item is confirmed in In Dev or Acceptance.']},
    repository: {readRepository: async () => ({repositoryId: 'repo', url: 'https://github.com/acme/repo', defaultBranch: 'main', observedAt: '2026-08-24T00:00:00.000Z'})},
    composeAcceptedNotification: async (item, idempotencyKey) => ({projectId: item.projectId,
      contour: 'trusted-main', channelReference: 'internal', text: `Hermes accepted: ${item.url}`, idempotencyKey}),
    delivery: {submit: vi.fn(async () => ({deliveryReference: 'hermes:receipt', sessionReference: 'hermes:session'})),
      observe: vi.fn(async () => ({status: 'started' as const}))},
    transaction: {execute: async (input, submit) => { const prior = deliveries.get(input.idempotencyKey);
      if (prior !== undefined) return {status: 'duplicate', deliveryReference: prior};
      const result = await submit(); deliveries.set(input.idempotencyKey, result.deliveryReference);
      return {status: 'completed', ...result}; }},
    tracker: {listAssignableUsers: async () => [{id: 'U_1', login: 'octo', name: 'Octo'}],
      startExecutor: async (command) => {
        if (failStart) throw new Error('github_mutation_failed');
        if (command.expectedVersion !== `github:updated-at:v${version}` || command.expectedStage !== status ||
          command.expectedBlocked !== blocked) throw new Error('github_version_conflict');
        const prior = JSON.stringify({owner, assignees, blocked, status});
        if (command.executor.kind === 'human') {
          owner = null; assignees = [{id: command.executor.candidate.id, login: command.executor.candidate.login, name: 'Octo'}];
        } else { owner = command.executor.ownerOptionId; assignees = []; }
        blocked = false; status = command.targetStage;
        if (JSON.stringify({owner, assignees, blocked, status}) !== prior) version += 1;
      }}
  };
  return {value, delivery: value.delivery.submit};
};

describe('task executor assignment', () => {
  it('resolves a nonstandard entry and agent role entirely from the active process policy', async () => {
    const value = ports(false, 'Intake');
    const original = value.value.resolveContext;
    const custom: TaskExecutorAssignmentPorts = {...value.value, resolveContext: async (input) => {
      const context = await original(input); if (context === null) return null;
      return {...context, processPolicyVersion: 'c'.repeat(64), processPolicy: {contract:'fai.project-process.v1',stages:[
        {id:'intake',title:'Intake',responsibility:'Owner',gate:'Explicit',evidence:'Task',nextStageId:'build',automation:null},
        {id:'build',title:'Build',responsibility:'Agent',gate:'Work',evidence:'Result',nextStageId:null,
          automation:{agentRole:'developer',afterRoles:['qa'],maxStarts:1,reworkStageId:null}}
      ]}};
    }};
    await expect(assignTaskExecutor({actorId:'actor',projectId:'project',projectItemId:'item',executor:{kind:'hermes'}}, custom))
      .resolves.toMatchObject({status:'started'});
    expect(value.delivery).toHaveBeenCalledWith(expect.objectContaining({role:'developer',
      process:expect.objectContaining({policyVersion:'c'.repeat(64),stageId:'build',stageTitle:'Build',successTargetTitle:null})}));
  });
  it('uses GitHub candidates for a human assignment without a Hermes submission', async () => {
    const value = ports();
    await expect(assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'human', candidate: {id: 'U_1', login: 'octo'}}}, value.value)).resolves.toEqual({status: 'assigned'});
    expect(value.delivery).not.toHaveBeenCalled();
  });

  it('fails closed when the fresh human assignment does not match the requested GitHub login', async () => {
    const value = ports(); const broken: TaskExecutorAssignmentPorts = {...value.value, tracker: {...value.value.tracker, startExecutor: async () => undefined}};
    await expect(assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'human', candidate: {id: 'U_1', login: 'octo'}}}, broken)).rejects.toThrow('task_executor_conflict');
  });

  it('denies Hermes on Acceptance before delivery', async () => {
    const value = ports(); const baseRead = value.value.readFreshSnapshot;
    const acceptance: TaskExecutorAssignmentPorts = {...value.value, readFreshSnapshot: async (context) => { const snapshot = await baseRead(context); return {...snapshot, items: [{...snapshot.items[0]!, statusOptionName: 'Acceptance'}]}; }};
    await expect(assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'hermes'}}, acceptance)).rejects.toThrow('task_executor_unavailable');
    expect(value.delivery).not.toHaveBeenCalled();
  });

  it.each(['In Dev', 'QA'])('starts Hermes in %s without changing the current stage', async (stage) => {
    const value = ports(false, stage); const command = {actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'hermes'} as const};
    await expect(assignTaskExecutor(command, value.value)).resolves.toMatchObject({status: 'started', deliveryReference: 'hermes:receipt'});
    expect(value.delivery).toHaveBeenCalledTimes(1);
    const context = await value.value.resolveContext({actorId: 'actor', projectId: 'project'});
    if (context === null) throw new Error('missing test context');
    const fresh = await value.value.readFreshSnapshot(context);
    expect(fresh.items[0]?.statusOptionName).toBe(stage);
  });

  it('delivers the ASCON developer and QA status-verification contract', async () => {
    const developer = ports(false, 'In Dev');
    await assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'hermes'}}, developer.value);
    expect(developer.delivery).toHaveBeenCalledWith(expect.objectContaining({role: 'developer', constraints: expect.arrayContaining([
      expect.stringContaining('In Dev to QA'), expect.stringContaining('verify')
    ])}));
    const qa = ports(false, 'QA');
    await assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'hermes'}}, qa.value);
    expect(qa.delivery).toHaveBeenCalledWith(expect.objectContaining({role: 'qa', constraints: expect.arrayContaining([
      expect.stringContaining('QA to In Dev'), expect.stringContaining('QA to Acceptance')
    ])}));
  });

  it('does not deliver Hermes twice when the confirmed start command is replayed', async () => {
    const value = ports(); const command = {actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'hermes'} as const};
    await expect(assignTaskExecutor(command, value.value)).resolves.toMatchObject({status: 'started', deliveryReference: 'hermes:receipt'});
    await expect(assignTaskExecutor(command, value.value)).resolves.toMatchObject({status: 'duplicate', deliveryReference: 'hermes:receipt'});
    expect(value.delivery).toHaveBeenCalledTimes(1);
  });

  it.each(['human','hermes'] as const)('starts a blocked Backlog item with one explicit %s command', async (kind) => {
    const value = ports(false, 'Backlog', true, 'chatgpt-work');
    const start = vi.spyOn(value.value.tracker, 'startExecutor');
    const executor = kind === 'human' ? {kind, candidate: {id: 'U_1', login: 'octo'}} as const : {kind} as const;
    await expect(assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item', executor}, value.value))
      .resolves.toMatchObject({status: kind === 'human' ? 'assigned' : 'started'});
    const context = await value.value.resolveContext({actorId: 'actor', projectId: 'project'});
    const item = (await value.value.readFreshSnapshot(context!)).items[0]!;
    expect(item).toMatchObject({statusOptionName: 'In Dev', blocked: false,
      ownerOptionId: kind === 'human' ? null : 'hermes'});
    expect(start).toHaveBeenCalledWith(expect.objectContaining({expectedStage: 'Backlog', expectedBlocked: true,
      executor: kind === 'human' ? {kind: 'human', candidate: {id: 'U_1', login: 'octo'}} : {kind: 'agent', ownerOptionId: 'hermes'}}));
    expect(value.delivery).toHaveBeenCalledTimes(kind === 'human' ? 0 : 1);
  });

  it('checks an exact unknown prior run before changing GitHub, then recovers and starts', async () => {
    const value = ports(false, 'Backlog', true, 'chatgpt-work'); const order: string[] = [];
    const tracker = value.value.tracker;
    const recovered: TaskExecutorAssignmentPorts = {...value.value,
      delivery: {...value.value.delivery, observe: vi.fn(async (reference) => { order.push(`observe:${reference}`); return {status: 'unknown' as const}; })},
      tracker: {...tracker, startExecutor: async (command) => { order.push('github:start'); return tracker.startExecutor(command); }}};
    await expect(assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'hermes'},
      retry: {deliveryReference: 'run_old', nonce: 'confirmed', confirmUnobservableFailure: true}}, recovered))
      .resolves.toMatchObject({status: 'started'});
    expect(order.slice(0,2)).toEqual(['observe:run_old','github:start']);
  });

  it('denies a claimed unknown recovery before GitHub when the exact prior run is still active', async () => {
    const value = ports(false, 'Backlog', true, 'chatgpt-work'); const start = vi.spyOn(value.value.tracker, 'startExecutor');
    await expect(assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'hermes'},
      retry: {deliveryReference: 'run_active', nonce: 'claimed', confirmUnobservableFailure: true}}, value.value))
      .rejects.toThrow('agent_retry_denied');
    expect(value.value.delivery.observe).toHaveBeenCalledWith('run_active');
    expect(start).not.toHaveBeenCalled(); expect(value.delivery).not.toHaveBeenCalled();
  });

  it('preserves Acceptance while assigning a human', async () => {
    const value = ports(false, 'Acceptance', true, 'chatgpt-work');
    await expect(assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item',
      executor: {kind: 'human', candidate: {id: 'U_1', login: 'octo'}}}, value.value)).resolves.toEqual({status: 'assigned'});
    const context = await value.value.resolveContext({actorId: 'actor', projectId: 'project'});
    expect((await value.value.readFreshSnapshot(context!)).items[0]).toMatchObject({statusOptionName: 'Acceptance', blocked: false});
  });

  it('denies Done before any tracker mutation or delivery', async () => {
    const value = ports(false, 'Done', true); const start = vi.spyOn(value.value.tracker, 'startExecutor');
    await expect(assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'hermes'}}, value.value))
      .rejects.toThrow('task_executor_unavailable');
    expect(start).not.toHaveBeenCalled(); expect(value.delivery).not.toHaveBeenCalled();
  });

  it('process.start create adopts only the exact provider readback and returns one chain reference', async () => {
    const value = ports(false, 'In Dev');
    const tracker = {...value.value.tracker, createIssue: vi.fn(async () => ({referenceId:'219',
      url:'https://github.com/acme/repo/issues/219',version:'github:updated-at:v1'}))};
    await expect(startProcess({actorId:'actor',projectId:'project',task:{kind:'create',title:'Task',statement:'Work'},
      sourceReference:'telegram:message:12',idempotencyKey:'process.start:telegram:77'},
    {...value.value,tracker})).resolves.toMatchObject({status:'started',itemId:'item',
      chainReference:expect.stringMatching(/^browser:[a-f0-9]{64}$/)});
    expect(tracker.createIssue).toHaveBeenCalledOnce();
  });

  it('process.start create refuses a non-exact tracker readback', async () => {
    const value = ports(false, 'In Dev'); const start = vi.spyOn(value.value.tracker,'startExecutor');
    const tracker = {...value.value.tracker, createIssue: vi.fn(async () => ({referenceId:'220',
      url:'https://github.com/acme/repo/issues/220',version:'github:updated-at:v1'}))};
    await expect(startProcess({actorId:'actor',projectId:'project',task:{kind:'create',title:'Task',statement:'Work'},
      sourceReference:'telegram:message:12',idempotencyKey:'process.start:telegram:77'},
    {...value.value,tracker})).rejects.toThrow('process_start_readback_conflict');
    expect(start).not.toHaveBeenCalled(); expect(value.delivery).not.toHaveBeenCalled();
  });
});
