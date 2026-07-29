import {createHash} from 'node:crypto';
import type {CanonicalJson, CommandResult, WorkItemStatus} from './index.ts';
import {
  projectMembershipRoles,
  type ProjectMembershipRole
} from './access.ts';

export const deliveryProtocolExecutionModes = [
  'manual',
  'autonomous',
  'human_approval'
] as const;
export type DeliveryProtocolExecutionMode =
  (typeof deliveryProtocolExecutionModes)[number];

export const deliveryProtocolStates = ['draft', 'published', 'retired'] as const;
export type DeliveryProtocolState = (typeof deliveryProtocolStates)[number];

export type DeliveryProtocolResponsibility =
  | Readonly<{
      kind: 'project_role';
      role: Exclude<ProjectMembershipRole, 'agent'>;
    }>
  | Readonly<{
      kind: 'actor';
      actorId: string;
      actorType: 'human';
    }>
  | Readonly<{
      kind: 'actor';
      actorId: string;
      actorType: 'agent';
      agentProfileId: string;
    }>;

export type DeliveryProtocolStage = Readonly<{
  key: string;
  name: string;
  enabled: boolean;
  taskStatus: WorkItemStatus;
  responsibility: DeliveryProtocolResponsibility;
  executionMode: DeliveryProtocolExecutionMode;
  entryCriteria: readonly string[];
  requiredEvidence: readonly string[];
  allowedNextStageKey: string | null;
}>;

export type DeliveryProtocolDefinition = Readonly<{
  schemaVersion: 1;
  stages: readonly DeliveryProtocolStage[];
}>;

export type DeliveryProtocol = Readonly<{
  id: string;
  projectId: string;
  name: string;
  version: number;
  revision: number;
  state: DeliveryProtocolState;
  active: boolean;
  definition: DeliveryProtocolDefinition;
  contentHash: string;
}>;

export type DeliveryProtocolSimulationContext = Readonly<{
  projectExists: boolean;
  memberships: readonly Readonly<{
    actorId: string;
    role: ProjectMembershipRole;
    active: boolean;
  }>[];
  actors: readonly Readonly<{
    actorId: string;
    actorType: 'human' | 'agent';
    active: boolean;
  }>[];
  agentProfiles: readonly Readonly<{
    profileId: string;
    actorId: string;
    enabled: boolean;
  }>[];
  agentRegistrations: readonly Readonly<{
    actorId: string;
    profileId: string;
    enabled: boolean;
  }>[];
}>;

export type DeliveryProtocolStageSimulation = Readonly<{
  stageKey: string;
  responsibilityResolved: boolean;
  agentProfileResolved: boolean;
  autonomousPermission: boolean;
  missingContext: readonly string[];
}>;

export type DeliveryProtocolSimulation = Readonly<{
  definitionHash: string;
  contextHash: string;
  simulationHash: string;
  valid: boolean;
  violations: readonly string[];
  stages: readonly DeliveryProtocolStageSimulation[];
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stageKeyPattern = /^[a-z][a-z0-9_]{0,63}$/;
const workItemStatusSet = new Set<WorkItemStatus>([
  'backlog', 'ready', 'in_dev', 'qa', 'acceptance', 'done'
]);
const success = <T>(value: T): CommandResult<T> => ({ok: true, value});
const failure = <T>(message: string): CommandResult<T> => ({
  ok: false,
  error: {code: 'INVALID_COMMAND', message}
});
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const stableJson = (value: CanonicalJson): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Readonly<Record<string, CanonicalJson>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key]!)}`
  ).join(',')}}`;
};
const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
};
const denseStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  Object.keys(value).length === value.length &&
  value.every((item) =>
    typeof item === 'string' && item.trim() === item && item.length > 0 && item.length <= 500
  );
const hasProviderKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasProviderKey);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    /provider|external.*(?:id|identifier)|(?:id|identifier).*external/i.test(key) ||
    hasProviderKey(nested)
  );
};

const responsibility = (
  value: unknown
): DeliveryProtocolResponsibility | null => {
  if (!isObject(value)) return null;
  if (
    exactKeys(value, ['kind', 'role']) &&
    value.kind === 'project_role' &&
    typeof value.role === 'string' &&
    projectMembershipRoles.includes(value.role as ProjectMembershipRole) &&
    value.role !== 'agent'
  ) {
    return {kind: 'project_role', role: value.role as Exclude<ProjectMembershipRole, 'agent'>};
  }
  if (
    exactKeys(value, ['kind', 'actorId', 'actorType']) &&
    value.kind === 'actor' &&
    value.actorType === 'human' &&
    typeof value.actorId === 'string' &&
    uuidPattern.test(value.actorId)
  ) {
    return {kind: 'actor', actorId: value.actorId, actorType: 'human'};
  }
  if (
    exactKeys(value, ['kind', 'actorId', 'actorType', 'agentProfileId']) &&
    value.kind === 'actor' &&
    value.actorType === 'agent' &&
    typeof value.actorId === 'string' &&
    uuidPattern.test(value.actorId) &&
    typeof value.agentProfileId === 'string' &&
    uuidPattern.test(value.agentProfileId)
  ) {
    return {
      kind: 'actor',
      actorId: value.actorId,
      actorType: 'agent',
      agentProfileId: value.agentProfileId
    };
  }
  return null;
};

