import type {
  AgentRun,
  Approval,
  ApprovalRequiredMutationResult,
  AuditAppendToken,
  AuditEvent,
  CanonicalCommand,
  CanonicalCommandTransaction,
  CanonicalMutation,
  CommandReceipt,
  CommandReceiptClaim,
  CommandReceiptClaimResult,
  CommandReceiptCompletion,
  CompletedApprovalRequiredCommand,
  CompletedCanonicalCommand,
  CompletedCanonicalMutation,
  NonApprovalAuditEvent,
  PersistedCanonicalMutation,
  PersistedVersionCas,
  ReceiptClaimToken,
  TaskPacket,
  UnitOfWork
} from '@fai-control-plane/domain';
import {and, eq, sql} from 'drizzle-orm';
import type {ExtractTablesWithRelations, SQL} from 'drizzle-orm';
import type {
  NodePgDatabase,
  NodePgTransaction
} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Transaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type JsonObject = Record<string, unknown>;
type ClaimState = Readonly<{rowId: string; claim: CommandReceiptClaim}>;
type MutationState = Readonly<{
  claimToken: ReceiptClaimToken;
  aggregateType: CanonicalMutation['aggregateType'];
  aggregateId: string;
  cas: PersistedVersionCas;
  auditToken: AuditAppendToken;
}>;
type PersistedAggregate = Readonly<{
  status: 'persisted';
  cas: PersistedVersionCas;
  projectId: string | null;
}>;
type PersistenceFailure =
  | Readonly<{
      status: 'version_conflict';
      expectedPersistedVersion: number | null;
      persistedVersion: number | null;
    }>
  | Readonly<{status: 'not_found'}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invariant: (
  condition: unknown,
  message: string
) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const uuid = (value: string, field: string): void => {
  invariant(uuidPattern.test(value), `${field} must be a UUID.`);
};

const date = (value: string, field: string): Date => {
  const parsed = new Date(value);
  invariant(!Number.isNaN(parsed.getTime()), `${field} must be an ISO timestamp.`);
  return parsed;
};

const claimToken = (): ReceiptClaimToken => ({}) as ReceiptClaimToken;
const auditToken = (): AuditAppendToken => ({}) as AuditAppendToken;
const completionToken = (): CommandReceiptCompletion =>
  ({}) as CommandReceiptCompletion;
const jsonObject = (value: unknown): JsonObject => value as JsonObject;

const mapReceipt = (
  row: typeof schema.commandReceipts.$inferSelect
): CommandReceipt => {
  invariant(
    row.state === 'completed' && row.result !== null,
    'A claimed command receipt cannot be replayed before completion.'
  );
  return {
    commandId: row.commandId,
    workspaceId: row.workspaceId,
    correlationId: row.correlationId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    commandType: row.commandType as CanonicalCommand['type'],
    ...(row.aggregateType === null ? {} : {aggregateType: row.aggregateType}),
    ...(row.aggregateId === null ? {} : {aggregateId: row.aggregateId}),
    ...(row.expectedVersion === null
      ? {}
      : {expectedVersion: row.expectedVersion}),
    ...(row.resultVersion === null ? {} : {resultVersion: row.resultVersion}),
    result: row.result as CommandReceipt['result'],
    createdAt: row.createdAt.toISOString()
  };
};

const validateClaim = (claim: CommandReceiptClaim): void => {
  uuid(claim.commandId, 'claim.commandId');
  uuid(claim.workspaceId, 'claim.workspaceId');
  date(claim.createdAt, 'claim.createdAt');
  invariant(claim.correlationId.length > 0, 'claim.correlationId is required.');
  invariant(claim.idempotencyKey.length > 0, 'claim.idempotencyKey is required.');
  invariant(claim.requestHash.length > 0, 'claim.requestHash is required.');
};

