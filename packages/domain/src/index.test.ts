import {describe, expect, expectTypeOf, it} from 'vitest';
import {
  accessRequestStatuses,
  actionCategories,
  agentRunStatuses,
  approvalStatuses,
  authorize,
  createActorContextIssuer,
  createTaskPacket,
  effectiveCapabilities,
  isTrustedActorContext,
  policyDecisionFor,
  policySurfaces,
  providerEvidenceStates,
  setWorkItemBlocked,
  transitionAccessRequest,
  transitionAgentRun,
  transitionApproval,
  transitionWorkItem,
  type AccessRequestStatus,
  type AccessRequest,
  type AgentRun,
  type AgentRunView,
  type Approval,
  type ApprovalTarget,
  type ApprovalRequiredCommandOutcome,
  type ApprovalRequiredAuditEvent,
  type AgentRunStatus,
  type ApprovalStatus,
  type Capability,
  type CanonicalMutation,
  type CanonicalCommandTransaction,
  type CommandReceiptCompletion,
  type CommandReceiptClaim,
  type CommandExecutionResult,
  type CompletedCanonicalCommand,
  type CompletedCanonicalMutation,
  type CompletedAuditedReceipt,
  type NonApprovalAuditEvent,
  type PersistedCanonicalMutation,
  type ReceiptClaimToken,
  type RequestApprovalCommand,
  type TaskPacketContent,
  type UnitOfWork,
  type WorkItemStatus,
  workItemStatuses
} from './index';

const packetContent = (): TaskPacketContent => ({
  projectId: 'project-1',
  workItemId: 'work-item-1',
  workItemVersion: 1,
  goal: 'Implement the bounded change.',
  acceptanceCriteria: ['Tests pass', 'No secrets leave the secret provider'],
  inScope: ['packages/domain/**'],
  outOfScope: ['packages/db/**'],
  relevantLinks: ['https://example.test/issues/3'],
  relevantFiles: ['packages/domain/src/index.ts'],
  allowedTools: ['pnpm test'],
  forbiddenSurfaces: ['production'],
  dataPolicy: {classification: 'internal', redaction: ['secrets']},
  timeboxMinutes: 30,
  expectedOutputSchema: {type: 'object', required: ['summary']},
  reviewerActorId: 'reviewer-1',
  approverActorId: 'approver-1',
  runtimeProfile: 'read_safe',
  authMode: 'agent',
  secretsRef: {provider: 'vault', reference: 'kv/fai/github', scope: ['repository:read']},
  createdFromEventId: 'event-1',
  createdByActorId: 'user-1'
});

describe('provider evidence lifecycle', () => {
  it('is provider-neutral and bounded to explicit observable states', () => {
    expect(providerEvidenceStates).toEqual([
      'observed',
      'pending_confirmation',
      'confirmed',
      'stale',
      'conflict',
      'missing'
    ]);
  });
});

const agentRun = (status: AgentRunStatus): AgentRun => ({
  id: 'run',
  taskPacketId: 'packet',
  agentProfileId: 'profile',
  confirmedPacketHash: 'b'.repeat(64),
  baseCommit: 'a'.repeat(40),
  status,
  idempotencyKey: 'key',
  version: 4
});

const approval = (status: ApprovalStatus): Approval => ({
  id: 'approval',
  projectId: 'project',
  workItemId: 'work-item',
  actionCategory: 'deploy',
  surface: 'runner',
  environment: 'production',
  requestedByActorId: 'requester',
  binding: {
    subjectHash: 'a'.repeat(64),
    policyVersion: 1,
    executionIdentity: 'execution',
    actorId: 'requester',
    expiresAt: '2026-07-25T13:00:00.000Z',
    actionHash: 'b'.repeat(64)
  },
  status,
  version: 4
});

const accessRequest = (status: AccessRequestStatus): AccessRequest => ({
  id: 'access',
  workspaceId: 'workspace',
  requesterActorId: 'requester',
  targetSurface: 'repository',
  requestedScope: ['contents:read'],
  status,
  version: 4
});

