import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {
  CURRENT_POLICY_VERSION,
  DEFAULT_HERMES_INSTRUCTIONS,
  DEFAULT_HERMES_SETTINGS,
  createActorContextIssuer,
  createApprovalBinding,
  createTaskPacket,
  hashAgentProfileConfiguration,
  type AccessRequest,
  type AgentProfileConfiguration,
  type AgentRunView,
  type Approval,
  type CanonicalCommand,
  type CanonicalCommandTransaction,
  type CommandReceipt,
  type CommandReceiptClaim,
  type CommandExecutionResult,
  type CompletedCanonicalCommand,
  type ReceiptClaimToken,
  type TaskPacket,
  type UnitOfWork,
  type WorkItem
} from '@fai-control-plane/domain';
import {
  createCanonicalCommandService,
  hashCanonicalCommandRequest,
  type Clock,
  type IdGenerator
} from './index';

const id = (): string => randomUUID();
const fixedClock: Clock = {now: () => new Date('2026-07-25T12:00:00.000Z')};
const fixedIds: IdGenerator = {next: () => id()};
const actorId = id();
const workspaceId = id();
const projectId = id();
const issuerResult = createActorContextIssuer({
  users: [{actorId, capabilities: ['write:control_plane:development', 'deploy:runner:development']}],
  agents: [], systems: []
});
if (!issuerResult.ok) throw new Error('Test actor issuer did not initialize.');
const actor = issuerResult.value.issueUser(actorId);
if (!actor.ok) throw new Error('Test actor did not initialize.');

const approvalBindingRequest = (
  overrides: Partial<Extract<CanonicalCommand, {type: 'approval.request'}>['payload']['binding']> = {}
) => ({
  subjectHash: 'a'.repeat(64),
  expectedPolicyVersion: CURRENT_POLICY_VERSION,
  executionIdentity: id(),
  expiresAt: '2026-07-25T13:00:00.000Z',
  ...overrides
});

const approvalFixture = (status: Approval['status']): Approval => {
  const workItemId = id();
  const action = {actionCategory: 'deploy', surface: 'runner', environment: 'development'} as const;
  const binding = createApprovalBinding(
    action,
    {workItemId},
    approvalBindingRequest(),
    actorId,
    new Date('2026-07-25T11:00:00.000Z')
  );
  if (!binding.ok) throw new Error('Test approval binding did not initialize.');
  return {
    id: id(), projectId, workItemId, ...action, requestedByActorId: actorId,
    binding: binding.value, status, version: 1
  };
};

const approvalDecision = (approval: Approval, status: 'approved' | 'rejected') => ({
  approvalId: approval.id,
  status,
  expectedVersion: approval.version,
  expectedActionHash: approval.binding.actionHash,
  expectedPolicyVersion: approval.binding.policyVersion
});

const packetContent = () => ({
  projectId,
  workItemId: id(),
  workItemVersion: 1,
  goal: 'Test packet',
  acceptanceCriteria: ['works'],
  inScope: ['packages/application/**'],
  outOfScope: ['apps/**'],
  relevantLinks: [],
  relevantFiles: ['packages/application/src/index.ts'],
  allowedTools: ['pnpm test'],
  forbiddenSurfaces: ['production'],
  dataPolicy: {},
  timeboxMinutes: 10,
  expectedOutputSchema: {},
  reviewerActorId: actorId,
  approverActorId: actorId,
  runtimeProfile: 'test',
  authMode: 'user' as const,
  secretsRef: null,
  createdFromEventId: id(),
  createdByActorId: actorId
});

const command = <T extends CanonicalCommand['type']>(type: T, payload: Extract<CanonicalCommand, {type: T}>['payload']) => ({
  commandId: id(), workspaceId, correlationId: id(), idempotencyKey: `key-${id()}`,
  issuedAt: '2026-07-25T11:00:00.000Z', actor: actor.value, type, payload
}) as Extract<CanonicalCommand, {type: T}>;

class FakeUnitOfWork implements UnitOfWork {
  readonly workItems = new Map<string, WorkItem>();
  readonly agentProfiles = new Map<string, AgentProfileConfiguration>();
  readonly taskPackets = new Map<string, TaskPacket>();
  readonly agentRuns = new Map<string, AgentRunView>();
  readonly approvals = new Map<string, Approval>();
  readonly accessRequests = new Map<string, AccessRequest>();
  readonly receipts = new Map<string, CommandReceipt>();
  readonly audits: unknown[] = [];
  readonly mutations: unknown[] = [];
  executions = 0;
  failure: 'not_found' | 'version_conflict' | undefined;
  failCompletion = false;
  approvalCalls = 0;
  hermesRunnerEnabled = true;

