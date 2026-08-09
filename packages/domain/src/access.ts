import type {PolicyDecision} from './index.ts';

export const projectMembershipRoles = [
  'workspace_owner',
  'project_owner',
  'contributor',
  'reviewer',
  'client_viewer',
  'agent'
] as const;
export type ProjectMembershipRole = (typeof projectMembershipRoles)[number];

export const actorOnboardingRolesAreCompatible = (input: Readonly<{
  actorType: 'human' | 'agent';
  actorRole: 'delivery_lead' | 'developer' | 'agent_operator';
  membershipRole: ProjectMembershipRole;
  hasAgentProfile: boolean;
}>): boolean => input.actorType === 'agent'
  ? input.actorRole === 'agent_operator' && input.membershipRole === 'agent' && input.hasAgentProfile
  : input.actorRole !== 'agent_operator' &&
    !['agent', 'workspace_owner'].includes(input.membershipRole) && !input.hasAgentProfile;

export const accessResourceTypes = [
  'repository',
  'tracker',
  'internal_chat',
  'client_chat',
  'environment',
  'control_plane_action'
] as const;
export type AccessResourceType = (typeof accessResourceTypes)[number];

export const accessLevels = ['none', 'read', 'write', 'admin'] as const;
export type AccessLevel = (typeof accessLevels)[number];

export type ProjectMembership = Readonly<{
  id: string;
  projectId: string;
  actorId: string;
  role: ProjectMembershipRole;
  active: boolean;
  version: number;
}>;

export type ActorExternalIdentity = Readonly<{
  id: string;
  actorId: string;
  provider: string;
  externalSubject: string;
  active: boolean;
  version: number;
}>;

export type ProviderAccessObservation = Readonly<{
  provider: string;
  externalResourceRef: string;
  confirmedLevel: AccessLevel;
  observedAt: string;
}>;

export type ResourceAccessGrant = Readonly<{
  id: string;
  projectId: string;
  actorId: string;
  resourceType: AccessResourceType;
  resourceId: string;
  desiredLevel: AccessLevel;
  providerObservation?: ProviderAccessObservation | null;
  version: number;
}>;

export type ConnectedAccessResource = Readonly<{
  projectId: string;
  resourceType: AccessResourceType;
  resourceId: string;
  policyDecision: Exclude<PolicyDecision, 'ask'>;
}>;

export type EffectiveAccessExplanation = Readonly<{
  projectId: string;
  actorId: string;
  resourceType: AccessResourceType;
  resourceId: string;
  membership: Readonly<{
    role: ProjectMembershipRole | null;
    active: boolean;
    baselineLevel: AccessLevel;
  }>;
  explicitGrant: Readonly<{
    grantId: string;
    desiredLevel: AccessLevel;
    version: number;
  }> | null;
  policy: Readonly<{decision: Exclude<PolicyDecision, 'ask'>}>;
  desiredCanonical: Readonly<{
    level: AccessLevel;
    allowed: boolean;
    reasons: readonly string[];
  }>;
  providerConfirmed: Readonly<{
    state: 'confirmed' | 'unobserved';
    provider?: string;
    externalResourceRef?: string;
    level?: AccessLevel;
    observedAt?: string;
  }>;
}>;

const levelRank: Readonly<Record<AccessLevel, number>> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3
};

const baselineFor = (
  role: ProjectMembershipRole | null,
  resourceType: AccessResourceType
): AccessLevel => {
  if (role === 'workspace_owner' || role === 'project_owner') return 'admin';
  if (role === 'contributor') {
    if (['repository', 'tracker', 'internal_chat'].includes(resourceType)) return 'write';
    return resourceType === 'environment' ? 'read' : 'none';
  }
  if (role === 'reviewer') {
    return ['repository', 'tracker', 'internal_chat', 'control_plane_action'].includes(resourceType)
      ? 'read'
      : 'none';
  }
  return role === 'client_viewer' && resourceType === 'client_chat' ? 'read' : 'none';
};

const higherLevel = (left: AccessLevel, right: AccessLevel): AccessLevel =>
  levelRank[left] >= levelRank[right] ? left : right;

export const explainEffectiveAccess = (input: Readonly<{
  actorIds: readonly string[];
  resources: readonly ConnectedAccessResource[];
  memberships: readonly ProjectMembership[];
  grants: readonly ResourceAccessGrant[];
}>): readonly EffectiveAccessExplanation[] => {
  const memberships = new Map(
    input.memberships.map((membership) => [
      `${membership.projectId}\0${membership.actorId}`,
      membership
    ])
  );
  const grants = new Map(
    input.grants.map((grant) => [
      `${grant.projectId}\0${grant.actorId}\0${grant.resourceType}\0${grant.resourceId}`,
      grant
    ])
  );
  return input.actorIds
    .flatMap((actorId) => input.resources.map((resource) => {
      const membership = memberships.get(`${resource.projectId}\0${actorId}`);
      const role = membership?.active === true ? membership.role : null;
      const baselineLevel = baselineFor(role, resource.resourceType);
      const grant = grants.get(
        `${resource.projectId}\0${actorId}\0${resource.resourceType}\0${resource.resourceId}`
      );
      const candidate = role === null
        ? 'none'
        : higherLevel(baselineLevel, grant?.desiredLevel ?? 'none');
      const level = resource.policyDecision === 'allow' ? candidate : 'none';
      const reasons = role === null
        ? ['membership_missing_or_inactive']
        : resource.policyDecision === 'deny'
          ? ['policy_denied']
          : level === 'none'
            ? ['role_and_grant_do_not_allow']
            : [
                ...(baselineLevel === level
                  ? [`role:${role}`]
                  : []),
                ...(grant !== undefined && grant.desiredLevel === level
                  ? [`grant:${grant.id}`]
                  : [])
              ];
      const observation = grant?.providerObservation;
      return {
        projectId: resource.projectId,
        actorId,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        membership: {
          role,
          active: membership?.active === true,
          baselineLevel
        },
        explicitGrant: grant === undefined
          ? null
          : {grantId: grant.id, desiredLevel: grant.desiredLevel, version: grant.version},
        policy: {decision: resource.policyDecision},
        desiredCanonical: {level, allowed: level !== 'none', reasons},
        providerConfirmed: observation == null
          ? {state: 'unobserved' as const}
          : {
              state: 'confirmed' as const,
              provider: observation.provider,
              externalResourceRef: observation.externalResourceRef,
              level: observation.confirmedLevel,
              observedAt: observation.observedAt
            }
      };
    }))
    .sort((left, right) =>
      left.projectId.localeCompare(right.projectId) ||
      left.actorId.localeCompare(right.actorId) ||
      left.resourceType.localeCompare(right.resourceType) ||
      left.resourceId.localeCompare(right.resourceId)
    );
};
