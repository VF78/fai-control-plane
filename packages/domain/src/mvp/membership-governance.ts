export type ProjectRole = 'project_owner' | 'operator' | 'contributor' | 'client';

/** Membership is governance: only an active owner may change it, and an owner cannot remove itself. */
export const mayChangeMembership = (input: Readonly<{
  requesterActorId: string;
  requesterRole: ProjectRole | null;
  targetActorId: string;
  targetRole: ProjectRole;
  requestedRole: ProjectRole;
  requestedActive: boolean;
}>): boolean => input.requesterRole === 'project_owner' && !(
  input.requesterActorId === input.targetActorId &&
  (input.requestedRole !== 'project_owner' || !input.requestedActive)
);