const validateAggregateIdentity = (mutation: CanonicalMutation): void => {
  uuid(mutation.aggregateId, 'mutation.aggregateId');
  const aggregateId =
    mutation.aggregateType === 'task_packet'
      ? mutation.aggregate.packetId
      : mutation.aggregate.id;
  invariant(
    mutation.aggregateId === aggregateId,
    'mutation.aggregateId must equal the aggregate identifier.'
  );

  switch (mutation.aggregateType) {
    case 'work_item':
      uuid(mutation.aggregate.id, 'workItem.id');
      uuid(mutation.aggregate.projectId, 'workItem.projectId');
      invariant(
        mutation.aggregate.version === mutation.expectedPersistedVersion + 1,
        'WorkItem update version must equal expected version plus one.'
      );
      break;
    case 'task_packet':
      invariant(
        mutation.expectedPersistedVersion === null,
        'TaskPacket mutations must use insert mode.'
      );
      uuid(mutation.aggregate.packetId, 'taskPacket.packetId');
      uuid(mutation.aggregate.content.projectId, 'taskPacket.projectId');
      uuid(mutation.aggregate.content.workItemId, 'taskPacket.workItemId');
      uuid(
        mutation.aggregate.content.reviewerActorId,
        'taskPacket.reviewerActorId'
      );
      uuid(
        mutation.aggregate.content.approverActorId,
        'taskPacket.approverActorId'
      );
      uuid(
        mutation.aggregate.content.createdFromEventId,
        'taskPacket.createdFromEventId'
      );
      uuid(
        mutation.aggregate.content.createdByActorId,
        'taskPacket.createdByActorId'
      );
      break;
    case 'agent_run':
      uuid(mutation.aggregate.id, 'agentRun.id');
      uuid(mutation.aggregate.taskPacketId, 'agentRun.taskPacketId');
      uuid(mutation.aggregate.agentProfileId, 'agentRun.agentProfileId');
      validateVersionMode(mutation.expectedPersistedVersion, mutation.aggregate.version);
      break;
    case 'approval':
      uuid(mutation.aggregate.id, 'approval.id');
      uuid(mutation.aggregate.projectId, 'approval.projectId');
      uuid(mutation.aggregate.requestedByActorId, 'approval.requestedByActorId');
      {
        const runtimeApproval = mutation.aggregate as Approval & {
          workItemId?: unknown;
          agentRunId?: unknown;
        };
        const hasWorkItem = typeof runtimeApproval.workItemId === 'string';
        const hasAgentRun = typeof runtimeApproval.agentRunId === 'string';
        invariant(
          hasWorkItem !== hasAgentRun,
          'Approval must target exactly one WorkItem or AgentRun.'
        );
        if (hasWorkItem) {
          uuid(runtimeApproval.workItemId as string, 'approval.workItemId');
        } else {
          uuid(runtimeApproval.agentRunId as string, 'approval.agentRunId');
        }
      }
      validateVersionMode(mutation.expectedPersistedVersion, mutation.aggregate.version);
      break;
    case 'access_request':
      uuid(mutation.aggregate.id, 'accessRequest.id');
      uuid(mutation.aggregate.workspaceId, 'accessRequest.workspaceId');
      uuid(
        mutation.aggregate.requesterActorId,
        'accessRequest.requesterActorId'
      );
      validateVersionMode(mutation.expectedPersistedVersion, mutation.aggregate.version);
      break;
  }
};

const validateVersionMode = (
  expectedVersion: number | null,
  aggregateVersion: number
): void => {
  if (expectedVersion === null) {
    invariant(aggregateVersion === 1, 'Inserted aggregate version must equal 1.');
  } else {
    invariant(
      aggregateVersion === expectedVersion + 1,
      'Updated aggregate version must equal expected version plus one.'
    );
  }
};

const expectedAuditTarget = (
  mutation: CanonicalMutation
): Readonly<{targetType: string; targetId: string}> => ({
  targetType: mutation.aggregateType,
  targetId: mutation.aggregateId
});

const mutationResultVersion = (mutation: CanonicalMutation): number =>
  mutation.aggregateType === 'task_packet' ? 1 : mutation.aggregate.version;

const validateAuditEnvelope = (
  audit: AuditEvent | NonApprovalAuditEvent,
  claim: CommandReceiptClaim,
  mutation: CanonicalMutation
): void => {
  uuid(audit.id, 'audit.id');
  uuid(audit.actorId, 'audit.actorId');
  date(audit.occurredAt, 'audit.occurredAt');
  const target = expectedAuditTarget(mutation);
  invariant(audit.workspaceId === claim.workspaceId, 'Audit workspace does not match claim.');
  invariant(audit.commandId === claim.commandId, 'Audit command does not match claim.');
  invariant(
    audit.correlationId === claim.correlationId,
    'Audit correlation does not match claim.'
  );
  invariant(
    audit.targetType === target.targetType && audit.targetId === target.targetId,
    'Audit target does not match mutation.'
  );
  const expected = mutation.expectedPersistedVersion;
  invariant(
    audit.expectedVersion === (expected ?? undefined),
    'Audit expected version does not match mutation.'
  );
  invariant(
    audit.resultVersion === mutationResultVersion(mutation),
    'Audit result version does not match aggregate.'
  );
};

