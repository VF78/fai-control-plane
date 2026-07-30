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
  OPERATOR_RECOVERED_EXPIRED_LEASE,
  type Capability,
  type TrustedUserActorContext
} from '@fai-control-plane/domain';

type Database = ReturnType<typeof createDatabase>['db'];
type RegistrationMutationStatus =
  | Readonly<{
      status: 'updated' | 'replayed';
      commandId: string;
      commandType: 'runtime_registration.update' | 'runtime_registration.disable';
      enabled: boolean;
      version: number;
    }>
  | Readonly<{status: 'forbidden' | 'not_found' | 'stale' | 'invalid'}>;
type RecoveryMutationStatus =
  | Readonly<{
      status: 'updated' | 'replayed';
      commandId: string;
      commandType: 'agent_run.transition';
      failureCode: typeof OPERATOR_RECOVERED_EXPIRED_LEASE;
      version: number;
    }>
  | Readonly<{status: 'forbidden' | 'not_found' | 'stale' | 'invalid'}>;
type ReplacementMutationStatus =
  | Readonly<{
      status: 'updated' | 'replayed';
      commandId: string;
      commandType: 'runtime_registration.replace';
      source: Readonly<{enabled: false; version: number}>;
      target: Readonly<{enabled: true; version: number}>;
    }>
  | Readonly<{status: 'forbidden' | 'not_found' | 'stale' | 'invalid'}>;

const enabledCapabilities = (capabilities: Record<string, boolean>): Capability[] =>
  Object.entries(capabilities).flatMap(([capability, enabled]) =>
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
    users: [{actorId, capabilities: enabledCapabilities(operator.capabilities)}],
    agents: [],
    systems: []
  });
  if (!issuer.ok) return null;
  const actor = issuer.value.issueUser(actorId);
  return actor.ok ? actor.value : null;
};

export type RuntimeRegistrationRuntime = Readonly<{
  setEnabled(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    registrationId: string;
    expectedProjectId: string;
    expectedAgentId: string;
    expectedVersion: number;
    enabled: boolean;
  }>): Promise<RegistrationMutationStatus>;
  recoverExpiredRun(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    registrationId: string;
    expectedRegistrationVersion: number;
    expectedProjectId: string;
    expectedAgentId: string;
    expectedAgentProfileId: string;
    agentRunId: string;
    expectedRunVersion: number;
  }>): Promise<RecoveryMutationStatus>;
  replace(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    projectId: string;
    sourceRegistrationId: string;
    sourceExpectedVersion: number;
    targetRegistrationId: string;
    targetExpectedVersion: number;
  }>): Promise<ReplacementMutationStatus>;
}>;

export const createRuntimeRegistrationRuntime = (db: Database): RuntimeRegistrationRuntime => ({
  async setEnabled(input) {
    const actor = await operatorActor(
      db, input.workspaceId, input.operatorActorId
    );
    if (actor === null) return {status: 'forbidden'};

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
      actor
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
  },
  async recoverExpiredRun(input) {
    const actor = await operatorActor(
      db, input.workspaceId, input.operatorActorId
    );
    if (actor === null) return {status: 'forbidden'};
    const commandId = randomUUID();
    const inputHash = createHash('sha256').update([
      input.agentRunId,
      input.expectedRunVersion,
      input.registrationId,
      input.expectedRegistrationVersion,
      input.expectedProjectId,
      input.expectedAgentId,
      input.expectedAgentProfileId
    ].join('\0')).digest('hex');
    const result = await createCanonicalCommandService({
      unitOfWork: createPostgresUnitOfWork(db)
    }).execute({
      commandId,
      workspaceId: input.workspaceId,
      correlationId: randomUUID(),
      idempotencyKey: [
        'agent_run.recover_expired_lease.v1',
        input.agentRunId,
        input.expectedRunVersion,
        inputHash
      ].join(':'),
      issuedAt: new Date().toISOString(),
      actor,
      type: 'agent_run.transition',
      payload: {
        agentRunId: input.agentRunId,
        status: 'failed',
        expectedVersion: input.expectedRunVersion,
        failureCode: OPERATOR_RECOVERED_EXPIRED_LEASE,
        registrationId: input.registrationId,
        expectedRegistrationVersion: input.expectedRegistrationVersion,
        expectedProjectId: input.expectedProjectId,
        expectedActorId: input.expectedAgentId,
        expectedAgentProfileId: input.expectedAgentProfileId
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
        case 'INVALID_TRANSITION':
        case 'VERSION_CONFLICT':
          return {status: 'stale'};
        default:
          return {status: 'invalid'};
      }
    }
    const value = result.receipt.result.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {status: 'invalid'};
    }
    const run = value as Readonly<{
      failureCode?: unknown;
      status?: unknown;
      version?: unknown;
    }>;
    if (
      run.status !== 'failed' ||
      run.failureCode !== OPERATOR_RECOVERED_EXPIRED_LEASE ||
      typeof run.version !== 'number'
    ) return {status: 'invalid'};
    return {
      status: result.status === 'replayed' ? 'replayed' : 'updated',
      commandId: result.receipt.commandId,
      commandType: 'agent_run.transition',
      failureCode: OPERATOR_RECOVERED_EXPIRED_LEASE,
      version: run.version
    };
  },
  async replace(input) {
    const actor = await operatorActor(
      db, input.workspaceId, input.operatorActorId
    );
    if (actor === null) return {status: 'forbidden'};
    const inputHash = createHash('sha256').update([
      input.projectId,
      input.sourceRegistrationId,
      input.sourceExpectedVersion,
      input.targetRegistrationId,
      input.targetExpectedVersion
    ].join('\0')).digest('hex');
    const result = await createCanonicalCommandService({
      unitOfWork: createPostgresUnitOfWork(db)
    }).execute({
      commandId: randomUUID(),
      workspaceId: input.workspaceId,
      correlationId: randomUUID(),
      idempotencyKey: [
        'runtime_registration.replace.v1',
        input.sourceRegistrationId,
        input.sourceExpectedVersion,
        inputHash
      ].join(':'),
      issuedAt: new Date().toISOString(),
      actor,
      type: 'runtime_registration.replace',
      payload: {
        projectId: input.projectId,
        sourceRegistrationId: input.sourceRegistrationId,
        sourceExpectedVersion: input.sourceExpectedVersion,
        targetRegistrationId: input.targetRegistrationId,
        targetExpectedVersion: input.targetExpectedVersion
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
        case 'INVALID_TRANSITION':
        case 'VERSION_CONFLICT':
          return {status: 'stale'};
        default:
          return {status: 'invalid'};
      }
    }
    const value = result.receipt.result.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {status: 'invalid'};
    }
    const replacement = value as Readonly<{
      source?: Readonly<{enabled?: unknown; version?: unknown}>;
      target?: Readonly<{enabled?: unknown; version?: unknown}>;
    }>;
    if (
      replacement.source?.enabled !== false ||
      typeof replacement.source.version !== 'number' ||
      replacement.target?.enabled !== true ||
      typeof replacement.target.version !== 'number'
    ) return {status: 'invalid'};
    return {
      status: result.status === 'replayed' ? 'replayed' : 'updated',
      commandId: result.receipt.commandId,
      commandType: 'runtime_registration.replace',
      source: {enabled: false, version: replacement.source.version},
      target: {enabled: true, version: replacement.target.version}
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
