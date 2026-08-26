import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {defaultAgentRoutingPolicy, projectContextSnapshotKind, projectContextSnapshotVersion, projectContextSourceKind,
  serializeProjectContextSnapshot, type TrackerSnapshot} from '@fai-control-plane/domain';
import type {AgentSubmissionPorts} from './agent-submission.ts';
import {submitExplicitAgent} from './agent-submission.ts';

const snapshot: TrackerSnapshot = {bindingId: 'binding', externalVersion: 'snapshot-v1', cursor: null,
  observedAt: '2026-08-15T10:00:00.000Z', sourceUrl: 'https://github.com/users/VF78/projects/1', items: [{
    itemId: 'PVTI_item', projectId: 'project', issueId: '210', title: 'GUI recovery',
    url: 'https://github.com/VF78/fai-control-plane/issues/210', version: 'github:updated-at:v1',
    statusOptionId: 'in-dev', statusOptionName: 'In Dev', ownerOptionId: 'owner-hermes', blocked: false, targetDate: null,
    parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: [], assignees: [],
    observedAt: '2026-08-15T10:00:00.000Z'}]};
const task = snapshot.items[0]!;
const routingPolicyVersion = createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex');
const executorCatalog = {'codex-cli': {available: true, models: ['gpt-5.6-terra', 'gpt-5.6-sol']},
  'claude-code-cli': {available: false, models: []}} as const;
const processPolicy = {contract: 'fai.project-process.v1' as const, stages: [
  {id:'ready',title:'Ready',responsibility:'Owner',gate:'Explicit',evidence:'Task',nextStageId:'dev',automation:null},
  {id:'dev',title:'In Dev',responsibility:'Agent',gate:'Work',evidence:'PR',nextStageId:null,
    automation:{agentRole:'developer' as const,afterRoles:['qa' as const],maxStarts:1,reworkStageId:null}}
]};
const contextContent = serializeProjectContextSnapshot({contract:'fai.project-context.v1',
  sources:[{id:'source',key:'requirements',kind:projectContextSourceKind,version:'a'.repeat(64),provenance:'operator'}],
  content:'Approved project context'});
const activeContext = {id:'context',sha256:projectContextSnapshotVersion(contextContent),
  kind:projectContextSnapshotKind,provenance:'control-plane:context',content:contextContent};

const ports = (role: 'project_owner'|'operator'|'contributor' = 'operator'): AgentSubmissionPorts => ({
  resolveContext: async () => ({workspaceId: 'workspace', projectId: 'project', requesterRole: role,
    bindingId: 'binding', repository: {id: 'R_repo', url: 'https://github.com/VF78/fai-control-plane'},
    agentTrackerOwnerOptionId: 'owner-hermes', doneStatusOptionId: 'done',
    routingPolicyVersion, routingPolicy: defaultAgentRoutingPolicy, executorCatalog,
    processPolicyVersion: 'b'.repeat(64), processPolicy}),
  readFreshSnapshot: async () => snapshot, persistSnapshot: async () => undefined,
  resolveActiveContext: async () => activeContext,
  repository: {readRepository: async () => ({repositoryId: 'R_repo',
    url: 'https://github.com/VF78/fai-control-plane', defaultBranch: 'main', defaultBranchSha: 'a'.repeat(40),
    observedAt: '2026-08-15T10:00:00.000Z'})},
  composeAcceptedNotification: async (item, idempotencyKey) => ({projectId: item.projectId,
    contour: 'trusted-main', channelReference: 'internal', text: `Hermes accepted: ${item.url}`, idempotencyKey}),
  delivery: {submit: async (request) => ({deliveryReference: `hermes:${request.idempotencyKey}`,
    sessionReference: request.correlationId}), observe: async () => ({status: 'started'})},
  transaction: {execute: async (_input, submit) => ({status: 'completed', ...(await submit())})}
});
const command = {actorId: 'actor', projectId: 'project', projectItemId: 'PVTI_item', role: 'developer' as const,
  constraints: ['Do not deploy'], acceptanceCriteria: ['Focused tests pass']};