export const validateDeliveryProtocolDefinition = (
  value: unknown
): CommandResult<DeliveryProtocolDefinition> => {
  if (hasProviderKey(value)) {
    return failure('Delivery protocol definitions cannot contain provider identifiers.');
  }
  if (
    !isObject(value) ||
    !exactKeys(value, ['schemaVersion', 'stages']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.stages) ||
    value.stages.length === 0 ||
    value.stages.length > 50 ||
    Object.keys(value.stages).length !== value.stages.length
  ) return failure('Delivery protocol definition is not canonical.');

  const stages: DeliveryProtocolStage[] = [];
  const keys = new Set<string>();
  for (const raw of value.stages) {
    if (
      !isObject(raw) ||
      !exactKeys(raw, [
        'key',
        'name',
        'enabled',
        'taskStatus',
        'responsibility',
        'executionMode',
        'entryCriteria',
        'requiredEvidence',
        'allowedNextStageKey'
      ]) ||
      typeof raw.key !== 'string' ||
      !stageKeyPattern.test(raw.key) ||
      keys.has(raw.key) ||
      typeof raw.name !== 'string' ||
      raw.name.trim() !== raw.name ||
      raw.name.length === 0 ||
      raw.name.length > 120 ||
      typeof raw.enabled !== 'boolean' ||
      typeof raw.taskStatus !== 'string' ||
      !workItemStatusSet.has(raw.taskStatus as WorkItemStatus) ||
      !deliveryProtocolExecutionModes.includes(raw.executionMode as DeliveryProtocolExecutionMode) ||
      !denseStrings(raw.entryCriteria) ||
      !denseStrings(raw.requiredEvidence) ||
      (raw.enabled && (raw.entryCriteria.length === 0 || raw.requiredEvidence.length === 0)) ||
      !(raw.allowedNextStageKey === null ||
        typeof raw.allowedNextStageKey === 'string' &&
        stageKeyPattern.test(raw.allowedNextStageKey))
    ) return failure('Delivery protocol stage is not canonical.');
    const owner = responsibility(raw.responsibility);
    if (owner === null) return failure('Delivery protocol responsibility is not canonical.');
    if (
      raw.executionMode === 'autonomous' &&
      !(owner.kind === 'actor' && owner.actorType === 'agent')
    ) {
      return failure('Autonomous stages require an agent actor and profile.');
    }
    if (
      owner.kind === 'actor' &&
      owner.actorType === 'agent' &&
      raw.executionMode === 'manual'
    ) {
      return failure('Agent-owned stages cannot use manual execution.');
    }
    keys.add(raw.key);
    stages.push({
      key: raw.key,
      name: raw.name,
      enabled: raw.enabled,
      taskStatus: raw.taskStatus as WorkItemStatus,
      responsibility: owner,
      executionMode: raw.executionMode as DeliveryProtocolExecutionMode,
      entryCriteria: [...raw.entryCriteria],
      requiredEvidence: [...raw.requiredEvidence],
      allowedNextStageKey: raw.allowedNextStageKey
    });
  }

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    const next = stage.allowedNextStageKey;
    if (next !== null && (!keys.has(next) || stages.findIndex((item) => item.key === next) <= index)) {
      return failure('Allowed next stages must reference a later stable stage.');
    }
    if (stage.enabled && next !== null && stages.find((item) => item.key === next)?.enabled !== true) {
      return failure('Enabled stages cannot advance to a disabled stage.');
    }
  }
  return success(Object.freeze({
    schemaVersion: 1,
    stages: Object.freeze(stages.map((stage) => Object.freeze(stage)))
  }));
};

export const hashDeliveryProtocolDefinition = (
  definition: DeliveryProtocolDefinition
): string => createHash('sha256')
  .update(stableJson(definition as unknown as CanonicalJson))
  .digest('hex');

