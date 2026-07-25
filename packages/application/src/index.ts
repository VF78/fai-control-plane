import {createHash, randomUUID} from 'node:crypto';
import {
  actionCategories,
  accessRequestStatuses,
  agentRunStatuses,
  approvalStatuses,
  authorize,
  canonicalJson,
  createTaskPacket,
  environments,
  isTrustedActorContext,
  policySurfaces,
  setWorkItemBlocked,
  transitionAccessRequest,
  transitionAgentRun,
  transitionApproval,
  transitionWorkItem,
  workItemStatuses,
  type AccessRequest,
  type ActionCategory,
  type AgentRun,
  type Approval,
  type ApprovalTarget,
  type CanonicalCommand,
  type CanonicalCommandTransaction,
  type CanonicalJson,
  type CommandError,
  type CommandReceipt,
  type CommandReceiptClaim,
  type CommandResult,
  type NonApprovalAuditEvent,
  type NonApprovalCommandOutcome,
  type NonApprovalReceipt,
  type PolicyDecision,
  type PolicyRequest,
  type ReceiptClaimToken,
  type TaskPacket,
  type UnitOfWork,
  type WorkItem
} from '@fai-control-plane/domain';

export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}

export type CanonicalCommandExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: CommandReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;

export interface CanonicalCommandService {
  execute(command: CanonicalCommand): Promise<CanonicalCommandExecution>;
}

export type CreateCanonicalCommandServiceInput = Readonly<{
  unitOfWork: UnitOfWork;
  idGenerator?: IdGenerator;
  clock?: Clock;
}>;

type Target = Readonly<{
  aggregateType: string;
  aggregateId: string;
  expectedVersion?: number;
  resultVersion?: number;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routinePolicy: PolicyRequest = {
  actionCategory: 'write', surface: 'control_plane', environment: 'development'
};
const commandTypes = new Set<CanonicalCommand['type']>([
  'work_item.transition',
  'work_item.set_blocked',
  'task_packet.create',
  'agent_run.queue',
  'agent_run.transition',
  'approval.request',
  'approval.decide',
  'access_request.request',
  'access_request.decide'
]);

const defaultIds: IdGenerator = {next: randomUUID};
const defaultClock: Clock = {now: () => new Date()};

const failed = (code: CommandError['code'], message: string): CommandResult<never> => ({
  ok: false, error: {code, message}
});
const succeeded = <T extends CanonicalJson>(value: T): CommandResult<T> => ({ok: true, value});
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
};
const isDenseArray = (value: unknown): value is readonly unknown[] => {
  try {
    return Array.isArray(value) && Object.keys(value).length === value.length &&
      Array.from({length: value.length}, (_, index) => Object.hasOwn(value, index)).every(Boolean);
  } catch {
    return false;
  }
};

/** Rejects undefined, sparse arrays, accessors, non-plain objects, and cycles before hashing. */
const isSafeCanonicalInput = (value: unknown, ancestors = new WeakSet<object>()): value is CanonicalJson => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return isDenseArray(value) && value.every((item) => isSafeCanonicalInput(item, ancestors));
    }
    if (!isPlainObject(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every((descriptor) =>
      descriptor.enumerable === true && 'value' in descriptor && descriptor.value !== undefined &&
      isSafeCanonicalInput(descriptor.value, ancestors)
    );
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
};

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const isVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;
const hasValidIssuedAt = (value: unknown): boolean =>
  typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && values.includes(value as T);
const error = (message: string): Readonly<{ok: false; error: CommandError}> => ({
  ok: false, error: {code: 'INVALID_COMMAND', message}
});
const assertNever = (value: never): never => {
  throw new TypeError(`Unhandled canonical command: ${String(value)}`);
};

const isCommandShape = (value: unknown): value is CanonicalCommand => {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'commandId', 'workspaceId', 'correlationId', 'idempotencyKey', 'issuedAt', 'actor', 'type', 'payload'
  ])) return false;
  if (!isUuid(value.commandId) || !isUuid(value.workspaceId) || !isNonEmptyString(value.correlationId) ||
    !isNonEmptyString(value.idempotencyKey) || !hasValidIssuedAt(value.issuedAt) ||
    !commandTypes.has(value.type as CanonicalCommand['type']) || !isTrustedActorContext(value.actor) ||
    !isSafeCanonicalInput(value.payload)) return false;
  if (!commandPayloadIsSafe(value.type as CanonicalCommand['type'], value.payload)) return false;
  if (value.type === 'task_packet.create') {
    const payload = value.payload as Extract<
      CanonicalCommand,
      {type: 'task_packet.create'}
    >['payload'];
    return payload.content.createdByActorId === value.actor.actorId;
  }
  return true;
};

