import {createHash, randomUUID} from 'node:crypto';
import {
  canonicalJson,
  simulateAgentRunQueuePolicy,
  type PolicySimulationResult,
  type PolicySimulationTrustedContext
} from '@fai-control-plane/domain';
import {and, eq, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import {isRuntimeAvailable} from './runtime-availability';

type Database = NodePgDatabase<typeof schema>;

export type PolicySimulationStoreResult =
  | Readonly<{status: 'completed' | 'replayed'; simulation: PolicySimulationResult}>
  | Readonly<{status: 'forbidden'}>;

const stableUuid = (hash: string): string =>
  `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;

const requestHashFor = (
  workspaceId: string,
  actorId: string,
  simulation: PolicySimulationResult
): string => createHash('sha256').update(canonicalJson({
  workspaceId,
  actorId,
  inputHash: simulation.inputHash,
  contextHash: simulation.contextHash,
  simulationHash: simulation.simulationHash
})).digest('hex');

export const createPostgresPolicySimulationStore = (
  db: Database,
  options: Readonly<{
    runnerQueueEnabled?: boolean;
    runtimeAvailable?: boolean;
    now?: () => Date;
  }> = {}
) => ({
  async simulate(input: Readonly<{
    workspaceId: string;
    actorId: string;
    taskPacketId: string;
    profileId: string;
  }>): Promise<PolicySimulationStoreResult> {
    return db.transaction(async (tx) => {
      const [operator] = await tx.select({
        id: schema.actors.id,
        capabilities: schema.actors.capabilities
      })
        .from(schema.actors)
        .where(and(
          eq(schema.actors.id, input.actorId),
          eq(schema.actors.workspaceId, input.workspaceId),
          eq(schema.actors.type, 'human'),
          eq(schema.actors.authMode, 'user'),
          isNull(schema.actors.disabledAt)
        ))
        .limit(1);
      if (operator === undefined) return {status: 'forbidden'} as const;

      const [packet] = await tx.select({
        packetId: schema.taskPackets.id,
        contentHash: schema.taskPackets.contentHash,
        approverActorId: schema.taskPackets.approverActorId,
        runtimeProfile: schema.taskPackets.runtimeProfile,
        workItemVersion: schema.taskPackets.workItemVersion,
        currentWorkItemVersion: schema.workItems.version,
        workItemDeletedAt: schema.workItems.deletedAt,
        agentProfileSnapshotId: schema.taskPackets.agentProfileSnapshotId,
        agentProfileSnapshotVersion: schema.taskPackets.agentProfileSnapshotVersion,
        agentProfileSnapshotHash: schema.taskPackets.agentProfileSnapshotHash,
        agentRunId: schema.agentRuns.id,
        projectId: schema.taskPackets.projectId
      })
        .from(schema.taskPackets)
        .innerJoin(schema.projects, and(
          eq(schema.projects.id, schema.taskPackets.projectId),
          eq(schema.projects.workspaceId, input.workspaceId)
        ))
        .leftJoin(schema.workItems, eq(schema.workItems.id, schema.taskPackets.workItemId))
        .leftJoin(schema.agentRuns, eq(schema.agentRuns.taskPacketId, schema.taskPackets.id))
        .where(eq(schema.taskPackets.id, input.taskPacketId))
        .limit(1);
      const [profile] = await tx.select({
        profileId: schema.agentProfiles.id,
        runtimeId: schema.agentProfiles.runtimeId,
        runtimeProfile: schema.agentProfiles.runtimeProfile,
        enabled: schema.agentProfiles.enabled,
        version: schema.agentProfiles.version,
        configHash: schema.agentProfiles.configHash,
        actorType: schema.actors.type,
        actorAuthMode: schema.actors.authMode,
        actorDisabledAt: schema.actors.disabledAt
      })
        .from(schema.agentProfiles)
        .innerJoin(schema.actors, and(
          eq(schema.actors.id, schema.agentProfiles.actorId),
          eq(schema.actors.workspaceId, input.workspaceId)
        ))
        .where(and(
          eq(schema.agentProfiles.id, input.profileId),
          eq(schema.agentProfiles.workspaceId, input.workspaceId)
        ))
        .limit(1);
      const [binding] = packet === undefined ? [] : await tx.select({
        metadata: schema.trackerBindings.metadata
      })
        .from(schema.trackerBindings)
        .where(and(
          eq(schema.trackerBindings.projectId, packet.projectId),
          eq(schema.trackerBindings.provider, 'github'),
          eq(schema.trackerBindings.surface, 'repository'),
          eq(schema.trackerBindings.entityType, 'project'),
          eq(schema.trackerBindings.entityId, packet.projectId)
        ))
        .limit(1);
      const headSha = binding?.metadata.headSha;
      const defaultBranch = binding?.metadata.defaultBranch;
      const context: PolicySimulationTrustedContext = {
        operatorActorId: input.actorId,
        operatorCapabilities: Object.entries(operator.capabilities)
          .flatMap(([capability, enabled]) => enabled ? [capability] : [])
          .sort(),
        runnerQueueEnabled: options.runnerQueueEnabled ??
          (process.env.RUNNER_ENABLED === 'true' &&
            process.env.LOCAL_RUNNER_TRANSPORT_ENABLED === 'true'),
        runtimeAvailable: options.runtimeAvailable ?? isRuntimeAvailable(profile?.runtimeId),
        packet: packet === undefined ? null : {
          packetId: packet.packetId,
          contentHash: packet.contentHash,
          approverActorId: packet.approverActorId,
          runtimeProfile: packet.runtimeProfile,
          workItemVersion: packet.workItemVersion,
          currentWorkItemVersion: packet.currentWorkItemVersion,
          workItemDeleted: packet.workItemDeletedAt !== null,
          agentProfileSnapshotId: packet.agentProfileSnapshotId,
          agentProfileSnapshotVersion: packet.agentProfileSnapshotVersion,
          agentProfileSnapshotHash: packet.agentProfileSnapshotHash,
          hasAgentRun: packet.agentRunId !== null,
          repositoryBaseCommit:
            typeof defaultBranch === 'string' && defaultBranch.length > 0 &&
            typeof headSha === 'string' && /^[0-9a-f]{40}$/.test(headSha) ? headSha : null
        },
        profile: profile === undefined ? null : {
          profileId: profile.profileId,
          runtimeId: profile.runtimeId,
          runtimeProfile: profile.runtimeProfile,
          enabled: profile.enabled,
          version: profile.version,
          configHash: profile.configHash,
          actorType: profile.actorType,
          actorAuthMode: profile.actorAuthMode,
          actorDisabled: profile.actorDisabledAt !== null
        }
      };
      const simulation = simulateAgentRunQueuePolicy({
        taskPacketId: input.taskPacketId,
        profileId: input.profileId,
        context,
        simulatedAt: options.now?.() ?? new Date()
      });
      const commandId = stableUuid(simulation.simulationHash);
      const idempotencyKey = `policy.simulate:${simulation.simulationHash}`;
      const requestHash = requestHashFor(input.workspaceId, input.actorId, simulation);
      const receiptResult = {
        ok: true,
        value: simulation
      } as unknown as Record<string, unknown>;
      const [inserted] = await tx.insert(schema.commandReceipts).values({
        workspaceId: input.workspaceId,
        idempotencyKey,
        requestHash,
        commandId,
        correlationId: commandId,
        state: 'completed',
        commandType: 'policy.simulate',
        aggregateType: 'task_packet',
        aggregateId: input.taskPacketId,
        result: receiptResult,
        createdAt: new Date(simulation.simulatedAt),
        completedAt: new Date(simulation.simulatedAt)
      }).onConflictDoNothing({
        target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
      }).returning({id: schema.commandReceipts.id});
      if (inserted === undefined) {
        const [existing] = await tx.select({
          requestHash: schema.commandReceipts.requestHash,
          result: schema.commandReceipts.result
        }).from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.workspaceId, input.workspaceId),
          eq(schema.commandReceipts.idempotencyKey, idempotencyKey)
        )).limit(1);
        if (existing === undefined || existing.requestHash !== requestHash) {
          throw new Error('Policy simulation receipt conflict.');
        }
        const value = (existing.result as {value?: unknown} | null)?.value;
        return {status: 'replayed', simulation: value as PolicySimulationResult} as const;
      }
      await tx.insert(schema.auditEvents).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        projectId: packet?.projectId ?? null,
        actorId: input.actorId,
        commandId,
        actionCategory: 'write',
        action: 'policy.simulate',
        targetType: 'task_packet',
        targetId: input.taskPacketId,
        policyDecision: simulation.decision,
        outcome: simulation.decision === 'allow' ? 'succeeded' : 'rejected',
        reasonCode: simulation.decision === 'allow' ? null : 'POLICY_SIMULATION_DENIED',
        correlationId: commandId,
        occurredAt: new Date(simulation.simulatedAt),
        metadata: {}
      });
      return {status: 'completed', simulation} as const;
    });
  }
});
