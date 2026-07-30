import {createHash, randomUUID} from 'node:crypto';
import {createCanonicalCommandService} from '@fai-control-plane/application';
import {
  actors,
  agentProfiles,
  createDatabase,
  createPostgresUnitOfWork
} from '@fai-control-plane/db';
import {
  canonicalJson,
  createActorContextIssuer,
  type Capability,
  type PortableAgentSettings
} from '@fai-control-plane/domain';
import {and, eq, isNull} from 'drizzle-orm';

type Database = ReturnType<typeof createDatabase>['db'];
const requiredCapability = 'write:control_plane:development';

const enabledCapabilities = (capabilities: Record<string, boolean>): Capability[] =>
  Object.entries(capabilities).flatMap(([capability, enabled]) =>
    enabled ? [capability as Capability] : []);

export type AgentProfileRuntime = Readonly<{
  update(input: Readonly<{
    workspaceId: string;
    actorId: string;
    profileId: string;
    expectedVersion: number;
    instructions: string;
    settings: PortableAgentSettings;
    enabled: boolean;
  }>): Promise<'updated' | 'replayed' | 'forbidden' | 'not_found' | 'stale' | 'invalid'>;
}>;

const createRuntime = (db: Database): AgentProfileRuntime => ({
  async update(input) {
    const [operator] = await db.select({capabilities: actors.capabilities})
      .from(actors)
      .where(and(
        eq(actors.id, input.actorId),
        eq(actors.workspaceId, input.workspaceId),
        eq(actors.type, 'human'),
        eq(actors.authMode, 'user'),
        isNull(actors.disabledAt)
      ))
      .limit(1);
    if (operator === undefined || operator.capabilities[requiredCapability] !== true) {
      return 'forbidden';
    }
    const [profile] = await db.select({id: agentProfiles.id})
      .from(agentProfiles)
      .where(and(
        eq(agentProfiles.id, input.profileId),
        eq(agentProfiles.workspaceId, input.workspaceId)
      ))
      .limit(1);
    if (profile === undefined) return 'not_found';

    const issuer = createActorContextIssuer({
      users: [{actorId: input.actorId, capabilities: enabledCapabilities(operator.capabilities)}],
      agents: [],
      systems: []
    });
    if (!issuer.ok) return 'forbidden';
    const actor = issuer.value.issueUser(input.actorId);
    if (!actor.ok) return 'forbidden';
    const canonicalInput = {
      instructions: input.instructions,
      settings: input.settings,
      enabled: input.enabled
    } as const;
    const inputHash = createHash('sha256')
      .update(canonicalJson(canonicalInput))
      .digest('hex');
    const result = await createCanonicalCommandService({
      unitOfWork: createPostgresUnitOfWork(db)
    }).execute({
      commandId: randomUUID(),
      workspaceId: input.workspaceId,
      correlationId: randomUUID(),
      idempotencyKey: `agent_profile.update.v1:${profile.id}:${input.expectedVersion}:${inputHash}`,
      issuedAt: new Date().toISOString(),
      actor: actor.value,
      type: 'agent_profile.update',
      payload: {
        agentProfileId: profile.id,
        expectedVersion: input.expectedVersion,
        ...canonicalInput
      }
    });
    if (result.status === 'replayed') return 'replayed';
    if (!('receipt' in result)) return 'invalid';
    if (result.receipt.result.ok) return 'updated';
    switch (result.receipt.result.error.code) {
      case 'CAPABILITY_DENIED':
      case 'POLICY_DENIED':
        return 'forbidden';
      case 'NOT_FOUND':
        return 'not_found';
      case 'VERSION_CONFLICT':
        return 'stale';
      default:
        return 'invalid';
    }
  }
});

let runtimePromise: Promise<AgentProfileRuntime> | undefined;

export const getAgentProfileRuntime = async (): Promise<AgentProfileRuntime> => {
  if (runtimePromise !== undefined) return runtimePromise;
  runtimePromise = (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const database = createDatabase(databaseUrl);
    return createRuntime(database.db);
  })().catch((cause) => {
    runtimePromise = undefined;
    throw cause;
  });
  return runtimePromise;
};
