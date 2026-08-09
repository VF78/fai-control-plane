import {createHash, randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import {createCanonicalCommandService} from '@fai-control-plane/application';
import {actors, createDatabase, createPostgresUnitOfWork} from '@fai-control-plane/db';
import {createActorContextIssuer, type Capability, type ProjectMembershipRole,
  type ProjectSetupBindingMode, type ProjectSetupExecutionMode} from '@fai-control-plane/domain';

type Database = ReturnType<typeof createDatabase>['db'];
type Status = 'created' | 'replayed' | 'forbidden' | 'conflict' | 'invalid';

export type ProjectIntakeInput = Readonly<{
  workspaceId: string;
  operatorActorId: string;
  idempotencyKey: string;
  name: string;
  slug: string;
  productOwnerActorId: string;
  members: readonly Readonly<{actorId: string; role: ProjectMembershipRole}>[];
  repositoryBinding: ProjectSetupBindingMode;
  trackerBinding: ProjectSetupBindingMode;
  internalChat: ProjectSetupBindingMode;
  clientChat: ProjectSetupBindingMode;
  executionMode: ProjectSetupExecutionMode;
  agentProfileId: string | null;
}>;

const enabledCapabilities = (capabilities: Record<string, boolean>): Capability[] =>
  Object.entries(capabilities).flatMap(([capability, enabled]) => enabled ? [capability as Capability] : []);
const deterministicUuid = (key: string, purpose: string): string => {
  const bytes = Buffer.from(createHash('sha256').update(`${key}\0${purpose}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const createProjectIntakeRuntime = (db: Database) => ({
  async create(input: ProjectIntakeInput): Promise<Readonly<{status: Status; slug?: string}>> {
    const [operator] = await db.select({capabilities: actors.capabilities}).from(actors).where(and(
      eq(actors.id, input.operatorActorId), eq(actors.workspaceId, input.workspaceId),
      eq(actors.type, 'human'), eq(actors.authMode, 'user'), isNull(actors.disabledAt)
    ));
    if (operator === undefined || operator.capabilities['write:control_plane:development'] !== true) {
      return {status: 'forbidden'};
    }
    const issuer = createActorContextIssuer({users: [{actorId: input.operatorActorId,
      capabilities: enabledCapabilities(operator.capabilities)}], agents: [], systems: []});
    if (!issuer.ok) return {status: 'forbidden'};
    const actor = issuer.value.issueUser(input.operatorActorId);
    if (!actor.ok) return {status: 'forbidden'};
    const aggregateKey = `${input.workspaceId}:${input.idempotencyKey}`;
    const result = await createCanonicalCommandService({unitOfWork: createPostgresUnitOfWork(db)}).execute({
      commandId: randomUUID(), workspaceId: input.workspaceId, correlationId: randomUUID(),
      idempotencyKey: input.idempotencyKey, issuedAt: new Date().toISOString(), actor: actor.value,
      type: 'project.create', payload: {
        projectId: deterministicUuid(aggregateKey, 'project'), setupId: deterministicUuid(aggregateKey, 'setup'), name: input.name, slug: input.slug,
        productOwnerActorId: input.productOwnerActorId, productOwnerMembershipId: deterministicUuid(aggregateKey, 'owner-membership'),
        members: input.members.map((member, index) => ({membershipId: deterministicUuid(aggregateKey, `member-${index}`), ...member})),
        repositoryBinding: input.repositoryBinding, trackerBinding: input.trackerBinding,
        internalChat: input.internalChat, clientChat: input.clientChat,
        executionMode: input.executionMode, agentProfileId: input.agentProfileId
      }
    });
    if (result.status === 'replayed') return {status: 'replayed', slug: input.slug};
    if (!('receipt' in result) || !result.receipt.result.ok) {
      const code = 'receipt' in result && !result.receipt.result.ok ? result.receipt.result.error.code : null;
      return {status: code === 'CAPABILITY_DENIED' || code === 'POLICY_DENIED' ? 'forbidden'
        : code === 'VERSION_CONFLICT' ? 'conflict' : 'invalid'};
    }
    return {status: 'created', slug: input.slug};
  }
});

export const getProjectIntakeRuntime = async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const database = createDatabase(databaseUrl);
  const runtime = createProjectIntakeRuntime(database.db);
  return {runtime, close: () => database.pool.end()};
};