const commandPayloadIsSafe = (type: CanonicalCommand['type'], payload: CanonicalJson): boolean => {
  if (!isPlainObject(payload)) return false;
  switch (type) {
    case 'work_item.transition':
      return hasExactKeys(payload, ['workItemId', 'status', 'expectedVersion']) && isUuid(payload.workItemId) &&
        isOneOf(workItemStatuses, payload.status) && isVersion(payload.expectedVersion);
    case 'work_item.set_blocked':
      return hasExactKeys(payload, ['workItemId', 'blocked', 'expectedVersion']) && isUuid(payload.workItemId) &&
        typeof payload.blocked === 'boolean' && isVersion(payload.expectedVersion);
    case 'task_packet.create':
      return hasExactKeys(payload, ['packetId', 'content']) && isUuid(payload.packetId) &&
        isPlainObject(payload.content) && packetIdsAreSafe(payload.content);
    case 'agent_run.queue':
      return hasExactKeys(payload, ['agentRunId', 'taskPacketId', 'agentProfileId']) &&
        isUuid(payload.agentRunId) && isUuid(payload.taskPacketId) && isUuid(payload.agentProfileId);
    case 'agent_run.transition':
      return hasExactKeys(payload, ['agentRunId', 'status', 'expectedVersion']) && isUuid(payload.agentRunId) &&
        isOneOf(agentRunStatuses, payload.status) && isVersion(payload.expectedVersion);
    case 'approval.request':
      return hasExactKeys(payload, ['approvalId', 'action', 'target']) && isUuid(payload.approvalId) &&
        isPolicyRequest(payload.action) && isApprovalTarget(payload.target);
    case 'approval.decide':
      return hasExactKeys(payload, ['approvalId', 'status', 'expectedVersion']) && isUuid(payload.approvalId) &&
        isOneOf(approvalStatuses.filter((status) => status !== 'pending'), payload.status) &&
        isVersion(payload.expectedVersion);
    case 'access_request.request':
      return hasExactKeys(payload, ['requestId', 'targetSurface', 'requestedScope']) && isUuid(payload.requestId) &&
        isOneOf(policySurfaces, payload.targetSurface) && isDenseArray(payload.requestedScope) &&
        (payload.requestedScope as readonly unknown[]).every(isNonEmptyString);
    case 'access_request.decide':
      return hasExactKeys(payload, ['requestId', 'status', 'expectedVersion']) && isUuid(payload.requestId) &&
        isOneOf(accessRequestStatuses.filter((status) => status !== 'pending'), payload.status) &&
        isVersion(payload.expectedVersion);
  }
  return assertNever(type);
};

const packetIdsAreSafe = (content: Record<string, unknown>): boolean => [
  'projectId', 'workItemId', 'reviewerActorId', 'approverActorId', 'createdFromEventId', 'createdByActorId'
].every((field) => isUuid(content[field]));
const isPolicyRequest = (value: unknown): value is PolicyRequest => isPlainObject(value) &&
  hasExactKeys(value, ['actionCategory', 'surface', 'environment']) &&
  isOneOf(actionCategories, value.actionCategory) && isOneOf(policySurfaces, value.surface) &&
  isOneOf(environments, value.environment);
const isApprovalTarget = (value: unknown): value is ApprovalTarget => isPlainObject(value) &&
  ((hasExactKeys(value, ['workItemId']) && isUuid(value.workItemId)) ||
    (hasExactKeys(value, ['agentRunId']) && isUuid(value.agentRunId)));

const normalizedActorForHash = (command: CanonicalCommand): CanonicalJson => {
  const actor = command.actor;
  const base: Record<string, CanonicalJson> = {
    actorId: actor.actorId,
    actorType: actor.actorType,
    capabilities: [...actor.capabilities].sort()
  };
  if (actor.kind === 'trusted_agent') {
    base.delegatedBy = {
      actorId: actor.delegatedBy.actorId,
      actorType: actor.delegatedBy.actorType,
      capabilities: [...actor.delegatedBy.capabilities].sort()
    };
  }
  return base;
};

