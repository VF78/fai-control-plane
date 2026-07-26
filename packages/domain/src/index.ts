import {createHash} from 'node:crypto';

export const workItemStatuses = ['backlog', 'ready', 'in_dev', 'qa', 'acceptance', 'done'] as const;
export type WorkItemStatus = (typeof workItemStatuses)[number];

export const agentRunStatuses = ['queued', 'running', 'waiting_approval', 'done', 'failed'] as const;
export type AgentRunStatus = (typeof agentRunStatuses)[number];

export const approvalStatuses = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

export const accessRequestStatuses = ['pending', 'granted', 'rejected', 'expired'] as const;
export type AccessRequestStatus = (typeof accessRequestStatuses)[number];

export const actionCategories = [
  'read',
  'write',
  'delete',
  'external_message',
  'deploy',
  'access_change',
  'critical_config',
  'customer_data_touch'
] as const;
export type ActionCategory = (typeof actionCategories)[number];

export const actorTypes = ['human', 'agent', 'system'] as const;
export type ActorType = (typeof actorTypes)[number];

export const policySurfaces = [
  'control_plane',
  'tracker',
  'chat',
  'repository',
  'runner',
  'artifact_store',
  'secrets',
  'worktree'
] as const;
export type PolicySurface = (typeof policySurfaces)[number];

export const environments = ['local', 'development', 'staging', 'production'] as const;
export type Environment = (typeof environments)[number];

export const policyDecisions = ['allow', 'ask', 'deny'] as const;
export type PolicyDecision = (typeof policyDecisions)[number];

export const commandErrorCodes = [
  'INVALID_COMMAND',
  'INVALID_TRANSITION',
  'WORK_ITEM_BLOCKED',
  'POLICY_DENIED',
  'CAPABILITY_DENIED',
  'APPROVAL_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'VERSION_CONFLICT',
  'SECRET_VALUE_FORBIDDEN',
  'INVALID_TASK_PACKET',
  'INVALID_ACTOR_CONTEXT',
  'NOT_FOUND'
] as const;
export type CommandErrorCode = (typeof commandErrorCodes)[number];

export type CommandError = Readonly<{code: CommandErrorCode; message: string}>;
export type CommandResult<T> =
  | Readonly<{ok: true; value: T}>
  | Readonly<{ok: false; error: CommandError}>;

const succeeded = <T>(value: T): CommandResult<T> => ({ok: true, value});
const failed = <T>(code: CommandErrorCode, message: string): CommandResult<T> => ({
  ok: false,
  error: {code, message}
});

export type WorkItem = Readonly<{
  id: string;
  projectId: string;
  status: WorkItemStatus;
  blocked: boolean;
  version: number;
}>;

export type AgentRun = Readonly<{
  id: string;
  taskPacketId: string;
  agentProfileId: string;
  confirmedPacketHash: string;
  baseCommit: string;
  status: AgentRunStatus;
  idempotencyKey: string;
  version: number;
}>;
export type AgentRunView = Readonly<{
  aggregate: AgentRun;
  projectId: string;
}>;

export type RunnerRepositoryAuthorization = Readonly<{
  owner: string;
  name: string;
}>;
export type RunnerClaimAuthorization = Readonly<{
  workspaceId: string;
  runnerId: string;
  projectIds: readonly string[];
  repositories: readonly RunnerRepositoryAuthorization[];
  runtimeIds: readonly string[];
}>;
export type RunnerClaimRecord = Readonly<{
  runId: string;
  attempt: number;
  packetId: string;
  packetHash: string;
  repository: RunnerRepositoryAuthorization;
  baseCommit: string;
  runtimeProfile: string;
  timeboxMinutes: number;
  promptFields: Readonly<{
    goal: string;
    acceptanceCriteria: readonly string[];
    inScope: readonly string[];
    outOfScope: readonly string[];
    relevantLinks: readonly string[];
    relevantFiles: readonly string[];
    allowedTools: readonly string[];
    forbiddenSurfaces: readonly string[];
    dataPolicy: CanonicalJson;
    expectedOutputSchema: CanonicalJson;
  }>;
}>;
export type RunnerClaimLeaseInput = RunnerClaimAuthorization & Readonly<{
  leaseTokenHash: string;
  claimedAt: Date;
  leaseExpiresAt: Date;
}>;
export interface RunnerClaimStore {
  claim<T>(
    input: RunnerClaimLeaseInput,
    prepare: (record: RunnerClaimRecord) => T
  ): Promise<T | null>;
}

export type RunnerLeaseInput = RunnerClaimAuthorization & Readonly<{
  runId: string;
  attempt: number;
  leaseTokenHash: string;
  at: Date;
  leaseExpiresAt: Date;
}>;
export type RunnerHeartbeatResult = Readonly<{
  status: 'extended' | 'unchanged' | 'denied';
  leaseExpiresAt?: Date;
}>;
export type RunnerCompletionInput = RunnerClaimAuthorization & Readonly<{
  runId: string;
  attempt: number;
  leaseTokenHash: string;
  completionReplayHash: string;
  terminal: 'done' | 'failed';
  receiptSha256: string;
  receiptSizeBytes: number;
  metadata: CanonicalJson;
  at: Date;
}>;
export type RunnerCompletionResult = Readonly<{
  status: 'completed' | 'replayed' | 'denied' | 'conflict';
  terminal?: 'done' | 'failed';
  completedAt?: Date;
}>;
export interface RunnerTransportStore extends RunnerClaimStore {
  heartbeat(input: RunnerLeaseInput): Promise<RunnerHeartbeatResult>;
  complete(input: RunnerCompletionInput): Promise<RunnerCompletionResult>;
}

export type ApprovalTarget =
  | Readonly<{workItemId: string; agentRunId?: never}>
  | Readonly<{workItemId?: never; agentRunId: string}>;
export type ApprovalBindingRequest = Readonly<{
  subjectHash: string;
  expectedPolicyVersion: number;
  executionIdentity: string;
  expiresAt: string;
}>;
export type ApprovalBinding = Readonly<{
  subjectHash: string;
  policyVersion: number;
  executionIdentity: string;
  actorId: string;
  expiresAt: string;
  actionHash: string;
}>;
export type ApprovalBindingFields = Readonly<Omit<ApprovalBinding, 'actionHash'>>;
export type Approval = Readonly<{
  id: string;
  projectId: string;
  actionCategory: ActionCategory;
  surface: PolicySurface;
  environment: Environment;
  requestedByActorId: string;
  binding: ApprovalBinding;
  decidedByActorId?: string;
  decidedAt?: string;
  status: ApprovalStatus;
  version: number;
}> & ApprovalTarget;
export type ApprovalReceipt = Readonly<{
  id: string;
  status: ApprovalStatus;
  version: number;
  binding: ApprovalBinding;
  decidedByActorId?: string;
  decidedAt?: string;
}>;
export type AccessRequest = Readonly<{
  id: string;
  workspaceId: string;
  requesterActorId: string;
  targetSurface: PolicySurface;
  requestedScope: readonly string[];
  status: AccessRequestStatus;
  version: number;
}>;

type TransitionMap<T extends string> = Readonly<Record<T, readonly T[]>>;

const workItemTransitions: TransitionMap<WorkItemStatus> = {
  backlog: ['ready'],
  ready: ['backlog', 'in_dev'],
  in_dev: ['ready', 'qa'],
  qa: ['in_dev', 'acceptance'],
  acceptance: ['in_dev', 'done'],
  done: []
};
const agentRunTransitions: TransitionMap<AgentRunStatus> = {
  queued: ['running', 'failed'],
  running: ['waiting_approval', 'done', 'failed'],
  waiting_approval: ['running', 'failed'],
  done: [],
  failed: []
};
const approvalTransitions: TransitionMap<ApprovalStatus> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: []
};
const accessRequestTransitions: TransitionMap<AccessRequestStatus> = {
  pending: ['granted', 'rejected', 'expired'],
  granted: [],
  rejected: [],
  expired: []
};

const canTransition = <T extends string>(
  map: TransitionMap<T>,
  from: T,
  to: T
): boolean => map[from].includes(to);

const workItemStatusIndex = (status: WorkItemStatus): number => workItemStatuses.indexOf(status);

export const transitionWorkItem = (
  workItem: WorkItem,
  status: WorkItemStatus
): CommandResult<WorkItem> => {
  if (!canTransition(workItemTransitions, workItem.status, status)) {
    return failed('INVALID_TRANSITION', `Work item cannot transition from ${workItem.status} to ${status}.`);
  }
  if (workItem.blocked && workItemStatusIndex(status) > workItemStatusIndex(workItem.status)) {
    return failed('WORK_ITEM_BLOCKED', 'Blocked work items cannot advance until they are unblocked.');
  }
  return succeeded({...workItem, status, version: workItem.version + 1});
};