const validateReceipt = (
  receipt: CommandReceipt,
  claim: CommandReceiptClaim,
  mutation: CanonicalMutation,
  cas: PersistedVersionCas
): void => {
  invariant(receipt.commandId === claim.commandId, 'Receipt command does not match claim.');
  invariant(receipt.workspaceId === claim.workspaceId, 'Receipt workspace does not match claim.');
  invariant(
    receipt.correlationId === claim.correlationId,
    'Receipt correlation does not match claim.'
  );
  invariant(
    receipt.idempotencyKey === claim.idempotencyKey &&
      receipt.requestHash === claim.requestHash &&
      receipt.commandType === claim.commandType,
    'Receipt idempotency facts do not match claim.'
  );
  invariant(
    receipt.aggregateType === mutation.aggregateType &&
      receipt.aggregateId === mutation.aggregateId,
    'Receipt aggregate does not match persisted mutation.'
  );
  invariant(
    receipt.expectedVersion === (cas.expectedPersistedVersion ?? undefined) &&
      receipt.resultVersion === cas.persistedVersion,
    'Receipt version facts do not match persisted CAS.'
  );
};

const actorBelongsToWorkspace = async (
  tx: Transaction,
  workspaceId: string,
  actorId: string
): Promise<void> => {
  const [actor] = await tx
    .select({id: schema.actors.id})
    .from(schema.actors)
    .where(
      and(
        eq(schema.actors.id, actorId),
        eq(schema.actors.workspaceId, workspaceId)
      )
    );
  invariant(actor !== undefined, 'Actor does not belong to claim workspace.');
};

const projectBelongsToWorkspace = async (
  tx: Transaction,
  workspaceId: string,
  projectId: string
): Promise<void> => {
  const [project] = await tx
    .select({id: schema.projects.id})
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.workspaceId, workspaceId)
      )
    );
  invariant(project !== undefined, 'Project does not belong to claim workspace.');
};

const workItemScope = (workspaceId: string): SQL =>
  sql`exists (
    select 1 from ${schema.projects}
    where ${schema.projects.id} = ${schema.workItems.projectId}
      and ${schema.projects.workspaceId} = ${workspaceId}
  )`;

const taskPacketScope = (workspaceId: string): SQL =>
  sql`exists (
    select 1 from ${schema.projects}
    where ${schema.projects.id} = ${schema.taskPackets.projectId}
      and ${schema.projects.workspaceId} = ${workspaceId}
  )`;

const agentRunScope = (workspaceId: string): SQL =>
  sql`exists (
    select 1
    from ${schema.taskPackets}
    inner join ${schema.projects}
      on ${schema.projects.id} = ${schema.taskPackets.projectId}
    where ${schema.taskPackets.id} = ${schema.agentRuns.taskPacketId}
      and ${schema.projects.workspaceId} = ${workspaceId}
  )`;

const approvalScope = (workspaceId: string): SQL =>
  sql`exists (
    select 1 from ${schema.projects}
    where ${schema.projects.id} = ${schema.approvalRequests.projectId}
      and ${schema.projects.workspaceId} = ${workspaceId}
  )`;

const currentVersion = async (
  tx: Transaction,
  workspaceId: string,
  mutation: CanonicalMutation
): Promise<number | null> => {
  switch (mutation.aggregateType) {
    case 'work_item': {
      const [row] = await tx
        .select({version: schema.workItems.version})
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.id, mutation.aggregateId),
            workItemScope(workspaceId)
          )
        );
      return row?.version ?? null;
    }
    case 'task_packet': {
      const [row] = await tx
        .select({id: schema.taskPackets.id})
        .from(schema.taskPackets)
        .where(
          and(
            eq(schema.taskPackets.id, mutation.aggregateId),
            taskPacketScope(workspaceId)
          )
        );
      return row === undefined ? null : 1;
    }
    case 'agent_run': {
      const [row] = await tx
        .select({version: schema.agentRuns.version})
        .from(schema.agentRuns)
        .where(
          and(
            eq(schema.agentRuns.id, mutation.aggregateId),
            agentRunScope(workspaceId)
          )
        );
      return row?.version ?? null;
    }
    case 'approval': {
      const [row] = await tx
        .select({version: schema.approvalRequests.version})
        .from(schema.approvalRequests)
        .where(
          and(
            eq(schema.approvalRequests.id, mutation.aggregateId),
            approvalScope(workspaceId)
          )
        );
      return row?.version ?? null;
    }
    case 'access_request': {
      const [row] = await tx
        .select({version: schema.accessRequests.version})
        .from(schema.accessRequests)
        .where(
          and(
            eq(schema.accessRequests.id, mutation.aggregateId),
            eq(schema.accessRequests.workspaceId, workspaceId)
          )
        );
      return row?.version ?? null;
    }
  }
};