const statusCases = <T extends string>(statuses: readonly T[], allowed: readonly `${T}:${T}`[]) =>
  statuses.flatMap((from) => statuses.map((to) => [
    from,
    to,
    allowed.includes(`${from}:${to}` as `${T}:${T}`)
  ] as const));

describe('aggregate transitions', () => {
  it.each(statusCases<WorkItemStatus>(workItemStatuses, [
    'backlog:ready', 'ready:backlog', 'ready:in_dev', 'in_dev:ready', 'in_dev:qa',
    'qa:in_dev', 'qa:acceptance', 'acceptance:in_dev', 'acceptance:done'
  ]))('work item %s -> %s is %s', (from, to, legal) => {
    const result = transitionWorkItem(
      {id: 'work-1', projectId: 'project-1', status: from, blocked: false, version: 3}, to
    );
    expect(result.ok).toBe(legal);
    if (legal && result.ok) expect(result.value.version).toBe(4);
    if (!legal && !result.ok) expect(result.error.code).toBe('INVALID_TRANSITION');
  });

  it.each([
    ['ready', 'in_dev', false], ['in_dev', 'qa', false], ['qa', 'acceptance', false],
    ['acceptance', 'done', false], ['acceptance', 'in_dev', true], ['qa', 'in_dev', true]
  ] as const)('blocked work item %s -> %s succeeds: %s', (from, to, legal) => {
    const result = transitionWorkItem(
      {id: 'work-1', projectId: 'project-1', status: from, blocked: true, version: 1}, to
    );
    expect(result.ok).toBe(legal);
    if (!legal && !result.ok) expect(result.error.code).toBe('WORK_ITEM_BLOCKED');
  });

  it('increments version when blocking or unblocking', () => {
    expect(setWorkItemBlocked({id: 'w', projectId: 'p', status: 'ready', blocked: false, version: 2}, true))
      .toMatchObject({ok: true, value: {blocked: true, version: 3}});
  });

  it('does not increment version when the blocked value is unchanged', () => {
    const workItem = {id: 'w', projectId: 'p', status: 'ready' as const, blocked: true, version: 2};
    const result = setWorkItemBlocked(workItem, true);
    expect(result).toMatchObject({ok: true, value: {blocked: true, version: 2}});
    if (result.ok) expect(result.value).toBe(workItem);
  });

  it.each(statusCases<AgentRunStatus>(agentRunStatuses, [
    'queued:running', 'queued:failed', 'running:waiting_approval', 'running:done',
    'running:failed', 'waiting_approval:running', 'waiting_approval:failed'
  ]))('agent run %s -> %s is %s', (from, to, legal) => {
    const result = transitionAgentRun(agentRun(from), to);
    expect(result.ok).toBe(legal);
    if (legal && result.ok) expect(result.value.version).toBe(5);
  });

  it.each(statusCases<ApprovalStatus>(approvalStatuses, [
    'pending:approved', 'pending:rejected', 'pending:expired'
  ]))('approval %s -> %s is %s', (from, to, legal) => {
    const result = transitionApproval(approval(from), to);
    expect(result.ok).toBe(legal);
    if (legal && result.ok) expect(result.value.version).toBe(5);
  });

  it.each(statusCases<AccessRequestStatus>(accessRequestStatuses, [
    'pending:granted', 'pending:rejected', 'pending:expired'
  ]))('access request %s -> %s is %s', (from, to, legal) => {
    const result = transitionAccessRequest(accessRequest(from), to);
    expect(result.ok).toBe(legal);
    if (legal && result.ok) expect(result.value.version).toBe(5);
  });
});

