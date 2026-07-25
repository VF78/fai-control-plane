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
  status: AgentRunStatus;
  idempotencyKey: string;
  version: number;
}>;

export type Approval = Readonly<{id: string; status: ApprovalStatus; version: number}>;
export type AccessRequest = Readonly<{
  id: string;
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
  Readonly<{agentRunId: string; taskPacketId: string; agentProfileId: string}>
>;
export type TransitionAgentRunCommand = CanonicalCommandEnvelope<
  'agent_run.transition',
  Readonly<{agentRunId: string; status: AgentRunStatus; expectedVersion: number}>
>;
export type RequestApprovalCommand = CanonicalCommandEnvelope<
  'approval.request',
  Readonly<{approvalId: string; action: PolicyRequest; workItemId?: string; agentRunId?: string}>
>;
export type DecideApprovalCommand = CanonicalCommandEnvelope<
  'approval.decide',
  Readonly<{approvalId: string; status: Exclude<ApprovalStatus, 'pending'>; expectedVersion: number}>
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

export type OpaqueSecretRef = Readonly<{
  provider: string;
  reference: string;
  scope: readonly string[];
}>;

export type TaskPacketContent = Readonly<{
  projectId: string;
  workItemId: string;
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

const packetStringFields = [
  'projectId', 'workItemId', 'goal', 'reviewerActorId', 'approverActorId',
  'runtimeProfile', 'createdFromEventId', 'createdByActorId'
] as const satisfies readonly (keyof TaskPacketContent)[];
const packetArrayFields = [
  'acceptanceCriteria', 'inScope', 'outOfScope', 'relevantLinks', 'relevantFiles',
  'allowedTools', 'forbiddenSurfaces'
] as const satisfies readonly (keyof TaskPacketContent)[];
const taskPacketContentKeys = new Set<keyof TaskPacketContent>([
  ...packetStringFields,
  ...packetArrayFields,
  'dataPolicy',
  'timeboxMinutes',
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
  if (!Number.isInteger(content.timeboxMinutes) || content.timeboxMinutes <= 0 ||
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

export type TrackerAdapter = Readonly<{
  provider: string;
  transitionWorkItem(input: Readonly<{
    bindingId: string; expectedVersion: string; status: WorkItemStatus; idempotencyKey: string;
  }>): Promise<Readonly<{externalVersion: string}>>;
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

/** Opaque capability returned only by a successful idempotency claim. */
export type ReceiptClaimToken = Readonly<{readonly [receiptClaimTokenBrand]: true}>;
/** The version pair returned by a successful compare-and-swap persistence operation. */
export type PersistedVersionCas = Readonly<{
  expectedPersistedVersion: number | null;
  persistedVersion: number;
}>;
export type CanonicalMutation = Readonly<{
  aggregateType: 'work_item' | 'agent_run' | 'approval' | 'access_request' | 'task_packet';
  aggregateId: string;
  /** `null` means insert-if-absent; otherwise persistence must compare this exact stored version. */
  expectedPersistedVersion: number | null;
  aggregate: WorkItem | AgentRun | Approval | AccessRequest | TaskPacket;
}>;
export type PersistedCanonicalMutation = Readonly<{
  cas: PersistedVersionCas;
  audit: AuditAppendToken;
  readonly [persistedMutationBrand]: true;
}>;
export type AuditedMutationResult =
  | Readonly<{status: 'persisted'; mutation: PersistedCanonicalMutation}>
  | Readonly<{status: 'version_conflict'; expectedPersistedVersion: number | null; persistedVersion: number | null}>
  | Readonly<{status: 'not_found'}>;
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
export type ApprovalMutation = Readonly<{
  aggregateType: 'approval';
  aggregateId: string;
  expectedPersistedVersion: number | null;
  aggregate: Approval;
}>;
export type ApprovalRequiredReceipt = Readonly<Omit<CommandReceipt, 'result'> & {
  result: Readonly<{
    ok: false;
    error: Readonly<{code: 'APPROVAL_REQUIRED'; message: string}>;
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
  claimReceipt(claim: CommandReceiptClaim): Promise<CommandReceiptClaimResult>;
  /** Atomically compare-and-swaps the aggregate and appends its audit event. */
  persistAuditedMutation(input: Readonly<{
    claimToken: ReceiptClaimToken;
    outcome: NonApprovalCommandOutcome;
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
  readonly [approvalRequiredCompletionBrand]: true;
}>;
export type ApprovalRequiredMutationResult =
  | Readonly<{status: 'completed'; command: CompletedApprovalRequiredCommand}>
  | Readonly<{status: 'version_conflict'; expectedPersistedVersion: number | null; persistedVersion: number | null}>;
export type CompletedCanonicalCommand<T> =
  | CompletedNonApprovalCommand<T>
  | CompletedApprovalRequiredCommand;
export interface UnitOfWork {
  /**
   * Runs one command callback atomically. A successful callback result must carry
   * the receipt completion, which requires a claim token, persisted CAS result, and audit append token.
   */
  executeCommand<T>(
    work: (transaction: CanonicalCommandTransaction) => Promise<CompletedCanonicalCommand<T>>
  ): Promise<CompletedCanonicalCommand<T>>;
}
