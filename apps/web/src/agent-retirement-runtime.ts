import {randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import {createCanonicalCommandService} from '@fai-control-plane/application';
import {actors, createDatabase, createPostgresUnitOfWork} from '@fai-control-plane/db';
import {
  createActorContextIssuer,
  type Capability,
  type TrustedUserActorContext
} from '@fai-control-plane/domain';

type Database = ReturnType<typeof createDatabase>['db'];
type RetirementResult =
  | Readonly<{
      status: 'retired' | 'replayed';
      commandId: string;
      disabledAt: string;
    }>
  | Readonly<{status: 'forbidden' | 'not_found' | 'conflict' | 'invalid'}>;

const capabilities = (input: Record<string, boolean>): Capability[] =>
  Object.entries(input).flatMap(([capability, enabled]) =>
    enabled ? [capability as Capability] : []);

const operatorActor = async (
  db: Database,
  workspaceId: string,
  actorId: string
): Promise<TrustedUserActorContext | null> => {
  const [operator] = await db.select({capabilities: actors.capabilities})
    .from(actors)
    .where(and(
      eq(actors.id, actorId),
      eq(actors.workspaceId, workspaceId),
      eq(actors.type, 'human'),
      eq(actors.authMode, 'user'),
      isNull(actors.disabledAt)
    ))
    .limit(1);
  if (operator === undefined) return null;
  const issuer = createActorContextIssuer({
    users: [{actorId, capabilities: capabilities(operator.capabilities)}],
    agents: [],
    systems: []
  });
  if (!issuer.ok) return null;
  const actor = issuer.value.issueUser(actorId);
  return actor.ok ? actor.value : null;
};

export type AgentRetirementRuntime = Readonly<{
  retire(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    agentId: string;
  }>): Promise<RetirementResult>;
}>;

export const createAgentRetirementRuntime = (db: Database): AgentRetirementRuntime => ({
  async retire(input) {
    const actor = await operatorActor(db, input.workspaceId, input.operatorActorId);
    if (actor === null) return {status: 'forbidden'};
    const result = await createCanonicalCommandService({
      unitOfWork: createPostgresUnitOfWork(db)
    }).execute({
      commandId: randomUUID(),
      workspaceId: input.workspaceId,
      correlationId: randomUUID(),
      idempotencyKey: `actor.retire.v1:${input.agentId}`,
      issuedAt: new Date().toISOString(),
      actor,
      type: 'actor.retire',
      payload: {agentId: input.agentId}
    });
    if (!('receipt' in result)) return {status: 'invalid'};
    if (!result.receipt.result.ok) {
      switch (result.receipt.result.error.code) {
        case 'CAPABILITY_DENIED':
        case 'POLICY_DENIED':
        case 'INVALID_ACTOR_CONTEXT':
          return {status: 'forbidden'};
        case 'NOT_FOUND':
          return {status: 'not_found'};
        case 'VERSION_CONFLICT':
          return {status: 'conflict'};
        default:
          return {status: 'invalid'};
      }
    }
    const value = result.receipt.result.value;
    if (
      typeof value !== 'object' || value === null || Array.isArray(value) ||
      typeof (value as Readonly<Record<string, unknown>>).disabledAt !== 'string'
    ) return {status: 'invalid'};
    const retired = value as Readonly<{disabledAt: string}>;
    return {
      status: result.status === 'replayed' ? 'replayed' : 'retired',
      commandId: result.receipt.commandId,
      disabledAt: retired.disabledAt
    };
  }
});

let runtimePromise: Promise<AgentRetirementRuntime> | undefined;
export const getAgentRetirementRuntime = async (): Promise<AgentRetirementRuntime> => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    return createAgentRetirementRuntime(createDatabase(databaseUrl).db);
  })().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};