export const setWorkItemBlocked = (
  workItem: WorkItem,
  blocked: boolean
): CommandResult<WorkItem> =>
  succeeded(blocked === workItem.blocked ? workItem : {...workItem, blocked, version: workItem.version + 1});

export const transitionAgentRun = (
  agentRun: AgentRun,
  status: AgentRunStatus
): CommandResult<AgentRun> =>
  canTransition(agentRunTransitions, agentRun.status, status)
    ? succeeded({...agentRun, status, version: agentRun.version + 1})
    : failed('INVALID_TRANSITION', `Agent run cannot transition from ${agentRun.status} to ${status}.`);

export const transitionApproval = (
  approval: Approval,
  status: ApprovalStatus
): CommandResult<Approval> =>
  canTransition(approvalTransitions, approval.status, status)
    ? succeeded({...approval, status, version: approval.version + 1})
    : failed('INVALID_TRANSITION', `Approval cannot transition from ${approval.status} to ${status}.`);

export const transitionAccessRequest = (
  request: AccessRequest,
  status: AccessRequestStatus
): CommandResult<AccessRequest> =>
  canTransition(accessRequestTransitions, request.status, status)
    ? succeeded({...request, status, version: request.version + 1})
    : failed('INVALID_TRANSITION', `Access request cannot transition from ${request.status} to ${status}.`);

export type Capability = `${ActionCategory}:${PolicySurface}:${Environment}`;
const trustedActorBrand = Symbol('trustedActor');
type TrustedActorBrand = {[trustedActorBrand]: true};
const trustedActorContexts = new WeakSet<object>();

export type TrustedUserActorContext = Readonly<{
  kind: 'trusted_user';
  actorId: string;
  actorType: 'human';
  capabilities: readonly Capability[];
}> & TrustedActorBrand;

export type TrustedAgentActorContext = Readonly<{
  kind: 'trusted_agent';
  actorId: string;
  actorType: 'agent';
  delegatedBy: TrustedUserActorContext;
  capabilities: readonly Capability[];
}> & TrustedActorBrand;

export type TrustedSystemActorContext = Readonly<{
  kind: 'trusted_system';
  actorId: string;
  actorType: 'system';
  capabilities: readonly Capability[];
}> & TrustedActorBrand;

export type TrustedActorContext =
  | TrustedUserActorContext
  | TrustedAgentActorContext
  | TrustedSystemActorContext;
export type ActorGrant = Readonly<{actorId: string; capabilities: readonly Capability[]}>;
export type AgentGrant = ActorGrant & Readonly<{delegatedByActorIds: readonly string[]}>;
export type ActorContextAuthorityConfig = Readonly<{
  users: readonly ActorGrant[];
  agents: readonly AgentGrant[];
  systems: readonly ActorGrant[];
}>;
export type ActorContextIssuer = Readonly<{
  issueUser(actorId: string): CommandResult<TrustedUserActorContext>;
  issueAgent(input: Readonly<{
    actorId: string;
    delegatedBy: TrustedUserActorContext;
  }>): CommandResult<TrustedAgentActorContext>;
  issueSystem(actorId: string): CommandResult<TrustedSystemActorContext>;
}>;

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);
const isCapability = (value: unknown): value is Capability => {
  if (typeof value !== 'string') return false;
  const [actionCategory, surface, environment, extra] = value.split(':');
  return extra === undefined && isOneOf(actionCategories, actionCategory) &&
    isOneOf(policySurfaces, surface) && isOneOf(environments, environment);
};
const isDenseArray = (value: unknown): value is readonly unknown[] => {
  try {
    return Array.isArray(value) && Object.keys(value).length === value.length &&
      Array.from({length: value.length}, (_, index) => Object.hasOwn(value, index)).every(Boolean);
  } catch {
    return false;
  }
};

const canonicalCapabilities = (value: unknown): readonly Capability[] | null => {
  if (!isDenseArray(value) || !value.every(isCapability)) return null;
  return Object.freeze([...new Set(value)].sort());
};

const registeredContext = <T extends TrustedActorContext>(
  contexts: WeakSet<object>,
  context: T
): T => {
  trustedActorContexts.add(context);
  contexts.add(context);
  return context;
};

const actorContextConfigError = <T>(): CommandResult<T> =>
  failed('INVALID_ACTOR_CONTEXT', 'Actor authority grants must use unique, configured identities and valid capabilities.');

/**
 * This is an in-process authority boundary. The trusted composition root creates
 * an issuer once from authoritative grants and keeps it out of request-derived
 * code. It is not a security boundary against malicious application code that
 * can import modules or tamper with the running JavaScript process.
 */
export const createActorContextIssuer = (
  config: ActorContextAuthorityConfig
): CommandResult<ActorContextIssuer> => {
  if (!isPlainObject(config) || !isDenseArray(config.users) || !isDenseArray(config.agents) ||
    !isDenseArray(config.systems)) return actorContextConfigError();

  const identities = new Set<string>();
  const grants = (entries: readonly ActorGrant[]): Map<string, readonly Capability[]> | null => {
    const result = new Map<string, readonly Capability[]>();
    for (const entry of entries) {
      if (!isPlainObject(entry) || !hasNonEmptyString(entry.actorId) || identities.has(entry.actorId)) return null;
      const capabilities = canonicalCapabilities(entry.capabilities);
      if (capabilities === null) return null;
      identities.add(entry.actorId);
      result.set(entry.actorId, capabilities);
    }
    return result;
  };
  const users = grants(config.users);
  const agents = grants(config.agents);
  const systems = grants(config.systems);
  if (users === null || agents === null || systems === null) return actorContextConfigError();

  const agentDelegators = new Map<string, ReadonlySet<string>>();
  for (const agent of config.agents) {
    if (!isDenseArray(agent.delegatedByActorIds) || agent.delegatedByActorIds.length === 0 ||
      !agent.delegatedByActorIds.every((actorId) => hasNonEmptyString(actorId) && users.has(actorId))) {
      return actorContextConfigError();
    }
    agentDelegators.set(agent.actorId, new Set(agent.delegatedByActorIds));
  }

  const issuerContexts = new WeakSet<object>();
  const user = (actorId: string): CommandResult<TrustedUserActorContext> => {
    const capabilities = users.get(actorId);
    if (capabilities === undefined) {
      return failed('INVALID_ACTOR_CONTEXT', 'User actor is not configured by the authority.');
    }
    return succeeded(registeredContext(issuerContexts, Object.freeze({
      kind: 'trusted_user', actorId, actorType: 'human', capabilities, [trustedActorBrand]: true
    }) as TrustedUserActorContext));
  };
  const agent = (input: Readonly<{
    actorId: string;
    delegatedBy: TrustedUserActorContext;
  }>): CommandResult<TrustedAgentActorContext> => {
    const capabilities = agents.get(input.actorId);
    const allowedDelegators = agentDelegators.get(input.actorId);
    if (capabilities === undefined || allowedDelegators === undefined ||
      !issuerContexts.has(input.delegatedBy) || !isTrustedUserContext(input.delegatedBy) ||
      !allowedDelegators.has(input.delegatedBy.actorId)) {
      return failed('INVALID_ACTOR_CONTEXT', 'Agent actor or delegating user is not configured by the authority.');
    }
    return succeeded(registeredContext(issuerContexts, Object.freeze({
      kind: 'trusted_agent', actorId: input.actorId, actorType: 'agent', delegatedBy: input.delegatedBy,
      capabilities, [trustedActorBrand]: true
    }) as TrustedAgentActorContext));
  };
  const system = (actorId: string): CommandResult<TrustedSystemActorContext> => {
    const capabilities = systems.get(actorId);
    if (capabilities === undefined) {
      return failed('INVALID_ACTOR_CONTEXT', 'System actor is not configured by the authority.');
    }
    return succeeded(registeredContext(issuerContexts, Object.freeze({
      kind: 'trusted_system', actorId, actorType: 'system', capabilities, [trustedActorBrand]: true
    }) as TrustedSystemActorContext));
  };
  return succeeded(Object.freeze({issueUser: user, issueAgent: agent, issueSystem: system}));
};

const hasCanonicalCapabilities = (value: unknown): value is readonly Capability[] =>
  isDenseArray(value) && Object.isFrozen(value) && value.every(isCapability) &&
  value.every((capability, index) => index === 0 || value[index - 1]! < capability);

