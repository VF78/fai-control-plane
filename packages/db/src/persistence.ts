import {createHash, randomUUID} from 'node:crypto';
import {computeApprovalActionHash} from '@fai-control-plane/domain';
import type {
  AccessRequest,
  AgentRun,
  AgentRunView,
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
  CommandExecutionResult,
  CommandReceiptCompletion,
  CompletedApprovalRequiredCommand,
  CompletedCanonicalCommand,
  CompletedCanonicalMutation,
  CompletedAuditedReceipt,
  NonApprovalAuditEvent,
  NonApprovalReceipt,
  PersistedCanonicalMutation,
  PersistedVersionCas,
  ReceiptClaimToken,
  TaskPacket,
  TaskPacketConfirmationView,
  UnitOfWork,
  WorkItem
} from '@fai-control-plane/domain';
import {and, eq, isNull, sql} from 'drizzle-orm';
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

type GitHubBindingEffect = Readonly<{
  bindingId: string;
  payload: Record<string, unknown>;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;

const isUuid = (value: string): boolean => uuidPattern.test(value);

const invariant: (
  condition: unknown,
  message: string
) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const uuid = (value: string, field: string): void => {
  invariant(isUuid(value), `${field} must be a UUID.`);
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
const agentRunIdempotencyKey = (
  workspaceId: string,
  idempotencyKey: string
): string =>
  `workspace-sha256:${createHash('sha256')
    .update(workspaceId)
    .update('\0')
    .update(idempotencyKey)
    .digest('hex')}`;

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
      invariant(
        Number.isSafeInteger(mutation.aggregate.content.workItemVersion) &&
          mutation.aggregate.content.workItemVersion > 0,
        'taskPacket.workItemVersion must be a positive safe integer.'
      );
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
      invariant(
        sha256Pattern.test(mutation.aggregate.confirmedPacketHash),
        'agentRun.confirmedPacketHash must be a lowercase SHA-256 digest.'
      );
      validateVersionMode(mutation.expectedPersistedVersion, mutation.aggregate.version);
      break;
    case 'approval':
      uuid(mutation.aggregate.id, 'approval.id');
      uuid(mutation.aggregate.projectId, 'approval.projectId');
      uuid(mutation.aggregate.requestedByActorId, 'approval.requestedByActorId');
      invariant(
        mutation.aggregate.binding.actorId === mutation.aggregate.requestedByActorId,
        'Approval binding actor must match the requester.'
      );
      uuid(mutation.aggregate.binding.actorId, 'approval.binding.actorId');
      uuid(mutation.aggregate.binding.executionIdentity, 'approval.binding.executionIdentity');
      invariant(
        sha256Pattern.test(mutation.aggregate.binding.subjectHash) &&
          sha256Pattern.test(mutation.aggregate.binding.actionHash),
        'Approval binding hashes must be lowercase SHA-256 digests.'
      );
      {
        const {actionHash, ...bindingFields} = mutation.aggregate.binding;
        invariant(
          computeApprovalActionHash({
            actionCategory: mutation.aggregate.actionCategory,
            surface: mutation.aggregate.surface,
            environment: mutation.aggregate.environment
          }, mutation.aggregate, bindingFields) === actionHash,
          'Approval action hash must match its structured action binding.'
        );
      }
      invariant(
        Number.isInteger(mutation.aggregate.binding.policyVersion) &&
          mutation.aggregate.binding.policyVersion > 0,
        'Approval binding policy version must be positive.'
      );
      invariant(
        date(mutation.aggregate.binding.expiresAt, 'approval.binding.expiresAt').toISOString() ===
          mutation.aggregate.binding.expiresAt,
        'Approval binding expiry must be canonical.'
      );
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
          invariant(
            mutation.aggregate.binding.executionIdentity === runtimeApproval.agentRunId,
            'AgentRun approval execution identity must match its target.'
          );
        }
      }
      if (mutation.expectedPersistedVersion === null) {
        invariant(
          mutation.aggregate.status === 'pending' &&
            mutation.aggregate.decidedByActorId === undefined && mutation.aggregate.decidedAt === undefined,
          'New approvals must be pending and undecided.'
        );
      } else {
        invariant(
          mutation.aggregate.status !== 'pending' &&
            mutation.aggregate.decidedByActorId !== undefined && mutation.aggregate.decidedAt !== undefined,
          'Approval decisions must retain the deciding actor and timestamp.'
        );
        uuid(mutation.aggregate.decidedByActorId, 'approval.decidedByActorId');
        invariant(
          date(mutation.aggregate.decidedAt, 'approval.decidedAt').toISOString() === mutation.aggregate.decidedAt,
          'Approval decision timestamp must be canonical.'
        );
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

const validateNoMutationAuditEnvelope = (
  audit: NonApprovalAuditEvent,
  claim: CommandReceiptClaim
): void => {
  uuid(audit.id, 'audit.id');
  uuid(audit.actorId, 'audit.actorId');
  date(audit.occurredAt, 'audit.occurredAt');
  invariant(audit.workspaceId === claim.workspaceId, 'Audit workspace does not match claim.');
  invariant(audit.commandId === claim.commandId, 'Audit command does not match claim.');
  invariant(
    audit.correlationId === claim.correlationId,
    'Audit correlation does not match claim.'
  );
};

const validateNoMutationReceipt = (
  receipt: NonApprovalReceipt,
  audit: NonApprovalAuditEvent,
  claim: CommandReceiptClaim
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
  const hasAggregate = receipt.aggregateType !== undefined || receipt.aggregateId !== undefined;
  invariant(
    !hasAggregate || (
      receipt.aggregateType === audit.targetType && receipt.aggregateId === audit.targetId
    ),
    'Receipt aggregate does not match audit target.'
  );
  if (receipt.aggregateId !== undefined) uuid(receipt.aggregateId, 'receipt.aggregateId');
  invariant(
    receipt.expectedVersion === audit.expectedVersion &&
      receipt.resultVersion === audit.resultVersion,
    'Receipt version facts do not match audit.'
  );
};

const workspaceHasActor = async (
  tx: Transaction,
  workspaceId: string,
  actorId: string
): Promise<boolean> => {
  const [actor] = await tx
    .select({id: schema.actors.id})
    .from(schema.actors)
    .where(
      and(
        eq(schema.actors.id, actorId),
        eq(schema.actors.workspaceId, workspaceId)
      )
    );
  return actor !== undefined;
};

const actorBelongsToWorkspace = async (
  tx: Transaction,
  workspaceId: string,
  actorId: string
): Promise<void> => {
  invariant(await workspaceHasActor(tx, workspaceId, actorId), 'Actor does not belong to claim workspace.');
};

const workspaceHasProject = async (
  tx: Transaction,
  workspaceId: string,
  projectId: string
): Promise<boolean> => {
  const [project] = await tx
    .select({id: schema.projects.id})
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.workspaceId, workspaceId)
      )
    );
  return project !== undefined;
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
): Promise<Readonly<{status: 'found'; secretRefId: string | null}> | Readonly<{status: 'not_found'}>> => {
  const content = packet.content;
  if (!await workspaceHasProject(tx, workspaceId, content.projectId)) return {status: 'not_found'};
  const [item] = await tx
    .select({id: schema.workItems.id, version: schema.workItems.version})
    .from(schema.workItems)
    .where(
      and(
        eq(schema.workItems.id, content.workItemId),
        eq(schema.workItems.projectId, content.projectId),
        workItemScope(workspaceId)
      )
    );
  if (item === undefined || item.version !== content.workItemVersion) return {status: 'not_found'};
  if (!await workspaceHasActor(tx, workspaceId, content.reviewerActorId) ||
    !await workspaceHasActor(tx, workspaceId, content.approverActorId) ||
    !await workspaceHasActor(tx, workspaceId, content.createdByActorId)) return {status: 'not_found'};
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
  if (event === undefined) return {status: 'not_found'};
  if (content.secretsRef === null) return {status: 'found', secretRefId: null};
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
  return secretRef === undefined
    ? {status: 'not_found'}
    : {status: 'found', secretRefId: secretRef.id};
};