describe('trusted actors and policy', () => {
  const issuerResult = createActorContextIssuer({
    users: [{
      actorId: 'user-1',
      capabilities: [
        'read:repository:production', 'read:artifact_store:production',
        'write:worktree:development', 'deploy:runner:production'
      ] as Capability[]
    }],
    agents: [{
      actorId: 'agent-1',
      delegatedByActorIds: ['user-1'],
      capabilities: ['read:artifact_store:production', 'write:worktree:development'] as Capability[]
    }],
    systems: [{actorId: 'system-1', capabilities: ['read:control_plane:production'] as Capability[]}]
  });

  it.each([
    [{users: [], agents: [], systems: [{actorId: '', capabilities: [] as Capability[]}]}],
    [{users: [{actorId: 'user-1', capabilities: ['invalid:capability' as Capability]}], agents: [], systems: []}],
    [{users: [{actorId: 'user-1', capabilities: []}], agents: [{
      actorId: 'agent-1', capabilities: [], delegatedByActorIds: ['unknown-user']
    }], systems: []}],
    [null as never]
  ])('rejects invalid authority configuration', (input) => {
    expect(createActorContextIssuer(input)).toMatchObject({
      ok: false, error: {code: 'INVALID_ACTOR_CONTEXT'}
    });
  });

  it('issues only configured identities and bounds agent capabilities to authoritative grants and delegation', () => {
    expect(issuerResult.ok).toBe(true);
    if (!issuerResult.ok) return;
    expect(issuerResult.value.issueUser('unknown-user')).toMatchObject({
      ok: false, error: {code: 'INVALID_ACTOR_CONTEXT'}
    });
    const userResult = issuerResult.value.issueUser('user-1');
    expect(userResult).toMatchObject({ok: true});
    if (!userResult.ok) return;
    const agentResult = issuerResult.value.issueAgent({
      actorId: 'agent-1', delegatedBy: userResult.value,
      capabilities: ['deploy:runner:production']
    } as unknown as {actorId: string; delegatedBy: typeof userResult.value});
    expect(agentResult).toMatchObject({ok: true});
    if (agentResult.ok) {
      expect(Object.isFrozen(agentResult.value)).toBe(true);
      expect(effectiveCapabilities(agentResult.value)).toMatchObject({ok: true, value: [
        'read:artifact_store:production', 'write:worktree:development'
      ]});
      expect(authorize(agentResult.value, {
        actionCategory: 'deploy', surface: 'runner', environment: 'production'
      })).toMatchObject({ok: false, error: {code: 'CAPABILITY_DENIED'}});
    }
  });

  it('contains an explicit decision for every policy coordinate', () => {
    for (const actorType of ['human', 'agent', 'system'] as const) {
      for (const actionCategory of actionCategories) {
        for (const surface of policySurfaces) {
          for (const environment of ['local', 'development', 'staging', 'production'] as const) {
            expect(policyDecisionFor(actorType, {actionCategory, surface, environment}))
              .toMatch(/allow|ask|deny/);
          }
        }
      }
    }
  });

  it.each([
    ['agent', 'deploy', 'runner', 'production', 'ask'],
    ['agent', 'external_message', 'chat', 'production', 'ask'],
    ['agent', 'access_change', 'control_plane', 'production', 'ask'],
    ['agent', 'critical_config', 'control_plane', 'production', 'ask'],
    ['agent', 'customer_data_touch', 'tracker', 'production', 'ask'],
    ['agent', 'delete', 'repository', 'development', 'deny'],
    ['human', 'delete', 'repository', 'staging', 'ask'],
    ['human', 'read', 'repository', 'production', 'allow'],
    ['agent', 'read', 'artifact_store', 'production', 'allow'],
    ['agent', 'read', 'repository', 'production', 'deny'],
    ['human', 'write', 'repository', 'production', 'deny'],
    ['system', 'read', 'repository', 'development', 'deny'],
    ['system', 'read', 'control_plane', 'production', 'allow'],
    ['system', 'deploy', 'runner', 'production', 'ask']
  ] as const)('%s %s on %s in %s defaults to %s', (actorType, actionCategory, surface, environment, decision) => {
    expect(policyDecisionFor(actorType, {actionCategory, surface, environment})).toBe(decision);
  });

  it('requires capabilities and turns ask decisions into approval requirements', () => {
    if (!issuerResult.ok) throw new Error('test setup failed');
    const userResult = issuerResult.value.issueUser('user-1');
    if (!userResult.ok) throw new Error('test setup failed');
    expect(authorize(userResult.value, {
      actionCategory: 'read', surface: 'repository', environment: 'production'
    })).toMatchObject({ok: true, value: 'allow'});
    expect(authorize(userResult.value, {
      actionCategory: 'deploy', surface: 'runner', environment: 'production'
    })).toMatchObject({ok: false, error: {code: 'APPROVAL_REQUIRED'}});
    expect(authorize(userResult.value, {
      actionCategory: 'read', surface: 'tracker', environment: 'production'
    })).toMatchObject({ok: false, error: {code: 'CAPABILITY_DENIED'}});
  });

  it('rejects forged user, agent, and system contexts at runtime', () => {
    if (!issuerResult.ok) throw new Error('test setup failed');
    const userResult = issuerResult.value.issueUser('user-1');
    const forgedContexts = [
      {
        kind: 'trusted_user', actorId: 'user-1', actorType: 'human',
        capabilities: Object.freeze(['read:repository:production'] as Capability[])
      },
      {
        kind: 'trusted_agent', actorId: 'agent-1', actorType: 'agent',
        delegatedBy: userResult.ok ? userResult.value : null,
        capabilities: Object.freeze(['read:repository:production'] as Capability[])
      },
      {
        kind: 'trusted_system', actorId: 'system-1', actorType: 'system',
        capabilities: Object.freeze(['read:control_plane:production'] as Capability[])
      }
    ];
    for (const forged of forgedContexts) {
      Object.freeze(forged);
      expect(isTrustedActorContext(forged)).toBe(false);
      expect(effectiveCapabilities(forged as never)).toMatchObject({
        ok: false, error: {code: 'INVALID_ACTOR_CONTEXT'}
      });
      expect(authorize(forged as never, {
        actionCategory: 'read', surface: 'control_plane', environment: 'production'
      })).toMatchObject({ok: false, error: {code: 'INVALID_ACTOR_CONTEXT'}});
    }
  });

  it('creates a trusted least-privilege system context', () => {
    if (!issuerResult.ok) throw new Error('test setup failed');
    const system = issuerResult.value.issueSystem('system-1');
    expect(system).toMatchObject({ok: true});
    if (!system.ok) return;
    expect(isTrustedActorContext(system.value)).toBe(true);
    expect(authorize(system.value, {
      actionCategory: 'read', surface: 'control_plane', environment: 'production'
    })).toMatchObject({ok: true, value: 'allow'});
    expect(authorize(system.value, {
      actionCategory: 'read', surface: 'repository', environment: 'production'
    })).toMatchObject({ok: false, error: {code: 'CAPABILITY_DENIED'}});
  });
});