export const isTrustedActorContext = (value: unknown): value is TrustedActorContext => {
  if (typeof value !== 'object' || value === null || !trustedActorContexts.has(value)) return false;
  try {
    if (!Object.isFrozen(value) || (value as TrustedActorContext)[trustedActorBrand] !== true) return false;
    const context = value as TrustedActorContext;
    if (!hasNonEmptyString(context.actorId) || !hasCanonicalCapabilities(context.capabilities)) return false;
    if (context.kind === 'trusted_user') return context.actorType === 'human';
    if (context.kind === 'trusted_system') return context.actorType === 'system';
    return context.kind === 'trusted_agent' && context.actorType === 'agent' &&
      isTrustedUserContext(context.delegatedBy);
  } catch {
    return false;
  }
};

const isTrustedUserContext = (value: unknown): value is TrustedUserActorContext =>
  isTrustedActorContext(value) && value.kind === 'trusted_user';

export type PolicyRequest = Readonly<{
  actionCategory: ActionCategory;
  surface: PolicySurface;
  environment: Environment;
}>;

export type PolicyMatrix = Readonly<Record<ActorType, Readonly<Record<
  ActionCategory,
  Readonly<Record<PolicySurface, Readonly<Record<Environment, PolicyDecision>>>>
>>>>;

const approvalActions = new Set<ActionCategory>([
  'deploy',
  'external_message',
  'access_change',
  'critical_config',
  'customer_data_touch'
]);
export const safePacketSurfaces = ['artifact_store', 'worktree'] as const satisfies readonly PolicySurface[];
const safePacketSurfaceSet = new Set<PolicySurface>(safePacketSurfaces);

const defaultDecision = (
  actorType: ActorType,
  actionCategory: ActionCategory,
  surface: PolicySurface,
  environment: Environment
): PolicyDecision => {
  if (approvalActions.has(actionCategory)) return 'ask';
  if (actorType === 'system') {
    return actionCategory === 'read' && surface === 'control_plane' ? 'allow' : 'deny';
  }
  if (actionCategory === 'delete') return actorType === 'human' ? 'ask' : 'deny';
  if (environment === 'production') {
    if (actionCategory === 'read') {
      if (actorType === 'human') return 'allow';
      return actorType === 'agent' && safePacketSurfaceSet.has(surface) ? 'allow' : 'deny';
    }
    return 'deny';
  }
  if (actorType === 'human') {
    return actionCategory === 'read' || actionCategory === 'write' ? 'allow' : 'deny';
  }
  if (actorType === 'agent') {
    if (actionCategory === 'read') {
      return ['tracker', 'repository', 'artifact_store', 'worktree'].includes(surface) ? 'allow' : 'deny';
    }
    return actionCategory === 'write' && surface === 'worktree' ? 'allow' : 'deny';
  }
  return 'deny';
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const buildPolicyMatrix = (): PolicyMatrix => {
  const matrix = {} as Record<string, unknown>;
  for (const actorType of actorTypes) {
    matrix[actorType] = {};
    for (const actionCategory of actionCategories) {
      const actions = matrix[actorType] as Record<string, unknown>;
      actions[actionCategory] = {};
      for (const surface of policySurfaces) {
        const surfaces = actions[actionCategory] as Record<string, unknown>;
        surfaces[surface] = {};
        for (const environment of environments) {
          (surfaces[surface] as Record<string, PolicyDecision>)[environment] = defaultDecision(
            actorType, actionCategory, surface, environment
          );
        }
      }
    }
  }
  return deepFreeze(matrix) as PolicyMatrix;
};

export const CURRENT_POLICY_VERSION = 1 as const;
export const APPROVAL_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
export const policyMatrix = buildPolicyMatrix();
export const policyDecisionFor = (actorType: ActorType, request: PolicyRequest): PolicyDecision =>
  policyMatrix[actorType][request.actionCategory][request.surface][request.environment];

export const effectiveCapabilities = (
  context: TrustedActorContext
): CommandResult<readonly Capability[]> => {
  if (!isTrustedActorContext(context)) {
    return failed('INVALID_ACTOR_CONTEXT', 'Actor context must be created by a trusted context factory.');
  }
  if (context.kind === 'trusted_user' || context.kind === 'trusted_system') {
    return succeeded(context.capabilities);
  }
  const delegated = new Set(context.delegatedBy.capabilities);
  return succeeded(Object.freeze(context.capabilities.filter((capability) => delegated.has(capability))));
};

export const authorize = (
  context: TrustedActorContext,
  request: PolicyRequest
): CommandResult<PolicyDecision> => {
  const capabilities = effectiveCapabilities(context);
  if (!capabilities.ok) return capabilities;
  const capability = `${request.actionCategory}:${request.surface}:${request.environment}` as Capability;
  if (!capabilities.value.includes(capability)) {
    return failed('CAPABILITY_DENIED', 'Actor lacks the required capability.');
  }
  const decision = policyDecisionFor(context.actorType, request);
  if (decision === 'deny') return failed('POLICY_DENIED', 'Policy denies this action.');
  if (decision === 'ask') return failed('APPROVAL_REQUIRED', 'This action requires an approval.');
  return succeeded(decision);
};

export type CanonicalCommandEnvelope<TType extends string, TPayload> = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  issuedAt: string;
  actor: TrustedActorContext;
  type: TType;
  payload: TPayload;
}>;

export type TransitionWorkItemCommand = CanonicalCommandEnvelope<
  'work_item.transition',
  Readonly<{workItemId: string; status: WorkItemStatus; expectedVersion: number}>
>;
export type SetBlockedCommand = CanonicalCommandEnvelope<
  'work_item.set_blocked',
  Readonly<{workItemId: string; blocked: boolean; expectedVersion: number}>
>;
export type CreateTaskPacketCommand = CanonicalCommandEnvelope<
  'task_packet.create',
  Readonly<{packetId: string; content: TaskPacketContent}>
>;
export type QueueAgentRunCommand = CanonicalCommandEnvelope<
  'agent_run.queue',
  Readonly<{
    agentRunId: string;
    taskPacketId: string;
    agentProfileId: string;
    confirmedPacketHash: string;
    baseCommit: string;
  }>
>;
export type TransitionAgentRunCommand = CanonicalCommandEnvelope<
  'agent_run.transition',
  Readonly<{agentRunId: string; status: AgentRunStatus; expectedVersion: number}>
>;
export type RequestApprovalCommand = CanonicalCommandEnvelope<
  'approval.request',
  Readonly<{
    approvalId: string;
    action: PolicyRequest;
    target: ApprovalTarget;
    binding: ApprovalBindingRequest;
  }>
>;
export type DecideApprovalCommand = CanonicalCommandEnvelope<
  'approval.decide',
  Readonly<{
    approvalId: string;
    status: 'approved' | 'rejected';
    expectedVersion: number;
    expectedActionHash: string;
    expectedPolicyVersion: number;
  }>
>;
export type RequestAccessCommand = CanonicalCommandEnvelope<
  'access_request.request',
  Readonly<{requestId: string; targetSurface: PolicySurface; requestedScope: readonly string[]}>
>;
export type DecideAccessRequestCommand = CanonicalCommandEnvelope<
  'access_request.decide',
  Readonly<{requestId: string; status: Exclude<AccessRequestStatus, 'pending'>; expectedVersion: number}>
>;
export type CanonicalCommand =
  | TransitionWorkItemCommand
  | SetBlockedCommand
  | CreateTaskPacketCommand
  | QueueAgentRunCommand
  | TransitionAgentRunCommand
  | RequestApprovalCommand
  | DecideApprovalCommand
  | RequestAccessCommand
  | DecideAccessRequestCommand;

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | Readonly<{[key: string]: CanonicalJson}>;

export type GitHubIncomingEventSource = Readonly<{
  kind: 'github';
  installationId: string;
  repositoryId: string;
  projectNodeId: string;
}>;

export type TelegramIncomingEventSource = Readonly<{
  kind: 'telegram';
  messageId: string;
  chatId: string;
  userId: string;
}>;

export type IncomingEventSource =
  | GitHubIncomingEventSource
  | TelegramIncomingEventSource;

export type IncomingEvent = Readonly<{
  eventId: string;
  workspaceId: string;
  projectId: string;
  provider: string;
  deliveryId: string;
  eventType: string;
  action: string;
  receivedAt: string;
  payloadSha256: string;
  verification: Readonly<{
    outcome: 'verified';
    method: 'hmac-sha256' | 'shared-token';
  }>;
  source: IncomingEventSource;
  projection: Readonly<{[key: string]: CanonicalJson}>;
}>;