export const simulateDeliveryProtocol = (
  value: unknown,
  context: DeliveryProtocolSimulationContext
): DeliveryProtocolSimulation => {
  const validated = validateDeliveryProtocolDefinition(value);
  const definitionHash = validated.ok
    ? hashDeliveryProtocolDefinition(validated.value)
    : createHash('sha256').update('invalid-delivery-protocol').digest('hex');
  const canonicalContext = {
    projectExists: context.projectExists,
    memberships: [...context.memberships].sort((a, b) =>
      a.actorId.localeCompare(b.actorId) || a.role.localeCompare(b.role)
    ),
    actors: [...context.actors].sort((a, b) => a.actorId.localeCompare(b.actorId)),
    agentProfiles: [...context.agentProfiles].sort((a, b) =>
      a.profileId.localeCompare(b.profileId)
    ),
    agentRegistrations: [...context.agentRegistrations].sort((a, b) =>
      a.profileId.localeCompare(b.profileId) || a.actorId.localeCompare(b.actorId)
    )
  };
  const contextHash = createHash('sha256')
    .update(stableJson(canonicalContext as unknown as CanonicalJson))
    .digest('hex');
  const violations = validated.ok ? [] : [validated.error.message];
  const stages = validated.ok
    ? validated.value.stages.map((stage): DeliveryProtocolStageSimulation => {
        const owner = stage.responsibility;
        const missing = new Set<string>();
        if (!context.projectExists) missing.add('missing.project');
        let responsibilityResolved = false;
        let agentProfileResolved = stage.responsibility.kind !== 'actor' ||
          stage.responsibility.actorType !== 'agent';
        let agentRegistrationResolved = agentProfileResolved;
        if (owner.kind === 'project_role') {
          responsibilityResolved = context.memberships.some((item) =>
            item.active &&
            item.role === owner.role &&
            context.actors.some((actor) =>
              actor.actorId === item.actorId && actor.active
            )
          );
          if (!responsibilityResolved) missing.add('missing.responsible_project_role');
        } else {
          const actor = context.actors.find((item) =>
            item.actorId === owner.actorId &&
            item.actorType === owner.actorType &&
            item.active
          );
          const membership = context.memberships.find((item) =>
            item.actorId === owner.actorId && item.active
          );
          responsibilityResolved = actor !== undefined && membership !== undefined;
          if (!responsibilityResolved) missing.add('missing.responsible_actor_or_membership');
          if (owner.actorType === 'agent') {
            agentProfileResolved = context.agentProfiles.some((profile) =>
              profile.profileId === owner.agentProfileId &&
              profile.actorId === owner.actorId &&
              profile.enabled
            );
            if (!agentProfileResolved) missing.add('missing.agent_profile');
            agentRegistrationResolved = context.agentRegistrations.some((registration) =>
              registration.actorId === owner.actorId &&
              registration.profileId === owner.agentProfileId &&
              registration.enabled
            );
            if (!agentRegistrationResolved) missing.add('missing.runtime_registration');
          }
        }
        return {
          stageKey: stage.key,
          responsibilityResolved,
          agentProfileResolved,
          autonomousPermission:
            stage.enabled &&
            stage.executionMode === 'autonomous' &&
            responsibilityResolved &&
            agentProfileResolved &&
            agentRegistrationResolved &&
            missing.size === 0,
          missingContext: Object.freeze([...missing].sort())
        };
      })
    : [];
  const stable = {
    definitionHash,
    contextHash,
    valid: validated.ok && context.projectExists && stages.every((stage) =>
      stage.responsibilityResolved &&
      stage.agentProfileResolved &&
      !stage.missingContext.includes('missing.runtime_registration')
    ),
    violations,
    stages
  };
  return Object.freeze({
    ...stable,
    simulationHash: createHash('sha256')
      .update(stableJson(stable as unknown as CanonicalJson))
      .digest('hex')
  });
};

export const defaultDeliveryProtocolDefinition = (): DeliveryProtocolDefinition => ({
  schemaVersion: 1,
  stages: [
    {
      key: 'intake',
      name: 'Intake',
      enabled: true,
      taskStatus: 'ready',
      responsibility: {kind: 'project_role', role: 'project_owner'},
      executionMode: 'manual',
      entryCriteria: ['Task context is complete'],
      requiredEvidence: ['Accepted task brief'],
      allowedNextStageKey: 'development'
    },
    {
      key: 'development',
      name: 'Development',
      enabled: true,
      taskStatus: 'in_dev',
      responsibility: {kind: 'project_role', role: 'contributor'},
      executionMode: 'manual',
      entryCriteria: ['Task is ready for implementation'],
      requiredEvidence: ['Implementation change', 'Relevant checks'],
      allowedNextStageKey: 'qa'
    },
    {
      key: 'qa',
      name: 'QA',
      enabled: true,
      taskStatus: 'qa',
      responsibility: {kind: 'project_role', role: 'reviewer'},
      executionMode: 'human_approval',
      entryCriteria: ['Development evidence is complete'],
      requiredEvidence: ['QA result'],
      allowedNextStageKey: 'staging'
    },
    {
      key: 'staging',
      name: 'Staging',
      enabled: true,
      taskStatus: 'acceptance',
      responsibility: {kind: 'project_role', role: 'project_owner'},
      executionMode: 'human_approval',
      entryCriteria: ['QA passed'],
      requiredEvidence: ['Staging verification'],
      allowedNextStageKey: 'production'
    },
    {
      key: 'production',
      name: 'Production',
      enabled: true,
      taskStatus: 'done',
      responsibility: {kind: 'project_role', role: 'project_owner'},
      executionMode: 'human_approval',
      entryCriteria: ['Staging verification passed'],
      requiredEvidence: ['Production release receipt'],
      allowedNextStageKey: null
    }
  ]
});