describe('explicit agent submission', () => {
  it('denies inactive/disallowed membership before reading a provider or delivering', async () => {
    const value = ports('contributor'); const read = vi.spyOn(value, 'readFreshSnapshot'); const deliver = vi.spyOn(value.delivery, 'submit');
    await expect(submitExplicitAgent(command, value)).rejects.toThrow('agent_submit_denied');
    expect(read).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
  });

  it('derives stable request idempotency and lets the canonical transaction return a duplicate', async () => {
    const seen = new Map<string, string>(); const transactionInputs: unknown[] = []; const base = ports();
    const value: AgentSubmissionPorts = {...base, transaction: {execute: async (input, submit) => {
      transactionInputs.push(input);
      const prior = seen.get(input.idempotencyKey);
      if (prior !== undefined) return {status: 'duplicate', deliveryReference: prior};
      const delivered = await submit(); seen.set(input.idempotencyKey, delivered.deliveryReference);
      return {status: 'completed', deliveryReference: delivered.deliveryReference};
    }}};
    const deliver = vi.spyOn(value.delivery, 'submit');
    await expect(submitExplicitAgent(command, value)).resolves.toMatchObject({status: 'completed'});
    await expect(submitExplicitAgent(command, value)).resolves.toMatchObject({status: 'duplicate'});
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]).toMatchObject({repository: {id: 'R_repo', defaultBranch: 'main',
      defaultBranchSha: 'a'.repeat(40)}, projectItem: {id: 'PVTI_item', projectId: 'project',
        title: 'GUI recovery'},
      observedVersion: 'github:updated-at:v1', constraints: ['Do not deploy'],
      routing: {policyVersion: routingPolicyVersion, classification: 'runtime-classification-required'},
      sources: [{id: 'context', content: contextContent}]});
    expect(transactionInputs[0]).toMatchObject({notification: {projectId: 'project', contour: 'trusted-main',
      channelReference: 'internal', text: 'Hermes accepted: https://github.com/VF78/fai-control-plane/issues/210',
      idempotencyKey: expect.stringMatching(/^agent\.submit:[a-f0-9]{64}:accepted$/)}});
  });

  it('submits once and leaves provider recovery to the worker guarantee loop', async () => {
    const base = ports();
    const submit = vi.fn(async (request: Parameters<typeof base.delivery.submit>[0]) => {
      throw new Error(`agent_provider_unavailable:${request.idempotencyKey}`);
    });
    const value: AgentSubmissionPorts = {...base,delivery:{...base.delivery,submit}};
    await expect(submitExplicitAgent(command,value)).rejects.toThrow('agent_provider_unavailable');
    expect(submit).toHaveBeenCalledOnce();
  });

  it('rejects a missing, stale, or malformed active context before delivery', async () => {
    const base = ports();
    for (const context of [null,{...activeContext,sha256:'b'.repeat(64)},{...activeContext,content:'not-json'}]) {
      const value: AgentSubmissionPorts = {...base, resolveActiveContext: async () => context};
      const deliver = vi.spyOn(value.delivery, 'submit');
      await expect(submitExplicitAgent(command, value)).rejects.toThrow('agent_context_unavailable');
      expect(deliver).not.toHaveBeenCalled();
    }
  });

  it('never exposes the devops/production role on this seam', async () => {
    await expect(submitExplicitAgent({...command, role: 'devops'}, ports('project_owner')))
      .rejects.toThrow('agent_submit_denied');
  });

  it('denies launch when the active routing policy version is missing or stale', async () => {
    const base = ports(); const deliver = vi.spyOn(base.delivery, 'submit');
    const value: AgentSubmissionPorts = {...base, resolveContext: async () => ({
      ...(await base.resolveContext({actorId: 'actor', projectId: 'project'}))!, routingPolicyVersion: ''
    })};
    await expect(submitExplicitAgent(command, value)).rejects.toThrow('agent_request_invalid');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('denies launch when Codex CLI or a configured Claude CLI route is unavailable', async () => {
    for (const context of [
      {...(await ports().resolveContext({actorId: 'actor', projectId: 'project'}))!,
        executorCatalog: {...executorCatalog, 'codex-cli': {available: false, models: []}}},
      {...(await ports().resolveContext({actorId: 'actor', projectId: 'project'}))!,
        routingPolicy: {...defaultAgentRoutingPolicy, routes: defaultAgentRoutingPolicy.routes.map((route) =>
          route.taskClass === 'ordinary_implementation'
            ? {...route, executor: {kind: 'cli' as const, id: 'claude-code-cli'}} : route)}}
    ]) {
      const base = ports(); const deliver = vi.spyOn(base.delivery, 'submit');
      await expect(submitExplicitAgent(command, {...base, resolveContext: async () => context}))
        .rejects.toThrow('agent_submit_denied');
      expect(deliver).not.toHaveBeenCalled();
    }
  });

  it('denies a Done task even when it is assigned exactly to Hermes', async () => {
    const base = ports();
    const value: AgentSubmissionPorts = {...base, readFreshSnapshot: async () => ({...snapshot, items: [
      {...task, statusOptionId: 'done'}
    ]})};
    const deliver = vi.spyOn(value.delivery, 'submit');
    await expect(submitExplicitAgent(command, value)).rejects.toThrow('agent_submit_denied');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('denies a non-Done task without the exact Hermes Owner option', async () => {
    for (const ownerOptionId of [null, 'owner-other', 'OWNER-HERMES']) {
      const base = ports();
      const value: AgentSubmissionPorts = {...base, readFreshSnapshot: async () => ({...snapshot, items: [
        {...task, ownerOptionId}
      ]})};
      const deliver = vi.spyOn(value.delivery, 'submit');
      await expect(submitExplicitAgent(command, value)).rejects.toThrow('agent_submit_denied');
      expect(deliver).not.toHaveBeenCalled();
    }
  });

  it('allows an exact assigned non-Done task and refreshes it immediately before delivery', async () => {
    const order: string[] = [];
    const base = ports();
    const value: AgentSubmissionPorts = {...base,
      resolveActiveContext: async (input) => { order.push('context'); return base.resolveActiveContext(input); },
      repository: {readRepository: async (input) => { order.push('repository'); return base.repository.readRepository(input); }},
      readFreshSnapshot: async () => { order.push('fresh-snapshot'); return snapshot; },
      persistSnapshot: async () => { order.push('persist-snapshot'); },
      delivery: {submit: async (request) => { order.push('delivery'); return base.delivery.submit(request); },
        observe: base.delivery.observe}
    };
    await expect(submitExplicitAgent(command, value)).resolves.toMatchObject({status: 'completed'});
    expect(order).toEqual(['repository', 'context', 'fresh-snapshot', 'persist-snapshot', 'delivery']);
  });

  it('creates a distinct key for an explicit retry and binds it to the failed receipt', async () => {
    const base = ports(); let input: Parameters<AgentSubmissionPorts['transaction']['execute']>[0]|undefined;
    const value: AgentSubmissionPorts = {...base, delivery: {...base.delivery, observe: async () => ({status: 'unknown'})},
      transaction: {execute: async (next, submit) => {
      input = next; return {status: 'completed', ...(await submit())};
    }}};
    const initial = await submitExplicitAgent(command, value);
    const initialKey = input!.idempotencyKey;
    await submitExplicitAgent({...command, retry: {deliveryReference: initial.deliveryReference,
      nonce: 'operator-confirmation', confirmUnobservableFailure: true}}, value);
    expect(input).toMatchObject({retryOf: initial.deliveryReference, confirmUnobservableFailure: true});
    expect(input!.idempotencyKey).not.toBe(initialKey);
  });

  it.each(['started','completed','failed'] as const)('denies a direct unobservable-recovery bypass when Hermes reports %s', async (status) => {
    const base = ports(); const execute = vi.spyOn(base.transaction, 'execute');
    await expect(submitExplicitAgent({...command, retry: {deliveryReference: 'run_exact', nonce: 'direct-bypass',
      confirmUnobservableFailure: true}}, {...base, delivery: {...base.delivery, observe: async (reference) => {
        expect(reference).toBe('run_exact'); return {status};
      }}})).rejects.toThrow('agent_retry_denied');
    expect(execute).not.toHaveBeenCalled();
  });
});