const persistTaskPacket = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'task_packet'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const packet = mutation.aggregate;
  const content = packet.content;
  const ownership = await validateTaskPacketOwnership(tx, workspaceId, packet);
  if (ownership.status === 'not_found') return ownership;
  const [row] = await tx
    .insert(schema.taskPackets)
    .values({
      id: packet.packetId,
      projectId: content.projectId,
      workItemId: content.workItemId,
      workItemVersion: content.workItemVersion,
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
      secretRefId: ownership.secretRefId,
      createdFromEventId: content.createdFromEventId,
      contentHash: packet.contentHash,
      createdByActorId: content.createdByActorId
    })
    .onConflictDoNothing()
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
): Promise<Readonly<{status: 'found'; projectId: string}> | Readonly<{status: 'not_found'}>> => {
  const [packet] = await tx
    .select({
      projectId: schema.taskPackets.projectId,
      contentHash: schema.taskPackets.contentHash,
      runtimeProfile: schema.taskPackets.runtimeProfile
    })
    .from(schema.taskPackets)
    .where(
      and(
        eq(schema.taskPackets.id, aggregate.taskPacketId),
        taskPacketScope(workspaceId)
      )
    );
  if (packet === undefined || packet.contentHash !== aggregate.confirmedPacketHash) {
    return {status: 'not_found'};
  }
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
        eq(schema.actors.workspaceId, workspaceId),
        eq(schema.agentProfiles.enabled, true),
        eq(schema.agentProfiles.runtimeProfile, packet.runtimeProfile),
        isNull(schema.actors.disabledAt)
      )
    );
  return profile === undefined
    ? {status: 'not_found'}
    : {status: 'found', projectId: packet.projectId};
};

