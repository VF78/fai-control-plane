import {randomUUID} from 'node:crypto';
import {
  firstEnabledDeliveryStage,
  nextEnabledDeliveryStage,
  transitionWorkItem,
  validateDeliveryEvidenceReferences,
  validateDeliveryProtocolDefinition,
  type CommandError,
  type DeliveryJourneyProjection,
  type DeliveryProtocol,
  type DeliveryProtocolStage,
  type WorkItem
} from '@fai-control-plane/domain';
import {and, asc, eq, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Command = Readonly<{
  commandId: string; workspaceId: string; correlationId: string; idempotencyKey: string;
  actor: Readonly<{actorId: string}>;
}> & (
  | Readonly<{type: 'delivery_journey.start'; payload: Readonly<{
      workItemId: string; protocolId: string; expectedWorkItemVersion: number;
      deadlineAt: string | null;
    }>}>
  | Readonly<{type: 'delivery_journey.advance'; payload: Readonly<{
      workItemId: string; expectedWorkItemVersion: number; expectedJourneyVersion: number;
      evidenceReferences: readonly Readonly<{requirement: string; reference: string}>[];
    }>}>
);
type StoreInput = Readonly<{
  command: Command; requestHash: string; authorized: boolean; policyError?: CommandError;
}>;
const errorResult = (code: CommandError['code'], message: string) => ({
  ok: false as const, error: {code, message}
});
const known = <T>(value: T) => ({availability: 'known' as const, value});
const unknown = <T>() => ({availability: 'unknown' as const});
const notConfigured = <T>() => ({availability: 'not_configured' as const});

const protocolFrom = (row: typeof schema.runbooks.$inferSelect): DeliveryProtocol | null => {
  if (row.protocolState === null || row.revision === null || row.contentHash === null) return null;
  const definition = validateDeliveryProtocolDefinition(row.definition);
  return definition.ok ? {
    id: row.id, projectId: row.projectId, name: row.name, version: row.version,
    revision: row.revision, state: row.protocolState, active: row.active,
    definition: definition.value, contentHash: row.contentHash
  } : null;
};
const authority = async (tx: Transaction, workspaceId: string, actorId: string,
  projectId: string, write: boolean) => {
  const [actor] = await tx.select().from(schema.actors).where(and(
    eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId),
    eq(schema.actors.type, 'human'), eq(schema.actors.authMode, 'user'),
    isNull(schema.actors.disabledAt)
  )).limit(1);
  if (actor === undefined) return false;
  if (['workspace_admin', 'delivery_lead'].includes(actor.role)) return true;
  const [membership] = await tx.select().from(schema.projectMemberships).where(and(
    eq(schema.projectMemberships.projectId, projectId),
    eq(schema.projectMemberships.actorId, actorId),
    eq(schema.projectMemberships.active, true)
  )).limit(1);
  return membership !== undefined && (!write ||
    ['workspace_owner', 'project_owner'].includes(membership.role));
};
const responsibilityProjection = async (
  tx: Transaction,
  projectId: string,
  stage: DeliveryProtocolStage
) => {
  const configured = stage.responsibility;
  if (configured.kind === 'project_role') {
    const rows = await tx.select({
      id: schema.actors.id,
      displayName: schema.actors.displayName,
      type: schema.actors.type
    }).from(schema.projectMemberships)
      .innerJoin(schema.actors, eq(schema.actors.id, schema.projectMemberships.actorId))
      .where(and(
        eq(schema.projectMemberships.projectId, projectId),
        eq(schema.projectMemberships.role, configured.role),
        eq(schema.projectMemberships.active, true),
        isNull(schema.actors.disabledAt)
      )).orderBy(asc(schema.actors.id));
    const actor = rows[0];
    return {
      configured,
      actor: actor === undefined || actor.type === 'system' ? unknown() : known({
        id: actor.id, displayName: actor.displayName, type: actor.type
      }),
      agentProfile: notConfigured(),
      resolved: actor !== undefined && actor.type !== 'system'
    };
  }
  const [actor] = await tx.select({
    id: schema.actors.id, displayName: schema.actors.displayName, type: schema.actors.type
  }).from(schema.actors)
    .innerJoin(schema.projectMemberships, and(
      eq(schema.projectMemberships.actorId, schema.actors.id),
      eq(schema.projectMemberships.projectId, projectId),
      eq(schema.projectMemberships.active, true)
    ))
    .where(and(eq(schema.actors.id, configured.actorId), isNull(schema.actors.disabledAt)))
    .limit(1);
  if (configured.actorType === 'human') return {
    configured,
    actor: actor?.type === 'human' ? known({
      id: actor.id, displayName: actor.displayName, type: actor.type
    }) : unknown(),
    agentProfile: notConfigured(),
    resolved: actor?.type === 'human'
  };
  const [profile] = await tx.select({id: schema.agentProfiles.id})
    .from(schema.agentProfiles)
    .innerJoin(schema.runtimeRegistrations, and(
      eq(schema.runtimeRegistrations.agentProfileId, schema.agentProfiles.id),
      eq(schema.runtimeRegistrations.actorId, configured.actorId),
      eq(schema.runtimeRegistrations.projectId, projectId),
      eq(schema.runtimeRegistrations.enabled, true)
    ))
    .where(and(
      eq(schema.agentProfiles.id, configured.agentProfileId),
      eq(schema.agentProfiles.actorId, configured.actorId),
      eq(schema.agentProfiles.enabled, true)
    )).limit(1);
  return {
    configured,
    actor: actor?.type === 'agent' ? known({
      id: actor.id, displayName: actor.displayName, type: actor.type
    }) : unknown(),
    agentProfile: profile === undefined ? unknown() : known(profile),
    resolved: actor?.type === 'agent' && profile !== undefined
  };
};
const readProjection = async (
  tx: Transaction, workspaceId: string, workItemId: string, actorId: string, at: Date
): Promise<DeliveryJourneyProjection | null> => {
  const [item] = await tx.select().from(schema.workItems)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.workItems.projectId))
    .where(and(
      eq(schema.workItems.id, workItemId),
      eq(schema.projects.workspaceId, workspaceId),
      isNull(schema.workItems.deletedAt)
    )).limit(1);
  if (item === undefined || !await authority(
    tx, workspaceId, actorId, item.work_items.projectId, false
  )) return null;
  const task = item.work_items;
  const [journey] = await tx.select().from(schema.deliveryJourneys)
    .where(eq(schema.deliveryJourneys.workItemId, workItemId)).limit(1);
  if (journey === undefined) return {
    state: 'not_configured',
    task: {id: task.id, status: task.status, version: task.version},
    reason: 'protocol_not_bound'
  };
  const [protocolRow] = await tx.select().from(schema.runbooks).where(and(
    eq(schema.runbooks.id, journey.protocolId),
    eq(schema.runbooks.version, journey.protocolVersion)
  )).limit(1);
  const protocol = protocolRow === undefined ? null : protocolFrom(protocolRow);
  const stage = protocol?.definition.stages.find((candidate) => candidate.key === journey.stageKey);
  if (protocol === null || stage === undefined) return null;
  const responsibility = await responsibilityProjection(tx, task.projectId, stage);
  const evidence = await tx.select().from(schema.deliveryJourneyEvidence).where(and(
    eq(schema.deliveryJourneyEvidence.workItemId, workItemId),
    eq(schema.deliveryJourneyEvidence.stageKey, stage.key)
  ));
  const next = nextEnabledDeliveryStage(protocol, stage.key);
  const nextAllowedAction = task.blocked
    ? {kind: 'blocked' as const, reason: 'work_item_blocked' as const}
    : !responsibility.resolved
      ? {kind: 'blocked' as const, reason: 'responsibility_unresolved' as const}
      : next === null
        ? {kind: 'blocked' as const, reason: 'journey_complete' as const}
        : {kind: 'advance' as const, toStageKey: next.key,
            expectedWorkItemVersion: task.version, expectedJourneyVersion: journey.version};
  return {
    state: 'configured',
    task: {id: task.id, status: task.status, version: task.version},
    protocol: {id: protocol.id, version: protocol.version},
    journeyVersion: journey.version,
    stage: {
      key: stage.key,
      name: stage.name,
      taskStatus: stage.taskStatus,
      executionMode: stage.executionMode
    },
    responsibility: {
      configured: responsibility.configured,
      actor: responsibility.actor,
      agentProfile: responsibility.agentProfile
    },
    deadline: journey.deadlineAt === null
      ? {state: 'not_set', at: null}
      : {state: task.status === 'done' ? 'completed' : journey.deadlineAt <= at ? 'overdue' : 'upcoming',
          at: journey.deadlineAt.toISOString()},
    requiredEvidence: stage.requiredEvidence.map((requirement) => ({
      requirement,
      references: evidence.filter((row) => row.requirement === requirement)
        .map((row) => row.evidenceReference)
    })),
    nextAllowedAction
  };
};

