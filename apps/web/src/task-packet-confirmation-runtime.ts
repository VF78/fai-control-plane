import {createHash, randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import {
  createCanonicalCommandService
} from '@fai-control-plane/application';
import {
  actors,
  agentProfiles,
  agentRuns,
  createDatabase,
  createPostgresUnitOfWork,
  projects,
  taskPackets,
  trackerBindings
} from '@fai-control-plane/db';
import {createActorContextIssuer, type Capability} from '@fai-control-plane/domain';

type Database = ReturnType<typeof createDatabase>['db'];

const shaPattern = /^[0-9a-f]{40}$/;

type PacketLookup = Readonly<{
  packetId: string;
  contentHash: string;
  agentProfileId: string;
  baseCommit: string;
}>;

const baseCommitFrom = (metadata: Record<string, unknown> | undefined): string | null => {
  if (metadata === undefined || typeof metadata.defaultBranch !== 'string' ||
    metadata.defaultBranch.length === 0) return null;
  const headSha = metadata.headSha;
  return typeof headSha === 'string' && shaPattern.test(headSha) ? headSha : null;
};

const enabledCapabilities = (value: Record<string, boolean>): Capability[] =>
  Object.entries(value).flatMap(([capability, enabled]) => enabled ? [capability as Capability] : []);

const confirmationRunId = (packet: PacketLookup): string => {
  const hash = createHash('sha256')
    .update(`task-packet-confirm-v1\0${packet.packetId}\0${packet.contentHash}\0${packet.agentProfileId}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

export type TaskPacketConfirmationRuntime = Readonly<{
  load(
    workspaceId: string,
    packetId: string,
    agentProfileId: string
  ): Promise<PacketLookup | null>;
  queue(input: PacketLookup & Readonly<{workspaceId: string; actorId: string}>): Promise<
    | Readonly<{status: 'queued'; runId: string; commandId: string; correlationId: string; resultVersion: number | null}>
    | Readonly<{status: 'conflict' | 'forbidden' | 'unavailable'}>
  >;
}>;

const createRuntime = (db: Database): TaskPacketConfirmationRuntime => ({
  async load(workspaceId, packetId, agentProfileId) {
    const [packet] = await db.select({
      packetId: taskPackets.id,
      contentHash: taskPackets.contentHash,
      runtimeProfile: taskPackets.runtimeProfile,
      projectId: taskPackets.projectId,
      workItemId: taskPackets.workItemId
    }).from(taskPackets)
      .innerJoin(projects, and(
        eq(projects.id, taskPackets.projectId),
        eq(projects.workspaceId, workspaceId)
      ))
      .leftJoin(agentRuns, eq(agentRuns.taskPacketId, taskPackets.id))
      .where(and(eq(taskPackets.id, packetId), isNull(agentRuns.id)))
      .limit(1);
    if (packet === undefined) return null;

    const [profile] = await db.select({id: agentProfiles.id})
      .from(agentProfiles).innerJoin(actors, and(
        eq(actors.id, agentProfiles.actorId),
        eq(actors.workspaceId, workspaceId)
      ))
      .where(and(
        eq(agentProfiles.id, agentProfileId),
        eq(agentProfiles.workspaceId, workspaceId),
        eq(agentProfiles.runtimeProfile, packet.runtimeProfile),
        eq(agentProfiles.enabled, true),
        isNull(actors.disabledAt)
      ))
      .limit(1);
    if (profile === undefined) return null;

    const [repositoryBinding] = await db.select({metadata: trackerBindings.metadata})
      .from(trackerBindings)
      .where(and(
        eq(trackerBindings.projectId, packet.projectId),
        eq(trackerBindings.provider, 'github'),
        eq(trackerBindings.surface, 'repository'),
        eq(trackerBindings.entityType, 'project'),
        eq(trackerBindings.entityId, packet.projectId)
      ))
      .limit(1);
    const baseCommit = baseCommitFrom(repositoryBinding?.metadata);
    return baseCommit === null ? null : {
      packetId: packet.packetId,
      contentHash: packet.contentHash,
      agentProfileId: profile.id,
      baseCommit
    };
  },

  async queue(input) {
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
    if (operator === undefined) return {status: 'forbidden'};
    const issuer = createActorContextIssuer({
      users: [{actorId: input.actorId, capabilities: enabledCapabilities(operator.capabilities)}],
      agents: [],
      systems: []
    });
    if (!issuer.ok) return {status: 'forbidden'};
    const actor = issuer.value.issueUser(input.actorId);
    if (!actor.ok) return {status: 'forbidden'};

    const commandId = randomUUID();
    const correlationId = randomUUID();
    const result = await createCanonicalCommandService({
      unitOfWork: createPostgresUnitOfWork(db)
    }).execute({
      commandId,
      workspaceId: input.workspaceId,
      correlationId,
      idempotencyKey: `task-packet-confirm:${input.packetId}:${input.contentHash}:${input.agentProfileId}`,
      issuedAt: new Date().toISOString(),
      actor: actor.value,
      type: 'agent_run.queue',
      payload: {
        agentRunId: confirmationRunId(input),
        taskPacketId: input.packetId,
        agentProfileId: input.agentProfileId,
        confirmedPacketHash: input.contentHash,
        baseCommit: input.baseCommit
      }
    });
    if (result.status === 'completed' || result.status === 'replayed') {
      const receipt = result.receipt;
      if (!receipt.result.ok) return receipt.result.error.code === 'VERSION_CONFLICT'
        ? {status: 'conflict'}
        : {status: 'forbidden'};
      if (receipt.aggregateId === undefined) return {status: 'unavailable'};
      return {
        status: 'queued',
        runId: receipt.aggregateId,
        commandId: receipt.commandId,
        correlationId: receipt.correlationId,
        resultVersion: receipt.resultVersion ?? null
      };
    }
    return result.status === 'key_reused' ? {status: 'conflict'} : {status: 'unavailable'};
  }
});

let runtimePromise: Promise<TaskPacketConfirmationRuntime> | undefined;

export const getTaskPacketConfirmationRuntime = async (): Promise<TaskPacketConfirmationRuntime> => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required for task packet confirmation');
    }
    const {db} = createDatabase(databaseUrl);
    return createRuntime(db);
  })().catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};