const persistWorkItem = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'work_item'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  const [row] = await tx
    .update(schema.workItems)
    .set({
      status: aggregate.status,
      blocked: aggregate.blocked,
      version: sql`${schema.workItems.version} + 1`,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.workItems.id, aggregate.id),
        eq(schema.workItems.projectId, aggregate.projectId),
        eq(schema.workItems.version, mutation.expectedPersistedVersion),
        workItemScope(workspaceId)
      )
    )
    .returning({
      version: schema.workItems.version,
      projectId: schema.workItems.projectId
    });
  return row === undefined
    ? conflictOrNotFound(tx, workspaceId, mutation)
    : {
        status: 'persisted',
        cas: {
          expectedPersistedVersion: mutation.expectedPersistedVersion,
          persistedVersion: row.version
        },
        projectId: row.projectId
      };
};

const validateTaskPacketOwnership = async (
  tx: Transaction,
  workspaceId: string,
  packet: TaskPacket
): Promise<string | null> => {
  const content = packet.content;
  await projectBelongsToWorkspace(tx, workspaceId, content.projectId);
  const [item] = await tx
    .select({id: schema.workItems.id})
    .from(schema.workItems)
    .where(
      and(
        eq(schema.workItems.id, content.workItemId),
        eq(schema.workItems.projectId, content.projectId),
        workItemScope(workspaceId)
      )
    );
  invariant(item !== undefined, 'Task packet WorkItem is outside claim workspace or project.');
  await actorBelongsToWorkspace(tx, workspaceId, content.reviewerActorId);
  await actorBelongsToWorkspace(tx, workspaceId, content.approverActorId);
  await actorBelongsToWorkspace(tx, workspaceId, content.createdByActorId);
  const [event] = await tx
    .select({id: schema.canonicalEvents.id})
    .from(schema.canonicalEvents)
    .where(
      and(
        eq(schema.canonicalEvents.id, content.createdFromEventId),
        eq(schema.canonicalEvents.workspaceId, workspaceId),
        eq(schema.canonicalEvents.projectId, content.projectId)
      )
    );
  invariant(event !== undefined, 'Task packet source event is outside claim workspace or project.');
  if (content.secretsRef === null) return null;
  const [secretRef] = await tx
    .select({id: schema.secretRefs.id})
    .from(schema.secretRefs)
    .where(
      and(
        eq(schema.secretRefs.workspaceId, workspaceId),
        eq(schema.secretRefs.provider, content.secretsRef.provider),
        eq(schema.secretRefs.reference, content.secretsRef.reference)
      )
    );
  invariant(secretRef !== undefined, 'Task packet secret reference is outside claim workspace.');
  return secretRef.id;
};

const persistTaskPacket = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'task_packet'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const packet = mutation.aggregate;
  const content = packet.content;
  const secretRefId = await validateTaskPacketOwnership(tx, workspaceId, packet);
  const [row] = await tx
    .insert(schema.taskPackets)
    .values({
      id: packet.packetId,
      projectId: content.projectId,
      workItemId: content.workItemId,
      goal: content.goal,
      acceptanceCriteria: [...content.acceptanceCriteria],
      inScope: [...content.inScope],
      outOfScope: [...content.outOfScope],
      relevantLinks: [...content.relevantLinks],
      relevantFiles: [...content.relevantFiles],
      allowedTools: [...content.allowedTools],
      forbiddenSurfaces: [...content.forbiddenSurfaces],
      dataPolicy: content.dataPolicy as JsonObject,
      timeboxMinutes: content.timeboxMinutes,
      expectedOutputSchema: content.expectedOutputSchema as JsonObject,
      reviewerActorId: content.reviewerActorId,
      approverActorId: content.approverActorId,
      runtimeProfile: content.runtimeProfile,
      authMode: content.authMode,
      secretRefId,
      createdFromEventId: content.createdFromEventId,
      contentHash: packet.contentHash,
      createdByActorId: content.createdByActorId
    })
    .onConflictDoNothing({target: schema.taskPackets.id})
    .returning({id: schema.taskPackets.id, projectId: schema.taskPackets.projectId});
  return row === undefined
    ? conflictOrNotFound(tx, workspaceId, mutation)
    : {
        status: 'persisted',
        cas: {expectedPersistedVersion: null, persistedVersion: 1},
        projectId: row.projectId
      };
};