export const createPostgresDeliveryJourneyStore = (db: Database) => ({
  async execute(input: StoreInput) {
    return db.transaction(async (tx) => {
      const command = input.command;
      const [claimed] = await tx.insert(schema.commandReceipts).values({
        workspaceId: command.workspaceId, idempotencyKey: command.idempotencyKey,
        requestHash: input.requestHash, commandId: command.commandId,
        correlationId: command.correlationId, commandType: command.type
      }).onConflictDoNothing({
        target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
      }).returning();
      if (claimed === undefined) {
        const [existing] = await tx.select().from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.workspaceId, command.workspaceId),
          eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
        )).for('update');
        if (existing === undefined || existing.requestHash !== input.requestHash) {
          return {status: 'key_reused' as const, existingRequestHash: existing?.requestHash ?? ''};
        }
        if (existing.state !== 'completed' || existing.result === null) {
          throw new Error('delivery_journey_receipt_incomplete');
        }
        return {status: 'replayed' as const, receipt: {
          commandId: existing.commandId, workspaceId: command.workspaceId,
          correlationId: existing.correlationId, idempotencyKey: command.idempotencyKey,
          requestHash: existing.requestHash, commandType: command.type,
          result: existing.result as never, createdAt: existing.createdAt.toISOString()
        }};
      }
      let result: any;
      let projectId: string | null = null;
      let resultVersion: number | undefined;
      const complete = async () => {
        const now = new Date();
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(), workspaceId: command.workspaceId, projectId,
          actorId: command.actor.actorId, commandId: command.commandId,
          actionCategory: 'write', action: command.type, targetType: 'delivery_journey',
          targetId: command.payload.workItemId,
          policyDecision: input.authorized ? 'allow' : 'deny',
          outcome: result.ok ? 'succeeded' : input.authorized ? 'failed' : 'rejected',
          ...(!result.ok ? {reasonCode: result.error.code} : {}),
          expectedVersion: command.type === 'delivery_journey.advance'
            ? command.payload.expectedJourneyVersion : undefined,
          resultVersion, correlationId: command.correlationId, occurredAt: now
        });
        await tx.update(schema.commandReceipts).set({
          state: 'completed', aggregateType: 'delivery_journey',
          aggregateId: command.payload.workItemId,
          expectedVersion: command.type === 'delivery_journey.advance'
            ? command.payload.expectedJourneyVersion : undefined,
          resultVersion, result, completedAt: now
        }).where(eq(schema.commandReceipts.id, claimed.id));
        return {status: 'completed' as const, receipt: {
          commandId: command.commandId, workspaceId: command.workspaceId,
          correlationId: command.correlationId, idempotencyKey: command.idempotencyKey,
          requestHash: input.requestHash, commandType: command.type, result,
          createdAt: claimed.createdAt.toISOString()
        }};
      };
      if (!input.authorized) {
        result = errorResult(input.policyError?.code ?? 'POLICY_DENIED',
          input.policyError?.message ?? 'Policy denies this command.');
        return complete();
      }
      const rows = await tx.select().from(schema.workItems)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.workItems.projectId))
        .where(and(eq(schema.workItems.id, command.payload.workItemId),
          eq(schema.projects.workspaceId, command.workspaceId),
          isNull(schema.workItems.deletedAt))).limit(1).for('update');
      const item = rows[0]?.work_items;
      if (item === undefined) {
        result = errorResult('NOT_FOUND', 'Work item was not found.');
        return complete();
      }
      projectId = item.projectId;
      if (!await authority(tx, command.workspaceId, command.actor.actorId, projectId, true)) {
        result = errorResult('CAPABILITY_DENIED', 'Actor is not a task owner for this project.');
        return complete();
      }
      if (item.version !== command.payload.expectedWorkItemVersion) {
        result = errorResult('VERSION_CONFLICT', 'Work item version conflicts.');
        return complete();
      }
      let journey = (await tx.select().from(schema.deliveryJourneys)
        .where(eq(schema.deliveryJourneys.workItemId, item.id)).limit(1).for('update'))[0];
      let protocol: DeliveryProtocol | null = null;
      let stage: DeliveryProtocolStage | null = null;
      if (command.type === 'delivery_journey.start') {
        if (journey !== undefined) {
          resultVersion = journey.version;
          result = errorResult('VERSION_CONFLICT', 'Delivery journey is already configured.');
          return complete();
        }
        const [row] = await tx.select().from(schema.runbooks).where(and(
          eq(schema.runbooks.id, command.payload.protocolId),
          eq(schema.runbooks.projectId, item.projectId)
        )).limit(1).for('update');
        protocol = row === undefined ? null : protocolFrom(row);
        if (protocol?.state !== 'published' || !protocol.active) {
          result = errorResult('INVALID_COMMAND', 'Active published delivery protocol is required.');
          return complete();
        }
        if (!['backlog', 'ready'].includes(item.status)) {
          result = errorResult(
            'INVALID_TRANSITION',
            'A new delivery journey can start only from backlog or ready.'
          );
          return complete();
        }
        stage = firstEnabledDeliveryStage(protocol);
      } else {
        if (journey === undefined) {
          result = errorResult('NOT_FOUND', 'Delivery journey is not configured.');
          return complete();
        }
        if (journey.version !== command.payload.expectedJourneyVersion) {
          resultVersion = journey.version;
          result = errorResult('VERSION_CONFLICT', 'Delivery journey version conflicts.');
          return complete();
        }
        const [row] = await tx.select().from(schema.runbooks).where(and(
          eq(schema.runbooks.id, journey.protocolId),
          eq(schema.runbooks.version, journey.protocolVersion)
        )).limit(1);
        protocol = row === undefined ? null : protocolFrom(row);
        stage = protocol?.definition.stages.find(
          (candidate) => candidate.key === journey!.stageKey
        ) ?? null;
      }
      if (protocol === null || stage === null) {
        result = errorResult('INVALID_COMMAND', 'Bound delivery protocol context is incomplete.');
        return complete();
      }
      const responsibility = await responsibilityProjection(tx, item.projectId, stage);
      if (!responsibility.resolved) {
        result = errorResult('INVALID_COMMAND', 'Delivery stage responsibility is unresolved.');
        return complete();
      }
      const next = command.type === 'delivery_journey.start'
        ? stage : nextEnabledDeliveryStage(protocol, stage.key);
      if (next === null) {
        result = errorResult('INVALID_TRANSITION', 'Delivery journey has no enabled next stage.');
        return complete();
      }
      if (next.key !== stage.key) {
        const nextResponsibility = await responsibilityProjection(tx, item.projectId, next);
        if (!nextResponsibility.resolved) {
          result = errorResult(
            'INVALID_COMMAND',
            'Next delivery stage responsibility is unresolved.'
          );
          return complete();
        }
      }
      let acceptedEvidence: readonly Readonly<{requirement: string; reference: string}>[] = [];
      if (command.type === 'delivery_journey.advance') {
        const evidence = validateDeliveryEvidenceReferences(stage, command.payload.evidenceReferences);
        if (!evidence.ok) {
          result = evidence;
          return complete();
        }
        acceptedEvidence = evidence.value;
      }
      const targetStatus = next.taskStatus;
      let updated: WorkItem = {
        id: item.id, projectId: item.projectId, status: item.status,
        blocked: item.blocked, version: item.version
      };
      if (item.status !== targetStatus) {
        const transitioned = transitionWorkItem(updated, targetStatus);
        if (!transitioned.ok) {
          result = transitioned;
          return complete();
        }
        updated = transitioned.value;
      }
      if (acceptedEvidence.length > 0) {
        await tx.insert(schema.deliveryJourneyEvidence).values(acceptedEvidence.map((entry) => ({
          workItemId: item.id, stageKey: stage!.key, requirement: entry.requirement,
          evidenceReference: entry.reference, commandId: command.commandId
        })));
      }
      if (item.status !== targetStatus) {
        await tx.update(schema.workItems).set({
          status: updated.status, version: updated.version, updatedAt: new Date()
        }).where(and(eq(schema.workItems.id, item.id), eq(schema.workItems.version, item.version)));
        await tx.insert(schema.statusTransitions).values({
          workItemId: item.id, fromStatus: item.status, toStatus: updated.status,
          actorId: command.actor.actorId, reason: 'delivery_journey_stage_advance',
          idempotencyKey: `delivery-journey:${command.commandId}`
        });
      }
      if (command.type === 'delivery_journey.start') {
        [journey] = await tx.insert(schema.deliveryJourneys).values({
          workItemId: item.id, protocolId: protocol.id, protocolVersion: protocol.version,
          stageKey: stage.key,
          deadlineAt: command.payload.deadlineAt === null ? null : new Date(command.payload.deadlineAt)
        }).returning();
      } else {
        [journey] = await tx.update(schema.deliveryJourneys).set({
          stageKey: next.key, version: command.payload.expectedJourneyVersion + 1,
          updatedAt: new Date()
        }).where(and(
          eq(schema.deliveryJourneys.workItemId, item.id),
          eq(schema.deliveryJourneys.version, command.payload.expectedJourneyVersion)
        )).returning();
      }
      resultVersion = journey!.version;
      const projection = await readProjection(
        tx, command.workspaceId, item.id, command.actor.actorId, new Date()
      );
      if (projection === null) throw new Error('delivery_journey_projection_missing');
      result = {ok: true as const, value: projection};
      return complete();
    });
  },
  async read(input: Readonly<{
    workspaceId: string; workItemId: string; actorId: string; at: string;
  }>) {
    return db.transaction((tx) =>
      readProjection(tx, input.workspaceId, input.workItemId, input.actorId, new Date(input.at)));
  }
});
