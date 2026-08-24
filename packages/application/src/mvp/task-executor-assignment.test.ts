import {describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {defaultAgentRoutingPolicy, projectContextSnapshotKind, projectContextSnapshotVersion, projectContextSourceKind,
  serializeProjectContextSnapshot, type TrackerSnapshot} from '@fai-control-plane/domain';
import type {TaskExecutorAssignmentPorts} from './task-executor-assignment.ts';
import {assignTaskExecutor} from './task-executor-assignment.ts';

const base: TrackerSnapshot = {bindingId: 'binding', externalVersion: 'v1', cursor: null, observedAt: '2026-08-24T00:00:00.000Z', sourceUrl: 'https://github.com/users/acme/projects/1', items: [{itemId: 'item', projectId: 'project', issueId: '219', title: 'Assign executor', url: 'https://github.com/acme/repo/issues/219', version: 'github:updated-at:v1', statusOptionId: 'ready', statusOptionName: 'Ready', ownerOptionId: null, blocked: false, targetDate: null, parentIssueId: null, subIssueIds: [], dependencyIssueIds: [], assigneeIds: [], assignees: [], observedAt: '2026-08-24T00:00:00.000Z'}]};
const contextContent = serializeProjectContextSnapshot({contract:'fai.project-context.v1',
  sources:[{id:'source',key:'requirements',kind:projectContextSourceKind,version:'a'.repeat(64),provenance:'operator'}],content:'Context'});
const activeContext = {id:'context',sha256:projectContextSnapshotVersion(contextContent),
  kind:projectContextSnapshotKind,provenance:'control-plane:context',content:contextContent};

const ports = (failStart = false, initialStatus = 'Ready') => {
  let owner: string|null = null; let assignees: readonly {id: string; login: string; name: string|null}[] = []; let status = initialStatus; let version = 1; let delivered = false; let startFails = failStart;
  const snapshot = (): TrackerSnapshot => ({...base, items: [{...base.items[0]!, ownerOptionId: owner, assignees, assigneeIds: assignees.map((user) => user.id), statusOptionName: status, version: `github:updated-at:v${version}`}]});
  const value: TaskExecutorAssignmentPorts = {
    resolveContext: async () => ({workspaceId: 'workspace', projectId: 'project', requesterRole: 'operator', bindingId: 'binding', repository: {id: 'repo', url: 'https://github.com/acme/repo'}, agentTrackerOwnerOptionId: 'hermes', doneStatusOptionId: 'done', routingPolicyVersion: createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex'), routingPolicy: defaultAgentRoutingPolicy, executorCatalog: {'codex-cli': {available: true, models: ['gpt-5.6-terra', 'gpt-5.6-sol']}, 'claude-code-cli': {available: false, models: []}}}),
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
    transaction: {execute: async (_input, submit) => delivered ? {status: 'duplicate', deliveryReference: 'hermes:receipt'} : (delivered = true, {status: 'completed', ...(await submit())})},
    tracker: {listAssignableUsers: async () => [{id: 'U_1', login: 'octo', name: 'Octo'}], assignHumanExecutor: async () => { owner = null; assignees = [{id: 'U_1', login: 'octo', name: 'Octo'}]; status = 'In Dev'; version += 1; },
      assignHermesExecutor: async () => { if (owner === 'hermes') return 'already_assigned'; owner = 'hermes'; assignees = []; version += 1; return 'assigned'; },
      startHermesExecutor: async () => { if (startFails) { startFails = false; throw new Error('github_mutation_failed'); } status = 'In Dev'; version += 1; return 'advanced'; }}
  };
  return {value, delivery: value.delivery.submit};
};

describe('task executor assignment', () => {
  it('uses GitHub candidates for a human assignment without a Hermes submission', async () => {
    const value = ports();
    await expect(assignTaskExecutor({actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'human', candidate: {id: 'U_1', login: 'octo'}}}, value.value)).resolves.toEqual({status: 'assigned'});
    expect(value.delivery).not.toHaveBeenCalled();
  });

  it('fails closed when the fresh human assignment does not match the requested GitHub login', async () => {
    const value = ports(); const broken: TaskExecutorAssignmentPorts = {...value.value, tracker: {...value.value.tracker, assignHumanExecutor: async () => undefined}};
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

  it('retries a failed status sync without delivering Hermes twice', async () => {
    const value = ports(true); const command = {actorId: 'actor', projectId: 'project', projectItemId: 'item', executor: {kind: 'hermes'} as const};
    await expect(assignTaskExecutor(command, value.value)).resolves.toMatchObject({status: 'status_sync_failed', deliveryReference: 'hermes:receipt'});
    await expect(assignTaskExecutor(command, value.value)).resolves.toMatchObject({status: 'duplicate', deliveryReference: 'hermes:receipt'});
    expect(value.delivery).toHaveBeenCalledTimes(1);
  });
});
