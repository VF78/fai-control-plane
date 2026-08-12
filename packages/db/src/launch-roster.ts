import type {createDatabase} from './index';
import type {ProjectMembershipRole} from '@fai-control-plane/domain';
import {
  actorExternalIdentities,
  actors,
  projectMemberships
} from './schema';

type Database = ReturnType<typeof createDatabase>['db'];
export type LaunchHumanMember = Readonly<{
  actorId: string;
  roles: readonly Extract<ProjectMembershipRole, 'project_owner' | 'contributor'>[];
}>;

export type LaunchHumanRoster = Readonly<{
  bootstrapActorId: string;
  members: readonly LaunchHumanMember[];
}>;

export type LaunchProjectSlug = 'msa' | 'ascon';

export type LaunchSystemRoster = Readonly<{
  runtimeObserverActorId: string;
}>;

const runtimeObserverSeed = (workspaceId: string) => ({
  workspaceId,
  type: 'system' as const,
  role: 'agent_operator' as const,
  displayName: 'Runtime Observer',
  authMode: 'system' as const,
  externalSubject: 'system:runtime-observer:v1',
  capabilities: {'write:runtime_observation:development': true},
  disabledAt: null
});

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

    const roles = isProductOwner ? ['project_owner'] as const : ['contributor'] as const;
    members.push({actorId: actor.id, roles});
    if (isProductOwner) bootstrapActorId = actor.id;
  }

  if (bootstrapActorId === undefined) {
    throw new Error('bootstrap operator seed failed');
  }
  return {bootstrapActorId, members};
};

export const reconcileLaunchSystemRoster = async (
  db: Database,
  workspaceId: string
): Promise<LaunchSystemRoster> => {
  const seed = runtimeObserverSeed(workspaceId);
  const [runtimeObserver] = await db.insert(actors).values(seed).onConflictDoUpdate({
    target: [actors.workspaceId, actors.authMode, actors.externalSubject],
    set: {
      type: seed.type,
      role: seed.role,
      displayName: seed.displayName,
      capabilities: seed.capabilities,
      disabledAt: seed.disabledAt
    }
  }).returning({id: actors.id});
  if (runtimeObserver === undefined) {
    throw new Error('launch runtime observer seed failed');
  }
  return {runtimeObserverActorId: runtimeObserver.id};
};

export const reconcileLaunchProjectMemberships = async (
  db: Database,
  projectId: string,
  projectSlug: LaunchProjectSlug,
  humanMembers: readonly LaunchHumanMember[],
  hermesActorId: string
): Promise<void> => {
  const projectOwner = humanMembers.find(({roles}) => roles.includes('project_owner'));
  if (projectOwner === undefined) {
    throw new Error('launch project membership seed requires a project owner');
  }
  const fixedMembers = [
    ...humanMembers,
    {actorId: hermesActorId, roles: ['agent'] as const}
  ];
  for (const member of fixedMembers) {
    const active = projectSlug === 'msa' || member.actorId === projectOwner.actorId;
    const roles = projectSlug === 'ascon' && member.actorId === projectOwner.actorId
      ? ['project_owner', 'contributor'] as const
      : member.roles;
    await db.insert(projectMemberships).values({
      projectId,
      actorId: member.actorId,
      roles: [...roles],
      active
    }).onConflictDoUpdate({
      target: [
        projectMemberships.projectId,
        projectMemberships.actorId
      ],
      set: {roles: [...roles], active}
    });
  }
};
