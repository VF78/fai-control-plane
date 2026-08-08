import {createHash, randomUUID} from 'node:crypto';
import {createInstructionVersionService, type InstructionVersionExecution} from '@fai-control-plane/application';
import {
  actors,
  agentProfileInstructionVersions,
  agentProfiles,
  createDatabase,
  createPostgresInstructionVersionStore,
  workspaceInstructionVersions
} from '@fai-control-plane/db';
import {canonicalJson, createActorContextIssuer, type Capability, type InstructionSettings} from '@fai-control-plane/domain';
import {and, desc, eq, isNull} from 'drizzle-orm';

type Database = ReturnType<typeof createDatabase>['db'];
type Status = 'updated' | 'replayed' | 'forbidden' | 'not_found' | 'stale' | 'invalid';
type Scope = Readonly<{scope: 'workspace'}> | Readonly<{scope: 'agent_profile'; agentProfileId: string}>;

export type InstructionManagementRuntime = Readonly<{
  publish(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    target: Scope;
    expectedVersion: number | null;
    instructions: string;
  }>): Promise<Status>;
  rollback(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    target: Scope;
    expectedVersion: number;
    rollbackOfVersionId: string;
  }>): Promise<Status>;
}>;

const enabledCapabilities = (capabilities: Record<string, boolean>): Capability[] =>
  Object.entries(capabilities).flatMap(([capability, enabled]) => enabled ? [capability as Capability] : []);

const createRuntime = (db: Database): InstructionManagementRuntime => {
  const context = async (workspaceId: string, actorId: string) => {
    const [operator] = await db.select({capabilities: actors.capabilities}).from(actors).where(and(
      eq(actors.id, actorId), eq(actors.workspaceId, workspaceId), eq(actors.type, 'human'),
      eq(actors.authMode, 'user'), isNull(actors.disabledAt)
    )).limit(1);
    if (operator === undefined || operator.capabilities['write:control_plane:development'] !== true) return null;
    const issuer = createActorContextIssuer({
      users: [{actorId, capabilities: enabledCapabilities(operator.capabilities)}], agents: [], systems: []
    });
    if (!issuer.ok) return null;
    const actor = issuer.value.issueUser(actorId);
    return actor.ok ? actor.value : null;
  };
  const mapResult = (result: InstructionVersionExecution): Status => {
    if (result.status === 'replayed') return 'replayed';
    if (result.status === 'key_reused') return 'invalid';
    if (result.status === 'rejected') {
      return result.error.code === 'CAPABILITY_DENIED' || result.error.code === 'POLICY_DENIED' || result.error.code === 'INVALID_ACTOR_CONTEXT'
        ? 'forbidden' : 'invalid';
    }
    if (!('receipt' in result)) return 'invalid';
    if (result.receipt.result.ok) return 'updated';
    switch (result.receipt.result.error.code) {
      case 'CAPABILITY_DENIED':
      case 'POLICY_DENIED':
      case 'INVALID_ACTOR_CONTEXT': return 'forbidden';
      case 'NOT_FOUND': return 'not_found';
      case 'VERSION_CONFLICT': return 'stale';
      default: return 'invalid';
    }
  };
  const currentSettings = async (workspaceId: string, target: Scope): Promise<InstructionSettings | null> => {
    if (target.scope === 'workspace') {
      const [row] = await db.select({settings: workspaceInstructionVersions.settings})
        .from(workspaceInstructionVersions)
        .where(eq(workspaceInstructionVersions.workspaceId, workspaceId))
        .orderBy(desc(workspaceInstructionVersions.version)).limit(1);
      return row?.settings as InstructionSettings | undefined ?? {};
    }
    const [profile] = await db.select({id: agentProfiles.id}).from(agentProfiles).where(and(
      eq(agentProfiles.id, target.agentProfileId), eq(agentProfiles.workspaceId, workspaceId)
    )).limit(1);
    if (profile === undefined) return null;
    const [row] = await db.select({settings: agentProfileInstructionVersions.settings})
      .from(agentProfileInstructionVersions).where(and(
        eq(agentProfileInstructionVersions.workspaceId, workspaceId),
        eq(agentProfileInstructionVersions.agentProfileId, target.agentProfileId)
      )).orderBy(desc(agentProfileInstructionVersions.version)).limit(1);
    return row?.settings as InstructionSettings | undefined ?? {};
  };
  const service = createInstructionVersionService(createPostgresInstructionVersionStore(db));
  return {
    async publish(input) {
      const actor = await context(input.workspaceId, input.operatorActorId);
      if (actor === null) return 'forbidden';
      const settings = await currentSettings(input.workspaceId, input.target);
      if (settings === null) return 'not_found';
      const content = {instructions: input.instructions, settings};
      const hash = createHash('sha256').update(canonicalJson(content)).digest('hex');
      return mapResult(await service.execute({
        commandId: randomUUID(), workspaceId: input.workspaceId, correlationId: randomUUID(),
        idempotencyKey: `instruction_version.publish.v1:${input.target.scope}:${input.target.scope === 'agent_profile' ? input.target.agentProfileId : input.workspaceId}:${input.expectedVersion ?? 0}:${hash}`,
        issuedAt: new Date().toISOString(), actor, type: 'instruction_version.publish',
        payload: {
          ...input.target,
          versionId: randomUUID(), expectedVersion: input.expectedVersion,
          approvedByActorId: input.operatorActorId, content
        }
      }));
    },
    async rollback(input) {
      const actor = await context(input.workspaceId, input.operatorActorId);
      if (actor === null) return 'forbidden';
      return mapResult(await service.execute({
        commandId: randomUUID(), workspaceId: input.workspaceId, correlationId: randomUUID(),
        idempotencyKey: `instruction_version.rollback.v1:${input.target.scope}:${input.target.scope === 'agent_profile' ? input.target.agentProfileId : input.workspaceId}:${input.expectedVersion}:${input.rollbackOfVersionId}`,
        issuedAt: new Date().toISOString(), actor, type: 'instruction_version.rollback',
        payload: {
          ...input.target,
          versionId: randomUUID(), expectedVersion: input.expectedVersion,
          approvedByActorId: input.operatorActorId,
          rollbackOfVersionId: input.rollbackOfVersionId
        }
      }));
    }
  };
};

let runtimePromise: Promise<InstructionManagementRuntime> | undefined;
export const getInstructionManagementRuntime = async (): Promise<InstructionManagementRuntime> => {
  if (runtimePromise !== undefined) return runtimePromise;
  runtimePromise = (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    return createRuntime(createDatabase(databaseUrl).db);
  })().catch((cause) => { runtimePromise = undefined; throw cause; });
  return runtimePromise;
};
