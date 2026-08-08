import {randomUUID} from 'node:crypto';
import {
  hashDeliveryProtocolDefinition,
  simulateDeliveryProtocol,
  validateDeliveryProtocolDefinition,
  type DeliveryProtocol,
  type DeliveryProtocolDefinition,
  type DeliveryProtocolSimulationContext,
  type DeliveryProtocolSimulation,
  type CommandError
} from '@fai-control-plane/domain';
import {and, eq, inArray, isNull, max} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type ProtocolRow = typeof schema.runbooks.$inferSelect;
type DeliveryProtocolMutationCommand = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  issuedAt: string;
  actor: Readonly<{actorId: string}>;
}> & (
  | Readonly<{
      type: 'delivery_protocol.draft';
      payload: Readonly<{
        protocolId: string;
        projectId: string;
        name: string;
        expectedRevision: number | null;
        definition: DeliveryProtocolDefinition;
      }>;
    }>
  | Readonly<{
      type: 'delivery_protocol.publish';
      payload: Readonly<{
        protocolId: string;
        expectedRevision: number;
        expectedSimulationHash: string;
      }>;
    }>
  | Readonly<{
      type: 'delivery_protocol.activate' | 'delivery_protocol.retire';
      payload: Readonly<{protocolId: string; expectedRevision: number}>;
    }>
);
type StoreInput = Readonly<{
  command: DeliveryProtocolMutationCommand;
  requestHash: string;
  authorized: boolean;
  policyError?: CommandError;
}>;
type SimulationInput = Readonly<{
  workspaceId: string;
  projectId: string;
  actorId: string;
  definition: DeliveryProtocolDefinition;
}>;
type GetInput = Readonly<{
  workspaceId: string;
  protocolId: string;
  actorId: string;
}>;

const resultError = (code: CommandError['code'], message: string) => ({
  ok: false as const,
  error: {code, message}
});
type StoreResult = ReturnType<typeof resultError> | Readonly<{ok: true; value: Readonly<{
  protocol: DeliveryProtocol;
  simulation?: DeliveryProtocolSimulation;
  replacedProtocolId?: string;
}>}>;

const protocolFrom = (row: ProtocolRow): DeliveryProtocol | null => {
  if (
    row.protocolState === null ||
    row.revision === null ||
    row.contentHash === null
  ) return null;
  const definition = validateDeliveryProtocolDefinition(row.definition);
  if (!definition.ok) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    version: row.version,
    revision: row.revision,
    state: row.protocolState,
    active: row.active,
    definition: definition.value,
    contentHash: row.contentHash
  };
};

const authorityIn = async (
  tx: Transaction,
  input: Readonly<{
    workspaceId: string;
    actorId: string;
    projectId: string;
    write: boolean;
  }>
): Promise<boolean> => {
  const [actor] = await tx.select({role: schema.actors.role})
    .from(schema.actors)
    .where(and(
      eq(schema.actors.id, input.actorId),
      eq(schema.actors.workspaceId, input.workspaceId),
      eq(schema.actors.type, 'human'),
      eq(schema.actors.authMode, 'user'),
      isNull(schema.actors.disabledAt)
    ))
    .limit(1);
  if (actor === undefined) return false;
  if (['workspace_admin', 'delivery_lead'].includes(actor.role)) return true;
  const [membership] = await tx.select({role: schema.projectMemberships.role})
    .from(schema.projectMemberships)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectMemberships.projectId))
    .where(and(
      eq(schema.projectMemberships.projectId, input.projectId),
      eq(schema.projectMemberships.actorId, input.actorId),
      eq(schema.projectMemberships.active, true),
      eq(schema.projects.workspaceId, input.workspaceId)
    ))
    .limit(1);
  if (membership === undefined) return false;
  return input.write
    ? ['workspace_owner', 'project_owner'].includes(membership.role)
    : true;
};

