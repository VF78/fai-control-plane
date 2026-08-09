import {createHash, randomUUID} from 'node:crypto';
import {createCanonicalCommandService} from '@fai-control-plane/application';
import {
  actors,
  conversationChannelConfigurations,
  createDatabase,
  createPostgresUnitOfWork,
  projectMemberships,
  projects,
  resourceAccessGrants
} from '@fai-control-plane/db';
import {
  canonicalJson,
  createActorContextIssuer,
  DEFAULT_AGENT_INSTRUCTIONS,
  DEFAULT_AGENT_SETTINGS,
  hashAgentProfileConfiguration,
  type AccessLevel,
  type Capability,
  type ProjectMembershipRole
} from '@fai-control-plane/domain';
import {and, eq, isNull} from 'drizzle-orm';

type Database = ReturnType<typeof createDatabase>['db'];
const requiredCapability = 'write:control_plane:development';

const enabledCapabilities = (capabilities: Record<string, boolean>): Capability[] =>
  Object.entries(capabilities).flatMap(([capability, enabled]) =>
    enabled ? [capability as Capability] : []);

type MutationStatus = 'updated' | 'replayed' | 'forbidden' | 'not_found' | 'stale' | 'invalid';

export type AccessManagementRuntime = Readonly<{
  onboardActor(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    idempotencyKey: string;
    projectId: string;
    actorType: 'human' | 'agent';
    displayName: string;
    actorRole: 'delivery_lead' | 'developer' | 'agent_operator';
    membershipRole: ProjectMembershipRole;
    runtimeId?: string;
    runtimeProfile?: string;
    runtimeKey?: string;
  }>): Promise<MutationStatus>;
  setMembership(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    membershipId: string;
    expectedVersion: number;
    role: ProjectMembershipRole;
    active: boolean;
  }>): Promise<MutationStatus>;
  setDesiredAccess(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    grantId: string;
    expectedVersion: number;
    desiredLevel: AccessLevel;
  }>): Promise<MutationStatus>;
  setConversationAccess(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    projectId: string;
    channelId: string;
    conversationClass: 'internal' | 'client';
    subjectActorId: string;
    grantId: string;
    expectedVersion: number | null;
    desiredLevel: AccessLevel;
  }>): Promise<MutationStatus>;
}>;