  async executeCommand<T>(claim: CommandReceiptClaim, work: (
    transaction: CanonicalCommandTransaction, claimToken: ReceiptClaimToken
  ) => Promise<CompletedCanonicalCommand<T>>): Promise<CommandExecutionResult<T>> {
    this.executions += 1;
    const existing = this.receipts.get(`${claim.workspaceId}:${claim.idempotencyKey}`);
    if (existing !== undefined) return existing.requestHash === claim.requestHash
      ? {status: 'replayed', receipt: existing}
      : {status: 'key_reused', existingRequestHash: existing.requestHash};
    const workItems = new Map(this.workItems);
    const agentProfiles = new Map(this.agentProfiles);
    const taskPackets = new Map(this.taskPackets);
    const agentRuns = new Map(this.agentRuns);
    const approvals = new Map(this.approvals);
    const accessRequests = new Map(this.accessRequests);
    let completedReceipt: CommandReceipt | undefined;
    const token = {} as ReceiptClaimToken;
    const transaction: CanonicalCommandTransaction = {
      loadWorkItem: async (_token, value) => this.workItems.get(value) ?? null,
      loadAgentProfile: async (_token, value) => this.agentProfiles.get(value) ?? null,
      loadTaskPacket: async (_token, value) => {
        const packet = this.taskPackets.get(value);
        return packet === undefined ? null : {
          packetId: packet.packetId,
          content: {
            approverActorId: packet.content.approverActorId,
            agentProfileSnapshot: packet.content.agentProfileSnapshot ?? null
          },
          contentHash: packet.contentHash,
          hermesRunnerEnabled: this.hermesRunnerEnabled
        };
      },
      loadAgentRun: async (_token, value) => this.agentRuns.get(value) ?? null,
      loadApproval: async (_token, value) => this.approvals.get(value) ?? null,
      loadAccessRequest: async (_token, value) => this.accessRequests.get(value) ?? null,
      persistAuditedMutation: async ({outcome}) => {
        this.mutations.push(outcome);
        if (this.failure === 'not_found') return {status: 'not_found'} as const;
        if (this.failure === 'version_conflict') return {status: 'version_conflict' as const, expectedPersistedVersion: 1, persistedVersion: 2};
        const mutation = outcome.mutation;
        if (mutation.aggregateType === 'work_item') this.workItems.set(mutation.aggregateId, mutation.aggregate);
        if (mutation.aggregateType === 'agent_profile') this.agentProfiles.set(mutation.aggregateId, mutation.aggregate);
        if (mutation.aggregateType === 'task_packet') this.taskPackets.set(mutation.aggregateId, mutation.aggregate);
        if (mutation.aggregateType === 'agent_run') this.agentRuns.set(mutation.aggregateId, {aggregate: mutation.aggregate, projectId});
        if (mutation.aggregateType === 'approval') this.approvals.set(mutation.aggregateId, mutation.aggregate);
        if (mutation.aggregateType === 'access_request') this.accessRequests.set(mutation.aggregateId, mutation.aggregate);
        return {status: 'persisted' as const, mutation: {cas: {expectedPersistedVersion: mutation.expectedPersistedVersion, persistedVersion: mutation.aggregateType === 'task_packet' ? 1 : mutation.aggregate.version}, audit: {} as never} as never};
      },
      persistApprovalRequired: async ({outcome}) => {
        this.approvalCalls += 1;
        this.approvals.set(outcome.approval.aggregateId, outcome.approval.aggregate);
        this.audits.push(outcome.audit);
        completedReceipt = outcome.receipt;
        return {status: 'completed' as const, command: {kind: 'approval_required' as const, approval: {expectedPersistedVersion: null, persistedVersion: 1}, audit: {} as never, receipt: {} as never, commandReceipt: outcome.receipt} as never};
      },
      completeReceipt: async ({receipt}) => {
        if (this.failCompletion) throw new Error('completion failed');
        completedReceipt = receipt;
        return {cas: {expectedPersistedVersion: receipt.expectedVersion ?? null, persistedVersion: receipt.resultVersion!}, audit: {} as never, receipt: {} as never} as never;
      },
      completeAuditedReceipt: async ({audit, receipt}) => {
        this.audits.push(audit);
        completedReceipt = receipt;
        return {audit: {} as never, receipt: {} as never} as never;
      }
    };
    let result: CompletedCanonicalCommand<T>;
    try {
      result = await work(transaction, token);
    } catch (cause) {
      this.workItems.clear(); workItems.forEach((value, key) => this.workItems.set(key, value));
      this.agentProfiles.clear(); agentProfiles.forEach((value, key) => this.agentProfiles.set(key, value));
      this.taskPackets.clear(); taskPackets.forEach((value, key) => this.taskPackets.set(key, value));
      this.agentRuns.clear(); agentRuns.forEach((value, key) => this.agentRuns.set(key, value));
      this.approvals.clear(); approvals.forEach((value, key) => this.approvals.set(key, value));
      this.accessRequests.clear(); accessRequests.forEach((value, key) => this.accessRequests.set(key, value));
      throw cause;
    }
    if (completedReceipt === undefined) throw new Error('Command did not complete a receipt.');
    this.receipts.set(`${claim.workspaceId}:${claim.idempotencyKey}`, completedReceipt);
    return {status: 'completed', command: result};
  }
}