export type IncomingEventAcceptance =
  | Readonly<{status: 'accepted'; eventId: string}>
  | Readonly<{status: 'replayed'; eventId: string}>
  | Readonly<{status: 'collision'; eventId: string}>;

export interface IncomingEventInbox {
  accept(event: IncomingEvent): Promise<IncomingEventAcceptance>;
}

export type IncomingEventQueuePayload = Readonly<{eventId: string}>;

export type IncomingEventProcessingResult =
  | Readonly<{status: 'processed'; eventId: string}>
  | Readonly<{status: 'replayed'; eventId: string}>;

/**
 * Persists a sanitized inbox event as its sole canonical observation.
 * Implementations may reject while a live processor lease owns the event.
 */
export interface IncomingEventProcessor {
  process(eventId: string): Promise<IncomingEventProcessingResult>;
}

export interface IncomingEventQueueConsumer {
  consume(payload: unknown): Promise<IncomingEventProcessingResult>;
}

export type OpaqueSecretRef = Readonly<{
  provider: string;
  reference: string;
  scope: readonly string[];
}>;

export type TaskPacketContent = Readonly<{
  projectId: string;
  workItemId: string;
  workItemVersion: number;
  goal: string;
  acceptanceCriteria: readonly string[];
  inScope: readonly string[];
  outOfScope: readonly string[];
  relevantLinks: readonly string[];
  relevantFiles: readonly string[];
  allowedTools: readonly string[];
  forbiddenSurfaces: readonly string[];
  dataPolicy: CanonicalJson;
  timeboxMinutes: number;
  expectedOutputSchema: CanonicalJson;
  reviewerActorId: string;
  approverActorId: string;
  runtimeProfile: string;
  authMode: 'user' | 'agent' | 'system';
  secretsRef: OpaqueSecretRef | null;
  createdFromEventId: string;
  createdByActorId: string;
}>;

export type TaskPacket = Readonly<{
  packetId: string;
  content: TaskPacketContent;
  canonicalJson: string;
  contentHash: string;
}>;

export type TaskPacketConfirmationView = Readonly<{
  packetId: string;
  content: Readonly<Pick<TaskPacketContent, 'approverActorId'>>;
  contentHash: string;
}>;

const packetStringFields = [
  'projectId', 'workItemId', 'goal', 'reviewerActorId', 'approverActorId',
  'runtimeProfile', 'createdFromEventId', 'createdByActorId'
] as const satisfies readonly (keyof TaskPacketContent)[];
const packetPositiveIntegerFields = ['workItemVersion', 'timeboxMinutes'] as const satisfies readonly (keyof TaskPacketContent)[];
const packetArrayFields = [
  'acceptanceCriteria', 'inScope', 'outOfScope', 'relevantLinks', 'relevantFiles',
  'allowedTools', 'forbiddenSurfaces'
] as const satisfies readonly (keyof TaskPacketContent)[];
const taskPacketContentKeys = new Set<keyof TaskPacketContent>([
  ...packetStringFields,
  ...packetArrayFields,
  'dataPolicy',
  ...packetPositiveIntegerFields,
  'expectedOutputSchema',
  'authMode',
  'secretsRef'
]);
const secretKeyPattern = /secret(?!sref)|token|password|credential|api_?key|private_?key/i;
const opaqueSecretRefKeys = new Set(['provider', 'reference', 'scope']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  (() => {
    try {
      return typeof value === 'object' && value !== null && !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
    } catch {
      return false;
    }
  })();

const hasCyclicOrUnreadableInput = (
  value: unknown,
  ancestors = new WeakSet<object>(),
  visited = new WeakSet<object>()
): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  if (ancestors.has(value)) return true;
  if (visited.has(value)) return false;
  ancestors.add(value);
  try {
    for (const nested of Object.values(value)) {
      if (hasCyclicOrUnreadableInput(nested, ancestors, visited)) return true;
    }
  } catch {
    return true;
  } finally {
    ancestors.delete(value);
  }
  visited.add(value);
  return false;
};
const isCanonicalJson = (value: unknown): value is CanonicalJson => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return isDenseArray(value) && value.every(isCanonicalJson);
  return isPlainObject(value) && Object.values(value).every(isCanonicalJson);
};
const hasSecretValue = (value: unknown, inSecretRef = false): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasSecretValue(item, inSecretRef));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    if (key === 'secretsRef') return hasSecretValue(nested, true);
    if (!inSecretRef && secretKeyPattern.test(key)) return true;
    if (inSecretRef && !opaqueSecretRefKeys.has(key)) return true;
    return hasSecretValue(nested, inSecretRef);
  });
};
const isStringArray = (value: unknown): value is readonly string[] =>
  isDenseArray(value) && value.every(hasNonEmptyString);
const isOpaqueSecretRef = (value: unknown): value is OpaqueSecretRef =>
  isPlainObject(value) && Object.keys(value).length === 3 &&
  Object.keys(value).every((key) => opaqueSecretRefKeys.has(key)) &&
  hasNonEmptyString(value.provider) && hasNonEmptyString(value.reference) && isStringArray(value.scope);

export const canonicalJson = (value: CanonicalJson): string => {
  if (Array.isArray(value)) {
    if (!isDenseArray(value)) throw new TypeError('Canonical JSON cannot contain sparse arrays.');
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const objectValue = value as Readonly<Record<string, CanonicalJson>>;
    return `{${Object.keys(objectValue).sort().map((key) => {
      const nested = objectValue[key];
      if (nested === undefined) throw new TypeError('Canonical JSON cannot contain undefined.');
      return `${JSON.stringify(key)}:${canonicalJson(nested)}`;
    }).join(',')}}`;
  }
  return JSON.stringify(value);
};

const sha256Pattern = /^[0-9a-f]{64}$/;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const createApprovalBinding = (
  action: PolicyRequest,
  target: ApprovalTarget,
  request: ApprovalBindingRequest,
  actorId: string,
  now: Date
): CommandResult<ApprovalBinding> => {
  const nowMs = now.getTime();
  const expiresAtMs = new Date(request.expiresAt).getTime();
  if (!sha256Pattern.test(request.subjectHash)) {
    return failed('INVALID_COMMAND', 'Approval subject hash must be a lowercase SHA-256 digest.');
  }
  if (request.expectedPolicyVersion !== CURRENT_POLICY_VERSION) {
    return failed('VERSION_CONFLICT', 'Approval policy version is not current.');
  }
  if (!canonicalUuidPattern.test(request.executionIdentity) ||
    !canonicalUuidPattern.test(actorId) ||
    (target.agentRunId !== undefined && request.executionIdentity !== target.agentRunId)) {
    return failed('INVALID_COMMAND', 'Approval execution identity is invalid for the target.');
  }
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== request.expiresAt ||
    expiresAtMs <= nowMs || expiresAtMs - nowMs > APPROVAL_MAX_TTL_MS) {
    return failed('INVALID_COMMAND', 'Approval expiry must be future, canonical, and within the maximum TTL.');
  }

  const fields: ApprovalBindingFields = {
    subjectHash: request.subjectHash,
    policyVersion: CURRENT_POLICY_VERSION,
    executionIdentity: request.executionIdentity,
    actorId,
    expiresAt: request.expiresAt
  };
  const actionHash = computeApprovalActionHash(action, target, fields);
  return succeeded(deepFreeze({...fields, actionHash}));
};

export const computeApprovalActionHash = (
  action: PolicyRequest,
  target: ApprovalTarget,
  fields: ApprovalBindingFields
): string => {
  const hashInput: CanonicalJson = {
    bindingVersion: 1,
    policyRequest: {
      actionCategory: action.actionCategory,
      surface: action.surface,
      environment: action.environment
    },
    target: target.workItemId === undefined
      ? {agentRunId: target.agentRunId}
      : {workItemId: target.workItemId},
    binding: fields
  };
  return createHash('sha256').update(canonicalJson(hashInput)).digest('hex');
};

const cloneCanonicalJson = (value: CanonicalJson): CanonicalJson => JSON.parse(canonicalJson(value)) as CanonicalJson;
const cloneSecretRef = (value: OpaqueSecretRef | null): OpaqueSecretRef | null =>
  value === null ? null : {provider: value.provider, reference: value.reference, scope: [...value.scope]};