const contextIn = async (
  tx: Transaction,
  workspaceId: string,
  projectId: string
): Promise<DeliveryProtocolSimulationContext> => {
  const [project] = await tx.select({id: schema.projects.id})
    .from(schema.projects)
    .where(and(
      eq(schema.projects.id, projectId),
      eq(schema.projects.workspaceId, workspaceId)
    ))
    .limit(1);
  if (project === undefined) {
    return {
      projectExists: false,
      memberships: [],
      actors: [],
      agentProfiles: [],
      agentRegistrations: []
    };
  }
  const memberships = await tx.select({
    actorId: schema.projectMemberships.actorId,
    role: schema.projectMemberships.role,
    active: schema.projectMemberships.active
  }).from(schema.projectMemberships).where(eq(schema.projectMemberships.projectId, projectId));
  const actorIds = [...new Set(memberships.map((membership) => membership.actorId))];
  const actors = actorIds.length === 0
    ? []
    : await tx.select({
        actorId: schema.actors.id,
        actorType: schema.actors.type,
        disabledAt: schema.actors.disabledAt
      }).from(schema.actors).where(and(
        eq(schema.actors.workspaceId, workspaceId),
        inArray(schema.actors.id, actorIds),
        inArray(schema.actors.type, ['human', 'agent'])
      ));
  const agentIds = actors
    .filter((actor) => actor.actorType === 'agent')
    .map((actor) => actor.actorId);
  const profiles = agentIds.length === 0
    ? []
    : await tx.select({
        profileId: schema.agentProfiles.id,
        actorId: schema.agentProfiles.actorId,
        enabled: schema.agentProfiles.enabled
      }).from(schema.agentProfiles).where(and(
        eq(schema.agentProfiles.workspaceId, workspaceId),
        inArray(schema.agentProfiles.actorId, agentIds)
      ));
  const registrations = agentIds.length === 0
    ? []
    : await tx.select({
        actorId: schema.runtimeRegistrations.actorId,
        profileId: schema.runtimeRegistrations.agentProfileId,
        enabled: schema.runtimeRegistrations.enabled
      }).from(schema.runtimeRegistrations).where(and(
        eq(schema.runtimeRegistrations.projectId, projectId),
        inArray(schema.runtimeRegistrations.actorId, agentIds)
      ));
  return {
    projectExists: true,
    memberships,
    actors: actors.map((actor) => ({
      actorId: actor.actorId,
      actorType: actor.actorType as 'human' | 'agent',
      active: actor.disabledAt === null
    })),
    agentProfiles: profiles,
    agentRegistrations: registrations
  };
};

const loadProtocol = async (
  tx: Transaction,
  workspaceId: string,
  protocolId: string,
  lock = false
): Promise<DeliveryProtocol | null> => {
  const query = tx.select({
    id: schema.runbooks.id,
    projectId: schema.runbooks.projectId,
    name: schema.runbooks.name,
    version: schema.runbooks.version,
    definition: schema.runbooks.definition,
    active: schema.runbooks.active,
    protocolState: schema.runbooks.protocolState,
    revision: schema.runbooks.revision,
    contentHash: schema.runbooks.contentHash,
    createdAt: schema.runbooks.createdAt,
    updatedAt: schema.runbooks.updatedAt
  }).from(schema.runbooks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.runbooks.projectId))
    .where(and(
      eq(schema.runbooks.id, protocolId),
      eq(schema.projects.workspaceId, workspaceId)
    ))
    .limit(1);
  const rows = lock ? await query.for('update') : await query;
  return rows[0] === undefined ? null : protocolFrom(rows[0]);
};

const lockProject = async (
  tx: Transaction,
  workspaceId: string,
  projectId: string
): Promise<boolean> => {
  const rows = await tx.select({id: schema.projects.id})
    .from(schema.projects)
    .where(and(
      eq(schema.projects.id, projectId),
      eq(schema.projects.workspaceId, workspaceId)
    ))
    .limit(1)
    .for('update');
  return rows[0] !== undefined;
};

const runbookIdExists = async (
  tx: Transaction,
  workspaceId: string,
  protocolId: string
): Promise<boolean> => {
  const [row] = await tx.select({id: schema.runbooks.id})
    .from(schema.runbooks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.runbooks.projectId))
    .where(and(
      eq(schema.runbooks.id, protocolId),
      eq(schema.projects.workspaceId, workspaceId)
    ))
    .limit(1);
  return row !== undefined;
};