const serviceFor = (uow: FakeUnitOfWork, clock: Clock = fixedClock) =>
  createCanonicalCommandService({unitOfWork: uow, clock, idGenerator: fixedIds});
const item = (overrides: Partial<WorkItem> = {}): WorkItem => ({id: id(), projectId, status: 'ready', blocked: false, version: 1, ...overrides});

describe('canonical command service', () => {
  it('hashes key ordering deterministically and normalizes actor capabilities', () => {
    const workItemId = id();
    const first = command('work_item.transition', {workItemId, status: 'in_dev', expectedVersion: 1});
    const reordered = {...first, payload: {expectedVersion: 1, status: 'in_dev' as const, workItemId}};
    expect(hashCanonicalCommandRequest(first)).toBe(hashCanonicalCommandRequest(reordered));
    const secondIssuer = createActorContextIssuer({
      users: [{actorId, capabilities: ['deploy:runner:development', 'write:control_plane:development']}],
      agents: [], systems: []
    });
    if (!secondIssuer.ok) throw new Error('Second issuer did not initialize.');
    const secondActor = secondIssuer.value.issueUser(actorId);
    if (!secondActor.ok) throw new Error('Second actor did not initialize.');
    expect(hashCanonicalCommandRequest({...first, actor: secondActor.value})).toBe(hashCanonicalCommandRequest(first));
  });

  it.each([
    ['work_item.transition', (uow: FakeUnitOfWork) => {
      const aggregate = item(); uow.workItems.set(aggregate.id, aggregate);
      return command('work_item.transition', {workItemId: aggregate.id, status: 'in_dev', expectedVersion: 1});
    }],
    ['work_item.set_blocked', (uow: FakeUnitOfWork) => {
      const aggregate = item(); uow.workItems.set(aggregate.id, aggregate);
      return command('work_item.set_blocked', {workItemId: aggregate.id, blocked: true, expectedVersion: 1});
    }],
    ['task_packet.create', () => command('task_packet.create', {packetId: id(), content: packetContent()})],
    ['agent_run.queue', (uow: FakeUnitOfWork) => {
      const packetId = id();
      const packet = createTaskPacket(packetId, packetContent());
      if (!packet.ok) throw new Error('Test packet did not initialize.');
      uow.taskPackets.set(packetId, packet.value);
      return command('agent_run.queue', {
        agentRunId: id(),
        taskPacketId: packetId,
        agentProfileId: id(),
        confirmedPacketHash: packet.value.contentHash,
        baseCommit: 'a'.repeat(40)
      });
    }],
    ['agent_run.transition', (uow: FakeUnitOfWork) => {
      const aggregate = {
        id: id(),
        taskPacketId: id(),
        agentProfileId: id(),
        confirmedPacketHash: 'a'.repeat(64),
        baseCommit: 'a'.repeat(40),
        status: 'queued' as const,
        idempotencyKey: 'run',
        version: 1
      };
      uow.agentRuns.set(aggregate.id, {aggregate, projectId});
      return command('agent_run.transition', {agentRunId: aggregate.id, status: 'running', expectedVersion: 1});
    }],
    ['approval.request', (uow: FakeUnitOfWork) => {
      const aggregate = item(); uow.workItems.set(aggregate.id, aggregate);
      return command('approval.request', {approvalId: id(), action: {actionCategory: 'deploy', surface: 'runner', environment: 'development'}, target: {workItemId: aggregate.id}, binding: approvalBindingRequest()});
    }],
    ['approval.decide', (uow: FakeUnitOfWork) => {
      const approval = approvalFixture('pending');
      uow.approvals.set(approval.id, approval);
      return command('approval.decide', approvalDecision(approval, 'approved'));
    }],
    ['access_request.request', () => command('access_request.request', {requestId: id(), targetSurface: 'repository', requestedScope: ['read']})],
    ['access_request.decide', (uow: FakeUnitOfWork) => {
      const request: AccessRequest = {id: id(), workspaceId, requesterActorId: actorId, targetSurface: 'repository', requestedScope: ['read'], status: 'pending', version: 1};
      uow.accessRequests.set(request.id, request);
      return command('access_request.decide', {requestId: request.id, status: 'granted', expectedVersion: 1});
    }]
  ])('executes %s through an audited receipt', async (_name, make) => {
    const uow = new FakeUnitOfWork();
    const result = await serviceFor(uow).execute(make(uow));
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(JSON.stringify(result.receipt)).not.toContain('secretsRef');
    expect(result.receipt.result.ok).toBe(_name !== 'approval.request');
    if (_name === 'agent_run.queue') {
      const runCount = uow.agentRuns.size;
      const packet = [...uow.taskPackets.values()][0];
      if (packet === undefined) throw new Error('Test packet was not initialized.');
      const wrongApproverId = id();
      const agentId = id();
      const confirmationIssuer = createActorContextIssuer({
        users: [
          {actorId, capabilities: ['write:control_plane:development']},
          {actorId: wrongApproverId, capabilities: ['write:control_plane:development']}
        ],
        agents: [{
          actorId: agentId,
          delegatedByActorIds: [actorId],
          capabilities: ['write:control_plane:development']
        }],
        systems: []
      });
      if (!confirmationIssuer.ok) throw new Error('Confirmation actors did not initialize.');
      const wrongApprover = confirmationIssuer.value.issueUser(wrongApproverId);
      const confirmingUser = confirmationIssuer.value.issueUser(actorId);
      if (!wrongApprover.ok || !confirmingUser.ok) {
        throw new Error('Confirmation users did not initialize.');
      }
      const nonHuman = confirmationIssuer.value.issueAgent({
        actorId: agentId,
        delegatedBy: confirmingUser.value
      });
      if (!nonHuman.ok) throw new Error('Confirmation agent did not initialize.');
      const queuePayload = {
        taskPacketId: packet.packetId,
        agentProfileId: id(),
        confirmedPacketHash: packet.contentHash,
        baseCommit: 'a'.repeat(40)
      };
      const rejected = await Promise.all([
        serviceFor(uow).execute(command('agent_run.queue', {
          ...queuePayload,
          agentRunId: id(),
          confirmedPacketHash: '0'.repeat(64)
        })),
        serviceFor(uow).execute({
          ...command('agent_run.queue', {...queuePayload, agentRunId: id()}),
          actor: nonHuman.value
        }),
        serviceFor(uow).execute({
          ...command('agent_run.queue', {...queuePayload, agentRunId: id()}),
          actor: wrongApprover.value
        }),
        serviceFor(uow).execute(command('agent_run.queue', {
          ...queuePayload,
          agentRunId: id(),
          taskPacketId: id()
        }))
      ]);
      expect(rejected).toMatchObject([
        {receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}},
        {receipt: {result: {error: {code: 'POLICY_DENIED'}}}},
        {receipt: {result: {error: {code: 'INVALID_ACTOR_CONTEXT'}}}},
        {receipt: {result: {error: {code: 'NOT_FOUND'}}}}
      ]);
      expect(uow.agentRuns.size).toBe(runCount);
      expect(uow.audits).toHaveLength(4);
    }
  });

  it('persists an approval-required receipt atomically', async () => {
    const uow = new FakeUnitOfWork();
    const aggregate = item(); uow.workItems.set(aggregate.id, aggregate);
    const result = await serviceFor(uow).execute(command('approval.request', {
      approvalId: id(), action: {actionCategory: 'deploy', surface: 'runner', environment: 'development'}, target: {workItemId: aggregate.id}, binding: approvalBindingRequest()
    }));
    expect(result).toMatchObject({status: 'completed', receipt: {result: {ok: false, error: {code: 'APPROVAL_REQUIRED'}}}});
    expect(uow.approvalCalls).toBe(1);
  });

  it('approves only the exact current unexpired action binding', async () => {
    let now = new Date('2026-07-25T12:00:00.000Z');
    const clock: Clock = {now: () => new Date(now)};
    const uow = new FakeUnitOfWork();
    const aggregate = item();
    uow.workItems.set(aggregate.id, aggregate);
    const action = {actionCategory: 'deploy', surface: 'runner', environment: 'development'} as const;
    const target = {workItemId: aggregate.id} as const;
    const bindingRequest = approvalBindingRequest({expiresAt: '2026-07-25T12:30:00.000Z'});
    const service = serviceFor(uow, clock);

    const staleVersion = await service.execute(command('approval.request', {
      approvalId: id(), action, target,
      binding: {...bindingRequest, expectedPolicyVersion: CURRENT_POLICY_VERSION + 1}
    }));
    expect(staleVersion).toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});

    const approvalId = id();
    const requested = await service.execute(command('approval.request', {
      approvalId, action, target, binding: bindingRequest
    }));
    const pending = uow.approvals.get(approvalId);
    if (pending === undefined) throw new Error('Bound approval was not persisted.');
    expect(requested).toMatchObject({
      receipt: {result: {error: {approval: {binding: {actionHash: pending.binding.actionHash}}}}}
    });

    const materiallyChanged = createApprovalBinding(
      action,
      target,
      {...bindingRequest, subjectHash: 'b'.repeat(64)},
      actorId,
      now
    );
    if (!materiallyChanged.ok) throw new Error('Changed binding did not initialize.');
    const staleHash = await service.execute(command('approval.decide', {
      ...approvalDecision(pending, 'approved'),
      expectedActionHash: materiallyChanged.value.actionHash
    }));
    expect(staleHash).toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
    expect(uow.approvals.get(approvalId)?.status).toBe('pending');

    const delegatorId = id();
    const agentId = id();
    const systemId = id();
    const nonHumanIssuer = createActorContextIssuer({
      users: [{
        actorId: delegatorId,
        capabilities: ['write:control_plane:development', 'deploy:runner:development']
      }],
      agents: [{
        actorId: agentId,
        delegatedByActorIds: [delegatorId],
        capabilities: ['write:control_plane:development', 'deploy:runner:development']
      }],
      systems: [{
        actorId: systemId,
        capabilities: ['write:control_plane:development', 'deploy:runner:development']
      }]
    });
    if (!nonHumanIssuer.ok) throw new Error('Non-human actor issuer did not initialize.');
    const delegator = nonHumanIssuer.value.issueUser(delegatorId);
    if (!delegator.ok) throw new Error('Agent delegator did not initialize.');
    const agent = nonHumanIssuer.value.issueAgent({actorId: agentId, delegatedBy: delegator.value});
    const system = nonHumanIssuer.value.issueSystem(systemId);
    if (!agent.ok || !system.ok) throw new Error('Non-human actors did not initialize.');
    for (const nonHuman of [agent.value, system.value]) {
      const rejected = await service.execute({
        ...command('approval.decide', approvalDecision(pending, 'rejected')),
        actor: nonHuman
      });
      expect(rejected).toMatchObject({status: 'completed', receipt: {result: {ok: false}}});
      expect(uow.approvals.get(approvalId)?.status).toBe('pending');
    }

    const exactApprovalId = id();
    await service.execute(command('approval.request', {
      approvalId: exactApprovalId, action, target, binding: approvalBindingRequest({
        expiresAt: '2026-07-25T12:30:00.000Z'
      })
    }));
    const exactPending = uow.approvals.get(exactApprovalId);
    if (exactPending === undefined) throw new Error('Exact approval was not persisted.');
    const exact = await service.execute(command('approval.decide', approvalDecision(exactPending, 'approved')));
    expect(exact).toMatchObject({receipt: {result: {ok: true, value: {status: 'approved'}}}});

    now = new Date('2026-07-25T12:31:00.000Z');
    const expired = await service.execute(command('approval.decide', approvalDecision(pending, 'approved')));
    expect(expired).toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
    expect(uow.approvals.get(approvalId)?.status).toBe('pending');
  });

  it('records transition, authorization, no-op, conflict, and secret validation errors in receipts', async () => {
    const uow = new FakeUnitOfWork();
    const aggregate = item({status: 'done'}); uow.workItems.set(aggregate.id, aggregate);
    const invalidTransition = await serviceFor(uow).execute(command('work_item.transition', {workItemId: aggregate.id, status: 'ready', expectedVersion: 1}));
    expect(invalidTransition).toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
    const noOp = await serviceFor(uow).execute(command('work_item.set_blocked', {workItemId: aggregate.id, blocked: false, expectedVersion: 1}));
    expect(noOp).toMatchObject({receipt: {resultVersion: 1, result: {ok: true}}});
    const conflict = await serviceFor(uow).execute(command('work_item.set_blocked', {workItemId: aggregate.id, blocked: true, expectedVersion: 2}));
    expect(conflict).toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
    const secret = packetContent(); (secret as Record<string, unknown>).apiKey = 'never-return-this';
    const packet = await serviceFor(uow).execute(command('task_packet.create', {packetId: id(), content: secret}));
    expect(packet).toMatchObject({receipt: {result: {error: {code: 'SECRET_VALUE_FORBIDDEN'}}}});
    expect(JSON.stringify(packet)).not.toContain('never-return-this');
  });

  it('records invalid transitions for every transition aggregate and a CAS race', async () => {
    const uow = new FakeUnitOfWork();
    const run = {
      id: id(),
      taskPacketId: id(),
      agentProfileId: id(),
      confirmedPacketHash: 'a'.repeat(64),
      baseCommit: 'a'.repeat(40),
      status: 'queued' as const,
      idempotencyKey: 'run',
      version: 1
    };
    const approval = approvalFixture('approved');
    const request: AccessRequest = {id: id(), workspaceId, requesterActorId: actorId, targetSurface: 'repository', requestedScope: ['read'], status: 'granted', version: 1};
    uow.agentRuns.set(run.id, {aggregate: run, projectId}); uow.approvals.set(approval.id, approval); uow.accessRequests.set(request.id, request);
    await expect(serviceFor(uow).execute(command('agent_run.transition', {agentRunId: run.id, status: 'done', expectedVersion: 1})))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
    await expect(serviceFor(uow).execute(command('approval.decide', approvalDecision(approval, 'rejected'))))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
    await expect(serviceFor(uow).execute(command('access_request.decide', {requestId: request.id, status: 'rejected', expectedVersion: 1})))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
    const aggregate = item(); uow.workItems.set(aggregate.id, aggregate); uow.failure = 'version_conflict';
    await expect(serviceFor(uow).execute(command('work_item.set_blocked', {workItemId: aggregate.id, blocked: true, expectedVersion: 1})))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
  });

  it('does not create approvals for allowed actions and audits routine capability denial', async () => {
    const uow = new FakeUnitOfWork();
    const aggregate = item(); uow.workItems.set(aggregate.id, aggregate);
    const allowed = await serviceFor(uow).execute(command('approval.request', {
      approvalId: id(), action: {actionCategory: 'write', surface: 'control_plane', environment: 'development'}, target: {workItemId: aggregate.id}, binding: approvalBindingRequest()
    }));
    expect(allowed).toMatchObject({receipt: {result: {error: {code: 'INVALID_COMMAND'}}}});
    expect(uow.approvalCalls).toBe(0);
    const deniedActorId = id();
    const deniedIssuer = createActorContextIssuer({users: [{actorId: deniedActorId, capabilities: []}], agents: [], systems: []});
    if (!deniedIssuer.ok) throw new Error('Denied issuer did not initialize.');
    const deniedActor = deniedIssuer.value.issueUser(deniedActorId);
    if (!deniedActor.ok) throw new Error('Denied actor did not initialize.');
    const denied = await serviceFor(uow).execute({...command('work_item.set_blocked', {workItemId: aggregate.id, blocked: true, expectedVersion: 1}), actor: deniedActor.value});
    expect(denied).toMatchObject({receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}});
    const policyActorId = id();
    const policyIssuer = createActorContextIssuer({users: [{
      actorId: policyActorId,
      capabilities: ['write:control_plane:development', 'write:control_plane:production']
    }], agents: [], systems: []});
    if (!policyIssuer.ok) throw new Error('Policy issuer did not initialize.');
    const policyActor = policyIssuer.value.issueUser(policyActorId);
    if (!policyActor.ok) throw new Error('Policy actor did not initialize.');
    const policyDenied = await serviceFor(uow).execute({...command('approval.request', {
      approvalId: id(), action: {actionCategory: 'write', surface: 'control_plane', environment: 'production'}, target: {workItemId: aggregate.id}, binding: approvalBindingRequest()
    }), actor: policyActor.value});
    expect(policyDenied).toMatchObject({receipt: {result: {error: {code: 'POLICY_DENIED'}}}});
  });

  it('relies on the UoW transaction to roll back when receipt completion fails', async () => {
    const uow = new FakeUnitOfWork();
    const aggregate = item(); uow.workItems.set(aggregate.id, aggregate); uow.failCompletion = true;
    await expect(serviceFor(uow).execute(command('work_item.set_blocked', {workItemId: aggregate.id, blocked: true, expectedVersion: 1})))
      .rejects.toThrow('completion failed');
    expect(uow.workItems.get(aggregate.id)).toEqual(aggregate);
  });

  it('replays a matching key, rejects reuse, and rejects undefined or sparse payloads before UoW', async () => {
    const uow = new FakeUnitOfWork();
    const aggregate = item(); uow.workItems.set(aggregate.id, aggregate);
    const first = command('work_item.set_blocked', {workItemId: aggregate.id, blocked: true, expectedVersion: 1});
    const service = serviceFor(uow);
    await service.execute(first);
    const replay = await service.execute({...first, commandId: id(), correlationId: id(), issuedAt: '2026-07-25T13:00:00.000Z'});
    expect(replay.status).toBe('replayed');
    const reused = await service.execute({...first, payload: {...first.payload, blocked: false}});
    expect(reused).toMatchObject({status: 'key_reused', error: {code: 'IDEMPOTENCY_KEY_REUSED'}});
    const unsafe = {...first, idempotencyKey: `unsafe-${id()}`, payload: {...first.payload, blocked: undefined}};
    expect(await service.execute(unsafe as unknown as CanonicalCommand)).toMatchObject({status: 'rejected', error: {code: 'INVALID_COMMAND'}});
    const sparse = {...first, idempotencyKey: `sparse-${id()}`, payload: {packetId: id(), content: packetContent()}} as unknown as CanonicalCommand;
    (sparse.payload as unknown as {content: {acceptanceCriteria: string[]}}).content.acceptanceCriteria = new Array(1);
    expect(await service.execute(sparse)).toMatchObject({status: 'rejected', error: {code: 'INVALID_COMMAND'}});
  });

  it('rejects forged task packet provenance before claiming a receipt', async () => {
    const uow = new FakeUnitOfWork();
    const forged = packetContent();
    forged.createdByActorId = id();
    const result = await serviceFor(uow).execute(
      command('task_packet.create', {packetId: id(), content: forged})
    );

    expect(result).toMatchObject({
      status: 'rejected',
      error: {code: 'INVALID_COMMAND'}
    });
    expect(uow.executions).toBe(0);
    expect(uow.mutations).toHaveLength(0);
    expect(uow.audits).toHaveLength(0);
    expect(uow.receipts).toHaveLength(0);
  });

  it('updates Hermes with optimistic locking and freezes its exact config in a packet', async () => {
    const uow = new FakeUnitOfWork();
    const profileBase = {
      id: id(),
      workspaceId,
      actorId,
      runtimeId: 'hermes',
      runtimeProfile: 'read_safe',
      allowedTools: ['task_packet_read', 'artifact_write'],
      forbiddenSurfaces: ['external_message', 'github_write', 'production', 'deploy', 'merge'],
      instructions: DEFAULT_HERMES_INSTRUCTIONS,
      settings: DEFAULT_HERMES_SETTINGS,
      enabled: true,
      version: 1
    } as const;
    const profile: AgentProfileConfiguration = {
      ...profileBase,
      configHash: hashAgentProfileConfiguration(profileBase)
    };
    uow.agentProfiles.set(profile.id, profile);
    const service = serviceFor(uow);
    const firstInstructions = 'Act only from the packet and return structured evidence.';
    await expect(service.execute(command('agent_profile.update', {
      agentProfileId: profile.id,
      expectedVersion: 1,
      instructions: firstInstructions,
      settings: {resultFormat: 'structured_v1', includeEvidence: true},
      enabled: true
    }))).resolves.toMatchObject({receipt: {result: {ok: true}}});
    const frozenProfile = uow.agentProfiles.get(profile.id)!;
    const packet = createTaskPacket(id(), {
      ...packetContent(),
      runtimeProfile: 'read_safe',
      agentProfileSnapshot: {
        profileId: frozenProfile.id,
        runtimeId: 'hermes',
        runtimeProfile: 'read_safe',
        allowedTools: frozenProfile.allowedTools,
        forbiddenSurfaces: frozenProfile.forbiddenSurfaces,
        enabled: frozenProfile.enabled,
        configVersion: frozenProfile.version,
        configHash: frozenProfile.configHash,
        instructions: frozenProfile.instructions,
        settings: frozenProfile.settings
      }
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) throw new Error('Hermes packet did not initialize.');
    expect(createTaskPacket(id(), {
      ...packetContent(),
      runtimeProfile: 'read_safe',
      agentProfileSnapshot: {
        ...packet.value.content.agentProfileSnapshot!,
        configHash: '0'.repeat(64)
      }
    })).toMatchObject({ok: false, error: {code: 'INVALID_TASK_PACKET'}});
    expect(createTaskPacket(id(), {
      ...packetContent(),
      runtimeProfile: 'read_safe',
      agentProfileSnapshot: {
        ...packet.value.content.agentProfileSnapshot!,
        instructions: `Use github_pat_${'a'.repeat(24)}`
      }
    })).toMatchObject({ok: false, error: {code: 'INVALID_TASK_PACKET'}});
    uow.taskPackets.set(packet.value.packetId, packet.value);
    uow.hermesRunnerEnabled = false;
    await expect(service.execute(command('agent_run.queue', {
      agentRunId: id(),
      taskPacketId: packet.value.packetId,
      agentProfileId: frozenProfile.id,
      confirmedPacketHash: packet.value.contentHash,
      baseCommit: 'a'.repeat(40)
    }))).resolves.toMatchObject({receipt: {result: {error: {code: 'POLICY_DENIED'}}}});
    uow.hermesRunnerEnabled = true;
    await expect(service.execute(command('agent_run.queue', {
      agentRunId: id(),
      taskPacketId: packet.value.packetId,
      agentProfileId: id(),
      confirmedPacketHash: packet.value.contentHash,
      baseCommit: 'a'.repeat(40)
    }))).resolves.toMatchObject({receipt: {result: {error: {code: 'NOT_FOUND'}}}});
    await expect(service.execute(command('agent_profile.update', {
      agentProfileId: profile.id,
      expectedVersion: 1,
      instructions: 'Stale change.',
      settings: DEFAULT_HERMES_SETTINGS,
      enabled: true
    }))).resolves.toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
    await service.execute(command('agent_profile.update', {
      agentProfileId: profile.id,
      expectedVersion: 2,
      instructions: 'A later valid profile revision.',
      settings: {resultFormat: 'structured_v1', includeEvidence: false},
      enabled: true
    }));
    await expect(service.execute(command('agent_run.queue', {
      agentRunId: id(),
      taskPacketId: packet.value.packetId,
      agentProfileId: frozenProfile.id,
      confirmedPacketHash: packet.value.contentHash,
      baseCommit: 'a'.repeat(40)
    }))).resolves.toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
    expect(packet.value.content.agentProfileSnapshot).toEqual({
      profileId: frozenProfile.id,
      runtimeId: 'hermes',
      runtimeProfile: 'read_safe',
      allowedTools: frozenProfile.allowedTools,
      forbiddenSurfaces: frozenProfile.forbiddenSurfaces,
      enabled: true,
      configVersion: 2,
      configHash: frozenProfile.configHash,
      instructions: firstInstructions,
      settings: {resultFormat: 'structured_v1', includeEvidence: true}
    });
    expect(uow.agentProfiles.get(profile.id)?.version).toBe(3);
  });
});
