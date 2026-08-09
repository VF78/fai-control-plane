import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {
  CURRENT_POLICY_VERSION,
  DEFAULT_AGENT_INSTRUCTIONS,
  DEFAULT_AGENT_SETTINGS,
  createActorContextIssuer,
  createApprovalBinding,
  createTaskPacket,
  hashAgentProfileConfiguration,
  type AccessRequest,
  type ActorExternalIdentity,
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
  type ProjectMembership,
  type ResourceAccessGrant,
  type RetirableAgent,
  type RuntimeRegistration,
  type RuntimeRecoveryPolicy,
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
  readonly projectMemberships = new Map<string, ProjectMembership>();
  readonly actorExternalIdentities = new Map<string, ActorExternalIdentity>();
  readonly retirableAgents = new Map<string, RetirableAgent>();
  readonly resourceAccessGrants = new Map<string, ResourceAccessGrant>();
  readonly runtimeRegistrations = new Map<string, RuntimeRegistration>();
  readonly runtimeRecoveryPolicies = new Map<string, RuntimeRecoveryPolicy>();
  readonly receipts = new Map<string, CommandReceipt>();
  readonly audits: unknown[] = [];
  readonly mutations: unknown[] = [];
  executions = 0;
  failure: 'not_found' | 'version_conflict' | undefined;
  failCompletion = false;
  approvalCalls = 0;
  runtimeAvailable = true;
  accessAdmin = true;
  onboardingConflict: 'project_not_found' | 'duplicate' | null = null;
  projectSetupContext: {workspaceAdmin: boolean; slugExists: boolean; validProductOwner: boolean;
    validMembers: boolean; validAgentProfile: boolean} = {workspaceAdmin: true, slugExists: false, validProductOwner: true,
    validMembers: true, validAgentProfile: true};

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
          runtimeAvailable: this.runtimeAvailable
        };
      },
      loadAgentRun: async (_token, value) => this.agentRuns.get(value) ?? null,
      loadApproval: async (_token, value) => this.approvals.get(value) ?? null,
      loadAccessRequest: async (_token, value) => this.accessRequests.get(value) ?? null,
      loadProjectMembership: async (_token, value) =>
        this.projectMemberships.get(value) ?? null,
      loadActorOnboardingConflict: async () => this.onboardingConflict,
      loadActorExternalIdentity: async (_token, value) =>
        this.actorExternalIdentities.get(value) ?? null,
      loadRetirableAgent: async (_token, value) =>
        this.retirableAgents.get(value) ?? null,
      loadResourceAccessGrant: async (_token, value) =>
        this.resourceAccessGrants.get(value) ?? null,
      loadRuntimeRegistration: async (_token, value) =>
        this.runtimeRegistrations.get(value) ?? null,
      loadRuntimeRecoveryPolicy: async (_token, value) =>
        this.runtimeRecoveryPolicies.get(value) ?? null,
      loadAccessCommandAuthority: async () => ({
        workspaceAdmin: this.accessAdmin,
        projectRole: null
      }),
      loadProjectSetupContext: async () => this.projectSetupContext,
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
        if (mutation.aggregateType === 'project_membership') this.projectMemberships.set(mutation.aggregateId, mutation.aggregate);
        if (mutation.aggregateType === 'actor_external_identity') this.actorExternalIdentities.set(mutation.aggregateId, mutation.aggregate);
        if (mutation.aggregateType === 'actor') this.retirableAgents.set(mutation.aggregateId, mutation.aggregate);
        if (mutation.aggregateType === 'resource_access_grant') this.resourceAccessGrants.set(mutation.aggregateId, mutation.aggregate);
        if (mutation.aggregateType === 'runtime_registration') {
          this.runtimeRegistrations.set(mutation.aggregateId, mutation.aggregate);
          if (mutation.replacementTarget !== undefined) {
            this.runtimeRegistrations.set(
              mutation.replacementTarget.aggregate.id,
              mutation.replacementTarget.aggregate
            );
          }
        }
        if (mutation.aggregateType === 'runtime_recovery_policy') {
          this.runtimeRecoveryPolicies.set(mutation.aggregateId, mutation.aggregate);
        }
        return {status: 'persisted' as const, mutation: {cas: {expectedPersistedVersion: mutation.expectedPersistedVersion, persistedVersion: mutation.aggregateType === 'task_packet' || mutation.aggregateType === 'actor' ? 1 : mutation.aggregate.version}, audit: {} as never} as never};
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

