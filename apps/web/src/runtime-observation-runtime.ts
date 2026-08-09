import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createCanonicalCommandService} from '@fai-control-plane/application';
import {actors, createDatabase, createPostgresUnitOfWork} from '@fai-control-plane/db';
import {and, eq, isNull} from 'drizzle-orm';
import {canonicalJson, createActorContextIssuer} from '@fai-control-plane/domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const REQUIRED_CAPABILITY = 'write:runtime_observation:development' as const;
const MAX_REGISTRATIONS = 64;

export type RuntimeObservationInput = Readonly<{
  registrationId: string;
  component: 'service' | 'scheduler' | 'delivery';
  state: 'available' | 'unavailable';
  observedAt: string;
  ttlSeconds: number;
  evidenceReference: string;
}>;

type Runtime = Readonly<{
  tokenHash: Buffer;
  workspaceId: string;
  systemActorId: string;
  allowedRegistrationIds: ReadonlySet<string>;
  execute(input: RuntimeObservationInput): Promise<Readonly<{
    status: 'recorded' | 'replayed' | 'rejected';
    commandId?: string;
  }>>;
}>;

const required = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing required configuration: ${name}`);
  return value;
};

const allowedRegistrations = (raw: string): ReadonlySet<string> => {
  const values = raw.split(',').map((value) => value.trim());
  if (values.length < 1 || values.length > MAX_REGISTRATIONS ||
    values.some((value) => !UUID.test(value)) || new Set(values).size !== values.length) {
    throw new Error('Runtime observation registration allowlist is invalid.');
  }
  return new Set(values);
};

export const systemActorIsEligible = (row: Readonly<{
  id: string;
  workspaceId: string;
  type: string;
  authMode: string;
  disabledAt: Date | null;
  capabilities: Record<string, boolean>;
}> | undefined, workspaceId: string, systemActorId: string): boolean =>
  row !== undefined && row.id === systemActorId && row.workspaceId === workspaceId &&
  row.type === 'system' && row.authMode === 'system' && row.disabledAt === null &&
  row.capabilities[REQUIRED_CAPABILITY] === true;
export const runtimeRegistrationIsAllowed = (
  allowedRegistrationIds: ReadonlySet<string>, registrationId: string
): boolean => allowedRegistrationIds.has(registrationId);

const deterministicObservationId = (input: RuntimeObservationInput): string => {
  const hex = createHash('sha256').update([
    input.registrationId, input.component, input.state, input.observedAt,
    input.ttlSeconds, input.evidenceReference
  ].join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
export const runtimeObservationFactHash = (input: RuntimeObservationInput): string =>
  createHash('sha256').update(canonicalJson(input as unknown as Record<string, string | number>)).digest('hex');

const loadRuntime = async (): Promise<Runtime> => {
  const workspaceId = required('RUNTIME_OBSERVATION_WORKSPACE_ID');
  const systemActorId = required('RUNTIME_OBSERVATION_SYSTEM_ACTOR_ID');
  const tokenFile = required('RUNTIME_OBSERVATION_TOKEN_FILE');
  const allowedRegistrationIds = allowedRegistrations(required('RUNTIME_OBSERVATION_ALLOWED_REGISTRATION_IDS'));
  if (!UUID.test(workspaceId) || !UUID.test(systemActorId) || !isAbsolute(tokenFile)) {
    throw new Error('Runtime observation transport configuration is invalid.');
  }
  const raw = await readFile(tokenFile, 'utf8');
  const token = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!TOKEN.test(token)) throw new Error('Runtime observation credential file is invalid.');
  const database = createDatabase(required('DATABASE_URL'));
  const [persistedSystemActor] = await database.db.select({
    id: actors.id,
    workspaceId: actors.workspaceId,
    type: actors.type,
    authMode: actors.authMode,
    disabledAt: actors.disabledAt,
    capabilities: actors.capabilities
  }).from(actors).where(and(
    eq(actors.id, systemActorId),
    eq(actors.workspaceId, workspaceId),
    eq(actors.type, 'system'),
    eq(actors.authMode, 'system'),
    isNull(actors.disabledAt)
  )).limit(1);
  if (!systemActorIsEligible(persistedSystemActor, workspaceId, systemActorId)) {
    throw new Error('Runtime observation system actor is not active or authorized.');
  }
  const issuer = createActorContextIssuer({
    users: [],
    agents: [],
    systems: [{
      actorId: systemActorId,
      capabilities: [REQUIRED_CAPABILITY]
    }]
  });
  if (!issuer.ok) throw new Error('Runtime observation authority is invalid.');
  const actor = issuer.value.issueSystem(systemActorId);
  if (!actor.ok) throw new Error('Runtime observation actor is invalid.');
  const service = createCanonicalCommandService({
    unitOfWork: createPostgresUnitOfWork(database.db)
  });
  return {
    tokenHash: createHash('sha256').update(token).digest(),
    workspaceId,
    systemActorId,
    allowedRegistrationIds,
    async execute(input) {
      if (!runtimeRegistrationIsAllowed(allowedRegistrationIds, input.registrationId)) {
        return {status: 'rejected'};
      }
      const observationId = deterministicObservationId(input);
      const factHash = runtimeObservationFactHash(input);
      const result = await service.execute({
        commandId: randomUUID(),
        workspaceId,
        correlationId: randomUUID(),
        idempotencyKey: `runtime_availability.observe.v1:${observationId}:${factHash}`,
        issuedAt: new Date().toISOString(),
        actor: actor.value,
        type: 'runtime_availability.observe',
        payload: {observationId, ...input}
      });
      if (!('receipt' in result) || !result.receipt.result.ok) return {status: 'rejected'};
      return {
        status: result.status === 'replayed' ? 'replayed' : 'recorded',
        commandId: result.receipt.commandId
      };
    }
  };
};

let runtimePromise: Promise<Runtime> | undefined;
export const getRuntimeObservationRuntime = async (): Promise<Runtime> => {
  runtimePromise ??= loadRuntime().catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};

export const authenticateRuntimeObservation = (
  authorizationHeader: string | null,
  expectedHash: Buffer
): boolean => {
  const supplied = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length)
    : '';
  const validShape = TOKEN.test(supplied);
  const suppliedHash = createHash('sha256').update(validShape ? supplied : 'invalid-runtime-observation-token').digest();
  const matches = suppliedHash.length === expectedHash.length && timingSafeEqual(suppliedHash, expectedHash);
  return validShape && matches;
};