const createRuntime = (db: Database): AccessManagementRuntime => {
  const execute = async (
    workspaceId: string,
    operatorActorId: string,
    input: Readonly<{
      idempotencyKey: string;
      type: 'project_membership.set' | 'resource_access_grant.set' | 'actor.onboard';
      payload: Record<string, unknown>;
    }>
  ): Promise<MutationStatus> => {
    const [operator] = await db.select({capabilities: actors.capabilities})
      .from(actors)
      .where(and(
        eq(actors.id, operatorActorId),
        eq(actors.workspaceId, workspaceId),
        eq(actors.type, 'human'),
        eq(actors.authMode, 'user'),
        isNull(actors.disabledAt)
      ))
      .limit(1);
    if (operator === undefined || operator.capabilities[requiredCapability] !== true) return 'forbidden';
    const issuer = createActorContextIssuer({
      users: [{actorId: operatorActorId, capabilities: enabledCapabilities(operator.capabilities)}],
      agents: [],
      systems: []
    });
    if (!issuer.ok) return 'forbidden';
    const actor = issuer.value.issueUser(operatorActorId);
    if (!actor.ok) return 'forbidden';
    const result = await createCanonicalCommandService({
      unitOfWork: createPostgresUnitOfWork(db)
    }).execute({
      commandId: randomUUID(),
      workspaceId,
      correlationId: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      issuedAt: new Date().toISOString(),
      actor: actor.value,
      type: input.type,
      payload: input.payload
    } as never);
    if (result.status === 'replayed') return 'replayed';
    if (!('receipt' in result)) return 'invalid';
    if (result.receipt.result.ok) return 'updated';
    switch (result.receipt.result.error.code) {
      case 'CAPABILITY_DENIED':
      case 'POLICY_DENIED': return 'forbidden';
      case 'NOT_FOUND': return 'not_found';
      case 'VERSION_CONFLICT': return 'stale';
      default: return 'invalid';
    }
  };

  return {
    async onboardActor(input) {
      const seed = `${input.workspaceId}:${input.idempotencyKey}`;
      const id = (kind: string): string => {
        const hex = createHash('sha256').update(`${kind}:${seed}`).digest('hex').slice(0, 32);
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
      };
      const portable = input.actorType === 'agent' ? {
        runtimeId: input.runtimeId!, runtimeProfile: input.runtimeProfile!,
        allowedTools: [], forbiddenSurfaces: [], instructions: DEFAULT_AGENT_INSTRUCTIONS,
        settings: DEFAULT_AGENT_SETTINGS, enabled: true, version: 1
      } : null;
      const agentProfile = portable === null ? null : {
        profileId: id('profile'), registrationId: id('registration'),
        runtimeId: portable.runtimeId, runtimeProfile: portable.runtimeProfile,
        runtimeKey: input.runtimeKey!,
        configHash: hashAgentProfileConfiguration(portable)
      };
      const payload = {
        actorId: id('actor'), membershipId: id('membership'), projectId: input.projectId,
        actorType: input.actorType, displayName: input.displayName,
        actorRole: input.actorRole, membershipRole: input.membershipRole, agentProfile
      };
      return execute(input.workspaceId, input.operatorActorId, {
        idempotencyKey: `actor.onboard.v1:${input.idempotencyKey}`,
        type: 'actor.onboard', payload
      });
    },
    async setMembership(input) {
      const [binding] = await db.select({
        id: projectMemberships.id,
        projectId: projectMemberships.projectId,
        actorId: projectMemberships.actorId
      }).from(projectMemberships)
        .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
        .where(and(
          eq(projectMemberships.id, input.membershipId),
          eq(projects.workspaceId, input.workspaceId)
        )).limit(1);
      if (binding === undefined) return 'not_found';
      const change = {role: input.role, active: input.active};
      const inputHash = createHash('sha256').update(canonicalJson(change)).digest('hex');
      return execute(input.workspaceId, input.operatorActorId, {
        idempotencyKey: `project_membership.set.v1:${binding.id}:${input.expectedVersion}:${inputHash}`,
        type: 'project_membership.set',
        payload: {
          membershipId: binding.id,
          projectId: binding.projectId,
          subjectActorId: binding.actorId,
          expectedVersion: input.expectedVersion,
          ...change
        }
      });
    },

    async setDesiredAccess(input) {
      const [binding] = await db.select({
        id: resourceAccessGrants.id,
        projectId: resourceAccessGrants.projectId,
        actorId: resourceAccessGrants.actorId,
        resourceType: resourceAccessGrants.resourceType,
        resourceId: resourceAccessGrants.resourceId
      }).from(resourceAccessGrants)
        .innerJoin(projects, eq(projects.id, resourceAccessGrants.projectId))
        .where(and(
          eq(resourceAccessGrants.id, input.grantId),
          eq(projects.workspaceId, input.workspaceId)
        )).limit(1);
      if (binding === undefined) return 'not_found';
      const inputHash = createHash('sha256')
        .update(canonicalJson({desiredLevel: input.desiredLevel}))
        .digest('hex');
      return execute(input.workspaceId, input.operatorActorId, {
        idempotencyKey: `resource_access_grant.set.v1:${binding.id}:${input.expectedVersion}:${inputHash}`,
        type: 'resource_access_grant.set',
        payload: {
          grantId: binding.id,
          projectId: binding.projectId,
          subjectActorId: binding.actorId,
          resourceType: binding.resourceType,
          resourceId: binding.resourceId,
          desiredLevel: input.desiredLevel,
          expectedVersion: input.expectedVersion
        }
      });
    },

    async setConversationAccess(input) {
      const [binding] = await db.select({
        projectId: conversationChannelConfigurations.projectId,
        conversationClass: conversationChannelConfigurations.conversationClass,
        desiredState: conversationChannelConfigurations.desiredState
      }).from(conversationChannelConfigurations)
        .innerJoin(projects, eq(projects.id, conversationChannelConfigurations.projectId))
        .innerJoin(projectMemberships, and(
          eq(projectMemberships.projectId, conversationChannelConfigurations.projectId),
          eq(projectMemberships.actorId, input.subjectActorId)
        ))
        .where(and(
          eq(conversationChannelConfigurations.id, input.channelId),
          eq(conversationChannelConfigurations.projectId, input.projectId),
          eq(conversationChannelConfigurations.conversationClass, input.conversationClass),
          eq(projects.workspaceId, input.workspaceId),
          eq(projectMemberships.active, true)
        )).limit(1);
      if (binding === undefined || binding.desiredState === 'not_used') return 'not_found';
      const resourceType = input.conversationClass === 'internal' ? 'internal_chat' : 'client_chat';
      const [current] = await db.select({
        id: resourceAccessGrants.id,
        version: resourceAccessGrants.version
      }).from(resourceAccessGrants).where(and(
        eq(resourceAccessGrants.projectId, input.projectId),
        eq(resourceAccessGrants.actorId, input.subjectActorId),
        eq(resourceAccessGrants.resourceType, resourceType),
        eq(resourceAccessGrants.resourceId, input.channelId)
      )).limit(1);
      if (
        (input.expectedVersion === null && current !== undefined) ||
        (input.expectedVersion !== null && (
          current?.id !== input.grantId || current.version !== input.expectedVersion
        ))
      ) return 'stale';
      const inputHash = createHash('sha256').update(canonicalJson({
        channelId: input.channelId,
        subjectActorId: input.subjectActorId,
        desiredLevel: input.desiredLevel,
        expectedVersion: input.expectedVersion
      })).digest('hex');
      return execute(input.workspaceId, input.operatorActorId, {
        idempotencyKey: `conversation-access.set.v1:${input.grantId}:${input.expectedVersion ?? 0}:${inputHash}`,
        type: 'resource_access_grant.set',
        payload: {
          grantId: input.grantId,
          projectId: input.projectId,
          subjectActorId: input.subjectActorId,
          resourceType,
          resourceId: input.channelId,
          desiredLevel: input.desiredLevel,
          expectedVersion: input.expectedVersion
        }
      });
    }
  };
};

let runtimePromise: Promise<AccessManagementRuntime> | undefined;

export const getAccessManagementRuntime = async (): Promise<AccessManagementRuntime> => {
  if (runtimePromise !== undefined) return runtimePromise;
  runtimePromise = (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    return createRuntime(createDatabase(databaseUrl).db);
  })().catch((cause) => {
    runtimePromise = undefined;
    throw cause;
  });
  return runtimePromise;
};