const validateAgentRunOwnership = async (
  tx: Transaction,
  workspaceId: string,
  aggregate: AgentRun
): Promise<string> => {
  const [packet] = await tx
    .select({projectId: schema.taskPackets.projectId})
    .from(schema.taskPackets)
    .where(
      and(
        eq(schema.taskPackets.id, aggregate.taskPacketId),
        taskPacketScope(workspaceId)
      )
    );
  invariant(packet !== undefined, 'AgentRun task packet is outside claim workspace.');
  const [profile] = await tx
    .select({id: schema.agentProfiles.id})
    .from(schema.agentProfiles)
    .innerJoin(
      schema.actors,
      eq(schema.actors.id, schema.agentProfiles.actorId)
    )
    .where(
      and(
        eq(schema.agentProfiles.id, aggregate.agentProfileId),
        eq(schema.agentProfiles.workspaceId, workspaceId),
        eq(schema.actors.workspaceId, workspaceId)
      )
    );
  invariant(profile !== undefined, 'AgentRun profile is outside claim workspace.');
  return packet.projectId;
};

const persistAgentRun = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'agent_run'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  const projectId = await validateAgentRunOwnership(tx, workspaceId, aggregate);
  if (mutation.expectedPersistedVersion === null) {
    const [row] = await tx
      .insert(schema.agentRuns)
      .values({
        id: aggregate.id,
        taskPacketId: aggregate.taskPacketId,
        agentProfileId: aggregate.agentProfileId,
        status: aggregate.status,
        idempotencyKey: aggregate.idempotencyKey,
        version: 1
      })
      .onConflictDoNothing({target: schema.agentRuns.id})
      .returning({version: schema.agentRuns.version});
    return row === undefined
      ? conflictOrNotFound(tx, workspaceId, mutation)
      : {
          status: 'persisted',
          cas: {expectedPersistedVersion: null, persistedVersion: row.version},
          projectId
        };
  }
  const [row] = await tx
    .update(schema.agentRuns)
    .set({
      status: aggregate.status,
      version: sql`${schema.agentRuns.version} + 1`,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.agentRuns.id, aggregate.id),
        eq(schema.agentRuns.taskPacketId, aggregate.taskPacketId),
        eq(schema.agentRuns.agentProfileId, aggregate.agentProfileId),
        eq(schema.agentRuns.idempotencyKey, aggregate.idempotencyKey),
        eq(schema.agentRuns.version, mutation.expectedPersistedVersion),
        agentRunScope(workspaceId)
      )
    )
    .returning({version: schema.agentRuns.version});
  return row === undefined
    ? conflictOrNotFound(tx, workspaceId, mutation)
    : {
        status: 'persisted',
        cas: {
          expectedPersistedVersion: mutation.expectedPersistedVersion,
          persistedVersion: row.version
        },
        projectId
      };
};

const validateApprovalOwnership = async (
  tx: Transaction,
  workspaceId: string,
  aggregate: Approval
): Promise<void> => {
  await projectBelongsToWorkspace(tx, workspaceId, aggregate.projectId);
  await actorBelongsToWorkspace(tx, workspaceId, aggregate.requestedByActorId);
  if (aggregate.workItemId !== undefined) {
    const [item] = await tx
      .select({id: schema.workItems.id})
      .from(schema.workItems)
      .where(
        and(
          eq(schema.workItems.id, aggregate.workItemId),
          eq(schema.workItems.projectId, aggregate.projectId),
          workItemScope(workspaceId)
        )
      );
    invariant(item !== undefined, 'Approval WorkItem is outside claim workspace or project.');
  } else {
    const [run] = await tx
      .select({id: schema.agentRuns.id})
      .from(schema.agentRuns)
      .innerJoin(
        schema.taskPackets,
        eq(schema.taskPackets.id, schema.agentRuns.taskPacketId)
      )
      .where(
        and(
          eq(schema.agentRuns.id, aggregate.agentRunId),
          eq(schema.taskPackets.projectId, aggregate.projectId),
          agentRunScope(workspaceId)
        )
      );
    invariant(run !== undefined, 'Approval AgentRun is outside claim workspace or project.');
  }
};