export const hashCanonicalCommandRequest = (command: CanonicalCommand): string => {
  const input: CanonicalJson = {
    workspaceId: command.workspaceId,
    actor: normalizedActorForHash(command),
    type: command.type,
    payload: command.payload as CanonicalJson
  };
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
};

const claimFor = (command: CanonicalCommand, now: Date): CommandReceiptClaim => ({
  commandId: command.commandId,
  workspaceId: command.workspaceId,
  correlationId: command.correlationId,
  idempotencyKey: command.idempotencyKey,
  requestHash: hashCanonicalCommandRequest(command),
  commandType: command.type,
  createdAt: now.toISOString()
});

const receipt = (
  claim: CommandReceiptClaim,
  target: Target,
  result: CommandResult<CanonicalJson>
): NonApprovalReceipt => ({
  ...claim,
  aggregateType: target.aggregateType,
  aggregateId: target.aggregateId,
  ...(target.expectedVersion === undefined ? {} : {expectedVersion: target.expectedVersion}),
  ...(target.resultVersion === undefined ? {} : {resultVersion: target.resultVersion}),
  result
} as unknown as NonApprovalReceipt);

const audit = (
  claim: CommandReceiptClaim,
  idGenerator: IdGenerator,
  clock: Clock,
  target: Target,
  actorId: string,
  action: string,
  actionCategory: ActionCategory,
  result: CommandResult<CanonicalJson>,
  policyDecision?: Exclude<PolicyDecision, 'ask'>
): NonApprovalAuditEvent => ({
  id: idGenerator.next(),
  workspaceId: claim.workspaceId,
  commandId: claim.commandId,
  correlationId: claim.correlationId,
  actorId,
  actionCategory,
  action,
  targetType: target.aggregateType,
  targetId: target.aggregateId,
  ...(policyDecision === undefined ? {} : {policyDecision}),
  outcome: result.ok ? 'succeeded' : (policyDecision === 'deny' || result.error.code === 'CAPABILITY_DENIED' ? 'rejected' : 'failed'),
  ...(!result.ok ? {reasonCode: result.error.code} : {}),
  ...(target.expectedVersion === undefined ? {} : {expectedVersion: target.expectedVersion}),
  ...(target.resultVersion === undefined ? {} : {resultVersion: target.resultVersion}),
  occurredAt: clock.now().toISOString()
} as unknown as NonApprovalAuditEvent);

const targetFor = (type: string, id: string, expectedVersion?: number, resultVersion?: number): Target => ({
  aggregateType: type,
  aggregateId: id,
  ...(expectedVersion === undefined ? {} : {expectedVersion}),
  ...(resultVersion === undefined ? {} : {resultVersion})
});

