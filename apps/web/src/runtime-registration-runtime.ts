import {createHash, randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import {createCanonicalCommandService} from '@fai-control-plane/application';
import {
  actors,
  createDatabase,
  createPostgresUnitOfWork,
  projects,
  runtimeRegistrations
} from '@fai-control-plane/db';
import {
  createActorContextIssuer,
  type Capability
} from '@fai-control-plane/domain';

type Database = ReturnType<typeof createDatabase>['db'];
type MutationStatus =
  | Readonly<{
      status: 'updated' | 'replayed';
      commandId: string;
      commandType: 'runtime_registration.update' | 'runtime_registration.disable';
      enabled: boolean;
      version: number;
    }>
  | Readonly<{status: 'forbidden' | 'not_found' | 'stale' | 'invalid'}>;

const enabledCapabilities = (capabilities: Record<string, boolean>): Capability[] =>
  Object.entries(capabilities).flatMap(([capability, enabled]) =>
    enabled ? [capability as Capability] : []);

export type RuntimeRegistrationRuntime = Readonly<{
  setEnabled(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    registrationId: string;
    expectedProjectId: string;
    expectedAgentId: string;
    expectedVersion: number;
    enabled: boolean;
  }>): Promise<MutationStatus>;
}>;

export const createRuntimeRegistrationRuntime = (db: Database): RuntimeRegistrationRuntime => ({
  async setEnabled(input) {
    const [operator] = await db.select({capabilities: actors.capabilities})
      .from(actors)
      .where(and(
        eq(actors.id, input.operatorActorId),
        eq(actors.workspaceId, input.workspaceId),
        eq(actors.type, 'human'),
        eq(actors.authMode, 'user'),
        isNull(actors.disabledAt)
      ))
      .limit(1);
    if (operator === undefined) return {status: 'forbidden'};

    const [registration] = await db.select({
      projectId: runtimeRegistrations.projectId,
      actorId: runtimeRegistrations.actorId,
      provider: runtimeRegistrations.provider,
      runtimeKey: runtimeRegistrations.runtimeKey
    }).from(runtimeRegistrations)
      .innerJoin(projects, eq(projects.id, runtimeRegistrations.projectId))
      .where(and(
        eq(runtimeRegistrations.id, input.registrationId),
        eq(projects.workspaceId, input.workspaceId)
      ))
      .limit(1);
    if (registration === undefined ||
      registration.projectId !== input.expectedProjectId ||
      registration.actorId !== input.expectedAgentId) {
      return {status: 'not_found'};
    }

    const issuer = createActorContextIssuer({
      users: [{
        actorId: input.operatorActorId,
        capabilities: enabledCapabilities(operator.capabilities)
      }],
      agents: [],
      systems: []
    });
    if (!issuer.ok) return {status: 'forbidden'};
    const actor = issuer.value.issueUser(input.operatorActorId);
    if (!actor.ok) return {status: 'forbidden'};

    const commandType: 'runtime_registration.update' | 'runtime_registration.disable' =
      input.enabled ? 'runtime_registration.update' : 'runtime_registration.disable';
    const inputHash = createHash('sha256')
      .update(`${input.registrationId}\0${input.expectedVersion}\0${input.enabled}`)
      .digest('hex');
    const base = {
      commandId: randomUUID(),
      workspaceId: input.workspaceId,
      correlationId: randomUUID(),
      idempotencyKey: `runtime_registration.state.v1:${input.registrationId}:${input.expectedVersion}:${inputHash}`,
      issuedAt: new Date().toISOString(),
      actor: actor.value
    };
    const service = createCanonicalCommandService({
      unitOfWork: createPostgresUnitOfWork(db)
    });
    const result = input.enabled
      ? await service.execute({
          ...base,
          type: 'runtime_registration.update',
          payload: {
            registrationId: input.registrationId,
            provider: registration.provider,
            runtimeKey: registration.runtimeKey,
            enabled: true,
            expectedVersion: input.expectedVersion
          }
        })
      : await service.execute({
          ...base,
          type: 'runtime_registration.disable',
          payload: {
            registrationId: input.registrationId,
            expectedVersion: input.expectedVersion
          }
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
          return {status: 'stale'};
        default:
          return {status: 'invalid'};
      }
    }
    const value = result.receipt.result.value;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) return {status: 'invalid'};
    const registrationValue = value as Readonly<{enabled?: unknown; version?: unknown}>;
    if (
      typeof registrationValue.enabled !== 'boolean' ||
      typeof registrationValue.version !== 'number'
    ) return {status: 'invalid'};
    return {
      status: result.status === 'replayed' ? 'replayed' : 'updated',
      commandId: result.receipt.commandId,
      commandType,
      enabled: registrationValue.enabled,
      version: registrationValue.version
    };
  }
});

let runtimePromise: Promise<RuntimeRegistrationRuntime> | undefined;

export const getRuntimeRegistrationRuntime = async (): Promise<RuntimeRegistrationRuntime> => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    return createRuntimeRegistrationRuntime(createDatabase(databaseUrl).db);
  })().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};