const persistAgentRun = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'agent_run'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  const ownership = await validateAgentRunOwnership(tx, workspaceId, aggregate);
  if (ownership.status === 'not_found') return ownership;
  const {projectId} = ownership;
  if (mutation.expectedPersistedVersion === null) {
    const [row] = await tx
      .insert(schema.agentRuns)
      .values({
        id: aggregate.id,
        taskPacketId: aggregate.taskPacketId,
        agentProfileId: aggregate.agentProfileId,
        confirmedPacketHash: aggregate.confirmedPacketHash,
        baseCommit: aggregate.baseCommit,
        status: aggregate.status,
        idempotencyKey: agentRunIdempotencyKey(
          workspaceId,
          aggregate.idempotencyKey
        ),
        version: 1
      })
      .onConflictDoNothing()
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
        eq(schema.agentRuns.baseCommit, aggregate.baseCommit),
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
): Promise<boolean> => {
  if (!await workspaceHasProject(tx, workspaceId, aggregate.projectId) ||
    !await workspaceHasActor(tx, workspaceId, aggregate.requestedByActorId)) return false;
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
    return item !== undefined;
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
    return run !== undefined;
  }
};

const persistApproval = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'approval'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  if (!await validateApprovalOwnership(tx, workspaceId, aggregate)) return {status: 'not_found'};
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
        subjectHash: aggregate.binding.subjectHash,
        policyVersion: aggregate.binding.policyVersion,
        executionIdentity: aggregate.binding.executionIdentity,
        actionHash: aggregate.binding.actionHash,
        status: aggregate.status,
        requestedByActorId: aggregate.requestedByActorId,
        expiresAt: new Date(aggregate.binding.expiresAt),
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
      decidedByActorId: aggregate.decidedByActorId,
      decidedAt: new Date(aggregate.decidedAt!),
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
        eq(schema.approvalRequests.subjectHash, aggregate.binding.subjectHash),
        eq(schema.approvalRequests.policyVersion, aggregate.binding.policyVersion),
        eq(schema.approvalRequests.executionIdentity, aggregate.binding.executionIdentity),
        eq(schema.approvalRequests.actionHash, aggregate.binding.actionHash),
        eq(schema.approvalRequests.expiresAt, new Date(aggregate.binding.expiresAt)),
        eq(
          schema.approvalRequests.requestedByActorId,
          aggregate.requestedByActorId
        ),
        eq(schema.approvalRequests.status, 'pending'),
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
  if (!await workspaceHasActor(tx, workspaceId, aggregate.requesterActorId)) return {status: 'not_found'};
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

const githubStatusEffect = (
  binding: typeof schema.trackerBindings.$inferSelect,
  workItem: WorkItem,
  mutationId: string
): GitHubBindingEffect | null => {
  const metadata = binding.metadata as Record<string, unknown>;
  const projectStatus = metadata.projectStatus;
  const repositoryExternalId = metadata.repositoryExternalId;
  if (
    typeof repositoryExternalId !== 'string' ||
    !/^github:repository:[1-9][0-9]*$/.test(repositoryExternalId) ||
    projectStatus === null || typeof projectStatus !== 'object' ||
    Array.isArray(projectStatus)
  ) return null;
  const status = projectStatus as Record<string, unknown>;
  if (
    typeof status.projectExternalId !== 'string' ||
    typeof status.projectItemExternalId !== 'string' ||
    typeof status.fieldExternalId !== 'string' ||
    (status.optionExternalId !== null && typeof status.optionExternalId !== 'string')
  ) return null;
  return {
    bindingId: binding.id,
    payload: {
      version: 1,
      bindingId: binding.id,
      workItemId: workItem.id,
      canonicalVersion: workItem.version,
      status: workItem.status,
      expected: {
        bindingExternalVersion: binding.externalVersion,
        providerOptionId: status.optionExternalId as string | null
      },
      target: {
        repositoryExternalId,
        projectExternalId: status.projectExternalId,
        projectItemExternalId: status.projectItemExternalId,
        fieldExternalId: status.fieldExternalId
      },
      mutationId
    }
  };
};

