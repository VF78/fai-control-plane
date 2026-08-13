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