export const createTaskPacket = (packetId: string, content: TaskPacketContent): CommandResult<TaskPacket> => {
  if (!hasNonEmptyString(packetId) || !isPlainObject(content)) {
    return failed('INVALID_TASK_PACKET', 'Task packet ID and content are required.');
  }
  if (hasCyclicOrUnreadableInput(content)) {
    return failed('INVALID_TASK_PACKET', 'Task packet content must not contain cyclic data.');
  }
  if (hasSecretValue(content)) {
    return failed('SECRET_VALUE_FORBIDDEN', 'Task packets may contain opaque secret references but never secret values.');
  }
  const contentKeys = Object.keys(content);
  if (contentKeys.length !== taskPacketContentKeys.size ||
    !contentKeys.every((key) => taskPacketContentKeys.has(key as keyof TaskPacketContent))) {
    return failed('INVALID_TASK_PACKET', 'Task packet content must contain exactly the supported fields.');
  }
  if (!packetStringFields.every((field) => hasNonEmptyString(content[field]))) {
    return failed('INVALID_TASK_PACKET', 'Task packet required string fields must be non-empty.');
  }
  if (!packetArrayFields.every((field) => isStringArray(content[field]))) {
    return failed('INVALID_TASK_PACKET', 'Task packet required array fields must contain strings.');
  }
  if (!isCanonicalJson(content.dataPolicy) || !isCanonicalJson(content.expectedOutputSchema)) {
    return failed('INVALID_TASK_PACKET', 'Task packet JSON fields must be canonical JSON.');
  }
  if (!packetPositiveIntegerFields.every((field) =>
    Number.isSafeInteger(content[field]) && content[field] > 0
  ) ||
    !isOneOf(['user', 'agent', 'system'] as const, content.authMode) ||
    !(content.secretsRef === null || isOpaqueSecretRef(content.secretsRef))) {
    return failed('INVALID_TASK_PACKET', 'Task packet timebox, auth mode, or secret reference is invalid.');
  }
  const immutableContent = deepFreeze({
    ...content,
    acceptanceCriteria: [...content.acceptanceCriteria],
    inScope: [...content.inScope],
    outOfScope: [...content.outOfScope],
    relevantLinks: [...content.relevantLinks],
    relevantFiles: [...content.relevantFiles],
    allowedTools: [...content.allowedTools],
    forbiddenSurfaces: [...content.forbiddenSurfaces],
    dataPolicy: cloneCanonicalJson(content.dataPolicy),
    expectedOutputSchema: cloneCanonicalJson(content.expectedOutputSchema),
    secretsRef: cloneSecretRef(content.secretsRef)
  }) as TaskPacketContent;
  const serialized = canonicalJson(immutableContent);
  const contentHash = createHash('sha256').update(serialized).digest('hex');
  return succeeded(deepFreeze({packetId, content: immutableContent, canonicalJson: serialized, contentHash}));
};

export type TrackerCapabilities = Readonly<{
  readWorkItems: boolean;
  writeWorkItems: boolean;
  readPullRequests: boolean;
  readChecks: boolean;
}>;
export type TrackerRepositoryRef = Readonly<{
  owner: string;
  repository: string;
}>;
export type TrackerIdentity = Readonly<{
  externalId: string;
  login: string;
}>;
export type TrackerLabel = Readonly<{
  externalId: string;
  name: string;
  color: string;
}>;
export type TrackerMilestone = Readonly<{
  externalId: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
}>;
export type TrackerWorkItemSnapshot = Readonly<{
  externalId: string;
  externalVersion: string;
  url: string;
  htmlUrl: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: readonly TrackerLabel[];
  assignees: readonly TrackerIdentity[];
  milestone: TrackerMilestone | null;
  projectStatus: TrackerProjectStatusObservation | null;
}>;
/** A Project V2 Status observation, including an explicit unknown or missing option. */
export type TrackerProjectStatusObservation = Readonly<{
  projectExternalId: string;
  projectItemExternalId: string;
  fieldExternalId: string;
  optionExternalId: string | null;
  status: WorkItemStatus | null;
}>;
export type TrackerPullRequestSnapshot = Readonly<{
  externalId: string;
  externalVersion: string;
  url: string;
  htmlUrl: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  labels: readonly TrackerLabel[];
  assignees: readonly TrackerIdentity[];
  milestone: TrackerMilestone | null;
  linkedWorkItemExternalIds: readonly string[];
}>;
export type TrackerCheckConclusion =
  | 'action_required'
  | 'cancelled'
  | 'failure'
  | 'neutral'
  | 'skipped'
  | 'stale'
  | 'success'
  | 'timed_out';
export const trackerCheckStatuses = Object.freeze([
  'queued',
  'in_progress',
  'completed',
  'waiting',
  'requested',
  'pending'
] as const);
export type TrackerCheckStatus = (typeof trackerCheckStatuses)[number];
export type TrackerCheckSnapshot = Readonly<{
  externalId: string;
  externalVersion: string;
  pullRequestExternalId: string;
  name: string;
  status: TrackerCheckStatus;
  conclusion: TrackerCheckConclusion | null;
  detailsUrl: string | null;
}>;
export type TrackerRepositorySnapshot = Readonly<{
  repository: Readonly<{
    externalId: string;
    externalVersion: string;
    owner: string;
    name: string;
  }>;
  externalVersion: string;
  workItems: readonly TrackerWorkItemSnapshot[];
  pullRequests: readonly TrackerPullRequestSnapshot[];
  checks: readonly TrackerCheckSnapshot[];
}>;
export type TrackerRepositorySnapshotValidationInput = Readonly<{
  snapshot: unknown;
  repository: TrackerRepositoryRef;
  repositoryExternalId: string;
}>;

const trackerSnapshotIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const trackerCheckConclusions = [
  'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out'
] as const satisfies readonly TrackerCheckConclusion[];

