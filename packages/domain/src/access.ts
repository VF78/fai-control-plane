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

export const humanProjectMembershipRoles = projectMembershipRoles.filter(
  (role): role is Exclude<ProjectMembershipRole, 'agent'> => role !== 'agent'
);

export const canonicalProjectMembershipRoles = (
  roles: readonly ProjectMembershipRole[]
): readonly ProjectMembershipRole[] | null => {
  if (roles.length < 1 || roles.length > humanProjectMembershipRoles.length) return null;
  const unique = [...new Set(roles)];
  unique.sort((left, right) => projectMembershipRoles.indexOf(left) - projectMembershipRoles.indexOf(right));
  return unique.length === roles.length && unique.every((role, index) => role === roles[index])
    ? unique
    : null;
};

export const projectMembershipHasRole = (
  membership: Readonly<{roles: readonly ProjectMembershipRole[]; active: boolean}> | null | undefined,
  role: ProjectMembershipRole
): boolean => membership?.active === true && membership.roles.includes(role);

export const actorOnboardingRolesAreCompatible = (input: Readonly<{
  actorType: 'human' | 'agent';
  actorRole: 'delivery_lead' | 'developer' | 'agent_operator';
  membershipRoles: readonly ProjectMembershipRole[];
  hasAgentProfile: boolean;
}>): boolean => canonicalProjectMembershipRoles(input.membershipRoles) !== null && (input.actorType === 'agent'
  ? input.actorRole === 'agent_operator' && input.membershipRoles.length === 1 &&
    input.membershipRoles[0] === 'agent' && input.hasAgentProfile
  : input.actorRole !== 'agent_operator' &&
    !input.membershipRoles.includes('agent') && !input.hasAgentProfile);

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
  roles: readonly ProjectMembershipRole[];
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

export type AccessObservationState =
  | 'confirmed'
  | 'unobserved'
  | 'unsupported'
  | 'unavailable';

export type AccessObservationInput = Readonly<{
  resourceType: AccessResourceType;
  externalSubject: string;
  repository: Readonly<{
    owner: string;
    repository: string;
    externalId: string;
  }>;
}>;

export type AccessObservationResult =
  | Readonly<{
      state: 'confirmed';
      provider: string;
      externalResourceRef: string;
      confirmedLevel: AccessLevel;
      observedAt: string;
    }>
  | Readonly<{
      state: Exclude<AccessObservationState, 'confirmed'>;
      remediation: string;
    }>;

/** Read-only provider boundary. It cannot grant, revoke, or otherwise mutate access. */
export interface AccessObservationPort {
  readonly provider: string;
  observeAccess(input: AccessObservationInput): Promise<AccessObservationResult>;
}

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
    roles: readonly ProjectMembershipRole[] | null;
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
  roles: readonly ProjectMembershipRole[] | null,
  resourceType: AccessResourceType
): AccessLevel => {
  if (roles === null) return 'none';
  if (roles.includes('workspace_owner') || roles.includes('project_owner')) return 'admin';
  if (roles.includes('contributor')) {
    if (['repository', 'tracker', 'internal_chat'].includes(resourceType)) return 'write';
    return resourceType === 'environment' ? 'read' : 'none';
  }
  if (roles.includes('reviewer')) {
    return ['repository', 'tracker', 'internal_chat', 'control_plane_action'].includes(resourceType)
      ? 'read'
      : 'none';
  }
  return roles.includes('client_viewer') && resourceType === 'client_chat' ? 'read' : 'none';
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
      const roles = membership?.active === true ? membership.roles : null;
      const baselineLevel = baselineFor(roles, resource.resourceType);
      const grant = grants.get(
        `${resource.projectId}\0${actorId}\0${resource.resourceType}\0${resource.resourceId}`
      );
      const candidate = roles === null
        ? 'none'
        : higherLevel(baselineLevel, grant?.desiredLevel ?? 'none');
      const level = resource.policyDecision === 'allow' ? candidate : 'none';
      const reasons = roles === null
        ? ['membership_missing_or_inactive']
        : resource.policyDecision === 'deny'
          ? ['policy_denied']
          : level === 'none'
            ? ['role_and_grant_do_not_allow']
            : [
                ...(baselineLevel === level
                  ? roles.map((role) => `role:${role}`)
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
          roles,
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