const persistApproval = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'approval'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  await validateApprovalOwnership(tx, workspaceId, aggregate);
  if (mutation.expectedPersistedVersion === null) {
    const [row] = await tx
      .insert(schema.approvalRequests)
      .values({
        id: aggregate.id,
        projectId: aggregate.projectId,
        workItemId: aggregate.workItemId,
        agentRunId: aggregate.agentRunId,
        actionCategory: aggregate.actionCategory,
        surface: aggregate.surface,
        environment: aggregate.environment,
        status: aggregate.status,
        requestedByActorId: aggregate.requestedByActorId,
        version: 1
      })
      .onConflictDoNothing({target: schema.approvalRequests.id})
      .returning({version: schema.approvalRequests.version});
    return row === undefined
      ? conflictOrNotFound(tx, workspaceId, mutation)
      : {
          status: 'persisted',
          cas: {expectedPersistedVersion: null, persistedVersion: row.version},
          projectId: aggregate.projectId
        };
  }
  const [row] = await tx
    .update(schema.approvalRequests)
    .set({
      status: aggregate.status,
      version: sql`${schema.approvalRequests.version} + 1`,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.approvalRequests.id, aggregate.id),
        eq(schema.approvalRequests.projectId, aggregate.projectId),
        aggregate.workItemId === undefined
          ? sql`${schema.approvalRequests.workItemId} is null`
          : eq(schema.approvalRequests.workItemId, aggregate.workItemId),
        aggregate.agentRunId === undefined
          ? sql`${schema.approvalRequests.agentRunId} is null`
          : eq(schema.approvalRequests.agentRunId, aggregate.agentRunId),
        eq(schema.approvalRequests.actionCategory, aggregate.actionCategory),
        eq(schema.approvalRequests.surface, aggregate.surface),
        eq(schema.approvalRequests.environment, aggregate.environment),
        eq(
          schema.approvalRequests.requestedByActorId,
          aggregate.requestedByActorId
        ),
        eq(schema.approvalRequests.version, mutation.expectedPersistedVersion),
        approvalScope(workspaceId)
      )
    )
    .returning({version: schema.approvalRequests.version});
  return row === undefined
    ? conflictOrNotFound(tx, workspaceId, mutation)
    : {
        status: 'persisted',
        cas: {
          expectedPersistedVersion: mutation.expectedPersistedVersion,
          persistedVersion: row.version
        },
        projectId: aggregate.projectId
      };
};

const persistAccessRequest = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'access_request'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  invariant(
    aggregate.workspaceId === workspaceId,
    'AccessRequest workspace does not match claim.'
  );
  await actorBelongsToWorkspace(tx, workspaceId, aggregate.requesterActorId);
  if (mutation.expectedPersistedVersion === null) {
    const [row] = await tx
      .insert(schema.accessRequests)
      .values({
        id: aggregate.id,
        workspaceId,
        requesterActorId: aggregate.requesterActorId,
        targetSurface: aggregate.targetSurface,
        requestedScope: [...aggregate.requestedScope],
        status: aggregate.status,
        version: 1
      })
      .onConflictDoNothing({target: schema.accessRequests.id})
      .returning({version: schema.accessRequests.version});
    return row === undefined
      ? conflictOrNotFound(tx, workspaceId, mutation)
      : {
          status: 'persisted',
          cas: {expectedPersistedVersion: null, persistedVersion: row.version},
          projectId: null
        };
  }
  const [row] = await tx
    .update(schema.accessRequests)
    .set({
      status: aggregate.status,
      version: sql`${schema.accessRequests.version} + 1`,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.accessRequests.id, aggregate.id),
        eq(schema.accessRequests.workspaceId, workspaceId),
        eq(
          schema.accessRequests.requesterActorId,
          aggregate.requesterActorId
        ),
        eq(schema.accessRequests.targetSurface, aggregate.targetSurface),
        sql`${schema.accessRequests.requestedScope} = ${aggregate.requestedScope}`,
        eq(schema.accessRequests.version, mutation.expectedPersistedVersion)
      )
    )
    .returning({version: schema.accessRequests.version});
  return row === undefined
    ? conflictOrNotFound(tx, workspaceId, mutation)
    : {
        status: 'persisted',
        cas: {
          expectedPersistedVersion: mutation.expectedPersistedVersion,
          persistedVersion: row.version
        },
        projectId: null
      };
};