const trackerSnapshotObject = (
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> | null => {
  if (!isPlainObject(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Reflect.ownKeys(descriptors);
    if (
      actualKeys.length !== keys.length ||
      actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    ) return null;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined || descriptor.enumerable !== true ||
        !('value' in descriptor)
      ) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
};

const trackerSnapshotIdentifier = (value: unknown, maximumLength: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= maximumLength &&
    trackerSnapshotIdentifierPattern.test(value)
    ? value
    : null;

const trackerSnapshotString = (value: unknown, maximumLength: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximumLength
    ? value
    : null;

const trackerSnapshotUrl = (value: unknown, nullable = false): string | null => {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.username === '' && parsed.password === ''
      ? value
      : null;
  } catch {
    return null;
  }
};

const trackerSnapshotPositiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

const trackerSnapshotArray = (value: unknown, maximumLength: number): readonly unknown[] | null =>
  isDenseArray(value) && value.length <= maximumLength ? value : null;

const trackerSnapshotUnique = <T>(values: readonly T[], identity: (value: T) => string): boolean =>
  new Set(values.map(identity)).size === values.length;

const trackerSnapshotIdentity = (value: unknown): TrackerIdentity | null => {
  const record = trackerSnapshotObject(value, ['externalId', 'login']);
  if (record === null) return null;
  const externalId = trackerSnapshotIdentifier(record.externalId, 512);
  const login = trackerSnapshotString(record.login, 255);
  return externalId === null || login === null ? null : {externalId, login};
};

const trackerSnapshotLabel = (value: unknown): TrackerLabel | null => {
  const record = trackerSnapshotObject(value, ['externalId', 'name', 'color']);
  if (record === null) return null;
  const externalId = trackerSnapshotIdentifier(record.externalId, 512);
  const name = trackerSnapshotString(record.name, 255);
  const color = trackerSnapshotString(record.color, 64);
  return externalId === null || name === null || color === null ? null : {externalId, name, color};
};

const trackerSnapshotMilestone = (value: unknown): TrackerMilestone | null => {
  if (value === null) return null;
  const record = trackerSnapshotObject(value, ['externalId', 'number', 'title', 'state']);
  if (record === null || (record.state !== 'open' && record.state !== 'closed')) return null;
  const externalId = trackerSnapshotIdentifier(record.externalId, 512);
  const number = trackerSnapshotPositiveInteger(record.number);
  const title = trackerSnapshotString(record.title, 1_024);
  return externalId === null || number === null || title === null
    ? null
    : {externalId, number, title, state: record.state};
};

const trackerSnapshotLabels = (value: unknown): readonly TrackerLabel[] | null => {
  const values = trackerSnapshotArray(value, 100);
  if (values === null) return null;
  const labels: TrackerLabel[] = [];
  for (const value of values) {
    const label = trackerSnapshotLabel(value);
    if (label === null) return null;
    labels.push(label);
  }
  return trackerSnapshotUnique(labels, (label) => label.externalId) ? labels : null;
};

const trackerSnapshotAssignees = (value: unknown): readonly TrackerIdentity[] | null => {
  const values = trackerSnapshotArray(value, 100);
  if (values === null) return null;
  const assignees: TrackerIdentity[] = [];
  for (const value of values) {
    const assignee = trackerSnapshotIdentity(value);
    if (assignee === null) return null;
    assignees.push(assignee);
  }
  return trackerSnapshotUnique(assignees, (assignee) => assignee.externalId)
    ? assignees
    : null;
};

const trackerSnapshotWorkItem = (value: unknown): TrackerWorkItemSnapshot | null => {
  const record = trackerSnapshotObject(value, [
    'externalId', 'externalVersion', 'url', 'htmlUrl', 'number', 'title', 'state',
    'labels', 'assignees', 'milestone', 'projectStatus'
  ]);
  if (record === null || (record.state !== 'open' && record.state !== 'closed')) return null;
  const externalId = trackerSnapshotIdentifier(record.externalId, 512);
  const externalVersion = trackerSnapshotIdentifier(record.externalVersion, 512);
  const url = trackerSnapshotUrl(record.url);
  const htmlUrl = trackerSnapshotUrl(record.htmlUrl);
  const number = trackerSnapshotPositiveInteger(record.number);
  const title = trackerSnapshotString(record.title, 1_024);
  const labels = trackerSnapshotLabels(record.labels);
  const assignees = trackerSnapshotAssignees(record.assignees);
  const milestone = trackerSnapshotMilestone(record.milestone);
  const projectStatus = trackerSnapshotProjectStatus(record.projectStatus);
  return externalId === null || externalVersion === null || url === null || htmlUrl === null ||
    number === null || title === null || labels === null || assignees === null ||
    (record.milestone !== null && milestone === null) ||
    (record.projectStatus !== null && projectStatus === null)
    ? null
    : {
        externalId, externalVersion, url, htmlUrl, number, title, state: record.state,
        labels, assignees, milestone, projectStatus
      };
};

const trackerSnapshotProjectStatus = (
  value: unknown
): TrackerProjectStatusObservation | null => {
  if (value === null) return null;
  const record = trackerSnapshotObject(value, [
    'projectExternalId', 'projectItemExternalId', 'fieldExternalId', 'optionExternalId', 'status'
  ]);
  if (record === null) return null;
  const projectExternalId = trackerSnapshotIdentifier(record.projectExternalId, 512);
  const projectItemExternalId = trackerSnapshotIdentifier(record.projectItemExternalId, 512);
  const fieldExternalId = trackerSnapshotIdentifier(record.fieldExternalId, 512);
  const optionExternalId = record.optionExternalId === null
    ? null
    : trackerSnapshotIdentifier(record.optionExternalId, 512);
  const status = record.status === null
    ? null
    : typeof record.status === 'string' && workItemStatuses.includes(record.status as WorkItemStatus)
      ? record.status as WorkItemStatus
      : null;
  return projectExternalId === null || projectItemExternalId === null || fieldExternalId === null ||
    (optionExternalId === null && record.optionExternalId !== null) ||
    (record.status !== null && status === null)
    ? null
    : {projectExternalId, projectItemExternalId, fieldExternalId, optionExternalId, status};
};

const trackerSnapshotPullRequest = (value: unknown): TrackerPullRequestSnapshot | null => {
  const record = trackerSnapshotObject(value, [
    'externalId', 'externalVersion', 'url', 'htmlUrl', 'number', 'title', 'state', 'draft',
    'merged', 'headRef', 'headSha', 'baseRef', 'labels', 'assignees', 'milestone',
    'linkedWorkItemExternalIds'
  ]);
  if (
    record === null || (record.state !== 'open' && record.state !== 'closed') ||
    typeof record.draft !== 'boolean' || typeof record.merged !== 'boolean'
  ) return null;
  const externalId = trackerSnapshotIdentifier(record.externalId, 512);
  const externalVersion = trackerSnapshotIdentifier(record.externalVersion, 512);
  const url = trackerSnapshotUrl(record.url);
  const htmlUrl = trackerSnapshotUrl(record.htmlUrl);
  const number = trackerSnapshotPositiveInteger(record.number);
  const title = trackerSnapshotString(record.title, 1_024);
  const headRef = trackerSnapshotIdentifier(record.headRef, 255);
  const headSha = trackerSnapshotIdentifier(record.headSha, 255);
  const baseRef = trackerSnapshotIdentifier(record.baseRef, 255);
  const labels = trackerSnapshotLabels(record.labels);
  const assignees = trackerSnapshotAssignees(record.assignees);
  const milestone = trackerSnapshotMilestone(record.milestone);
  const linkedWorkItemExternalIds = trackerSnapshotArray(record.linkedWorkItemExternalIds, 2)?.map(
    (entry) => trackerSnapshotIdentifier(entry, 512)
  );
  return externalId === null || externalVersion === null || url === null || htmlUrl === null ||
    number === null || title === null || headRef === null || headSha === null || baseRef === null ||
    labels === null || assignees === null || (record.milestone !== null && milestone === null) ||
    linkedWorkItemExternalIds === undefined || linkedWorkItemExternalIds.some((entry) => entry === null) ||
    !trackerSnapshotUnique(linkedWorkItemExternalIds as string[], (entry) => entry)
    ? null
    : {
        externalId, externalVersion, url, htmlUrl, number, title, state: record.state,
        draft: record.draft, merged: record.merged, headRef, headSha, baseRef, labels, assignees,
        milestone, linkedWorkItemExternalIds: linkedWorkItemExternalIds as string[]
      };
};

const trackerSnapshotCheck = (value: unknown): TrackerCheckSnapshot | null => {
  const record = trackerSnapshotObject(value, [
    'externalId', 'externalVersion', 'pullRequestExternalId', 'name', 'status', 'conclusion', 'detailsUrl'
  ]);
  if (record === null) return null;
  const status = record.status;
  const conclusion = record.conclusion;
  if (!isTrackerSnapshotCheckStatus(status) || !isTrackerSnapshotCheckConclusion(conclusion)) return null;
  const externalId = trackerSnapshotIdentifier(record.externalId, 512);
  const externalVersion = trackerSnapshotIdentifier(record.externalVersion, 512);
  const pullRequestExternalId = trackerSnapshotIdentifier(record.pullRequestExternalId, 512);
  const name = trackerSnapshotString(record.name, 512);
  const detailsUrl = trackerSnapshotUrl(record.detailsUrl, true);
  return externalId === null || externalVersion === null || pullRequestExternalId === null ||
    name === null || (record.detailsUrl !== null && detailsUrl === null)
    ? null
    : {
        externalId, externalVersion, pullRequestExternalId, name,
        status, conclusion,
        detailsUrl
      };
};

const isTrackerSnapshotCheckStatus = (value: unknown): value is TrackerCheckStatus =>
  typeof value === 'string' && trackerCheckStatuses.some((status) => status === value);

const isTrackerSnapshotCheckConclusion = (
  value: unknown
): value is TrackerCheckConclusion | null =>
  value === null || (typeof value === 'string' && trackerCheckConclusions.some(
    (conclusion) => conclusion === value
  ));

const trackerSnapshotCollection = <T>(
  value: unknown,
  parse: (entry: unknown) => T | null,
  identity: (entry: T) => string
): readonly T[] | null => {
  const values = trackerSnapshotArray(value, 10_000);
  if (values === null) return null;
  const entries: T[] = [];
  for (const value of values) {
    const entry = parse(value);
    if (entry === null) return null;
    entries.push(entry);
  }
  return trackerSnapshotUnique(entries, identity) ? entries : null;
};

export const validateTrackerRepositorySnapshot = (
  input: TrackerRepositorySnapshotValidationInput
): TrackerRepositorySnapshot | null => {
  const snapshot = trackerSnapshotObject(input.snapshot, [
    'repository', 'externalVersion', 'workItems', 'pullRequests', 'checks'
  ]);
  if (snapshot === null) return null;
  const repository = trackerSnapshotObject(snapshot.repository, [
    'externalId', 'externalVersion', 'owner', 'name'
  ]);
  if (repository === null) return null;
  const externalId = trackerSnapshotIdentifier(repository.externalId, 512);
  const repositoryExternalVersion = trackerSnapshotIdentifier(repository.externalVersion, 512);
  const externalVersion = trackerSnapshotIdentifier(snapshot.externalVersion, 512);
  const workItems = trackerSnapshotCollection(
    snapshot.workItems,
    trackerSnapshotWorkItem,
    (item) => item.externalId
  );
  const pullRequests = trackerSnapshotCollection(
    snapshot.pullRequests,
    trackerSnapshotPullRequest,
    (pullRequest) => pullRequest.externalId
  );
  const checks = trackerSnapshotCollection(snapshot.checks, trackerSnapshotCheck, (check) => check.externalId);
  return externalId === null || repositoryExternalVersion === null || externalVersion === null ||
    repository.owner !== input.repository.owner || repository.name !== input.repository.repository ||
    externalId !== input.repositoryExternalId || workItems === null || pullRequests === null || checks === null
    ? null
    : {
        repository: {
          externalId, externalVersion: repositoryExternalVersion,
          owner: input.repository.owner, name: input.repository.repository
        },
        externalVersion, workItems, pullRequests, checks
      };
};
export type TrackerSnapshotProjectionBase = Readonly<{
  operationId: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  correlationId: string;
  provider: string;
  snapshot: TrackerRepositorySnapshot;
}>;
export type TrackerSnapshotBootstrapInput = TrackerSnapshotProjectionBase & Readonly<{mode: 'bootstrap'}>;
export type TrackerSnapshotSynchronizationInput = TrackerSnapshotProjectionBase &
  Readonly<{
    mode: 'synchronize';
    expectedPreviousExternalVersion: string;
  }>;
export type TrackerSnapshotProjectionInput =
  | TrackerSnapshotBootstrapInput
  | TrackerSnapshotSynchronizationInput;
export type TrackerSnapshotProjectionResult =
  | Readonly<{
      status: 'applied';
      snapshotExternalVersion: string;
      createdWorkItems: number;
      updatedWorkItems: number;
      updatedWorkItemStatuses: number;
      projectedPullRequests: number;
      projectedChecks: number;
      unknownWorkItemExternalIds: readonly string[];
      unknownProjectStatusWorkItemExternalIds: readonly string[];
      unmappablePullRequestExternalIds: readonly string[];
      ambiguousPullRequestExternalIds: readonly string[];
      unknownCheckExternalIds: readonly string[];
    }>
  | Readonly<{
      status: 'replayed';
      result: Exclude<TrackerSnapshotProjectionResult, {status: 'replayed'}>;
    }>
  | Readonly<{
      status: 'conflict';
      code:
        | 'bootstrap_already_completed'
        | 'bootstrap_required'
        | 'idempotency_key_reused'
        | 'repository_identity_conflict'
        | 'stale_snapshot';
      currentExternalVersion?: string;
    }>;
/** Canonical persistence boundary for a fully-read tracker repository snapshot. */
export type TrackerSnapshotProjector = Readonly<{
  bootstrap: (
    input: Omit<TrackerSnapshotBootstrapInput, 'mode'>
  ) => Promise<TrackerSnapshotProjectionResult>;
  synchronize: (
    input: Omit<TrackerSnapshotSynchronizationInput, 'mode'>
  ) => Promise<TrackerSnapshotProjectionResult>;
}>;
export type TrackerRepositoryReadInput = Readonly<{
  repository: TrackerRepositoryRef;
  credentialRef: OpaqueSecretRef;
}>;
export type TrackerRepositoryReadScopeAuthorizationInput = Readonly<{
  workspaceId: string;
  projectId: string;
  actorId: string;
  provider: string;
  repository: TrackerRepositoryRef;
  credentialRef: OpaqueSecretRef;
}>;
export type TrackerRepositoryReadScopeAuthorization =
  | Readonly<{status: 'authorized'; repositoryExternalId: string}>
  | Readonly<{status: 'denied'}>;
/** Authorizes a configured project repository scope before any provider read. */
export interface TrackerRepositoryReadScopeAuthorizer {
  authorize(
    input: TrackerRepositoryReadScopeAuthorizationInput
  ): Promise<TrackerRepositoryReadScopeAuthorization>;
}
export type TrackerWorkItemTransitionInput = Readonly<{
  bindingId: string;
  workItemId: string;
  canonicalVersion: number;
  status: WorkItemStatus;
  expectedBindingVersion: string | null;
  expectedProviderOptionId: string | null;
  target: Readonly<{
    repositoryExternalId: string;
    projectExternalId: string;
    projectItemExternalId: string;
    fieldExternalId: string;
  }>;
  mutationId: string;
  credentialRef: OpaqueSecretRef;
}>;
export type TrackerWorkItemTransitionResult =
  | Readonly<{
      status: 'confirmed';
      receipt: Readonly<{
        verification: 'read_after_write';
        projectItemExternalId: string;
        optionExternalId: string;
        clientMutationId: string;
      }>;
    }>
  | Readonly<{status: 'stale'}>
  | Readonly<{status: 'identity_denied'}>
  | Readonly<{status: 'retryable'}>;
export type TrackerAdapter = Readonly<{
  provider: string;
  capabilities: TrackerCapabilities;
  readRepositorySnapshot?: (
    input: TrackerRepositoryReadInput
  ) => Promise<TrackerRepositorySnapshot>;
  transitionWorkItem?: (
    input: TrackerWorkItemTransitionInput
  ) => Promise<TrackerWorkItemTransitionResult>;
}>;
export type ChatAdapter = Readonly<{
  provider: string;
  sendNotification(input: Readonly<{
    destinationRef: string; template: string; variables: Readonly<Record<string, string>>; idempotencyKey: string;
  }>): Promise<Readonly<{externalMessageId: string}>>;
}>;
export type AgentRuntime = Readonly<{
  runtimeId: string;
  run(input: Readonly<{
    packetId: string; packetHash: string; profile: string; timeboxMinutes: number;
  }>): Promise<Readonly<{exitCode: number; summaryRef: string}>>;
}>;
export type SecretsProvider = Readonly<{
  resolve(reference: OpaqueSecretRef, purpose: string): Promise<Readonly<{value: string; expiresAt?: Date}>>;
}>;
export type ArtifactStore = Readonly<{
  put(input: Readonly<{
    runId: string; name: string; contentType: string; body: Uint8Array;
  }>): Promise<Readonly<{storageKey: string; sha256: string; sizeBytes: number}>>;
}>;

export const auditOutcomes = ['succeeded', 'failed', 'rejected', 'approval_required'] as const;
export type AuditOutcome = (typeof auditOutcomes)[number];
export type AuditEvent = Readonly<{
  id: string;
  workspaceId: string;
  commandId: string;
  correlationId: string;
  actorId: string;
  actionCategory: ActionCategory;
  action: string;
  targetType: string;
  targetId: string;
  policyDecision?: PolicyDecision;
  outcome?: AuditOutcome;
  reasonCode?: CommandErrorCode;
  expectedVersion?: number;
  resultVersion?: number;
  occurredAt: string;
}>;
export type CommandReceipt = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  requestHash: string;
  commandType: CanonicalCommand['type'];
  aggregateType?: string;
  aggregateId?: string;
  expectedVersion?: number;
  resultVersion?: number;
  result: CommandResult<CanonicalJson>;
  createdAt: string;
}>;
export type CommandReceiptClaim = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  requestHash: string;
  commandType: CanonicalCommand['type'];
  createdAt: string;
}>;
declare const receiptClaimTokenBrand: unique symbol;
declare const persistedMutationBrand: unique symbol;
declare const auditAppendTokenBrand: unique symbol;
declare const receiptCompletionBrand: unique symbol;
declare const approvalRequiredCompletionBrand: unique symbol;
declare const noMutationCompletionBrand: unique symbol;

/** Opaque capability returned only by a successful idempotency claim. */
export type ReceiptClaimToken = Readonly<{readonly [receiptClaimTokenBrand]: true}>;
/** The version pair returned by a successful compare-and-swap persistence operation. */
export type PersistedVersionCas = Readonly<{
  expectedPersistedVersion: number | null;
  persistedVersion: number;
}>;
export type WorkItemUpdateMutation = Readonly<{
  aggregateType: 'work_item';
  aggregateId: string;
  expectedPersistedVersion: number;
  aggregate: WorkItem;
}>;
export type TaskPacketInsertMutation = Readonly<{
  aggregateType: 'task_packet';
  aggregateId: string;
  expectedPersistedVersion: null;
  aggregate: TaskPacket;
}>;
export type AgentRunMutation = Readonly<{
  aggregateType: 'agent_run';
  aggregateId: string;
  expectedPersistedVersion: number | null;
  aggregate: AgentRun;
}>;
export type ApprovalInsertMutation = Readonly<{
  aggregateType: 'approval';
  aggregateId: string;
  expectedPersistedVersion: null;
  aggregate: Approval;
}>;
export type ApprovalUpdateMutation = Readonly<{
  aggregateType: 'approval';
  aggregateId: string;
  expectedPersistedVersion: number;
  aggregate: Approval;
}>;
export type AccessRequestMutation = Readonly<{
  aggregateType: 'access_request';
  aggregateId: string;
  expectedPersistedVersion: number | null;
  aggregate: AccessRequest;
}>;
export type CanonicalMutation =
  | WorkItemUpdateMutation
  | TaskPacketInsertMutation
  | AgentRunMutation
  | ApprovalInsertMutation
  | ApprovalUpdateMutation
  | AccessRequestMutation;
export type PersistedCanonicalMutation = Readonly<{
  cas: PersistedVersionCas;
  audit: AuditAppendToken;
  readonly [persistedMutationBrand]: true;
}>;
export type AuditedMutationResult =
  | Readonly<{status: 'persisted'; mutation: PersistedCanonicalMutation}>
  | Readonly<{status: 'version_conflict'; expectedPersistedVersion: number | null; persistedVersion: number | null}>
  | Readonly<{status: 'not_found'}>
  | Readonly<{status: 'invalid_effect'}>;
export type AuditAppendToken = Readonly<{readonly [auditAppendTokenBrand]: true}>;
export type CommandReceiptCompletion = Readonly<{readonly [receiptCompletionBrand]: true}>;
export type CommandReceiptClaimResult =
  | Readonly<{status: 'claimed'; token: ReceiptClaimToken}>
  | Readonly<{status: 'replayed'; receipt: CommandReceipt}>
  | Readonly<{status: 'key_reused'; existingRequestHash: string}>;

export type NonApprovalAuditEvent = Readonly<Omit<
  AuditEvent,
  'policyDecision' | 'outcome' | 'reasonCode'
> & {
  policyDecision?: Exclude<PolicyDecision, 'ask'>;
  outcome?: Exclude<AuditOutcome, 'approval_required'>;
  reasonCode?: Exclude<CommandErrorCode, 'APPROVAL_REQUIRED'>;
}>;
export type ApprovalRequiredAuditEvent = Readonly<Omit<
  AuditEvent,
  'policyDecision' | 'outcome' | 'reasonCode'
> & {
  policyDecision: 'ask';
  outcome: 'approval_required';
  reasonCode: 'APPROVAL_REQUIRED';
}>;
export type ApprovalMutation = ApprovalInsertMutation;
export type ApprovalRequiredReceipt = Readonly<Omit<CommandReceipt, 'result'> & {
  result: Readonly<{
    ok: false;
    error: Readonly<{
      code: 'APPROVAL_REQUIRED';
      message: string;
      approval: ApprovalReceipt;
    }>;
  }>;
}>;
export type NonApprovalReceipt = Readonly<Omit<CommandReceipt, 'result'> & {
  result:
    | Readonly<{ok: true; value: CanonicalJson}>
    | Readonly<{
      ok: false;
      error: Readonly<{
        code: Exclude<CommandErrorCode, 'APPROVAL_REQUIRED'>;
        message: string;
      }>;
    }>;
}>;
export type NonApprovalCommandOutcome = Readonly<{
  kind: 'non_approval';
  mutation: CanonicalMutation;
  audit: NonApprovalAuditEvent;
}>;
export type ApprovalRequiredCommandOutcome = Readonly<{
  kind: 'approval_required';
  approval: ApprovalMutation;
  audit: ApprovalRequiredAuditEvent;
  receipt: ApprovalRequiredReceipt;
}>;
export type CanonicalCommandOutcome = NonApprovalCommandOutcome | ApprovalRequiredCommandOutcome;

/**
 * The only mutation surface supplied inside a command transaction. Implementations
 * keep raw aggregate repositories private so a caller cannot save around audit and
 * receipt handling.
 */
export interface CanonicalCommandTransaction {
  /** Loads only aggregates visible to the workspace bound to this command receipt. */
  loadWorkItem(claimToken: ReceiptClaimToken, workItemId: string): Promise<WorkItem | null>;
  loadTaskPacket(
    claimToken: ReceiptClaimToken,
    taskPacketId: string
  ): Promise<TaskPacketConfirmationView | null>;
  loadAgentRun(
    claimToken: ReceiptClaimToken,
    agentRunId: string
  ): Promise<AgentRunView | null>;
  loadApproval(claimToken: ReceiptClaimToken, approvalId: string): Promise<Approval | null>;
  loadAccessRequest(
    claimToken: ReceiptClaimToken,
    accessRequestId: string
  ): Promise<AccessRequest | null>;
  /** Atomically compare-and-swaps the aggregate and appends its audit event. */
  persistAuditedMutation(input: Readonly<{
    claimToken: ReceiptClaimToken;
    outcome: NonApprovalCommandOutcome;
  }>): Promise<AuditedMutationResult>;
  /**
   * Optional provider-effect extension for a WorkItem status transition. The
   * PostgreSQL implementation keeps the binding lock, aggregate CAS, outbox,
   * audit, and receipt in the command transaction.
   */
  persistAuditedWorkItemTransition?(input: Readonly<{
    claimToken: ReceiptClaimToken;
    outcome: NonApprovalCommandOutcome;
    fromStatus: WorkItemStatus;
    mutationId: string;
  }>): Promise<AuditedMutationResult>;
  /** Atomically persists the approval, ask audit, and completed receipt. */
  persistApprovalRequired(input: Readonly<{
    claimToken: ReceiptClaimToken;
    outcome: ApprovalRequiredCommandOutcome;
  }>): Promise<ApprovalRequiredMutationResult>;
  completeReceipt(input: Readonly<{
    claimToken: ReceiptClaimToken;
    receipt: NonApprovalReceipt;
    mutation: PersistedCanonicalMutation;
  }>): Promise<CompletedCanonicalMutation>;
  /** Atomically appends an audit event and completes a receipt when no aggregate changes. */
  completeAuditedReceipt(input: Readonly<{
    claimToken: ReceiptClaimToken;
    audit: NonApprovalAuditEvent;
    receipt: NonApprovalReceipt;
  }>): Promise<CompletedAuditedReceipt>;
}
export type CompletedCanonicalMutation = Readonly<{
  cas: PersistedVersionCas;
  audit: AuditAppendToken;
  receipt: CommandReceiptCompletion;
}>;
export type CompletedNonApprovalCommand<T> = Readonly<{
  kind: 'non_approval';
  value: T;
  mutation: CompletedCanonicalMutation;
}>;
export type CompletedApprovalRequiredCommand = Readonly<{
  kind: 'approval_required';
  approval: PersistedVersionCas;
  audit: AuditAppendToken;
  receipt: CommandReceiptCompletion;
  commandReceipt: ApprovalRequiredReceipt;
  readonly [approvalRequiredCompletionBrand]: true;
}>;
export type CompletedAuditedReceipt = Readonly<{
  audit: AuditAppendToken;
  receipt: CommandReceiptCompletion;
  readonly [noMutationCompletionBrand]: true;
}>;
export type CompletedNoMutationCommand<T> = Readonly<{
  kind: 'no_mutation';
  value: T;
  completion: CompletedAuditedReceipt;
}>;
export type ApprovalRequiredMutationResult =
  | Readonly<{status: 'completed'; command: CompletedApprovalRequiredCommand}>
  | Readonly<{status: 'not_found'}>
  | Readonly<{status: 'version_conflict'; expectedPersistedVersion: number | null; persistedVersion: number | null}>;
export type CompletedCanonicalCommand<T> =
  | CompletedNonApprovalCommand<T>
  | CompletedApprovalRequiredCommand
  | CompletedNoMutationCommand<T>;
export type CommandExecutionResult<T> =
  | Readonly<{status: 'completed'; command: CompletedCanonicalCommand<T>}>
  | Readonly<{status: 'replayed'; receipt: CommandReceipt}>
  | Readonly<{status: 'key_reused'; existingRequestHash: string}>;
export interface UnitOfWork {
  /**
   * Runs one command callback atomically. A successful callback result must carry
   * the receipt completion, which requires a claim token, persisted CAS result, and audit append token.
   */
  executeCommand<T>(
    claim: CommandReceiptClaim,
    work: (
      transaction: CanonicalCommandTransaction,
      claimToken: ReceiptClaimToken
    ) => Promise<CompletedCanonicalCommand<T>>
  ): Promise<CommandExecutionResult<T>>;
}