export const createPostgresDeliveryProtocolStore = (
  db: Database
) => ({
  async execute(input: StoreInput) {
    return db.transaction(async (tx) => {
      const command = input.command;
      const [claimed] = await tx.insert(schema.commandReceipts).values({
        workspaceId: command.workspaceId,
        idempotencyKey: command.idempotencyKey,
        requestHash: input.requestHash,
        commandId: command.commandId,
        correlationId: command.correlationId,
        commandType: command.type
      }).onConflictDoNothing({
        target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
      }).returning({id: schema.commandReceipts.id, createdAt: schema.commandReceipts.createdAt});

      if (claimed === undefined) {
        const [existing] = await tx.select({
          requestHash: schema.commandReceipts.requestHash,
          state: schema.commandReceipts.state,
          commandId: schema.commandReceipts.commandId,
          correlationId: schema.commandReceipts.correlationId,
          commandType: schema.commandReceipts.commandType,
          result: schema.commandReceipts.result,
          createdAt: schema.commandReceipts.createdAt
        }).from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.workspaceId, command.workspaceId),
          eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
        )).for('update');
        if (existing === undefined || existing.requestHash !== input.requestHash) {
          return {status: 'key_reused' as const, existingRequestHash: existing?.requestHash ?? ''};
        }
        if (existing.state !== 'completed' || existing.result === null) {
          throw new Error('delivery_protocol_receipt_incomplete');
        }
        return {
          status: 'replayed' as const,
          receipt: {
            commandId: existing.commandId,
            workspaceId: command.workspaceId,
            correlationId: existing.correlationId,
            idempotencyKey: command.idempotencyKey,
            requestHash: existing.requestHash,
            commandType: command.type,
            result: existing.result as never,
            createdAt: existing.createdAt.toISOString()
          }
        };
      }

      let result: StoreResult;
      let expectedVersion: number | undefined;
      let resultVersion: number | undefined;
      let projectId: string | null =
        command.type === 'delivery_protocol.draft' ? command.payload.projectId : null;
      const complete = async () => {
        const now = new Date();
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(),
          workspaceId: command.workspaceId,
          actorId: command.actor.actorId,
          commandId: command.commandId,
          actionCategory: 'write',
          action: command.type,
          targetType: 'delivery_protocol',
          targetId: command.payload.protocolId,
          ...(input.authorized
            ? {policyDecision: 'allow' as const}
            : input.policyError?.code === 'POLICY_DENIED'
              ? {policyDecision: 'deny' as const}
              : {}),
          outcome: result.ok ? 'succeeded' : input.authorized ? 'failed' : 'rejected',
          ...(!result.ok ? {reasonCode: result.error.code} : {}),
          ...(expectedVersion === undefined ? {} : {expectedVersion}),
          ...(resultVersion === undefined ? {} : {resultVersion}),
          correlationId: command.correlationId,
          occurredAt: now
        });
        await tx.update(schema.commandReceipts).set({
          state: 'completed',
          aggregateType: 'delivery_protocol',
          aggregateId: command.payload.protocolId,
          ...(expectedVersion === undefined ? {} : {expectedVersion}),
          ...(resultVersion === undefined ? {} : {resultVersion}),
          result,
          completedAt: now
        }).where(eq(schema.commandReceipts.id, claimed.id));
        return {
          status: 'completed' as const,
          receipt: {
            commandId: command.commandId,
            workspaceId: command.workspaceId,
            correlationId: command.correlationId,
            idempotencyKey: command.idempotencyKey,
            requestHash: input.requestHash,
            commandType: command.type,
            result,
            createdAt: claimed.createdAt.toISOString()
          }
        };
      };

      if (!input.authorized) {
        result = resultError(
          input.policyError?.code ?? 'POLICY_DENIED',
          input.policyError?.message ?? 'Policy denies this command.'
        );
        return complete();
      }

      let current = await loadProtocol(
        tx,
        command.workspaceId,
        command.payload.protocolId,
        true
      );
      if (current !== null) projectId = current.projectId;
      if (projectId === null || !await authorityIn(tx, {
        workspaceId: command.workspaceId,
        actorId: command.actor.actorId,
        projectId,
        write: true
      })) {
        result = resultError(
          projectId === null ? 'NOT_FOUND' : 'CAPABILITY_DENIED',
          projectId === null
            ? 'Delivery protocol was not found.'
            : 'Actor is not a protocol owner for this project.'
        );
        return complete();
      }
      if (!await lockProject(tx, command.workspaceId, projectId)) {
        result = resultError('NOT_FOUND', 'Project was not found in the workspace.');
        return complete();
      }

      if (command.type === 'delivery_protocol.draft') {
        expectedVersion = command.payload.expectedRevision ?? undefined;
        if (
          (command.payload.expectedRevision === null && current !== null) ||
          (command.payload.expectedRevision !== null &&
            current?.revision !== command.payload.expectedRevision)
        ) {
          resultVersion = current?.revision;
          result = resultError('VERSION_CONFLICT', 'Delivery protocol revision conflicts.');
          return complete();
        }
        if (
          command.payload.expectedRevision === null &&
          current === null &&
          await runbookIdExists(tx, command.workspaceId, command.payload.protocolId)
        ) {
          result = resultError(
            'VERSION_CONFLICT',
            'Runbook identifier is already used by another aggregate.'
          );
          return complete();
        }
        if (current !== null && (
          current.state !== 'draft' ||
          current.projectId !== command.payload.projectId ||
          current.name !== command.payload.name
        )) {
          result = resultError(
            current.state !== 'draft' ? 'INVALID_TRANSITION' : 'INVALID_COMMAND',
            current.state !== 'draft'
              ? 'Published protocol versions are immutable.'
              : 'Delivery protocol project and name are immutable.'
          );
          return complete();
        }
        const definition = validateDeliveryProtocolDefinition(command.payload.definition);
        if (!definition.ok) {
          result = definition;
          return complete();
        }
        const contentHash = hashDeliveryProtocolDefinition(definition.value);
        if (current === null) {
          const [latest] = await tx.select({version: max(schema.runbooks.version)})
            .from(schema.runbooks)
            .where(and(
              eq(schema.runbooks.projectId, command.payload.projectId),
              eq(schema.runbooks.name, command.payload.name)
            ));
          const version = (latest?.version ?? 0) + 1;
          await tx.insert(schema.runbooks).values({
            id: command.payload.protocolId,
            projectId: command.payload.projectId,
            name: command.payload.name,
            version,
            definition: definition.value as unknown as Record<string, unknown>,
            active: false,
            protocolState: 'draft',
            revision: 1,
            contentHash
          });
          resultVersion = 1;
        } else {
          resultVersion = current.revision + 1;
          await tx.update(schema.runbooks).set({
            definition: definition.value as unknown as Record<string, unknown>,
            contentHash,
            revision: resultVersion,
            updatedAt: new Date()
          }).where(and(
            eq(schema.runbooks.id, current.id),
            eq(schema.runbooks.revision, current.revision),
            eq(schema.runbooks.protocolState, 'draft')
          ));
        }
        current = await loadProtocol(tx, command.workspaceId, command.payload.protocolId);
        result = current === null
          ? resultError('NOT_FOUND', 'Delivery protocol was not found after persistence.')
          : {ok: true, value: {protocol: current}};
        return complete();
      }

      expectedVersion = command.payload.expectedRevision;
      if (current === null) {
        result = resultError('NOT_FOUND', 'Delivery protocol was not found.');
        return complete();
      }
      if (current.revision !== command.payload.expectedRevision) {
        resultVersion = current.revision;
        result = resultError('VERSION_CONFLICT', 'Delivery protocol revision conflicts.');
        return complete();
      }

      if (command.type === 'delivery_protocol.publish') {
        if (current.state !== 'draft') {
          result = resultError('INVALID_TRANSITION', 'Only a draft protocol can be published.');
          return complete();
        }
        const simulation = simulateDeliveryProtocol(
          current.definition,
          await contextIn(tx, command.workspaceId, current.projectId)
        );
        if (
          simulation.simulationHash !== command.payload.expectedSimulationHash ||
          !simulation.valid
        ) {
          result = resultError(
            'INVALID_COMMAND',
            simulation.simulationHash !== command.payload.expectedSimulationHash
              ? 'Delivery protocol simulation hash is stale or mismatched.'
              : 'Delivery protocol context is incomplete.'
          );
          return complete();
        }
        resultVersion = current.revision + 1;
        await tx.update(schema.runbooks).set({
          protocolState: 'published',
          revision: resultVersion,
          updatedAt: new Date()
        }).where(and(
          eq(schema.runbooks.id, current.id),
          eq(schema.runbooks.revision, current.revision),
          eq(schema.runbooks.protocolState, 'draft')
        ));
        const published = await loadProtocol(tx, command.workspaceId, current.id);
        result = published === null
          ? resultError('NOT_FOUND', 'Delivery protocol was not found after publication.')
          : {ok: true, value: {protocol: published, simulation}};
        return complete();
      }

      let replacedProtocolId: string | undefined;
      if (command.type === 'delivery_protocol.activate') {
        if (current.state !== 'published' || current.active) {
          result = resultError(
            'INVALID_TRANSITION',
            'Only an inactive published protocol can be activated.'
          );
          return complete();
        }
        const [active] = await tx.select({
          id: schema.runbooks.id,
          revision: schema.runbooks.revision
        })
          .from(schema.runbooks)
          .where(and(
            eq(schema.runbooks.projectId, current.projectId),
            eq(schema.runbooks.protocolState, 'published'),
            eq(schema.runbooks.active, true)
          ))
          .limit(1)
          .for('update');
        if (active !== undefined) {
          if (active.revision === null) {
            result = resultError(
              'INVALID_COMMAND',
              'Active delivery protocol metadata is incomplete.'
            );
            return complete();
          }
          await tx.update(schema.runbooks).set({
            active: false,
            protocolState: 'retired',
            revision: active.revision + 1,
            updatedAt: new Date()
          }).where(and(
            eq(schema.runbooks.id, active.id),
            eq(schema.runbooks.revision, active.revision),
            eq(schema.runbooks.protocolState, 'published'),
            eq(schema.runbooks.active, true)
          ));
          replacedProtocolId = active.id;
        }
        resultVersion = current.revision + 1;
        await tx.update(schema.runbooks).set({
          active: true,
          revision: resultVersion,
          updatedAt: new Date()
        }).where(and(
          eq(schema.runbooks.id, current.id),
          eq(schema.runbooks.revision, current.revision),
          eq(schema.runbooks.protocolState, 'published'),
          eq(schema.runbooks.active, false)
        ));
      } else {
        if (current.state !== 'published') {
          result = resultError('INVALID_TRANSITION', 'Only a published protocol can be retired.');
          return complete();
        }
        resultVersion = current.revision + 1;
        await tx.update(schema.runbooks).set({
          active: false,
          protocolState: 'retired',
          revision: resultVersion,
          updatedAt: new Date()
        }).where(and(
          eq(schema.runbooks.id, current.id),
          eq(schema.runbooks.revision, current.revision),
          eq(schema.runbooks.protocolState, 'published')
        ));
      }
      const changed = await loadProtocol(tx, command.workspaceId, current.id);
      result = changed === null
        ? resultError('NOT_FOUND', 'Delivery protocol was not found after transition.')
        : {
            ok: true,
            value: {
              protocol: changed,
              ...(replacedProtocolId === undefined
                ? {}
                : {replacedProtocolId})
            }
          };
      return complete();
    });
  },

  async simulate(input: SimulationInput) {
    return db.transaction(async (tx) => {
      if (!await authorityIn(tx, {...input, write: false})) return null;
      return simulateDeliveryProtocol(
        input.definition,
        await contextIn(tx, input.workspaceId, input.projectId)
      );
    });
  },

  async get(input: GetInput) {
    return db.transaction(async (tx) => {
      const protocol = await loadProtocol(tx, input.workspaceId, input.protocolId);
      if (protocol === null) return null;
      return await authorityIn(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        projectId: protocol.projectId,
        write: false
      }) ? protocol : null;
    });
  }
});