describe('task packets', () => {
  it('has a stable golden content hash and retains its supplied packet ID', () => {
    const result = createTaskPacket('packet-1', packetContent());
    expect(result).toMatchObject({ok: true, value: {packetId: 'packet-1'}});
    if (result.ok) {
      expect(result.value.contentHash).toBe(
        'e58c4b6cd439a285500ddc5a5024aa2370f3fa725c50505c11a063610e77f252'
      );
    }
  });

  it('normalizes object key order, preserves array order, and hashes opaque refs', () => {
    const first = createTaskPacket('packet-1', packetContent());
    const reordered = createTaskPacket('packet-1', {
      ...packetContent(), dataPolicy: {redaction: ['secrets'], classification: 'internal'}
    });
    const reversed = createTaskPacket('packet-1', {
      ...packetContent(), acceptanceCriteria: [...packetContent().acceptanceCriteria].reverse()
    });
    const changedRef = createTaskPacket('packet-1', {
      ...packetContent(), secretsRef: {provider: 'vault', reference: 'kv/fai/other', scope: ['repository:read']}
    });
    expect(first).toMatchObject({ok: true});
    expect(reordered).toMatchObject({ok: true});
    expect(reversed).toMatchObject({ok: true});
    expect(changedRef).toMatchObject({ok: true});
    if (first.ok && reordered.ok && reversed.ok && changedRef.ok) {
      expect(reordered.value.contentHash).toBe(first.value.contentHash);
      expect(reversed.value.contentHash).not.toBe(first.value.contentHash);
      expect(changedRef.value.contentHash).not.toBe(first.value.contentHash);
    }
  });

  it('copies and freezes packet content', () => {
    const acceptanceCriteria = ['Tests pass', 'No secrets leave the secret provider'];
    const result = createTaskPacket('packet-1', {...packetContent(), acceptanceCriteria});
    expect(result).toMatchObject({ok: true});
    if (!result.ok) return;
    acceptanceCriteria[0] = 'mutated input';
    expect(result.value.content.acceptanceCriteria[0]).toBe('Tests pass');
    expect(Object.isFrozen(result.value.content)).toBe(true);
    expect(Object.isFrozen(result.value.content.acceptanceCriteria)).toBe(true);
  });

  it('rejects sparse top-level string arrays', () => {
    const acceptanceCriteria = ['Tests pass', , 'No secrets leave the secret provider'];
    expect(createTaskPacket('packet-1', {
      ...packetContent(), acceptanceCriteria
    } as TaskPacketContent)).toMatchObject({ok: false, error: {code: 'INVALID_TASK_PACKET'}});
  });

  it('rejects sparse arrays nested in packet JSON fields', () => {
    const required = ['summary', , 'artifacts'];
    expect(createTaskPacket('packet-1', {
      ...packetContent(), expectedOutputSchema: {type: 'object', required}
    } as TaskPacketContent)).toMatchObject({ok: false, error: {code: 'INVALID_TASK_PACKET'}});
  });

  it.each([
    ['packet ID', '', packetContent(), 'INVALID_TASK_PACKET'],
    ['required string', 'packet-1', {...packetContent(), goal: ''}, 'INVALID_TASK_PACKET'],
    ['required array', 'packet-1', {...packetContent(), allowedTools: ['']}, 'INVALID_TASK_PACKET'],
    ['invalid JSON', 'packet-1', {...packetContent(), dataPolicy: new Date()} as unknown as TaskPacketContent, 'INVALID_TASK_PACKET'],
    ['timebox', 'packet-1', {...packetContent(), timeboxMinutes: 0}, 'INVALID_TASK_PACKET'],
    ['bounded timebox', 'packet-1', {...packetContent(), timeboxMinutes: 121}, 'INVALID_TASK_PACKET'],
    ['bounded content', 'packet-1', {...packetContent(), goal: 'x'.repeat(64 * 1024)}, 'INVALID_TASK_PACKET'],
    ['auth mode', 'packet-1', {...packetContent(), authMode: 'unknown'} as unknown as TaskPacketContent, 'INVALID_TASK_PACKET'],
    ['opaque ref', 'packet-1', {...packetContent(), secretsRef: {provider: '', reference: 'x', scope: []}}, 'INVALID_TASK_PACKET'],
    ['unknown field', 'packet-1', {...packetContent(), retryHint: 'safe'} as TaskPacketContent, 'INVALID_TASK_PACKET'],
    ['missing field', 'packet-1', (() => {
      const content = {...packetContent()} as Record<string, unknown>;
      delete content.goal;
      return content as TaskPacketContent;
    })(), 'INVALID_TASK_PACKET'],
    ['secret value', 'packet-1', {...packetContent(), secretValue: 'do-not-store'} as TaskPacketContent, 'SECRET_VALUE_FORBIDDEN'],
    ['secret ref value', 'packet-1', {...packetContent(), secretsRef: {provider: 'vault', reference: 'x', scope: [], value: 'no'}} as TaskPacketContent, 'SECRET_VALUE_FORBIDDEN']
  ] as const)('rejects invalid %s', (_name, packetId, content, code) => {
    expect(createTaskPacket(packetId, content)).toMatchObject({ok: false, error: {code}});
  });

  it.each(['dataPolicy', 'expectedOutputSchema'] as const)('rejects cyclic %s without throwing', (field) => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const content = {...packetContent(), [field]: cyclic} as TaskPacketContent;
    expect(() => createTaskPacket('packet-1', content)).not.toThrow();
    expect(createTaskPacket('packet-1', content)).toMatchObject({
      ok: false, error: {code: 'INVALID_TASK_PACKET'}
    });
  });

  it('rejects a cycle reachable through other packet content without throwing', () => {
    const forbiddenSurfaces = ['production'];
    const content = {...packetContent(), forbiddenSurfaces} as TaskPacketContent;
    (forbiddenSurfaces as unknown as {self: unknown}).self = content;
    expect(() => createTaskPacket('packet-1', content)).not.toThrow();
    expect(createTaskPacket('packet-1', content)).toMatchObject({
      ok: false, error: {code: 'INVALID_TASK_PACKET'}
    });
  });
});