describe('project intake canonical command', () => {
  const payload = () => ({
    projectId: id(), setupId: id(), name: 'Новый проект', slug: `project-${id().slice(0, 8)}`,
    productOwnerActorId: actorId, productOwnerMembershipId: id(), members: [],
    repositoryBinding: 'create_managed' as const, trackerBinding: 'link_existing' as const,
    internalChat: 'create_managed' as const, clientChat: 'none' as const,
    executionMode: 'manual' as const, agentProfileId: null
  });

  it('persists one pending provider-neutral setup aggregate and replays by idempotency key', async () => {
    const uow = new FakeUnitOfWork();
    const service = serviceFor(uow);
    const created = command('project.create', payload());
    const first = await service.execute(created);
    const second = await service.execute(created);
    expect(first.status).toBe('completed');
    expect(second.status).toBe('replayed');
    expect(uow.mutations).toHaveLength(1);
    expect(uow.mutations[0]).toMatchObject({mutation: {aggregateType: 'project_setup', aggregate: {
      state: 'pending', version: 1, configuration: {repositoryBinding: 'create_managed', agentProfileId: null}
    }}});
  });

  it('fails closed for duplicate slug and incompatible setup relationships', async () => {
    const duplicate = new FakeUnitOfWork();
    duplicate.projectSetupContext = {...duplicate.projectSetupContext, slugExists: true};
    const conflict = await serviceFor(duplicate).execute(command('project.create', payload()));
    expect(conflict).toMatchObject({receipt: {result: {ok: false, error: {code: 'VERSION_CONFLICT'}}}});
    expect(duplicate.mutations).toHaveLength(0);

    const invalid = new FakeUnitOfWork();
    invalid.projectSetupContext = {...invalid.projectSetupContext, validProductOwner: false};
    const rejected = await serviceFor(invalid).execute(command('project.create', payload()));
    expect(rejected).toMatchObject({receipt: {result: {ok: false, error: {code: 'INVALID_COMMAND'}}}});
    expect(invalid.mutations).toHaveLength(0);
  });

  it('rejects non-canonical member duplication and provider-shaped extra fields', async () => {
    const memberId = id();
    const base = payload();
    const duplicate = command('project.create', {
      ...base,
      members: [
        {membershipId: id(), actorId: memberId, role: 'contributor' as const},
        {membershipId: id(), actorId: memberId, role: 'reviewer' as const}
      ]
    });
    await expect(serviceFor(new FakeUnitOfWork()).execute(duplicate)).resolves.toMatchObject({
      status: 'rejected', error: {code: 'INVALID_COMMAND'}
    });
    const malformed = {...command('project.create', base), payload: {...base, providerId: 'github:secret'}} as never;
    await expect(serviceFor(new FakeUnitOfWork()).execute(malformed)).resolves.toMatchObject({
      status: 'rejected', error: {code: 'INVALID_COMMAND'}
    });
  });
});

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
      const agentProfileId = id();
      const profileBase = {
        id: agentProfileId,
        workspaceId,
        actorId,
        runtimeId: 'codex-cli',
        runtimeProfile: 'test',
        allowedTools: ['test'],
        forbiddenSurfaces: ['production'],
        instructions: 'Execute only the confirmed test packet.',
        settings: {resultFormat: 'structured_v1' as const, includeEvidence: true},
        enabled: true,
        version: 1
      };
      uow.agentProfiles.set(agentProfileId, {
        ...profileBase,
        configHash: hashAgentProfileConfiguration(profileBase)
      });
      return command('agent_run.queue', {
        agentRunId: id(),
        taskPacketId: packetId,
        agentProfileId,
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

  it('cancels only a queued agent run before claim and replays the same command', async () => {
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
    const uow = new FakeUnitOfWork();
    uow.agentRuns.set(run.id, {aggregate: run, projectId});
    const cancellation = command('agent_run.transition', {
      agentRunId: run.id,
      status: 'failed',
      expectedVersion: 1,
      failureCode: 'operator_cancelled_before_claim'
    });

    const completed = await serviceFor(uow).execute(cancellation);
    const replayed = await serviceFor(uow).execute(cancellation);

    expect(completed).toMatchObject({
      status: 'completed',
      receipt: {
        result: {
          ok: true,
          value: {
            status: 'failed',
            failureCode: 'operator_cancelled_before_claim',
            version: 2
          }
        }
      }
    });
    expect(replayed.status).toBe('replayed');
    expect(uow.agentRuns.get(run.id)?.aggregate).toMatchObject({
      status: 'failed',
      failureCode: 'operator_cancelled_before_claim',
      version: 2
    });
    expect(uow.mutations).toHaveLength(1);

    for (const status of ['running', 'done', 'failed'] as const) {
      const protectedRun = {...run, id: id(), status};
      const protectedUow = new FakeUnitOfWork();
      protectedUow.agentRuns.set(protectedRun.id, {aggregate: protectedRun, projectId});
      const result = await serviceFor(protectedUow).execute(command('agent_run.transition', {
        agentRunId: protectedRun.id,
        status: 'failed',
        expectedVersion: 1,
        failureCode: 'operator_cancelled_before_claim'
      }));
      expect(result).toMatchObject({
        receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}
      });
      expect(protectedUow.agentRuns.get(protectedRun.id)?.aggregate.status).toBe(status);
      expect(protectedUow.mutations).toHaveLength(0);
    }
  });

  it('recovers only an exact enabled registration binding for a running agent run', async () => {
    const subjectActorId = id();
    const profileId = id();
    const registrationId = id();
    const run = {
      id: id(),
      taskPacketId: id(),
      agentProfileId: profileId,
      confirmedPacketHash: 'a'.repeat(64),
      baseCommit: 'a'.repeat(40),
      status: 'running' as const,
      idempotencyKey: 'run',
      version: 3
    };
    const uow = new FakeUnitOfWork();
    uow.agentRuns.set(run.id, {aggregate: run, projectId});
    uow.runtimeRegistrations.set(registrationId, {
      id: registrationId,
      projectId,
      actorId: subjectActorId,
      agentProfileId: profileId,
      provider: 'provider_neutral',
      runtimeKey: 'runtime',
      enabled: true,
      version: 2
    });
    const recovery = command('agent_run.transition', {
      agentRunId: run.id,
      status: 'failed',
      expectedVersion: 3,
      failureCode: 'operator_recovered_expired_lease',
      registrationId,
      expectedRegistrationVersion: 2,
      expectedProjectId: projectId,
      expectedActorId: subjectActorId,
      expectedAgentProfileId: profileId
    });

    await expect(serviceFor(uow).execute(recovery)).resolves.toMatchObject({
      receipt: {
        result: {
          ok: true,
          value: {
            status: 'failed',
            failureCode: 'operator_recovered_expired_lease',
            version: 4
          }
        }
      }
    });
    expect(uow.mutations).toHaveLength(1);
    expect(uow.mutations[0]).toMatchObject({
      mutation: {
        recoveryBinding: {
          registrationId,
          registrationVersion: 2,
          projectId,
          actorId: subjectActorId,
          agentProfileId: profileId
        }
      }
    });

    const staleBinding = new FakeUnitOfWork();
    staleBinding.agentRuns.set(run.id, {aggregate: run, projectId});
    staleBinding.runtimeRegistrations.set(registrationId, {
      ...uow.runtimeRegistrations.get(registrationId)!,
      enabled: false
    });
    await expect(serviceFor(staleBinding).execute({
      ...recovery,
      commandId: id(),
      idempotencyKey: `key-${id()}`
    })).resolves.toMatchObject({
      receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}
    });
    expect(staleBinding.mutations).toHaveLength(0);

    const unauthorized = new FakeUnitOfWork();
    unauthorized.accessAdmin = false;
    unauthorized.agentRuns.set(run.id, {aggregate: run, projectId});
    unauthorized.runtimeRegistrations.set(
      registrationId,
      uow.runtimeRegistrations.get(registrationId)!
    );
    await expect(serviceFor(unauthorized).execute({
      ...recovery,
      commandId: id(),
      idempotencyKey: `key-${id()}`
    })).resolves.toMatchObject({
      receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}
    });
    expect(unauthorized.mutations).toHaveLength(0);
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
      instructions: DEFAULT_AGENT_INSTRUCTIONS,
      settings: DEFAULT_AGENT_SETTINGS,
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
    })).toMatchObject({ok: false, error: {code: 'SECRET_VALUE_FORBIDDEN'}});
    uow.taskPackets.set(packet.value.packetId, packet.value);
    uow.runtimeAvailable = false;
    await expect(service.execute(command('agent_run.queue', {
      agentRunId: id(),
      taskPacketId: packet.value.packetId,
      agentProfileId: frozenProfile.id,
      confirmedPacketHash: packet.value.contentHash,
      baseCommit: 'a'.repeat(40)
    }))).resolves.toMatchObject({receipt: {result: {error: {code: 'POLICY_DENIED'}}}});
    uow.runtimeAvailable = true;
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
      settings: DEFAULT_AGENT_SETTINGS,
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

  it('governs access aggregates with owner authority, CAS, audit, and observations', async () => {
    const uow = new FakeUnitOfWork();
    const service = serviceFor(uow);
    const subjectActorId = id();
    const membershipId = id();
    const grantId = id();
    const resourceId = id();

    await expect(service.execute(command('project_membership.set', {
      membershipId,
      projectId,
      subjectActorId,
      role: 'agent',
      active: true,
      expectedVersion: null
    }))).resolves.toMatchObject({
      status: 'completed',
      receipt: {result: {ok: true, value: {id: membershipId, version: 1}}}
    });
    await expect(service.execute(command('resource_access_grant.set', {
      grantId,
      projectId,
      subjectActorId,
      resourceType: 'repository',
      resourceId,
      desiredLevel: 'write',
      expectedVersion: null
    }))).resolves.toMatchObject({
      receipt: {result: {ok: true, value: {id: grantId, version: 1}}}
    });
    await expect(service.execute(command('resource_access_grant.observe', {
      grantId,
      provider: 'github',
      externalResourceRef: 'github:repository:123',
      confirmedLevel: 'read',
      observedAt: '2026-07-29T10:00:00.000Z',
      expectedVersion: 1
    }))).resolves.toMatchObject({
      receipt: {result: {ok: true, value: {id: grantId, version: 2}}}
    });
    expect(uow.resourceAccessGrants.get(grantId)).toMatchObject({
      desiredLevel: 'write',
      providerObservation: {
        provider: 'github',
        confirmedLevel: 'read'
      },
      version: 2
    });
    expect(uow.mutations).toHaveLength(3);
  });

  it('denies access commands by default without owner authority', async () => {
    const uow = new FakeUnitOfWork();
    uow.accessAdmin = false;
    await expect(serviceFor(uow).execute(command('project_membership.set', {
      membershipId: id(),
      projectId,
      subjectActorId: id(),
      role: 'contributor',
      active: true,
      expectedVersion: null
    }))).resolves.toMatchObject({
      receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}
    });
    expect(uow.mutations).toHaveLength(0);
  });

  it('creates, updates, disables, and idempotently receipts a scoped runtime registration', async () => {
    const uow = new FakeUnitOfWork();
    const service = serviceFor(uow);
    const registrationId = id();
    const subjectActorId = id();
    const agentProfileId = id();
    const create = command('runtime_registration.create', {
      registrationId,
      projectId,
      subjectActorId,
      agentProfileId,
      provider: 'codex',
      runtimeKey: 'workstation:primary',
      enabled: true
    });

    await expect(service.execute(create)).resolves.toMatchObject({
      status: 'completed',
      receipt: {result: {ok: true, value: {id: registrationId, enabled: true, version: 1}}}
    });
    await expect(service.execute(create)).resolves.toMatchObject({
      status: 'replayed',
      receipt: {result: {ok: true, value: {version: 1}}}
    });
    await expect(service.execute(command('runtime_registration.update', {
      registrationId,
      provider: 'codex',
      runtimeKey: 'workstation:replacement',
      enabled: true,
      expectedVersion: 1
    }))).resolves.toMatchObject({
      receipt: {result: {ok: true, value: {enabled: true, version: 2}}}
    });
    await expect(service.execute(command('runtime_registration.disable', {
      registrationId,
      expectedVersion: 1
    }))).resolves.toMatchObject({
      receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}
    });
    await expect(service.execute(command('runtime_registration.disable', {
      registrationId,
      expectedVersion: 2
    }))).resolves.toMatchObject({
      receipt: {result: {ok: true, value: {enabled: false, version: 3}}}
    });
    expect(uow.runtimeRegistrations.get(registrationId)).toMatchObject({
      projectId,
      actorId: subjectActorId,
      agentProfileId,
      provider: 'codex',
      runtimeKey: 'workstation:replacement',
      enabled: false,
      version: 3
    });
    expect(uow.mutations).toHaveLength(3);
  });

  it('replaces runtime registrations with one canonical mutation and receipt', async () => {
    const uow = new FakeUnitOfWork();
    const source = {
      id: id(),
      projectId,
      actorId: id(),
      agentProfileId: id(),
      provider: 'provider_neutral',
      runtimeKey: 'source-runtime',
      enabled: true,
      version: 2
    };
    const target = {
      ...source,
      id: id(),
      actorId: id(),
      agentProfileId: id(),
      runtimeKey: 'target-runtime',
      enabled: false,
      version: 4
    };
    uow.runtimeRegistrations.set(source.id, source);
    uow.runtimeRegistrations.set(target.id, target);
    const replacement = command('runtime_registration.replace', {
      projectId,
      sourceRegistrationId: source.id,
      sourceExpectedVersion: 2,
      targetRegistrationId: target.id,
      targetExpectedVersion: 4
    });

    await expect(serviceFor(uow).execute(replacement)).resolves.toMatchObject({
      status: 'completed',
      receipt: {
        result: {
          ok: true,
          value: {
            source: {id: source.id, enabled: false, version: 3},
            target: {id: target.id, enabled: true, version: 5}
          }
        }
      }
    });
    await expect(serviceFor(uow).execute(replacement)).resolves.toMatchObject({
      status: 'replayed'
    });
    expect(uow.runtimeRegistrations.get(source.id)).toMatchObject({
      enabled: false,
      version: 3
    });
    expect(uow.runtimeRegistrations.get(target.id)).toMatchObject({
      enabled: true,
      version: 5
    });
    expect(uow.mutations).toHaveLength(1);
    expect(uow.mutations[0]).toMatchObject({
      mutation: {
        aggregateId: source.id,
        replacementTarget: {
          expectedPersistedVersion: 4,
          aggregate: {id: target.id}
        }
      },
      audit: {action: 'runtime_registration.replace'}
    });

    const stale = new FakeUnitOfWork();
    stale.runtimeRegistrations.set(source.id, source);
    stale.runtimeRegistrations.set(target.id, target);
    await expect(serviceFor(stale).execute(command(
      'runtime_registration.replace',
      {...replacement.payload, targetExpectedVersion: 3}
    ))).resolves.toMatchObject({
      receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}
    });
    expect(stale.runtimeRegistrations.get(source.id)).toEqual(source);
    expect(stale.runtimeRegistrations.get(target.id)).toEqual(target);
    expect(stale.mutations).toHaveLength(0);

    const denied = new FakeUnitOfWork();
    denied.accessAdmin = false;
    denied.runtimeRegistrations.set(source.id, source);
    denied.runtimeRegistrations.set(target.id, target);
    await expect(serviceFor(denied).execute(command(
      'runtime_registration.replace',
      replacement.payload
    ))).resolves.toMatchObject({
      receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}
    });
    expect(denied.mutations).toHaveLength(0);
  });

  it('denies runtime registration without access-owner authority', async () => {
    const uow = new FakeUnitOfWork();
    uow.accessAdmin = false;
    await expect(serviceFor(uow).execute(command('runtime_registration.create', {
      registrationId: id(),
      projectId,
      subjectActorId: id(),
      agentProfileId: id(),
      provider: 'hermes',
      runtimeKey: 'hermes:primary',
      enabled: true
    }))).resolves.toMatchObject({
      receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}
    });
    expect(uow.runtimeRegistrations.size).toBe(0);
  });

  it('soft-retires an agent once, replays the same command, and rejects a new attempt', async () => {
    const uow = new FakeUnitOfWork();
    const agentId = id();
    uow.retirableAgents.set(agentId, {id: agentId, workspaceId, disabledAt: null});
    const retire = command('actor.retire', {agentId});
    const service = serviceFor(uow);

    await expect(service.execute(retire)).resolves.toMatchObject({
      status: 'completed',
      receipt: {
        aggregateType: 'actor',
        aggregateId: agentId,
        expectedVersion: 0,
        resultVersion: 1,
        result: {ok: true, value: {id: agentId, disabledAt: fixedClock.now().toISOString()}}
      }
    });
    await expect(service.execute(retire)).resolves.toMatchObject({status: 'replayed'});
    await expect(service.execute(command('actor.retire', {agentId}))).resolves.toMatchObject({
      status: 'completed',
      receipt: {result: {error: {code: 'VERSION_CONFLICT', message: 'Agent is already retired.'}}}
    });
    expect(uow.mutations).toHaveLength(1);
    expect(uow.mutations[0]).toMatchObject({
      mutation: {aggregateType: 'actor', aggregateId: agentId, expectedPersistedVersion: 0},
      audit: {action: 'actor.retire', actionCategory: 'access_change'}
    });
  });

  it('denies agent retirement without owner authority', async () => {
    const uow = new FakeUnitOfWork();
    uow.accessAdmin = false;
    const agentId = id();
    uow.retirableAgents.set(agentId, {id: agentId, workspaceId, disabledAt: null});
    await expect(serviceFor(uow).execute(command('actor.retire', {agentId}))).resolves.toMatchObject({
      receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}
    });
    expect(uow.retirableAgents.get(agentId)?.disabledAt).toBeNull();
    expect(uow.mutations).toHaveLength(0);
  });

  it('authorizes and atomically describes agent onboarding with replay and duplicate denial', async () => {
    const uow = new FakeUnitOfWork();
    const payload = {
      actorId: id(), membershipId: id(), projectId, actorType: 'agent' as const,
      displayName: 'Codex QA', actorRole: 'agent_operator' as const,
      membershipRole: 'agent' as const,
      agentProfile: {
        profileId: id(), registrationId: id(), runtimeId: 'codex',
        runtimeProfile: 'read_safe', runtimeKey: 'codex-qa',
        configHash: hashAgentProfileConfiguration({
          runtimeId: 'codex', runtimeProfile: 'read_safe', allowedTools: [], forbiddenSurfaces: [],
          instructions: DEFAULT_AGENT_INSTRUCTIONS, settings: DEFAULT_AGENT_SETTINGS,
          enabled: true, version: 1
        })
      }
    };
    const onboard = command('actor.onboard', payload);
    const service = serviceFor(uow);
    await expect(service.execute(onboard)).resolves.toMatchObject({
      status: 'completed', receipt: {aggregateType: 'actor_onboarding', resultVersion: 1, result: {ok: true}}
    });
    await expect(service.execute(onboard)).resolves.toMatchObject({status: 'replayed'});
    expect(uow.mutations).toHaveLength(1);
    expect(uow.mutations[0]).toMatchObject({mutation: {aggregate: {
      actorType: 'agent', membership: {role: 'agent'},
      agentProfile: {
        configHash: payload.agentProfile.configHash,
        registration: {provider: 'provider_neutral'}
      }
    }}});

    const duplicate = new FakeUnitOfWork();
    duplicate.onboardingConflict = 'duplicate';
    await expect(serviceFor(duplicate).execute(command('actor.onboard', {...payload, actorId: id()})))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
    duplicate.accessAdmin = false;
    duplicate.onboardingConflict = null;
    await expect(serviceFor(duplicate).execute(command('actor.onboard', {...payload, actorId: id()})))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}});
    expect(duplicate.mutations).toHaveLength(0);
  });

  it.each([
    ['runtime id over 128', {runtimeId: 'r'.repeat(129)}],
    ['runtime profile over 128', {runtimeProfile: 'p'.repeat(129)}],
    ['runtime key over 256', {runtimeKey: 'k'.repeat(257)}],
    ['secret-like runtime key', {runtimeKey: `github_pat_${'a'.repeat(24)}`}],
    ['non-canonical runtime key', {runtimeKey: 'codex qa'}]
  ])('rejects onboarding with %s at the canonical boundary', async (_label, runtimeOverride) => {
    const profile = {runtimeId: 'codex', runtimeProfile: 'read_safe', runtimeKey: 'codex-qa', ...runtimeOverride};
    const configHash = hashAgentProfileConfiguration({
      runtimeId: profile.runtimeId, runtimeProfile: profile.runtimeProfile,
      allowedTools: [], forbiddenSurfaces: [], instructions: DEFAULT_AGENT_INSTRUCTIONS,
      settings: DEFAULT_AGENT_SETTINGS, enabled: true, version: 1
    });
    const uow = new FakeUnitOfWork();
    await expect(serviceFor(uow).execute(command('actor.onboard', {
      actorId: id(), membershipId: id(), projectId, actorType: 'agent',
      displayName: 'Bounded agent', actorRole: 'agent_operator', membershipRole: 'agent',
      agentProfile: {profileId: id(), registrationId: id(), ...profile, configHash}
    }))).resolves.toMatchObject({status: 'rejected'});
    expect(uow.executions).toBe(0);
    expect(uow.mutations).toHaveLength(0);
  });

  it('rejects an onboarding profile hash that omits the initial version', async () => {
    const uow = new FakeUnitOfWork();
    await expect(serviceFor(uow).execute(command('actor.onboard', {
      actorId: id(), membershipId: id(), projectId, actorType: 'agent',
      displayName: 'Unversioned hash', actorRole: 'agent_operator', membershipRole: 'agent',
      agentProfile: {
        profileId: id(), registrationId: id(), runtimeId: 'codex',
        runtimeProfile: 'read_safe', runtimeKey: 'codex-unversioned',
        configHash: 'a'.repeat(64)
      }
    }))).resolves.toMatchObject({status: 'rejected'});
    expect(uow.executions).toBe(0);
  });

  it('accepts a fresh trusted-system observation once and rejects stale evidence', async () => {
    const systemActorId = id();
    const issuer = createActorContextIssuer({
      users: [], agents: [], systems: [{
        actorId: systemActorId,
        capabilities: ['write:runtime_observation:development']
      }]
    });
    if (!issuer.ok) throw new Error('System issuer did not initialize.');
    const systemActor = issuer.value.issueSystem(systemActorId);
    if (!systemActor.ok) throw new Error('System actor did not initialize.');
    const registration: RuntimeRegistration = {
      id: id(), projectId, actorId, agentProfileId: id(), provider: 'provider_neutral',
      runtimeKey: 'runtime-1', enabled: true, version: 1
    };
    const uow = new FakeUnitOfWork();
    uow.runtimeRegistrations.set(registration.id, registration);
    const observe = {
      commandId: id(), workspaceId, correlationId: id(), idempotencyKey: `observe-${id()}`,
      issuedAt: '2026-07-25T12:00:00.000Z', actor: systemActor.value,
      type: 'runtime_availability.observe' as const,
      payload: {
        observationId: id(), registrationId: registration.id, component: 'service' as const,
        state: 'available' as const, observedAt: '2026-07-25T11:59:30.000Z',
        ttlSeconds: 60, evidenceReference: 'probe:service:ok'
      }
    };
    const service = serviceFor(uow);
    await expect(service.execute(observe)).resolves.toMatchObject({
      status: 'completed', receipt: {result: {ok: true}}
    });
    await expect(service.execute(observe)).resolves.toMatchObject({status: 'replayed'});
    expect(uow.mutations).toHaveLength(1);
    const trustedHumanId = id();
    const trustedHumanIssuer = createActorContextIssuer({
      users: [{actorId: trustedHumanId, capabilities: ['write:runtime_observation:development']}],
      agents: [], systems: []
    });
    if (!trustedHumanIssuer.ok) throw new Error('Trusted human issuer did not initialize.');
    const trustedHuman = trustedHumanIssuer.value.issueUser(trustedHumanId);
    if (!trustedHuman.ok) throw new Error('Trusted human did not initialize.');
    await expect(service.execute({
      ...observe, commandId: id(), idempotencyKey: `human-${id()}`, actor: trustedHuman.value,
      payload: {...observe.payload, observationId: id()}
    })).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_ACTOR_CONTEXT'}}}});
    await expect(service.execute({
      ...observe, commandId: id(), idempotencyKey: `stale-${id()}`,
      payload: {...observe.payload, observationId: id(), observedAt: '2026-07-25T11:58:59.000Z'}
    })).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_COMMAND'}}}});
    expect(uow.mutations).toHaveLength(1);
  });

  it('sets one versioned recovery policy without executing a recovery action', async () => {
    const registration: RuntimeRegistration = {
      id: id(), projectId, actorId, agentProfileId: id(), provider: 'provider_neutral',
      runtimeKey: 'runtime-1', enabled: true, version: 1
    };
    const uow = new FakeUnitOfWork();
    uow.runtimeRegistrations.set(registration.id, registration);
    const service = serviceFor(uow);
    await expect(service.execute(command('runtime_registration.recovery_policy.set', {
      registrationId: registration.id,
      enabled: true,
      staleThresholdSeconds: 900,
      maximumAttempts: 2,
      expectedVersion: null
    }))).resolves.toMatchObject({receipt: {result: {ok: true, value: {
      enabled: true, staleThresholdSeconds: 900, maximumAttempts: 2, version: 1
    }}}});
    expect(uow.agentRuns.size).toBe(0);
    await expect(service.execute(command('runtime_registration.recovery_policy.set', {
      registrationId: registration.id,
      enabled: true,
      staleThresholdSeconds: 900,
      maximumAttempts: 3,
      expectedVersion: null
    }))).resolves.toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
  });
});
