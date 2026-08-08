import {createHash, randomUUID} from 'node:crypto';
import {createCanonicalCommandService} from '@fai-control-plane/application';
import {
  actors,
  createDatabase,
  createPostgresUnitOfWork,
  projectMemberships,
  projects,
  resourceAccessGrants
} from '@fai-control-plane/db';
import {
  canonicalJson,
  createActorContextIssuer,
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
}>;

const createRuntime = (db: Database): AccessManagementRuntime => {
  const execute = async (
    workspaceId: string,
    operatorActorId: string,
    input: Readonly<{
      idempotencyKey: string;
      type: 'project_membership.set' | 'resource_access_grant.set';
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