const conflictOrNotFound = async (
  tx: Transaction,
  workspaceId: string,
  mutation: CanonicalMutation
): Promise<PersistenceFailure> => {
  const persistedVersion = await currentVersion(tx, workspaceId, mutation);
  return mutation.expectedPersistedVersion !== null && persistedVersion === null
    ? {status: 'not_found'}
    : {
        status: 'version_conflict',
        expectedPersistedVersion: mutation.expectedPersistedVersion,
        persistedVersion
      };
};

const persistAggregate = (
  tx: Transaction,
  workspaceId: string,
  mutation: CanonicalMutation
): Promise<PersistedAggregate | PersistenceFailure> => {
  validateAggregateIdentity(mutation);
  switch (mutation.aggregateType) {
    case 'work_item':
      return persistWorkItem(tx, workspaceId, mutation);
    case 'task_packet':
      return persistTaskPacket(tx, workspaceId, mutation);
    case 'agent_run':
      return persistAgentRun(tx, workspaceId, mutation);
    case 'approval':
      return persistApproval(tx, workspaceId, mutation);
    case 'access_request':
      return persistAccessRequest(tx, workspaceId, mutation);
  }
};

const appendAudit = async (
  tx: Transaction,
  audit: AuditEvent | NonApprovalAuditEvent,
  projectId: string | null
): Promise<AuditAppendToken> => {
  const [row] = await tx
    .insert(schema.auditEvents)
    .values({
      id: audit.id,
      workspaceId: audit.workspaceId,
      projectId,
      actorId: audit.actorId,
      commandId: audit.commandId,
      actionCategory: audit.actionCategory,
      action: audit.action,
      targetType: audit.targetType,
      targetId: audit.targetId,
      policyDecision: audit.policyDecision,
      outcome: audit.outcome,
      reasonCode: audit.reasonCode,
      expectedVersion: audit.expectedVersion,
      resultVersion: audit.resultVersion,
      correlationId: audit.correlationId,
      occurredAt: date(audit.occurredAt, 'audit.occurredAt'),
      metadata: {}
    })
    .returning({id: schema.auditEvents.id});
  invariant(row !== undefined, 'Audit append did not return a row.');
  return auditToken();
};