export const createCanonicalCommandService = (
  input: CreateCanonicalCommandServiceInput
): CanonicalCommandService => {
  const ids = input.idGenerator ?? defaultIds;
  const clock = input.clock ?? defaultClock;

  const completeNoMutation = async <T extends CanonicalJson>(
    transaction: CanonicalCommandTransaction,
    claimToken: ReceiptClaimToken,
    claim: CommandReceiptClaim,
    command: CanonicalCommand,
    target: Target,
    result: CommandResult<T>,
    actionCategory: ActionCategory = 'write',
    policyDecision?: Exclude<PolicyDecision, 'ask'>
  ) => {
    const typedResult = result as CommandResult<CanonicalJson>;
    const commandReceipt = receipt(claim, target, typedResult);
    const completion = await transaction.completeAuditedReceipt({
      claimToken,
      audit: audit(claim, ids, clock, target, command.actor.actorId, command.type, actionCategory, typedResult, policyDecision),
      receipt: commandReceipt
    });
    return {kind: 'no_mutation' as const, value: commandReceipt, completion};
  };

  const completeMutation = async <T extends CanonicalJson>(
    transaction: CanonicalCommandTransaction,
    claimToken: ReceiptClaimToken,
    claim: CommandReceiptClaim,
    command: CanonicalCommand,
    outcome: NonApprovalCommandOutcome,
    target: Target,
    result: CommandResult<T>
  ) => {
    const persisted = await transaction.persistAuditedMutation({claimToken, outcome});
    if (persisted.status !== 'persisted') {
      const failedTarget = targetFor(
        target.aggregateType,
        target.aggregateId,
        target.expectedVersion,
        persisted.status === 'version_conflict' && persisted.persistedVersion !== null
          ? persisted.persistedVersion
          : undefined
      );
      return completeNoMutation(
        transaction,
        claimToken,
        claim,
        command,
        failedTarget,
        failed(persisted.status === 'not_found' ? 'NOT_FOUND' : 'VERSION_CONFLICT',
          persisted.status === 'not_found' ? 'Resource was not found.' : 'Resource version conflicts with the command.'),
        'write'
      );
    }
    const commandReceipt = receipt(claim, target, result as CommandResult<CanonicalJson>);
    const completion = await transaction.completeReceipt({claimToken, receipt: commandReceipt, mutation: persisted.mutation});
    return {kind: 'non_approval' as const, value: commandReceipt, mutation: completion};
  };

  const run = async (
    transaction: CanonicalCommandTransaction,
    claimToken: ReceiptClaimToken,
    claim: CommandReceiptClaim,
    command: CanonicalCommand
  ) => {
    const routine = authorize(command.actor, routinePolicy);
    if (!routine.ok) {
      return completeNoMutation(
        transaction, claimToken, claim, command, commandTarget(command), routine, 'write',
        routine.error.code === 'POLICY_DENIED' ? 'deny' : undefined
      );
    }
    switch (command.type) {
      case 'work_item.transition': return workItemTransition(transaction, claimToken, claim, command);
      case 'work_item.set_blocked': return workItemBlocked(transaction, claimToken, claim, command);
      case 'task_packet.create': return taskPacketCreate(transaction, claimToken, claim, command);
      case 'agent_run.queue': return agentRunQueue(transaction, claimToken, claim, command);
      case 'agent_run.transition': return agentRunTransition(transaction, claimToken, claim, command);
      case 'approval.request': return approvalRequest(transaction, claimToken, claim, command);
      case 'approval.decide': return approvalDecide(transaction, claimToken, claim, command);
      case 'access_request.request': return accessRequestCreate(transaction, claimToken, claim, command);
      case 'access_request.decide': return accessRequestDecide(transaction, claimToken, claim, command);
    }
    return assertNever(command);
  };

  const service: CanonicalCommandService = {
    async execute(command: CanonicalCommand): Promise<CanonicalCommandExecution> {
      if (!isCommandShape(command)) return {status: 'rejected', error: error('Command is not canonical.').error};
      const claim = claimFor(command, clock.now());
      const execution = await input.unitOfWork.executeCommand(claim, (transaction, token) =>
        run(transaction, token, claim, command)
      );
      if (execution.status === 'replayed') return {status: 'replayed', receipt: execution.receipt};
      if (execution.status === 'key_reused') {
        return {status: 'key_reused', error: {code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was already used for a different request.'}};
      }
      const commandReceipt = execution.command.kind === 'approval_required'
        ? approvalRequiredReceipt(claim, command.type === 'approval.request' ? command.payload.approvalId : '')
        : execution.command.value;
      return {status: 'completed', receipt: commandReceipt};
    }
  };

  async function workItemTransition(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim,
    command: Extract<CanonicalCommand, {type: 'work_item.transition'}>
  ) {
    const target = targetFor('work_item', command.payload.workItemId, command.payload.expectedVersion);
    const item = await transaction.loadWorkItem(token, command.payload.workItemId);
    if (item === null) return completeNoMutation(transaction, token, claim, command, target, failed('NOT_FOUND', 'Resource was not found.'));
    if (item.version !== command.payload.expectedVersion) {
      return completeNoMutation(transaction, token, claim, command, targetFor('work_item', item.id, command.payload.expectedVersion, item.version), failed('VERSION_CONFLICT', 'Resource version conflicts with the command.'));
    }
    const transitioned = transitionWorkItem(item, command.payload.status);
    if (!transitioned.ok) return completeNoMutation(transaction, token, claim, command, target, transitioned);
    return mutateWorkItem(transaction, token, claim, command, item, transitioned.value);
  }

  async function workItemBlocked(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim,
    command: Extract<CanonicalCommand, {type: 'work_item.set_blocked'}>
  ) {
    const target = targetFor('work_item', command.payload.workItemId, command.payload.expectedVersion);
    const item = await transaction.loadWorkItem(token, command.payload.workItemId);
    if (item === null) return completeNoMutation(transaction, token, claim, command, target, failed('NOT_FOUND', 'Resource was not found.'));
    if (item.version !== command.payload.expectedVersion) {
      return completeNoMutation(transaction, token, claim, command, targetFor('work_item', item.id, command.payload.expectedVersion, item.version), failed('VERSION_CONFLICT', 'Resource version conflicts with the command.'));
    }
    const updated = setWorkItemBlocked(item, command.payload.blocked);
    if (!updated.ok) return completeNoMutation(transaction, token, claim, command, target, updated);
    if (updated.value === item) {
      const noOpTarget = targetFor('work_item', item.id, item.version, item.version);
      return completeNoMutation(transaction, token, claim, command, noOpTarget, succeeded(compactWorkItem(item)));
    }
    return mutateWorkItem(transaction, token, claim, command, item, updated.value);
  }

  async function mutateWorkItem(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim, command: CanonicalCommand,
    original: WorkItem, updated: WorkItem
  ) {
    const target = targetFor('work_item', updated.id, original.version, updated.version);
    return completeMutation(transaction, token, claim, command, {
      kind: 'non_approval',
      mutation: {aggregateType: 'work_item', aggregateId: updated.id, expectedPersistedVersion: original.version, aggregate: updated},
      audit: audit(claim, ids, clock, target, command.actor.actorId, command.type, 'write', succeeded(compactWorkItem(updated)))
    }, target, succeeded(compactWorkItem(updated)));
  }

  async function taskPacketCreate(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim,
    command: Extract<CanonicalCommand, {type: 'task_packet.create'}>
  ) {
    const target = targetFor('task_packet', command.payload.packetId, undefined, 1);
    const packet = createTaskPacket(command.payload.packetId, command.payload.content);
    if (!packet.ok) return completeNoMutation(transaction, token, claim, command, targetFor('task_packet', command.payload.packetId), packet);
    return mutatePacket(transaction, token, claim, command, packet.value, target);
  }

  async function mutatePacket(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim,
    command: CanonicalCommand, packet: TaskPacket, target: Target
  ) {
    const value = succeeded({id: packet.packetId, contentHash: packet.contentHash});
    return completeMutation(transaction, token, claim, command, {
      kind: 'non_approval',
      mutation: {aggregateType: 'task_packet', aggregateId: packet.packetId, expectedPersistedVersion: null, aggregate: packet},
      audit: audit(claim, ids, clock, target, command.actor.actorId, command.type, 'write', value)
    }, target, value);
  }

  async function agentRunQueue(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim,
    command: Extract<CanonicalCommand, {type: 'agent_run.queue'}>
  ) {
    const run: AgentRun = {
      id: command.payload.agentRunId,
      taskPacketId: command.payload.taskPacketId,
      agentProfileId: command.payload.agentProfileId,
      status: 'queued',
      idempotencyKey: command.idempotencyKey,
      version: 1
    };
    const target = targetFor('agent_run', run.id, undefined, run.version);
    const value = succeeded(compactAgentRun(run));
    return completeMutation(transaction, token, claim, command, {
      kind: 'non_approval', mutation: {aggregateType: 'agent_run', aggregateId: run.id, expectedPersistedVersion: null, aggregate: run},
      audit: audit(claim, ids, clock, target, command.actor.actorId, command.type, 'write', value)
    }, target, value);
  }

  async function agentRunTransition(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim,
    command: Extract<CanonicalCommand, {type: 'agent_run.transition'}>
  ) {
    const target = targetFor('agent_run', command.payload.agentRunId, command.payload.expectedVersion);
    const view = await transaction.loadAgentRun(token, command.payload.agentRunId);
    if (view === null) return completeNoMutation(transaction, token, claim, command, target, failed('NOT_FOUND', 'Resource was not found.'));
    if (view.aggregate.version !== command.payload.expectedVersion) {
      return completeNoMutation(transaction, token, claim, command, targetFor('agent_run', view.aggregate.id, command.payload.expectedVersion, view.aggregate.version), failed('VERSION_CONFLICT', 'Resource version conflicts with the command.'));
    }
    const updated = transitionAgentRun(view.aggregate, command.payload.status);
    if (!updated.ok) return completeNoMutation(transaction, token, claim, command, target, updated);
    const resultTarget = targetFor('agent_run', updated.value.id, view.aggregate.version, updated.value.version);
    const value = succeeded(compactAgentRun(updated.value));
    return completeMutation(transaction, token, claim, command, {
      kind: 'non_approval', mutation: {aggregateType: 'agent_run', aggregateId: updated.value.id, expectedPersistedVersion: view.aggregate.version, aggregate: updated.value},
      audit: audit(claim, ids, clock, resultTarget, command.actor.actorId, command.type, 'write', value)
    }, resultTarget, value);
  }

  async function approvalRequest(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim,
    command: Extract<CanonicalCommand, {type: 'approval.request'}>
  ) {
    const requested = authorize(command.actor, command.payload.action);
    const target = targetFor('approval', command.payload.approvalId);
    if (requested.ok) return completeNoMutation(transaction, token, claim, command, target, failed('INVALID_COMMAND', 'Approval is unnecessary because the action is allowed.'), command.payload.action.actionCategory, 'allow');
    if (requested.error.code !== 'APPROVAL_REQUIRED') {
      return completeNoMutation(transaction, token, claim, command, target, requested, command.payload.action.actionCategory,
        requested.error.code === 'POLICY_DENIED' ? 'deny' : undefined);
    }
    const project = await approvalProject(transaction, token, command.payload.target);
    if (project === null) return completeNoMutation(transaction, token, claim, command, targetFor(target.aggregateType, target.aggregateId), failed('NOT_FOUND', 'Resource was not found.'), command.payload.action.actionCategory);
    const approval: Approval = {
      id: command.payload.approvalId,
      projectId: project,
      ...command.payload.target,
      actionCategory: command.payload.action.actionCategory,
      surface: command.payload.action.surface,
      environment: command.payload.action.environment,
      requestedByActorId: command.actor.actorId,
      status: 'pending',
      version: 1
    };
    const approvalTarget = targetFor('approval', approval.id, undefined, 1);
    const commandReceipt = receipt(claim, approvalTarget, failed('APPROVAL_REQUIRED', 'Approval is required.'));
    const persisted = await transaction.persistApprovalRequired({
      claimToken: token,
      outcome: {
        kind: 'approval_required',
        approval: {aggregateType: 'approval', aggregateId: approval.id, expectedPersistedVersion: null, aggregate: approval},
        audit: {
          ...audit(claim, ids, clock, approvalTarget, command.actor.actorId, command.type, command.payload.action.actionCategory,
            failed('INVALID_COMMAND', 'Approval is required.')),
          policyDecision: 'ask', outcome: 'approval_required', reasonCode: 'APPROVAL_REQUIRED'
        },
        receipt: commandReceipt as unknown as import('@fai-control-plane/domain').ApprovalRequiredReceipt
      }
    });
    if (persisted.status === 'completed') return persisted.command;
    return completeNoMutation(transaction, token, claim, command, targetFor('approval', approval.id),
      failed(persisted.status === 'not_found' ? 'NOT_FOUND' : 'VERSION_CONFLICT',
        persisted.status === 'not_found' ? 'Resource was not found.' : 'Resource version conflicts with the command.'),
      command.payload.action.actionCategory);
  }

  async function approvalProject(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, target: ApprovalTarget
  ): Promise<string | null> {
    if (target.workItemId !== undefined) return (await transaction.loadWorkItem(token, target.workItemId))?.projectId ?? null;
    return (await transaction.loadAgentRun(token, target.agentRunId))?.projectId ?? null;
  }

  async function approvalDecide(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim,
    command: Extract<CanonicalCommand, {type: 'approval.decide'}>
  ) {
    const target = targetFor('approval', command.payload.approvalId, command.payload.expectedVersion);
    const approval = await transaction.loadApproval(token, command.payload.approvalId);
    if (approval === null) return completeNoMutation(transaction, token, claim, command, target, failed('NOT_FOUND', 'Resource was not found.'));
    if (approval.version !== command.payload.expectedVersion) return completeNoMutation(transaction, token, claim, command,
      targetFor('approval', approval.id, command.payload.expectedVersion, approval.version), failed('VERSION_CONFLICT', 'Resource version conflicts with the command.'));
    const updated = transitionApproval(approval, command.payload.status);
    if (!updated.ok) return completeNoMutation(transaction, token, claim, command, target, updated);
    const resultTarget = targetFor('approval', updated.value.id, approval.version, updated.value.version);
    const value = succeeded(compactApproval(updated.value));
    return completeMutation(transaction, token, claim, command, {
      kind: 'non_approval', mutation: {aggregateType: 'approval', aggregateId: updated.value.id, expectedPersistedVersion: approval.version, aggregate: updated.value},
      audit: audit(claim, ids, clock, resultTarget, command.actor.actorId, command.type, 'write', value)
    }, resultTarget, value);
  }

  async function accessRequestCreate(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim,
    command: Extract<CanonicalCommand, {type: 'access_request.request'}>
  ) {
    const request: AccessRequest = {
      id: command.payload.requestId,
      workspaceId: command.workspaceId,
      requesterActorId: command.actor.actorId,
      targetSurface: command.payload.targetSurface as AccessRequest['targetSurface'],
      requestedScope: [...command.payload.requestedScope],
      status: 'pending', version: 1
    };
    const target = targetFor('access_request', request.id, undefined, 1);
    const value = succeeded(compactAccessRequest(request));
    return completeMutation(transaction, token, claim, command, {
      kind: 'non_approval', mutation: {aggregateType: 'access_request', aggregateId: request.id, expectedPersistedVersion: null, aggregate: request},
      audit: audit(claim, ids, clock, target, command.actor.actorId, command.type, 'write', value)
    }, target, value);
  }

  async function accessRequestDecide(
    transaction: CanonicalCommandTransaction, token: ReceiptClaimToken, claim: CommandReceiptClaim,
    command: Extract<CanonicalCommand, {type: 'access_request.decide'}>
  ) {
    const target = targetFor('access_request', command.payload.requestId, command.payload.expectedVersion);
    const request = await transaction.loadAccessRequest(token, command.payload.requestId);
    if (request === null) return completeNoMutation(transaction, token, claim, command, target, failed('NOT_FOUND', 'Resource was not found.'));
    if (request.version !== command.payload.expectedVersion) return completeNoMutation(transaction, token, claim, command,
      targetFor('access_request', request.id, command.payload.expectedVersion, request.version), failed('VERSION_CONFLICT', 'Resource version conflicts with the command.'));
    const updated = transitionAccessRequest(request, command.payload.status);
    if (!updated.ok) return completeNoMutation(transaction, token, claim, command, target, updated);
    const resultTarget = targetFor('access_request', updated.value.id, request.version, updated.value.version);
    const value = succeeded(compactAccessRequest(updated.value));
    return completeMutation(transaction, token, claim, command, {
      kind: 'non_approval', mutation: {aggregateType: 'access_request', aggregateId: updated.value.id, expectedPersistedVersion: request.version, aggregate: updated.value},
      audit: audit(claim, ids, clock, resultTarget, command.actor.actorId, command.type, 'write', value)
    }, resultTarget, value);
  }

  return service;
};

const commandTarget = (command: CanonicalCommand): Target => {
  switch (command.type) {
    case 'work_item.transition':
    case 'work_item.set_blocked': return targetFor('work_item', command.payload.workItemId, command.payload.expectedVersion);
    case 'task_packet.create': return targetFor('task_packet', command.payload.packetId);
    case 'agent_run.queue': return targetFor('agent_run', command.payload.agentRunId);
    case 'agent_run.transition': return targetFor('agent_run', command.payload.agentRunId, command.payload.expectedVersion);
    case 'approval.request':
    case 'approval.decide': return targetFor('approval', command.payload.approvalId,
      command.type === 'approval.decide' ? command.payload.expectedVersion : undefined);
    case 'access_request.request': return targetFor('access_request', command.payload.requestId);
    case 'access_request.decide': return targetFor('access_request', command.payload.requestId, command.payload.expectedVersion);
  }
  return assertNever(command);
};

const approvalRequiredReceipt = (claim: CommandReceiptClaim, approvalId: string): CommandReceipt =>
  receipt(claim, targetFor('approval', approvalId, undefined, 1), failed('APPROVAL_REQUIRED', 'Approval is required.'));
const compactWorkItem = (item: WorkItem): CanonicalJson => ({id: item.id, status: item.status, version: item.version});
const compactAgentRun = (run: AgentRun): CanonicalJson => ({id: run.id, status: run.status, version: run.version});
const compactApproval = (approval: Approval): CanonicalJson => ({id: approval.id, status: approval.status, version: approval.version});
const compactAccessRequest = (request: AccessRequest): CanonicalJson => ({id: request.id, status: request.status, version: request.version});