describe('canonical command transaction contract', () => {
  it('discriminates supported aggregate insert and update modes', () => {
    type WorkItemMutation = Extract<CanonicalMutation, {aggregateType: 'work_item'}>;
    type PacketMutation = Extract<CanonicalMutation, {aggregateType: 'task_packet'}>;
    type AgentRunMutation = Extract<CanonicalMutation, {aggregateType: 'agent_run'}>;

    expectTypeOf<WorkItemMutation['expectedPersistedVersion']>().toEqualTypeOf<number>();
    expectTypeOf<PacketMutation['expectedPersistedVersion']>().toEqualTypeOf<null>();
    expectTypeOf<AgentRunMutation['expectedPersistedVersion']>().toEqualTypeOf<number | null>();

    const invalidWorkItemInsert: WorkItemMutation = {
      aggregateType: 'work_item',
      aggregateId: 'work-item',
      // @ts-expect-error tracker ingestion owns WorkItem creation.
      expectedPersistedVersion: null,
      aggregate: {
        id: 'work-item', projectId: 'project', status: 'ready', blocked: false, version: 1
      }
    };
    const invalidPacketUpdate: PacketMutation = {
      aggregateType: 'task_packet',
      aggregateId: 'packet',
      // @ts-expect-error task packets are insert-only immutable snapshots.
      expectedPersistedVersion: 1,
      aggregate: null as never
    };
    expect(invalidWorkItemInsert.aggregateType).toBe('work_item');
    expect(invalidPacketUpdate.aggregateType).toBe('task_packet');
  });

  it('keeps claims internal and requires transaction-bound completions', () => {
    type CompletionInput = Parameters<CanonicalCommandTransaction['completeReceipt']>[0];
    type NoMutationInput = Parameters<CanonicalCommandTransaction['completeAuditedReceipt']>[0];
    expectTypeOf<CompletionInput['claimToken']>().toEqualTypeOf<ReceiptClaimToken>();
    expectTypeOf<CompletionInput['mutation']>().toEqualTypeOf<PersistedCanonicalMutation>();
    expectTypeOf<CompletionInput['mutation']['audit']>().not.toMatchTypeOf<ReceiptClaimToken>();
    expectTypeOf<NoMutationInput['claimToken']>().toEqualTypeOf<ReceiptClaimToken>();
    expectTypeOf<Awaited<ReturnType<CanonicalCommandTransaction['completeAuditedReceipt']>>>()
      .toEqualTypeOf<CompletedAuditedReceipt>();
    expectTypeOf<ApprovalRequiredAuditEvent['policyDecision']>().toEqualTypeOf<'ask'>();
    expectTypeOf<ApprovalRequiredAuditEvent['outcome']>().toEqualTypeOf<'approval_required'>();
    expectTypeOf<Parameters<UnitOfWork['executeCommand']>[0]>().toEqualTypeOf<CommandReceiptClaim>();
    expectTypeOf<Parameters<UnitOfWork['executeCommand']>[1]>().toMatchTypeOf<(
      transaction: CanonicalCommandTransaction,
      claimToken: ReceiptClaimToken
    ) => Promise<CompletedCanonicalCommand<unknown>>>();
    expectTypeOf<Parameters<CanonicalCommandTransaction['loadWorkItem']>[0]>()
      .toEqualTypeOf<ReceiptClaimToken>();
    expectTypeOf<Parameters<CanonicalCommandTransaction['loadAgentRun']>>()
      .toEqualTypeOf<[ReceiptClaimToken, string]>();
    expectTypeOf<ReturnType<CanonicalCommandTransaction['loadAgentRun']>>()
      .toEqualTypeOf<Promise<AgentRunView | null>>();
    expectTypeOf<ReturnType<UnitOfWork['executeCommand']>>()
      .toMatchTypeOf<Promise<CommandExecutionResult<unknown>>>();
    expectTypeOf<CompletedCanonicalMutation['receipt']>().toEqualTypeOf<CommandReceiptCompletion>();

    expectTypeOf<CanonicalCommandTransaction>().not.toMatchTypeOf<{
      claimReceipt(claim: CommandReceiptClaim): unknown;
    }>();
  });

  it('exports a single approval target for approval commands', () => {
    type Payload = RequestApprovalCommand['payload'];
    expectTypeOf<Payload['target']>().toEqualTypeOf<ApprovalTarget>();
    const target: ApprovalTarget = {workItemId: 'work-item'};
    // @ts-expect-error Approval commands cannot name both targets.
    const invalid: ApprovalTarget = {
      workItemId: 'work-item',
      agentRunId: 'agent-run'
    };
    expect(target).toEqual({workItemId: 'work-item'});
    expect(invalid.workItemId).toBe('work-item');
  });

  it('excludes approval-required audits from the generic persistence path', () => {
    type GenericInput = Parameters<CanonicalCommandTransaction['persistAuditedMutation']>[0];
    type GenericCompletionInput = Parameters<CanonicalCommandTransaction['completeReceipt']>[0];
    expectTypeOf<ApprovalRequiredAuditEvent>().not.toMatchTypeOf<NonApprovalAuditEvent>();
    expectTypeOf<ApprovalRequiredCommandOutcome>().not.toMatchTypeOf<GenericInput['outcome']>();
    expectTypeOf<ApprovalRequiredCommandOutcome['receipt']>()
      .not.toMatchTypeOf<GenericCompletionInput['receipt']>();

    const askAudit = null as unknown as ApprovalRequiredAuditEvent;
    const invalidGenericInput: GenericInput = {
      claimToken: null as unknown as ReceiptClaimToken,
      outcome: {
        kind: 'non_approval',
        mutation: null as unknown as CanonicalMutation,
        // @ts-expect-error ask/approval-required audits must use persistApprovalRequired.
        audit: askAudit
      }
    };
    expect(invalidGenericInput.outcome.kind).toBe('non_approval');
  });

  it('requires approval aggregate, ask audit, and receipt completion on the approval path', () => {
    type ApprovalInput = Parameters<CanonicalCommandTransaction['persistApprovalRequired']>[0];
    type ApprovalResult = Awaited<ReturnType<CanonicalCommandTransaction['persistApprovalRequired']>>;
    type CompletedApproval = Extract<ApprovalResult, {status: 'completed'}>['command'];

    expectTypeOf<ApprovalInput['outcome']>().toEqualTypeOf<ApprovalRequiredCommandOutcome>();
    expectTypeOf<ApprovalInput['outcome']['kind']>().toEqualTypeOf<'approval_required'>();
    expectTypeOf<ApprovalInput['outcome']['approval']['aggregateType']>().toEqualTypeOf<'approval'>();
    expectTypeOf<ApprovalInput['outcome']['audit']['policyDecision']>().toEqualTypeOf<'ask'>();
    expectTypeOf<ApprovalInput['outcome']['receipt']['result']['error']['code']>()
      .toEqualTypeOf<'APPROVAL_REQUIRED'>();
    expectTypeOf<CompletedApproval['kind']>().toEqualTypeOf<'approval_required'>();
    expectTypeOf<CompletedApproval['receipt']>().toEqualTypeOf<CommandReceiptCompletion>();
  });
});