export const createPostgresUnitOfWork = (db: Database): UnitOfWork => ({
  executeCommand<T>(
    work: (
      transaction: CanonicalCommandTransaction
    ) => Promise<CompletedCanonicalCommand<T>>
  ): Promise<CompletedCanonicalCommand<T>> {
    return db.transaction(async (tx) => {
      const claims = new WeakMap<object, ClaimState>();
      const mutations = new WeakMap<object, MutationState>();
      const completed = new WeakSet<object>();

      const requireClaim = (token: ReceiptClaimToken): ClaimState => {
        const state = claims.get(token as object);
        invariant(
          state !== undefined,
          'Receipt claim token does not belong to this database transaction.'
        );
        return state;
      };

      const completeReceipt = async (
        token: ReceiptClaimToken,
        receipt: CommandReceipt,
        mutation: CanonicalMutation,
        cas: PersistedVersionCas
      ): Promise<CommandReceiptCompletion> => {
        const state = requireClaim(token);
        validateReceipt(receipt, state.claim, mutation, cas);
        const [row] = await tx
          .update(schema.commandReceipts)
          .set({
            state: 'completed',
            aggregateType: receipt.aggregateType,
            aggregateId: receipt.aggregateId,
            expectedVersion: receipt.expectedVersion,
            resultVersion: receipt.resultVersion,
            result: jsonObject(receipt.result),
            completedAt: new Date()
          })
          .where(
            and(
              eq(schema.commandReceipts.id, state.rowId),
              eq(schema.commandReceipts.workspaceId, state.claim.workspaceId),
              eq(schema.commandReceipts.state, 'claimed')
            )
          )
          .returning({id: schema.commandReceipts.id});
        invariant(row !== undefined, 'Command receipt was not in claimed state.');
        return completionToken();
      };

      const transaction: CanonicalCommandTransaction = {
        async claimReceipt(claim): Promise<CommandReceiptClaimResult> {
          validateClaim(claim);
          const [workspace] = await tx
            .select({id: schema.workspaces.id})
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, claim.workspaceId));
          invariant(workspace !== undefined, 'Claim workspace does not exist.');
          const [inserted] = await tx
            .insert(schema.commandReceipts)
            .values({
              workspaceId: claim.workspaceId,
              idempotencyKey: claim.idempotencyKey,
              requestHash: claim.requestHash,
              commandId: claim.commandId,
              correlationId: claim.correlationId,
              state: 'claimed',
              commandType: claim.commandType,
              createdAt: date(claim.createdAt, 'claim.createdAt')
            })
            .onConflictDoNothing({
              target: [
                schema.commandReceipts.workspaceId,
                schema.commandReceipts.idempotencyKey
              ]
            })
            .returning({id: schema.commandReceipts.id});
          if (inserted !== undefined) {
            const token = claimToken();
            claims.set(token as object, {rowId: inserted.id, claim});
            return {status: 'claimed', token};
          }
          const [existing] = await tx
            .select()
            .from(schema.commandReceipts)
            .where(
              and(
                eq(schema.commandReceipts.workspaceId, claim.workspaceId),
                eq(schema.commandReceipts.idempotencyKey, claim.idempotencyKey)
              )
            )
            .for('update');
          invariant(existing !== undefined, 'Conflicting receipt disappeared during claim.');
          if (existing.requestHash !== claim.requestHash) {
            return {
              status: 'key_reused',
              existingRequestHash: existing.requestHash
            };
          }
          return {status: 'replayed', receipt: mapReceipt(existing)};
        },

        async persistAuditedMutation({claimToken: token, outcome}) {
          const state = requireClaim(token);
          validateAggregateIdentity(outcome.mutation);
          validateAuditEnvelope(outcome.audit, state.claim, outcome.mutation);
          await actorBelongsToWorkspace(
            tx,
            state.claim.workspaceId,
            outcome.audit.actorId
          );
          const persisted = await persistAggregate(
            tx,
            state.claim.workspaceId,
            outcome.mutation
          );
          if (persisted.status !== 'persisted') return persisted;
          const appended = await appendAudit(tx, outcome.audit, persisted.projectId);
          const mutation = {
            cas: persisted.cas,
            audit: appended
          } as PersistedCanonicalMutation;
          mutations.set(mutation as object, {
            claimToken: token,
            aggregateType: outcome.mutation.aggregateType,
            aggregateId: outcome.mutation.aggregateId,
            cas: persisted.cas,
            auditToken: appended
          });
          return {status: 'persisted', mutation};
        },

        async persistApprovalRequired({
          claimToken: token,
          outcome
        }): Promise<ApprovalRequiredMutationResult> {
          const state = requireClaim(token);
          validateAggregateIdentity(outcome.approval);
          validateAuditEnvelope(outcome.audit, state.claim, outcome.approval);
          validateReceipt(
            outcome.receipt,
            state.claim,
            outcome.approval,
            {expectedPersistedVersion: null, persistedVersion: 1}
          );
          await actorBelongsToWorkspace(
            tx,
            state.claim.workspaceId,
            outcome.audit.actorId
          );
          const persisted = await persistApproval(
            tx,
            state.claim.workspaceId,
            outcome.approval
          );
          if (persisted.status !== 'persisted') {
            return persisted.status === 'not_found'
              ? {
                  status: 'version_conflict',
                  expectedPersistedVersion: null,
                  persistedVersion: null
                }
              : persisted;
          }
          const appended = await appendAudit(tx, outcome.audit, persisted.projectId);
          const receipt = await completeReceipt(
            token,
            outcome.receipt,
            outcome.approval,
            persisted.cas
          );
          const command = {
            kind: 'approval_required',
            approval: persisted.cas,
            audit: appended,
            receipt
          } as CompletedApprovalRequiredCommand;
          completed.add(command as object);
          return {status: 'completed', command};
        },

        async completeReceipt({claimToken: token, receipt, mutation}) {
          const state = mutations.get(mutation as object);
          invariant(
            state !== undefined &&
              state.claimToken === token &&
              state.auditToken === mutation.audit,
            'Persisted mutation does not belong to this receipt claim.'
          );
          const canonicalMutation = {
            aggregateType: state.aggregateType,
            aggregateId: state.aggregateId,
            expectedPersistedVersion: state.cas.expectedPersistedVersion,
            aggregate: {
              id: state.aggregateId,
              version: state.cas.persistedVersion
            }
          } as unknown as CanonicalMutation;
          const receiptToken = await completeReceipt(
            token,
            receipt,
            canonicalMutation,
            state.cas
          );
          const result: CompletedCanonicalMutation = {
            cas: state.cas,
            audit: state.auditToken,
            receipt: receiptToken
          };
          completed.add(result as object);
          return result;
        }
      };

      const result = await work(transaction);
      const completion =
        result.kind === 'approval_required' ? result : result.mutation;
      invariant(
        completed.has(completion as object),
        'Command transaction returned without a transaction-scoped receipt completion.'
      );
      return result;
    });
  }
});
