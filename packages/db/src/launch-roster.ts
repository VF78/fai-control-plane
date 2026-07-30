import type {createDatabase} from './index';
import {
  actorExternalIdentities,
  actors,
  projectMemberships
} from './schema';

type Database = ReturnType<typeof createDatabase>['db'];
type MembershipRole = typeof projectMemberships.$inferInsert.role;

export type LaunchHumanMember = Readonly<{
  actorId: string;
  role: Extract<MembershipRole, 'project_owner' | 'contributor'>;
}>;

export type LaunchHumanRoster = Readonly<{
  bootstrapActorId: string;
  members: readonly LaunchHumanMember[];
}>;

export type LaunchProjectSlug = 'msa' | 'ascon';

const parseOperatorGitHubUserIds = (value: string): readonly string[] => {
  const ids = value.split(',');
  if (ids.length !== 2) {
    throw new Error('FCP_OPERATOR_GITHUB_USER_IDS must contain exactly two numeric IDs');
  }
  if (ids.some((id) => !/^[1-9][0-9]{0,15}$/.test(id))) {
    throw new Error('FCP_OPERATOR_GITHUB_USER_IDS must use canonical positive decimal IDs');
  }
  if (ids.some((id) => !Number.isSafeInteger(Number(id)))) {
    throw new Error('FCP_OPERATOR_GITHUB_USER_IDS contains an unsafe numeric ID');
  }
  if (new Set(ids).size !== 2) {
    throw new Error('FCP_OPERATOR_GITHUB_USER_IDS must not contain duplicates');
  }
  return ids;
};

export const reconcileLaunchHumanRoster = async (
  db: Database,
  workspaceId: string,
  bootstrapExternalSubject: string,
  operatorGitHubUserIds: string
): Promise<LaunchHumanRoster> => {
  const configuredOperatorIds = parseOperatorGitHubUserIds(operatorGitHubUserIds);
  const bootstrapOperatorId = bootstrapExternalSubject
    .match(/^github:user:([1-9][0-9]{0,15})$/)?.[1];
  if (
    bootstrapOperatorId === undefined ||
    !configuredOperatorIds.includes(bootstrapOperatorId)
  ) {
    throw new Error(
      'FCP_BOOTSTRAP_HUMAN_SUBJECT must equal github:user:<id> for FCP_OPERATOR_GITHUB_USER_IDS'
    );
  }

  const members: LaunchHumanMember[] = [];
  let bootstrapActorId: string | undefined;
  for (const githubUserId of configuredOperatorIds) {
    const isProductOwner = githubUserId === bootstrapOperatorId;
    const externalSubject = `github:user:${githubUserId}`;
    const actorSeed = {
      workspaceId,
      type: 'human' as const,
      role: isProductOwner ? 'workspace_admin' as const : 'developer' as const,
      displayName: isProductOwner ? 'Vladimir' : 'Vitaliy',
      authMode: 'user' as const,
      externalSubject,
      capabilities: isProductOwner
        ? {
          'read:repository:development': true,
          'write:tracker:development': true,
          'write:control_plane:development': true
        }
        : {
          'read:control_plane:development': true,
          'write:control_plane:development': true
        }
    };
    const [actor] = await db.insert(actors).values(actorSeed).onConflictDoUpdate({
      target: [actors.workspaceId, actors.authMode, actors.externalSubject],
      set: {
        type: actorSeed.type,
        role: actorSeed.role,
        displayName: actorSeed.displayName,
        capabilities: actorSeed.capabilities
      }
    }).returning({id: actors.id});
    if (actor === undefined) {
      throw new Error(`launch operator seed failed: ${externalSubject}`);
    }

    await db.insert(actorExternalIdentities).values({
      actorId: actor.id,
      provider: 'github',
      externalSubject,
      active: true
    }).onConflictDoUpdate({
      target: [
        actorExternalIdentities.actorId,
        actorExternalIdentities.provider
      ],
      set: {externalSubject, active: true}
    });

    const role = isProductOwner ? 'project_owner' as const : 'contributor' as const;
    members.push({actorId: actor.id, role});
    if (isProductOwner) bootstrapActorId = actor.id;
  }

  if (bootstrapActorId === undefined) {
    throw new Error('bootstrap operator seed failed');
  }
  return {bootstrapActorId, members};
};

export const reconcileLaunchProjectMemberships = async (
  db: Database,
  projectId: string,
  projectSlug: LaunchProjectSlug,
  humanMembers: readonly LaunchHumanMember[],
  hermesActorId: string
): Promise<void> => {
  const projectOwner = humanMembers.find(({role}) => role === 'project_owner');
  if (projectOwner === undefined) {
    throw new Error('launch project membership seed requires a project owner');
  }
  const fixedMembers = [
    ...humanMembers,
    {actorId: hermesActorId, role: 'agent' as const}
  ];
  const members = projectSlug === 'msa' ? fixedMembers : [projectOwner];
  const desiredActorIds = new Set(members.map(({actorId}) => actorId));
  for (const member of fixedMembers) {
    const active = desiredActorIds.has(member.actorId);
    await db.insert(projectMemberships).values({
      projectId,
      actorId: member.actorId,
      role: member.role,
      active
    }).onConflictDoUpdate({
      target: [
        projectMemberships.projectId,
        projectMemberships.actorId
      ],
      set: {role: member.role, active}
    });
  }
};