const auditProjectId = async (
  tx: Transaction,
  workspaceId: string,
  audit: NonApprovalAuditEvent
): Promise<string | null> => {
  if (!isUuid(audit.targetId)) return null;
  switch (audit.targetType) {
    case 'work_item': {
      const [row] = await tx
        .select({projectId: schema.workItems.projectId})
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, audit.targetId), workItemScope(workspaceId)));
      return row?.projectId ?? null;
    }
    case 'task_packet': {
      const [row] = await tx
        .select({projectId: schema.taskPackets.projectId})
        .from(schema.taskPackets)
        .where(and(eq(schema.taskPackets.id, audit.targetId), taskPacketScope(workspaceId)));
      return row?.projectId ?? null;
    }
    case 'agent_run': {
      const [row] = await tx
        .select({projectId: schema.taskPackets.projectId})
        .from(schema.agentRuns)
        .innerJoin(schema.taskPackets, eq(schema.taskPackets.id, schema.agentRuns.taskPacketId))
        .where(and(eq(schema.agentRuns.id, audit.targetId), agentRunScope(workspaceId)));
      return row?.projectId ?? null;
    }
    case 'approval': {
      const [row] = await tx
        .select({projectId: schema.approvalRequests.projectId})
        .from(schema.approvalRequests)
        .where(and(eq(schema.approvalRequests.id, audit.targetId), approvalScope(workspaceId)));
      return row?.projectId ?? null;
    }
    default:
      return null;
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
    claim: CommandReceiptClaim,
    work: (
      transaction: CanonicalCommandTransaction,
      claimToken: ReceiptClaimToken
    ) => Promise<CompletedCanonicalCommand<T>>
  ): Promise<CommandExecutionResult<T>> {
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

      const claimReceipt = async (): Promise<CommandReceiptClaimResult> => {
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
          return {status: 'key_reused', existingRequestHash: existing.requestHash};
        }
        return {status: 'replayed', receipt: mapReceipt(existing)};
      };

      const completeReceipt = async (
        token: ReceiptClaimToken,
        receipt: CommandReceipt
      ): Promise<CommandReceiptCompletion> => {
        const state = requireClaim(token);
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
        async loadWorkItem(token, workItemId): Promise<WorkItem | null> {
          const state = requireClaim(token);
          if (!isUuid(workItemId)) return null;
          const [row] = await tx
            .select({
              id: schema.workItems.id,
              projectId: schema.workItems.projectId,
              status: schema.workItems.status,
              blocked: schema.workItems.blocked,
              version: schema.workItems.version
            })
            .from(schema.workItems)
            .where(and(eq(schema.workItems.id, workItemId), workItemScope(state.claim.workspaceId)));
          return row === undefined ? null : {
            ...row,
            status: row.status as WorkItem['status']
          };
        },

        async loadTaskPacket(
          token,
          taskPacketId
        ): Promise<TaskPacketConfirmationView | null> {
          const state = requireClaim(token);
          if (!isUuid(taskPacketId)) return null;
          const [row] = await tx
            .select({
              packetId: schema.taskPackets.id,
              approverActorId: schema.taskPackets.approverActorId,
              contentHash: schema.taskPackets.contentHash
            })
            .from(schema.taskPackets)
            .where(and(
              eq(schema.taskPackets.id, taskPacketId),
              taskPacketScope(state.claim.workspaceId)
            ));
          return row === undefined ? null : {
            packetId: row.packetId,
            content: {approverActorId: row.approverActorId},
            contentHash: row.contentHash
          };
        },

        async loadAgentRun(token, agentRunId): Promise<AgentRunView | null> {
          const state = requireClaim(token);
          if (!isUuid(agentRunId)) return null;
          const [row] = await tx
            .select({
              id: schema.agentRuns.id,
              taskPacketId: schema.agentRuns.taskPacketId,
              agentProfileId: schema.agentRuns.agentProfileId,
              confirmedPacketHash: schema.agentRuns.confirmedPacketHash,
              baseCommit: schema.agentRuns.baseCommit,
              status: schema.agentRuns.status,
              idempotencyKey: schema.agentRuns.idempotencyKey,
              version: schema.agentRuns.version,
              projectId: schema.taskPackets.projectId
            })
            .from(schema.agentRuns)
            .innerJoin(schema.taskPackets, eq(schema.taskPackets.id, schema.agentRuns.taskPacketId))
            .where(and(
              eq(schema.agentRuns.id, agentRunId),
              agentRunScope(state.claim.workspaceId)
            ));
          return row === undefined ? null : {
            aggregate: {
              id: row.id,
              taskPacketId: row.taskPacketId,
              agentProfileId: row.agentProfileId,
              confirmedPacketHash: row.confirmedPacketHash,
              baseCommit: row.baseCommit,
              status: row.status as AgentRun['status'],
              idempotencyKey: row.idempotencyKey,
              version: row.version
            },
            projectId: row.projectId
          };
        },

        async loadApproval(token, approvalId): Promise<Approval | null> {
          const state = requireClaim(token);
          if (!isUuid(approvalId)) return null;
          const [row] = await tx
            .select({
              id: schema.approvalRequests.id,
              projectId: schema.approvalRequests.projectId,
              workItemId: schema.approvalRequests.workItemId,
              agentRunId: schema.approvalRequests.agentRunId,
              actionCategory: schema.approvalRequests.actionCategory,
              surface: schema.approvalRequests.surface,
              environment: schema.approvalRequests.environment,
              subjectHash: schema.approvalRequests.subjectHash,
              policyVersion: schema.approvalRequests.policyVersion,
              executionIdentity: schema.approvalRequests.executionIdentity,
              actionHash: schema.approvalRequests.actionHash,
              requestedByActorId: schema.approvalRequests.requestedByActorId,
              decidedByActorId: schema.approvalRequests.decidedByActorId,
              expiresAt: schema.approvalRequests.expiresAt,
              decidedAt: schema.approvalRequests.decidedAt,
              status: schema.approvalRequests.status,
              version: schema.approvalRequests.version
            })
            .from(schema.approvalRequests)
            .where(and(eq(schema.approvalRequests.id, approvalId), approvalScope(state.claim.workspaceId)));
          if (row === undefined) return null;
          const common = {
            id: row.id,
            projectId: row.projectId,
            actionCategory: row.actionCategory as Approval['actionCategory'],
            surface: row.surface as Approval['surface'],
            environment: row.environment as Approval['environment'],
            requestedByActorId: row.requestedByActorId,
            binding: {
              subjectHash: row.subjectHash,
              policyVersion: row.policyVersion,
              executionIdentity: row.executionIdentity,
              actorId: row.requestedByActorId,
              expiresAt: row.expiresAt.toISOString(),
              actionHash: row.actionHash
            },
            ...(row.decidedByActorId === null ? {} : {decidedByActorId: row.decidedByActorId}),
            ...(row.decidedAt === null ? {} : {decidedAt: row.decidedAt.toISOString()}),
            status: row.status as Approval['status'],
            version: row.version
          };
          return row.workItemId === null
            ? {...common, agentRunId: row.agentRunId!}
            : {...common, workItemId: row.workItemId};
        },

        async loadAccessRequest(token, accessRequestId): Promise<AccessRequest | null> {
          const state = requireClaim(token);
          if (!isUuid(accessRequestId)) return null;
          const [row] = await tx
            .select({
              id: schema.accessRequests.id,
              workspaceId: schema.accessRequests.workspaceId,
              requesterActorId: schema.accessRequests.requesterActorId,
              targetSurface: schema.accessRequests.targetSurface,
              requestedScope: schema.accessRequests.requestedScope,
              status: schema.accessRequests.status,
              version: schema.accessRequests.version
            })
            .from(schema.accessRequests)
            .where(and(
              eq(schema.accessRequests.id, accessRequestId),
              eq(schema.accessRequests.workspaceId, state.claim.workspaceId)
            ));
          return row === undefined ? null : {
            ...row,
            targetSurface: row.targetSurface as AccessRequest['targetSurface'],
            status: row.status as AccessRequest['status']
          };
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

        async persistAuditedWorkItemTransition({
          claimToken: token,
          outcome,
          fromStatus,
          mutationId
        }) {
          const state = requireClaim(token);
          if (outcome.mutation.aggregateType !== 'work_item') {
            return {status: 'invalid_effect'} as const;
          }
          validateAggregateIdentity(outcome.mutation);
          validateAuditEnvelope(outcome.audit, state.claim, outcome.mutation);
          await actorBelongsToWorkspace(
            tx,
            state.claim.workspaceId,
            outcome.audit.actorId
          );
          const bindings = await tx
            .select({binding: schema.trackerBindings})
            .from(schema.trackerBindings)
            .innerJoin(
              schema.workItems,
              and(
                eq(schema.workItems.id, schema.trackerBindings.entityId),
                eq(schema.workItems.projectId, schema.trackerBindings.projectId),
                workItemScope(state.claim.workspaceId)
              )
            )
            .where(and(
              eq(schema.trackerBindings.provider, 'github'),
              eq(schema.trackerBindings.surface, 'issue'),
              eq(schema.trackerBindings.entityType, 'work_item'),
              eq(schema.trackerBindings.entityId, outcome.mutation.aggregateId)
            ))
            .limit(2)
            .for('update');
          if (bindings.length > 1) {
            return {status: 'invalid_effect'} as const;
          }
          const [binding] = bindings;
          const effect = binding === undefined
            ? null
            : githubStatusEffect(binding.binding, outcome.mutation.aggregate, mutationId);
          if (binding !== undefined && effect === null) {
            return {status: 'invalid_effect'} as const;
          }
          const persisted = await persistWorkItem(
            tx,
            state.claim.workspaceId,
            outcome.mutation
          );
          if (persisted.status !== 'persisted') return persisted;
          await tx.insert(schema.statusTransitions).values({
            id: randomUUID(),
            workItemId: outcome.mutation.aggregateId,
            fromStatus,
            toStatus: outcome.mutation.aggregate.status,
            actorId: outcome.audit.actorId,
            reason: 'canonical_work_item_transition',
            idempotencyKey: `canonical-work-item-transition:${state.claim.commandId}`
          });
          if (effect !== null) {
            await tx.update(schema.trackerBindings).set({
              lastOutboundMutationId: mutationId,
              updatedAt: new Date()
            }).where(eq(schema.trackerBindings.id, effect.bindingId));
            await tx.insert(schema.outboxEvents).values({
              workspaceId: state.claim.workspaceId,
              projectId: persisted.projectId,
              destination: 'github',
              eventType: 'github.project_status.write.v1',
              idempotencyKey: `github-project-status:${effect.bindingId}:${mutationId}`,
              payload: effect.payload
            });
          }
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
          return {status: 'persisted' as const, mutation};
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
          if (persisted.status !== 'persisted') return persisted;
          const appended = await appendAudit(tx, outcome.audit, persisted.projectId);
          const receipt = await completeReceipt(
            token,
            outcome.receipt
          );
          const command = {
            kind: 'approval_required',
            approval: persisted.cas,
            audit: appended,
            receipt,
            commandReceipt: outcome.receipt
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
          validateReceipt(receipt, requireClaim(token).claim, canonicalMutation, state.cas);
          const receiptToken = await completeReceipt(
            token,
            receipt
          );
          const result: CompletedCanonicalMutation = {
            cas: state.cas,
            audit: state.auditToken,
            receipt: receiptToken
          };
          completed.add(result as object);
          return result;
        },

        async completeAuditedReceipt({claimToken: token, audit, receipt}) {
          const state = requireClaim(token);
          validateNoMutationAuditEnvelope(audit, state.claim);
          validateNoMutationReceipt(receipt, audit, state.claim);
          await actorBelongsToWorkspace(tx, state.claim.workspaceId, audit.actorId);
          const appended = await appendAudit(
            tx,
            audit,
            await auditProjectId(tx, state.claim.workspaceId, audit)
          );
          const receiptToken = await completeReceipt(token, receipt);
          const result = {audit: appended, receipt: receiptToken} as CompletedAuditedReceipt;
          completed.add(result as object);
          return result;
        }
      };

      const claimed = await claimReceipt();
      if (claimed.status === 'replayed' || claimed.status === 'key_reused') return claimed;
      const result = await work(transaction, claimed.token);
      const completion =
        result.kind === 'approval_required'
          ? result
          : result.kind === 'no_mutation'
            ? result.completion
            : result.mutation;
      invariant(
        completed.has(completion as object),
        'Command transaction returned without a transaction-scoped receipt completion.'
      );
      return {status: 'completed', command: result};
    });
  }
});
