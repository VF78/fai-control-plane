import {createHash, randomUUID} from 'node:crypto';
import {
  computeApprovalActionHash,
  canonicalProjectMembershipRoles,
  containsHighConfidenceSecretContent,
  DEFAULT_AGENT_INSTRUCTIONS,
  DEFAULT_AGENT_SETTINGS,
  OPERATOR_CANCELLED_BEFORE_CLAIM,
  OPERATOR_RECOVERED_EXPIRED_LEASE
} from '@fai-control-plane/domain';
import type {
  AccessRequest,
  ActorExternalIdentity,
  AgentProfileConfiguration,
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
  ProjectMembership,
  ReceiptClaimToken,
  ResourceAccessGrant,
  RuntimeRegistration,
  TaskPacket,
  TaskPacketConfirmationView,
  UnitOfWork,
  WorkItem
} from '@fai-control-plane/domain';
import {and, eq, exists, inArray, isNull, lte, sql} from 'drizzle-orm';
import type {ExtractTablesWithRelations, SQL} from 'drizzle-orm';
import type {
  NodePgDatabase,
  NodePgTransaction
} from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import {
  isRuntimeAvailable,
  isTaskPacketProfileEligible,
  matchesTaskPacketProfileSnapshot
} from './runtime-availability';
import {projectMembershipHasRoleSql} from './project-membership-roles';

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
      : mutation.aggregateType === 'runtime_recovery_policy'
        ? mutation.aggregate.runtimeRegistrationId
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
    case 'agent_profile':
      uuid(mutation.aggregate.id, 'agentProfile.id');
      uuid(mutation.aggregate.workspaceId, 'agentProfile.workspaceId');
      uuid(mutation.aggregate.actorId, 'agentProfile.actorId');
      invariant(
        mutation.aggregate.version === mutation.expectedPersistedVersion + 1,
        'AgentProfile update version must equal expected version plus one.'
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
      if (mutation.aggregate.retryOfAgentRunId != null) {
        uuid(mutation.aggregate.retryOfAgentRunId, 'agentRun.retryOfAgentRunId');
        invariant(
          mutation.aggregate.retryOfAgentRunId !== mutation.aggregate.id,
          'An AgentRun cannot retry itself.'
        );
      }
      invariant(
        sha256Pattern.test(mutation.aggregate.confirmedPacketHash),
        'agentRun.confirmedPacketHash must be a lowercase SHA-256 digest.'
      );
      validateVersionMode(mutation.expectedPersistedVersion, mutation.aggregate.version);
      if (mutation.recoveryBinding !== undefined) {
        invariant(
          mutation.aggregate.failureCode === OPERATOR_RECOVERED_EXPIRED_LEASE,
          'agentRun.recoveryBinding requires the recovery failure code.'
        );
        uuid(mutation.recoveryBinding.registrationId, 'agentRun.recoveryBinding.registrationId');
        uuid(mutation.recoveryBinding.projectId, 'agentRun.recoveryBinding.projectId');
        uuid(mutation.recoveryBinding.actorId, 'agentRun.recoveryBinding.actorId');
        uuid(mutation.recoveryBinding.agentProfileId, 'agentRun.recoveryBinding.agentProfileId');
        invariant(
          Number.isSafeInteger(mutation.recoveryBinding.registrationVersion) &&
            mutation.recoveryBinding.registrationVersion > 0,
          'agentRun.recoveryBinding.registrationVersion must be a positive safe integer.'
        );
      }
      invariant(
        mutation.aggregate.failureCode !== OPERATOR_RECOVERED_EXPIRED_LEASE ||
          mutation.recoveryBinding !== undefined,
        'Recovered AgentRun requires an exact recovery binding.'
      );
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
    case 'project_membership':
      uuid(mutation.aggregate.id, 'projectMembership.id');
      uuid(mutation.aggregate.projectId, 'projectMembership.projectId');
      uuid(mutation.aggregate.actorId, 'projectMembership.actorId');
      invariant(canonicalProjectMembershipRoles(mutation.aggregate.roles) !== null,
        'Project membership roles must be canonical.');
      validateVersionMode(mutation.expectedPersistedVersion, mutation.aggregate.version);
      break;
    case 'project_setup':
      uuid(mutation.aggregate.id, 'projectSetup.id');
      uuid(mutation.aggregate.project.id, 'projectSetup.project.id');
      uuid(mutation.aggregate.project.workspaceId, 'projectSetup.project.workspaceId');
      invariant(mutation.aggregateId === mutation.aggregate.id &&
        mutation.expectedPersistedVersion === null && mutation.aggregate.version === 1,
      'Project setup must use insert mode.');
      invariant(mutation.aggregate.memberships.every((membership) =>
        membership.projectId === mutation.aggregate.project.id && membership.active && membership.version === 1),
      'Project setup memberships must be active and project-bound.');
      break;
    case 'actor_onboarding':
      uuid(mutation.aggregate.id, 'actorOnboarding.id');
      uuid(mutation.aggregate.workspaceId, 'actorOnboarding.workspaceId');
      uuid(mutation.aggregate.projectId, 'actorOnboarding.projectId');
      uuid(mutation.aggregate.membership.id, 'actorOnboarding.membership.id');
      invariant(mutation.expectedPersistedVersion === null && mutation.aggregate.version === 1,
        'Actor onboarding must use insert mode.');
      invariant(mutation.aggregate.membership.actorId === mutation.aggregate.id &&
        mutation.aggregate.membership.projectId === mutation.aggregate.projectId &&
        mutation.aggregate.membership.version === 1 && mutation.aggregate.membership.active,
      'Actor onboarding membership must be active and bound to the actor and project.');
      invariant(
        (mutation.aggregate.actorType === 'human' && mutation.aggregate.agentProfile === null &&
          !mutation.aggregate.membership.roles.includes('agent')) ||
        (mutation.aggregate.actorType === 'agent' && mutation.aggregate.actorRole === 'agent_operator' &&
          mutation.aggregate.membership.roles.length === 1 &&
          mutation.aggregate.membership.roles[0] === 'agent' && mutation.aggregate.agentProfile !== null),
        'Actor onboarding role and profile must match actor type.'
      );
      if (mutation.aggregate.agentProfile !== null) {
        uuid(mutation.aggregate.agentProfile.id, 'actorOnboarding.profile.id');
        uuid(mutation.aggregate.agentProfile.registration.id, 'actorOnboarding.registration.id');
        invariant(mutation.aggregate.agentProfile.registration.actorId === mutation.aggregate.id &&
          mutation.aggregate.agentProfile.registration.projectId === mutation.aggregate.projectId &&
          mutation.aggregate.agentProfile.registration.agentProfileId === mutation.aggregate.agentProfile.id,
        'Actor onboarding registration must be bound to its actor, project, and profile.');
      }
      break;
    case 'actor_external_identity':
      uuid(mutation.aggregate.id, 'actorExternalIdentity.id');
      uuid(mutation.aggregate.actorId, 'actorExternalIdentity.actorId');
      invariant(
        /^[a-z][a-z0-9_-]{0,63}$/.test(mutation.aggregate.provider),
        'External identity provider must be a canonical provider key.'
      );
      validateVersionMode(mutation.expectedPersistedVersion, mutation.aggregate.version);
      break;
    case 'actor':
      uuid(mutation.aggregate.id, 'actor.id');
      uuid(mutation.aggregate.workspaceId, 'actor.workspaceId');
      invariant(mutation.expectedPersistedVersion === 0, 'Actor retirement must expect active state.');
      invariant(
        mutation.aggregate.disabledAt !== null &&
          date(mutation.aggregate.disabledAt, 'actor.disabledAt').toISOString() === mutation.aggregate.disabledAt,
        'Actor retirement timestamp must be canonical.'
      );
      break;
    case 'resource_access_grant':
      uuid(mutation.aggregate.id, 'resourceAccessGrant.id');
      uuid(mutation.aggregate.projectId, 'resourceAccessGrant.projectId');
      uuid(mutation.aggregate.actorId, 'resourceAccessGrant.actorId');
      uuid(mutation.aggregate.resourceId, 'resourceAccessGrant.resourceId');
      if (mutation.aggregate.providerObservation != null) {
        invariant(
          /^[a-z][a-z0-9_-]{0,63}$/.test(
            mutation.aggregate.providerObservation.provider
          ),
          'Access observation provider must be a canonical provider key.'
        );
        invariant(
          date(
            mutation.aggregate.providerObservation.observedAt,
            'resourceAccessGrant.providerObservation.observedAt'
          ).toISOString() === mutation.aggregate.providerObservation.observedAt,
          'Access observation timestamp must be canonical.'
        );
      }
      validateVersionMode(mutation.expectedPersistedVersion, mutation.aggregate.version);
      break;
    case 'runtime_registration':
      uuid(mutation.aggregate.id, 'runtimeRegistration.id');
      uuid(mutation.aggregate.projectId, 'runtimeRegistration.projectId');
      uuid(mutation.aggregate.actorId, 'runtimeRegistration.actorId');
      uuid(mutation.aggregate.agentProfileId, 'runtimeRegistration.agentProfileId');
      invariant(
        /^[a-z][a-z0-9_-]{0,63}$/.test(mutation.aggregate.provider),
        'Runtime registration provider must be a canonical provider key.'
      );
      invariant(
        mutation.aggregate.runtimeKey.length > 0 &&
          mutation.aggregate.runtimeKey.length <= 256 &&
          !/[\u0000-\u001f\u007f]/.test(mutation.aggregate.runtimeKey),
        'Runtime registration key must be a bounded external reference.'
      );
      validateVersionMode(mutation.expectedPersistedVersion, mutation.aggregate.version);
      if (mutation.replacementTarget !== undefined) {
        const target = mutation.replacementTarget.aggregate;
        uuid(target.id, 'runtimeRegistration.replacementTarget.id');
        uuid(target.projectId, 'runtimeRegistration.replacementTarget.projectId');
        uuid(target.actorId, 'runtimeRegistration.replacementTarget.actorId');
        uuid(target.agentProfileId, 'runtimeRegistration.replacementTarget.agentProfileId');
        invariant(
          /^[a-z][a-z0-9_-]{0,63}$/.test(target.provider),
          'Replacement target provider must be a canonical provider key.'
        );
        invariant(
          target.runtimeKey.length > 0 && target.runtimeKey.length <= 256 &&
            !/[\u0000-\u001f\u007f]/.test(target.runtimeKey),
          'Replacement target key must be a bounded external reference.'
        );
        validateVersionMode(
          mutation.replacementTarget.expectedPersistedVersion,
          target.version
        );
        invariant(
          mutation.expectedPersistedVersion !== null &&
            mutation.aggregate.id !== target.id &&
            mutation.aggregate.projectId === target.projectId &&
            mutation.aggregate.actorId !== target.actorId &&
            mutation.aggregate.agentProfileId !== target.agentProfileId &&
            !mutation.aggregate.enabled &&
            target.enabled,
          'Replacement must atomically switch two registrations for different agents.'
        );
      }
      break;
    case 'runtime_availability_observation':
      uuid(mutation.aggregate.id, 'runtimeAvailabilityObservation.id');
      uuid(mutation.aggregate.runtimeRegistrationId, 'runtimeAvailabilityObservation.runtimeRegistrationId');
      invariant(
        ['service', 'scheduler', 'delivery'].includes(mutation.aggregate.component),
        'Runtime availability component is invalid.'
      );
      invariant(
        ['available', 'unavailable'].includes(mutation.aggregate.state),
        'Runtime availability state is invalid.'
      );
      invariant(
        date(mutation.aggregate.observedAt, 'runtimeAvailabilityObservation.observedAt').toISOString() ===
          mutation.aggregate.observedAt,
        'Runtime availability timestamp must be canonical.'
      );
      invariant(
        Number.isInteger(mutation.aggregate.ttlSeconds) &&
          mutation.aggregate.ttlSeconds >= 30 && mutation.aggregate.ttlSeconds <= 604800,
        'Runtime availability TTL is invalid.'
      );
      invariant(
        mutation.aggregate.evidenceReference.length >= 1 &&
          mutation.aggregate.evidenceReference.length <= 500 &&
          !/[\u0000-\u001f\u007f]/.test(mutation.aggregate.evidenceReference) &&
          !containsHighConfidenceSecretContent(mutation.aggregate.evidenceReference),
        'Runtime availability evidence is invalid.'
      );
      validateVersionMode(null, mutation.aggregate.version);
      break;
    case 'runtime_recovery_policy':
      uuid(mutation.aggregate.runtimeRegistrationId, 'runtimeRecoveryPolicy.runtimeRegistrationId');
      invariant(
        mutation.aggregate.runtimeRegistrationId === mutation.aggregateId &&
          Number.isInteger(mutation.aggregate.staleThresholdSeconds) &&
          mutation.aggregate.staleThresholdSeconds >= 30 &&
          mutation.aggregate.staleThresholdSeconds <= 604800 &&
          Number.isInteger(mutation.aggregate.maximumAttempts) &&
          mutation.aggregate.maximumAttempts >= 1 && mutation.aggregate.maximumAttempts <= 10,
        'Runtime recovery policy is invalid.'
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
  mutation.aggregateType === 'task_packet' || mutation.aggregateType === 'actor' ||
    mutation.aggregateType === 'actor_onboarding'
    ? 1
    : mutation.aggregate.version;

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

const agentProfileScope = (workspaceId: string): SQL =>
  sql`${schema.agentProfiles.workspaceId} = ${workspaceId}`;

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
    case 'agent_profile': {
      const [row] = await tx
        .select({version: schema.agentProfiles.version})
        .from(schema.agentProfiles)
        .where(and(
          eq(schema.agentProfiles.id, mutation.aggregateId),
          agentProfileScope(workspaceId)
        ));
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
    case 'project_membership': {
      const [row] = await tx
        .select({version: schema.projectMemberships.version})
        .from(schema.projectMemberships)
        .innerJoin(
          schema.projects,
          eq(schema.projects.id, schema.projectMemberships.projectId)
        )
        .where(and(
          eq(schema.projectMemberships.id, mutation.aggregateId),
          eq(schema.projects.workspaceId, workspaceId)
        ));
      return row?.version ?? null;
    }
    case 'project_setup': {
      const [row] = await tx.select({version: schema.projectSetups.version})
        .from(schema.projectSetups)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.projectSetups.projectId))
        .where(and(eq(schema.projectSetups.id, mutation.aggregateId),
          eq(schema.projects.workspaceId, workspaceId)));
      return row?.version ?? null;
    }
    case 'actor_onboarding': {
      const [row] = await tx.select({id: schema.actors.id}).from(schema.actors).where(and(
        eq(schema.actors.id, mutation.aggregateId), eq(schema.actors.workspaceId, workspaceId)
      ));
      return row === undefined ? null : 1;
    }
    case 'actor_external_identity': {
      const [row] = await tx
        .select({version: schema.actorExternalIdentities.version})
        .from(schema.actorExternalIdentities)
        .innerJoin(
          schema.actors,
          eq(schema.actors.id, schema.actorExternalIdentities.actorId)
        )
        .where(and(
          eq(schema.actorExternalIdentities.id, mutation.aggregateId),
          eq(schema.actors.workspaceId, workspaceId)
        ));
      return row?.version ?? null;
    }
    case 'actor': {
      const [row] = await tx
        .select({disabledAt: schema.actors.disabledAt})
        .from(schema.actors)
        .where(and(
          eq(schema.actors.id, mutation.aggregateId),
          eq(schema.actors.workspaceId, workspaceId),
          eq(schema.actors.type, 'agent')
        ));
      return row === undefined ? null : row.disabledAt === null ? 0 : 1;
    }
    case 'resource_access_grant': {
      const [row] = await tx
        .select({version: schema.resourceAccessGrants.version})
        .from(schema.resourceAccessGrants)
        .innerJoin(
          schema.projects,
          eq(schema.projects.id, schema.resourceAccessGrants.projectId)
        )
        .where(and(
          eq(schema.resourceAccessGrants.id, mutation.aggregateId),
          eq(schema.projects.workspaceId, workspaceId)
        ));
      return row?.version ?? null;
    }
    case 'runtime_registration': {
      const [row] = await tx
        .select({version: schema.runtimeRegistrations.version})
        .from(schema.runtimeRegistrations)
        .innerJoin(
          schema.projects,
          eq(schema.projects.id, schema.runtimeRegistrations.projectId)
        )
        .where(and(
          eq(schema.runtimeRegistrations.id, mutation.aggregateId),
          eq(schema.projects.workspaceId, workspaceId)
        ));
      return row?.version ?? null;
    }
    case 'runtime_availability_observation': {
      const [row] = await tx.select({id: schema.runtimeAvailabilityObservations.id})
        .from(schema.runtimeAvailabilityObservations)
        .innerJoin(
          schema.runtimeRegistrations,
          eq(schema.runtimeRegistrations.id, schema.runtimeAvailabilityObservations.runtimeRegistrationId)
        )
        .innerJoin(schema.projects, eq(schema.projects.id, schema.runtimeRegistrations.projectId))
        .where(and(
          eq(schema.runtimeAvailabilityObservations.id, mutation.aggregateId),
          eq(schema.projects.workspaceId, workspaceId)
        ));
      return row === undefined ? null : 1;
    }
    case 'runtime_recovery_policy': {
      const [row] = await tx.select({version: schema.runtimeRecoveryPolicies.version})
        .from(schema.runtimeRecoveryPolicies)
        .innerJoin(
          schema.runtimeRegistrations,
          eq(schema.runtimeRegistrations.id, schema.runtimeRecoveryPolicies.runtimeRegistrationId)
        )
        .innerJoin(schema.projects, eq(schema.projects.id, schema.runtimeRegistrations.projectId))
        .where(and(
          eq(schema.runtimeRecoveryPolicies.runtimeRegistrationId, mutation.aggregateId),
          eq(schema.projects.workspaceId, workspaceId)
        ));
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

const persistAgentProfile = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'agent_profile'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  if (aggregate.workspaceId !== workspaceId) return {status: 'not_found'};
  const [row] = await tx
    .update(schema.agentProfiles)
    .set({
      instructions: aggregate.instructions,
      settings: aggregate.settings,
      enabled: aggregate.enabled,
      version: sql`${schema.agentProfiles.version} + 1`,
      configHash: aggregate.configHash,
      updatedAt: new Date()
    })
    .where(and(
      eq(schema.agentProfiles.id, aggregate.id),
      eq(schema.agentProfiles.workspaceId, workspaceId),
      eq(schema.agentProfiles.actorId, aggregate.actorId),
      eq(schema.agentProfiles.runtimeId, aggregate.runtimeId),
      eq(schema.agentProfiles.runtimeProfile, aggregate.runtimeProfile),
      eq(schema.agentProfiles.version, mutation.expectedPersistedVersion)
    ))
    .returning({version: schema.agentProfiles.version});
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
  const snapshot = content.agentProfileSnapshot;
  if (snapshot !== undefined && snapshot !== null) {
    const [profile] = await tx
      .select({id: schema.agentProfiles.id})
      .from(schema.agentProfiles)
      .where(and(
        eq(schema.agentProfiles.id, snapshot.profileId),
        eq(schema.agentProfiles.workspaceId, workspaceId),
        eq(schema.agentProfiles.runtimeId, snapshot.runtimeId),
        eq(schema.agentProfiles.runtimeProfile, snapshot.runtimeProfile),
        eq(schema.agentProfiles.version, snapshot.configVersion),
        eq(schema.agentProfiles.configHash, snapshot.configHash)
      ));
    if (profile === undefined) return {status: 'not_found'};
  }
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
      agentProfileSnapshotId: content.agentProfileSnapshot?.profileId,
      agentProfileSnapshotRuntimeId: content.agentProfileSnapshot?.runtimeId,
      agentProfileSnapshotAllowedTools: content.agentProfileSnapshot == null
        ? undefined
        : [...content.agentProfileSnapshot.allowedTools],
      agentProfileSnapshotForbiddenSurfaces: content.agentProfileSnapshot == null
        ? undefined
        : [...content.agentProfileSnapshot.forbiddenSurfaces],
      agentProfileSnapshotEnabled: content.agentProfileSnapshot?.enabled,
      agentProfileSnapshotVersion: content.agentProfileSnapshot?.configVersion,
      agentProfileSnapshotHash: content.agentProfileSnapshot?.configHash,
      agentProfileSnapshotInstructions: content.agentProfileSnapshot?.instructions,
      agentProfileSnapshotSettings: content.agentProfileSnapshot?.settings,
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
): Promise<
  | Readonly<{
      status: 'found';
      projectId: string;
      workItemId: string;
    }>
  | Readonly<{status: 'not_found'}>
> => {
  const [packet] = await tx
    .select({
      projectId: schema.taskPackets.projectId,
      workItemId: schema.taskPackets.workItemId,
      contentHash: schema.taskPackets.contentHash,
      runtimeProfile: schema.taskPackets.runtimeProfile,
      agentProfileSnapshotId: schema.taskPackets.agentProfileSnapshotId,
      agentProfileSnapshotVersion: schema.taskPackets.agentProfileSnapshotVersion,
      agentProfileSnapshotHash: schema.taskPackets.agentProfileSnapshotHash
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
  if (!matchesTaskPacketProfileSnapshot(
    packet.agentProfileSnapshotId,
    aggregate.agentProfileId
  )) return {status: 'not_found'};
  const [profile] = await tx
    .select({id: schema.agentProfiles.id, runtimeId: schema.agentProfiles.runtimeId})
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
        ...(packet.agentProfileSnapshotId === null ? [] : [
          eq(schema.agentProfiles.version, packet.agentProfileSnapshotVersion!),
          eq(schema.agentProfiles.configHash, packet.agentProfileSnapshotHash!)
        ]),
        isNull(schema.actors.disabledAt)
      )
    );
  if (profile === undefined || !isTaskPacketProfileEligible(
    profile.runtimeId,
    packet.agentProfileSnapshotId,
    aggregate.agentProfileId
  )) return {status: 'not_found'};
  return {
    status: 'found',
    projectId: packet.projectId,
    workItemId: packet.workItemId
  };
};

const persistAgentRun = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'agent_run'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  const ownership = await validateAgentRunOwnership(tx, workspaceId, aggregate);
  if (ownership.status === 'not_found') return ownership;
  const {projectId, workItemId} = ownership;
  if (mutation.expectedPersistedVersion === null) {
    const repositoryScopes = await tx
      .select({id: schema.projectTrackerRepositoryScopes.id})
      .from(schema.projectTrackerRepositoryScopes)
      .where(eq(schema.projectTrackerRepositoryScopes.projectId, projectId))
      .limit(2);
    if (repositoryScopes.length !== 1) return {status: 'not_found'};
    const repositoryScopeId = repositoryScopes[0]!.id;
    const [row] = await tx
      .insert(schema.agentRuns)
      .values({
        id: aggregate.id,
        taskPacketId: aggregate.taskPacketId,
        agentProfileId: aggregate.agentProfileId,
        workItemId,
        repositoryScopeId,
        retryOfAgentRunId: aggregate.retryOfAgentRunId,
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
  const persistedAt = new Date();
  const recovery = aggregate.failureCode === OPERATOR_RECOVERED_EXPIRED_LEASE
    ? mutation.recoveryBinding
    : undefined;
  const [row] = await tx
    .update(schema.agentRuns)
    .set({
      status: aggregate.status,
      ...(aggregate.failureCode === OPERATOR_CANCELLED_BEFORE_CLAIM
        ? {
            failureCode: OPERATOR_CANCELLED_BEFORE_CLAIM,
            completedAt: persistedAt
          }
        : {}),
      ...(recovery === undefined
        ? {}
        : {
            failureCode: OPERATOR_RECOVERED_EXPIRED_LEASE,
            completedAt: persistedAt,
            runnerId: null,
            leaseTokenHash: null,
            leaseExpiresAt: null
          }),
      version: sql`${schema.agentRuns.version} + 1`,
      updatedAt: persistedAt
    })
    .where(
      and(
        eq(schema.agentRuns.id, aggregate.id),
        eq(schema.agentRuns.taskPacketId, aggregate.taskPacketId),
        eq(schema.agentRuns.agentProfileId, aggregate.agentProfileId),
        eq(schema.agentRuns.baseCommit, aggregate.baseCommit),
        eq(schema.agentRuns.idempotencyKey, aggregate.idempotencyKey),
        eq(schema.agentRuns.version, mutation.expectedPersistedVersion),
        agentRunScope(workspaceId),
        ...(recovery === undefined
          ? []
          : [
              eq(schema.agentRuns.status, 'running'),
              lte(schema.agentRuns.leaseExpiresAt, persistedAt),
              exists(
                tx.select({id: schema.runtimeRegistrations.id})
                  .from(schema.runtimeRegistrations)
                  .where(and(
                    eq(schema.runtimeRegistrations.id, recovery.registrationId),
                    eq(schema.runtimeRegistrations.projectId, recovery.projectId),
                    eq(schema.runtimeRegistrations.actorId, recovery.actorId),
                    eq(schema.runtimeRegistrations.agentProfileId, recovery.agentProfileId),
                    eq(schema.runtimeRegistrations.version, recovery.registrationVersion),
                    eq(schema.runtimeRegistrations.enabled, true)
                  ))
              )
            ])
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

const accessSubjectIsScoped = async (
  tx: Transaction,
  workspaceId: string,
  projectId: string,
  actorId: string
): Promise<boolean> =>
  await workspaceHasProject(tx, workspaceId, projectId) &&
  await workspaceHasActor(tx, workspaceId, actorId);

const projectMembershipActorIsCompatible = async (
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  roles: readonly ProjectMembership['roles'][number][]
): Promise<boolean> => {
  const [actor] = await tx.select({type: schema.actors.type})
    .from(schema.actors)
    .where(and(eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId)));
  if (actor === undefined) return false;
  return actor.type === 'agent'
    ? roles.length === 1 && roles[0] === 'agent'
    : actor.type === 'human' && !roles.includes('agent');
};

const persistProjectMembership = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'project_membership'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  if (!await accessSubjectIsScoped(
    tx, workspaceId, aggregate.projectId, aggregate.actorId
  ) || !await projectMembershipActorIsCompatible(
    tx, workspaceId, aggregate.actorId, aggregate.roles
  )) return {status: 'not_found'};
  if (mutation.expectedPersistedVersion === null) {
    const [row] = await tx.insert(schema.projectMemberships).values({
      id: aggregate.id,
      projectId: aggregate.projectId,
      actorId: aggregate.actorId,
      roles: [...aggregate.roles],
      active: aggregate.active,
      version: 1
    }).onConflictDoNothing().returning({version: schema.projectMemberships.version});
    return row === undefined
      ? conflictOrNotFound(tx, workspaceId, mutation)
      : {
          status: 'persisted',
          cas: {expectedPersistedVersion: null, persistedVersion: row.version},
          projectId: aggregate.projectId
        };
  }
  const [row] = await tx.update(schema.projectMemberships).set({
    roles: [...aggregate.roles],
    active: aggregate.active,
    version: sql`${schema.projectMemberships.version} + 1`,
    updatedAt: new Date()
  }).where(and(
    eq(schema.projectMemberships.id, aggregate.id),
    eq(schema.projectMemberships.projectId, aggregate.projectId),
    eq(schema.projectMemberships.actorId, aggregate.actorId),
    eq(schema.projectMemberships.version, mutation.expectedPersistedVersion)
  )).returning({version: schema.projectMemberships.version});
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

const persistActorOnboarding = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'actor_onboarding'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  if (aggregate.workspaceId !== workspaceId ||
    !await workspaceHasProject(tx, workspaceId, aggregate.projectId)) return {status: 'not_found'};
  await tx.insert(schema.actors).values({
    id: aggregate.id,
    workspaceId,
    type: aggregate.actorType,
    role: aggregate.actorRole,
    displayName: aggregate.displayName,
    authMode: aggregate.actorType === 'human' ? 'user' : 'agent',
    capabilities: {}
  });
  await tx.insert(schema.projectMemberships).values({
    id: aggregate.membership.id,
    projectId: aggregate.projectId,
    actorId: aggregate.id,
    roles: [...aggregate.membership.roles],
    active: true,
    version: 1
  });
  if (aggregate.agentProfile !== null) {
    const profile = aggregate.agentProfile;
    await tx.insert(schema.agentProfiles).values({
      id: profile.id,
      workspaceId,
      actorId: aggregate.id,
      runtimeId: profile.runtimeId,
      runtimeProfile: profile.runtimeProfile,
      allowedTools: [],
      forbiddenSurfaces: [],
      instructions: DEFAULT_AGENT_INSTRUCTIONS,
      settings: DEFAULT_AGENT_SETTINGS,
      enabled: true,
      version: 1,
      configHash: profile.configHash
    });
    await tx.insert(schema.runtimeRegistrations).values({
      id: profile.registration.id,
      projectId: aggregate.projectId,
      actorId: aggregate.id,
      agentProfileId: profile.id,
      provider: profile.registration.provider,
      runtimeKey: profile.registration.runtimeKey,
      enabled: true,
      version: 1
    });
  }
  return {
    status: 'persisted',
    cas: {expectedPersistedVersion: null, persistedVersion: 1},
    projectId: aggregate.projectId
  };
};

const persistActorExternalIdentity = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'actor_external_identity'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  if (!await workspaceHasActor(tx, workspaceId, aggregate.actorId)) {
    return {status: 'not_found'};
  }
  if (mutation.expectedPersistedVersion === null) {
    const [row] = await tx.insert(schema.actorExternalIdentities).values({
      id: aggregate.id,
      actorId: aggregate.actorId,
      provider: aggregate.provider,
      externalSubject: aggregate.externalSubject,
      active: aggregate.active,
      version: 1
    }).onConflictDoNothing().returning({
      version: schema.actorExternalIdentities.version
    });
    return row === undefined
      ? conflictOrNotFound(tx, workspaceId, mutation)
      : {
          status: 'persisted',
          cas: {expectedPersistedVersion: null, persistedVersion: row.version},
          projectId: null
        };
  }
  const [row] = await tx.update(schema.actorExternalIdentities).set({
    externalSubject: aggregate.externalSubject,
    active: aggregate.active,
    version: sql`${schema.actorExternalIdentities.version} + 1`,
    updatedAt: new Date()
  }).where(and(
    eq(schema.actorExternalIdentities.id, aggregate.id),
    eq(schema.actorExternalIdentities.actorId, aggregate.actorId),
    eq(schema.actorExternalIdentities.provider, aggregate.provider),
    eq(schema.actorExternalIdentities.version, mutation.expectedPersistedVersion)
  )).returning({version: schema.actorExternalIdentities.version});
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

const persistResourceAccessGrant = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'resource_access_grant'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  if (!await accessSubjectIsScoped(
    tx, workspaceId, aggregate.projectId, aggregate.actorId
  )) return {status: 'not_found'};
  const [membership] = await tx.select({id: schema.projectMemberships.id})
    .from(schema.projectMemberships)
    .where(and(
      eq(schema.projectMemberships.projectId, aggregate.projectId),
      eq(schema.projectMemberships.actorId, aggregate.actorId),
      eq(schema.projectMemberships.active, true)
    ));
  if (membership === undefined) return {status: 'not_found'};
  const observation = aggregate.providerObservation;
  if (mutation.expectedPersistedVersion === null) {
    const [row] = await tx.insert(schema.resourceAccessGrants).values({
      id: aggregate.id,
      projectId: aggregate.projectId,
      actorId: aggregate.actorId,
      resourceType: aggregate.resourceType,
      resourceId: aggregate.resourceId,
      desiredLevel: aggregate.desiredLevel,
      observedProvider: observation?.provider ?? null,
      observedExternalResourceRef: observation?.externalResourceRef ?? null,
      observedLevel: observation?.confirmedLevel ?? null,
      observedAt: observation == null ? null : new Date(observation.observedAt),
      version: 1
    }).onConflictDoNothing().returning({version: schema.resourceAccessGrants.version});
    return row === undefined
      ? conflictOrNotFound(tx, workspaceId, mutation)
      : {
          status: 'persisted',
          cas: {expectedPersistedVersion: null, persistedVersion: row.version},
          projectId: aggregate.projectId
        };
  }
  const [row] = await tx.update(schema.resourceAccessGrants).set({
    desiredLevel: aggregate.desiredLevel,
    observedProvider: observation?.provider ?? null,
    observedExternalResourceRef: observation?.externalResourceRef ?? null,
    observedLevel: observation?.confirmedLevel ?? null,
    observedAt: observation == null ? null : new Date(observation.observedAt),
    version: sql`${schema.resourceAccessGrants.version} + 1`,
    updatedAt: new Date()
  }).where(and(
    eq(schema.resourceAccessGrants.id, aggregate.id),
    eq(schema.resourceAccessGrants.projectId, aggregate.projectId),
    eq(schema.resourceAccessGrants.actorId, aggregate.actorId),
    eq(schema.resourceAccessGrants.resourceType, aggregate.resourceType),
    eq(schema.resourceAccessGrants.resourceId, aggregate.resourceId),
    eq(schema.resourceAccessGrants.version, mutation.expectedPersistedVersion)
  )).returning({version: schema.resourceAccessGrants.version});
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

const runtimeRegistrationSubjectIsScoped = async (
  tx: Transaction,
  workspaceId: string,
  registration: RuntimeRegistration
): Promise<boolean> => {
  if (!await workspaceHasProject(tx, workspaceId, registration.projectId)) return false;
  const [binding] = await tx.select({
    profileId: schema.agentProfiles.id,
    profileEnabled: schema.agentProfiles.enabled,
    actorDisabledAt: schema.actors.disabledAt
  })
    .from(schema.actors)
    .innerJoin(
      schema.agentProfiles,
      and(
        eq(schema.agentProfiles.id, registration.agentProfileId),
        eq(schema.agentProfiles.actorId, schema.actors.id),
        eq(schema.agentProfiles.workspaceId, schema.actors.workspaceId)
      )
    )
    .where(and(
      eq(schema.actors.id, registration.actorId),
      eq(schema.actors.workspaceId, workspaceId),
      eq(schema.actors.type, 'agent')
    ));
  if (binding === undefined) return false;
  if (!registration.enabled) return true;
  if (binding.actorDisabledAt !== null || !binding.profileEnabled) return false;
  const [membership] = await tx.select({id: schema.projectMemberships.id})
    .from(schema.projectMemberships)
    .where(and(
      eq(schema.projectMemberships.projectId, registration.projectId),
      eq(schema.projectMemberships.actorId, registration.actorId),
      projectMembershipHasRoleSql(schema.projectMemberships.roles, 'agent'),
      eq(schema.projectMemberships.active, true)
    ));
  return membership !== undefined;
};

const persistRuntimeRegistration = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'runtime_registration'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  const replacement = mutation.replacementTarget;
  if (!await runtimeRegistrationSubjectIsScoped(tx, workspaceId, aggregate)) {
    return {status: 'not_found'};
  }
  if (
    replacement !== undefined &&
    !await runtimeRegistrationSubjectIsScoped(tx, workspaceId, replacement.aggregate)
  ) return {status: 'not_found'};
  if (mutation.expectedPersistedVersion === null) {
    const [row] = await tx.insert(schema.runtimeRegistrations).values({
      id: aggregate.id,
      projectId: aggregate.projectId,
      actorId: aggregate.actorId,
      agentProfileId: aggregate.agentProfileId,
      provider: aggregate.provider,
      runtimeKey: aggregate.runtimeKey,
      enabled: aggregate.enabled,
      version: 1
    }).onConflictDoNothing().returning({version: schema.runtimeRegistrations.version});
    return row === undefined
      ? conflictOrNotFound(tx, workspaceId, mutation)
      : {
          status: 'persisted',
          cas: {expectedPersistedVersion: null, persistedVersion: row.version},
          projectId: aggregate.projectId
        };
  }
  if (replacement !== undefined) {
    const rows = await tx.select({
      id: schema.runtimeRegistrations.id,
      projectId: schema.runtimeRegistrations.projectId,
      actorId: schema.runtimeRegistrations.actorId,
      agentProfileId: schema.runtimeRegistrations.agentProfileId,
      enabled: schema.runtimeRegistrations.enabled,
      version: schema.runtimeRegistrations.version
    }).from(schema.runtimeRegistrations).where(and(
      inArray(schema.runtimeRegistrations.id, [
        aggregate.id,
        replacement.aggregate.id
      ]),
      eq(schema.runtimeRegistrations.projectId, aggregate.projectId)
    )).orderBy(schema.runtimeRegistrations.id).for('update');
    if (rows.length !== 2) return {status: 'not_found'};
    const source = rows.find((row) => row.id === aggregate.id);
    const target = rows.find((row) => row.id === replacement.aggregate.id);
    if (
      source === undefined ||
      target === undefined ||
      source.actorId !== aggregate.actorId ||
      source.agentProfileId !== aggregate.agentProfileId ||
      target.actorId !== replacement.aggregate.actorId ||
      target.agentProfileId !== replacement.aggregate.agentProfileId ||
      source.version !== mutation.expectedPersistedVersion ||
      target.version !== replacement.expectedPersistedVersion ||
      !source.enabled ||
      target.enabled
    ) {
      return {
        status: 'version_conflict',
        expectedPersistedVersion: mutation.expectedPersistedVersion,
        persistedVersion: source?.version ?? null
      };
    }
    const switchedAt = new Date();
    const [sourceRow] = await tx.update(schema.runtimeRegistrations).set({
      enabled: false,
      version: sql`${schema.runtimeRegistrations.version} + 1`,
      updatedAt: switchedAt
    }).where(and(
      eq(schema.runtimeRegistrations.id, aggregate.id),
      eq(schema.runtimeRegistrations.version, mutation.expectedPersistedVersion)
    )).returning({version: schema.runtimeRegistrations.version});
    const [targetRow] = await tx.update(schema.runtimeRegistrations).set({
      enabled: true,
      version: sql`${schema.runtimeRegistrations.version} + 1`,
      updatedAt: switchedAt
    }).where(and(
      eq(schema.runtimeRegistrations.id, replacement.aggregate.id),
      eq(
        schema.runtimeRegistrations.version,
        replacement.expectedPersistedVersion
      )
    )).returning({version: schema.runtimeRegistrations.version});
    invariant(
      sourceRow?.version === aggregate.version &&
        targetRow?.version === replacement.aggregate.version,
      'Locked runtime replacement CAS did not update both registrations.'
    );
    return {
      status: 'persisted',
      cas: {
        expectedPersistedVersion: mutation.expectedPersistedVersion,
        persistedVersion: sourceRow.version
      },
      projectId: aggregate.projectId
    };
  }
  const [row] = await tx.update(schema.runtimeRegistrations).set({
    provider: aggregate.provider,
    runtimeKey: aggregate.runtimeKey,
    enabled: aggregate.enabled,
    version: sql`${schema.runtimeRegistrations.version} + 1`,
    updatedAt: new Date()
  }).where(and(
    eq(schema.runtimeRegistrations.id, aggregate.id),
    eq(schema.runtimeRegistrations.projectId, aggregate.projectId),
    eq(schema.runtimeRegistrations.actorId, aggregate.actorId),
    eq(schema.runtimeRegistrations.agentProfileId, aggregate.agentProfileId),
    eq(schema.runtimeRegistrations.version, mutation.expectedPersistedVersion)
  )).returning({version: schema.runtimeRegistrations.version});
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

const persistRuntimeAvailabilityObservation = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'runtime_availability_observation'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  const ttlColumn = aggregate.component === 'service'
    ? schema.runtimeRegistrations.serviceMaxAgeSeconds
    : aggregate.component === 'scheduler'
      ? schema.runtimeRegistrations.schedulerMaxAgeSeconds
      : schema.runtimeRegistrations.deliveryMaxAgeSeconds;
  const [registration] = await tx.select({
    projectId: schema.runtimeRegistrations.projectId,
    ttlSeconds: ttlColumn
  }).from(schema.runtimeRegistrations)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.runtimeRegistrations.projectId))
    .where(and(
      eq(schema.runtimeRegistrations.id, aggregate.runtimeRegistrationId),
      eq(schema.runtimeRegistrations.enabled, true),
      eq(schema.projects.workspaceId, workspaceId)
    ));
  if (registration === undefined || registration.ttlSeconds !== aggregate.ttlSeconds) {
    return {status: 'not_found'};
  }
  const [row] = await tx.insert(schema.runtimeAvailabilityObservations).values({
    id: aggregate.id,
    runtimeRegistrationId: aggregate.runtimeRegistrationId,
    component: aggregate.component,
    state: aggregate.state,
    observedAt: new Date(aggregate.observedAt),
    ttlSeconds: aggregate.ttlSeconds,
    evidenceReference: aggregate.evidenceReference
  }).onConflictDoNothing().returning({id: schema.runtimeAvailabilityObservations.id});
  return row === undefined
    ? conflictOrNotFound(tx, workspaceId, mutation)
    : {
        status: 'persisted',
        cas: {expectedPersistedVersion: null, persistedVersion: 1},
        projectId: registration.projectId
      };
};

const persistRuntimeRecoveryPolicy = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'runtime_recovery_policy'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  const [registration] = await tx.select({projectId: schema.runtimeRegistrations.projectId})
    .from(schema.runtimeRegistrations)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.runtimeRegistrations.projectId))
    .where(and(
      eq(schema.runtimeRegistrations.id, aggregate.runtimeRegistrationId),
      eq(schema.projects.workspaceId, workspaceId)
    ));
  if (registration === undefined) return {status: 'not_found'};
  if (mutation.expectedPersistedVersion === null) {
    const [row] = await tx.insert(schema.runtimeRecoveryPolicies).values({
      runtimeRegistrationId: aggregate.runtimeRegistrationId,
      enabled: aggregate.enabled,
      staleThresholdSeconds: aggregate.staleThresholdSeconds,
      maximumAttempts: aggregate.maximumAttempts,
      version: 1
    }).onConflictDoNothing().returning({version: schema.runtimeRecoveryPolicies.version});
    return row === undefined ? conflictOrNotFound(tx, workspaceId, mutation) : {
      status: 'persisted',
      cas: {expectedPersistedVersion: null, persistedVersion: row.version},
      projectId: registration.projectId
    };
  }
  const [row] = await tx.update(schema.runtimeRecoveryPolicies).set({
    enabled: aggregate.enabled,
    staleThresholdSeconds: aggregate.staleThresholdSeconds,
    maximumAttempts: aggregate.maximumAttempts,
    version: sql`${schema.runtimeRecoveryPolicies.version} + 1`,
    updatedAt: new Date()
  }).where(and(
    eq(schema.runtimeRecoveryPolicies.runtimeRegistrationId, aggregate.runtimeRegistrationId),
    eq(schema.runtimeRecoveryPolicies.version, mutation.expectedPersistedVersion)
  )).returning({version: schema.runtimeRecoveryPolicies.version});
  return row === undefined ? conflictOrNotFound(tx, workspaceId, mutation) : {
    status: 'persisted',
    cas: {
      expectedPersistedVersion: mutation.expectedPersistedVersion,
      persistedVersion: row.version
    },
    projectId: registration.projectId
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

const persistActorRetirement = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'actor'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const [current] = await tx.select({disabledAt: schema.actors.disabledAt})
    .from(schema.actors)
    .where(and(
      eq(schema.actors.id, mutation.aggregateId),
      eq(schema.actors.workspaceId, workspaceId),
      eq(schema.actors.type, 'agent')
    ))
    .for('update');
  if (current === undefined) return {status: 'not_found'};
  if (current.disabledAt !== null) return {
    status: 'version_conflict',
    expectedPersistedVersion: 0,
    persistedVersion: 1
  };
  const disabledAt = date(mutation.aggregate.disabledAt!, 'actor.disabledAt');
  const [updated] = await tx.update(schema.actors)
    .set({disabledAt, updatedAt: disabledAt})
    .where(and(
      eq(schema.actors.id, mutation.aggregateId),
      eq(schema.actors.workspaceId, workspaceId),
      eq(schema.actors.type, 'agent'),
      isNull(schema.actors.disabledAt)
    ))
    .returning({id: schema.actors.id});
  // Retirement is a terminal operator action.  Keep the historical bindings,
  // but make every executable/project-facing projection inactive in the same
  // transaction so the manager UI can never advertise a retired agent as live.
  if (updated !== undefined) {
    await tx.update(schema.agentProfiles).set({
      enabled: false,
      updatedAt: disabledAt
    }).where(and(
      eq(schema.agentProfiles.workspaceId, workspaceId),
      eq(schema.agentProfiles.actorId, mutation.aggregateId),
      eq(schema.agentProfiles.enabled, true)
    ));
    await tx.update(schema.runtimeRegistrations).set({
      enabled: false,
      version: sql`${schema.runtimeRegistrations.version} + 1`,
      updatedAt: disabledAt
    }).where(and(
      eq(schema.runtimeRegistrations.actorId, mutation.aggregateId),
      eq(schema.runtimeRegistrations.enabled, true)
    ));
    await tx.update(schema.projectMemberships).set({
      active: false,
      version: sql`${schema.projectMemberships.version} + 1`,
      updatedAt: disabledAt
    }).where(and(
      eq(schema.projectMemberships.actorId, mutation.aggregateId),
      eq(schema.projectMemberships.active, true)
    ));
  }
  return updated === undefined
    ? conflictOrNotFound(tx, workspaceId, mutation)
    : {
        status: 'persisted',
        cas: {expectedPersistedVersion: 0, persistedVersion: 1},
        projectId: null
      };
};

const persistProjectSetup = async (
  tx: Transaction,
  workspaceId: string,
  mutation: Extract<CanonicalMutation, {aggregateType: 'project_setup'}>
): Promise<PersistedAggregate | PersistenceFailure> => {
  const aggregate = mutation.aggregate;
  if (aggregate.project.workspaceId !== workspaceId) return {status: 'not_found'};
  invariant(aggregate.state === 'pending' && aggregate.lastErrorCode === null,
    'New project setup must start pending without an error.');
  const rawConfiguration: unknown = aggregate.configuration;
  const configurationKeys = [
    'repositoryBinding', 'trackerBinding', 'internalChat', 'clientChat',
    'executionMode', 'agentProfileId'
  ];
  const bindingModes = new Set(['none', 'link_existing', 'create_managed']);
  invariant(typeof rawConfiguration === 'object' && rawConfiguration !== null && !Array.isArray(rawConfiguration) &&
    Object.getPrototypeOf(rawConfiguration) === Object.prototype,
  'Project setup configuration must be a plain object.');
  const configuration = rawConfiguration as Record<string, unknown>;
  invariant(
    Object.keys(configuration).length === configurationKeys.length &&
    configurationKeys.every((key) => Object.hasOwn(configuration, key)),
  'Project setup configuration must have the exact canonical shape.');
  invariant(['repositoryBinding', 'trackerBinding', 'internalChat', 'clientChat']
    .every((key) => bindingModes.has(configuration[key] as string)) &&
    (configuration.executionMode === 'manual' || configuration.executionMode === 'managed_agent') &&
    (configuration.executionMode === 'manual'
      ? configuration.agentProfileId === null
      : typeof configuration.agentProfileId === 'string' && isUuid(configuration.agentProfileId)),
  'Project setup configuration values are not canonical.');
  invariant(aggregate.project.name.trim() === aggregate.project.name &&
    aggregate.project.name.length > 0 && aggregate.project.name.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(aggregate.project.name) &&
    /^[a-z][a-z0-9-]{1,47}$/.test(aggregate.project.slug) &&
    !['all', 'api', 'dashboard', 'new', 'projects', 'settings'].includes(aggregate.project.slug),
  'Project setup identity is not canonical.');
  invariant(aggregate.memberships.length >= 1 && aggregate.memberships.length <= 21,
    'Project setup membership count is out of bounds.');
  const membershipIds = new Set(aggregate.memberships.map(({id}) => id));
  const actorIds = new Set(aggregate.memberships.map(({actorId}) => actorId));
  invariant(membershipIds.size === aggregate.memberships.length && actorIds.size === aggregate.memberships.length &&
    aggregate.memberships.every(({id, actorId}) => isUuid(id) && isUuid(actorId)),
  'Project setup membership identities must be unique UUIDs.');
  const ownerMemberships = aggregate.memberships.filter(({actorId, roles}) =>
    actorId === aggregate.productOwnerActorId && roles.includes('project_owner'));
  invariant(ownerMemberships.length === 1 && aggregate.memberships.filter(({roles}) => roles.includes('project_owner')).length === 1 &&
    aggregate.memberships.every(({roles}) => roles.every((role) =>
      ['project_owner', 'contributor', 'reviewer', 'client_viewer', 'agent'].includes(role))),
  'Project setup must contain exactly one Product Owner membership and canonical roles.');
  const actorRows = await tx.select({id: schema.actors.id, type: schema.actors.type})
    .from(schema.actors).where(and(eq(schema.actors.workspaceId, workspaceId),
      inArray(schema.actors.id, [...actorIds]), isNull(schema.actors.disabledAt)));
  const actorTypes = new Map(actorRows.map((actor) => [actor.id, actor.type]));
  invariant(actorRows.length === aggregate.memberships.length && aggregate.memberships.every((membership) =>
    membership.roles.length === 1 && membership.roles[0] === 'agent'
      ? actorTypes.get(membership.actorId) === 'agent'
      : actorTypes.get(membership.actorId) === 'human'),
  'Project setup actors must be active, workspace-scoped, and role-compatible.');
  if (configuration.executionMode === 'managed_agent') {
    const [profile] = await tx.select({actorId: schema.agentProfiles.actorId})
      .from(schema.agentProfiles).innerJoin(schema.actors, eq(schema.actors.id, schema.agentProfiles.actorId))
      .where(and(eq(schema.agentProfiles.id, configuration.agentProfileId as string),
        eq(schema.agentProfiles.workspaceId, workspaceId), eq(schema.agentProfiles.enabled, true),
        eq(schema.actors.type, 'agent'), isNull(schema.actors.disabledAt)));
    invariant(profile !== undefined && aggregate.memberships.some(({actorId, roles}) =>
      actorId === profile.actorId && roles.length === 1 && roles[0] === 'agent'),
    'Managed execution profile must belong to an active agent member.');
  }
  const [project] = await tx.insert(schema.projects).values({
    id: aggregate.project.id,
    workspaceId,
    name: aggregate.project.name,
    slug: aggregate.project.slug,
    version: 1
  }).returning({id: schema.projects.id});
  invariant(project !== undefined, 'Project setup project insert failed.');
  await tx.insert(schema.projectMemberships).values(aggregate.memberships.map((membership) => ({
    id: membership.id,
    projectId: membership.projectId,
    actorId: membership.actorId,
    roles: [...membership.roles],
    active: true,
    version: 1
  })));
  const [setup] = await tx.insert(schema.projectSetups).values({
    id: aggregate.id,
    projectId: aggregate.project.id,
    state: aggregate.state,
    configuration: aggregate.configuration,
    lastErrorCode: aggregate.lastErrorCode,
    version: 1
  }).returning({version: schema.projectSetups.version});
  invariant(setup !== undefined, 'Project setup aggregate insert failed.');
  return {
    status: 'persisted',
    cas: {expectedPersistedVersion: null, persistedVersion: setup.version},
    projectId: aggregate.project.id
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
    case 'agent_profile':
      return persistAgentProfile(tx, workspaceId, mutation);
    case 'task_packet':
      return persistTaskPacket(tx, workspaceId, mutation);
    case 'agent_run':
      return persistAgentRun(tx, workspaceId, mutation);
    case 'approval':
      return persistApproval(tx, workspaceId, mutation);
    case 'access_request':
      return persistAccessRequest(tx, workspaceId, mutation);
    case 'project_membership':
      return persistProjectMembership(tx, workspaceId, mutation);
    case 'project_setup':
      return persistProjectSetup(tx, workspaceId, mutation);
    case 'actor_onboarding':
      return persistActorOnboarding(tx, workspaceId, mutation);
    case 'actor_external_identity':
      return persistActorExternalIdentity(tx, workspaceId, mutation);
    case 'actor':
      return persistActorRetirement(tx, workspaceId, mutation);
    case 'resource_access_grant':
      return persistResourceAccessGrant(tx, workspaceId, mutation);
    case 'runtime_registration':
      return persistRuntimeRegistration(tx, workspaceId, mutation);
    case 'runtime_availability_observation':
      return persistRuntimeAvailabilityObservation(tx, workspaceId, mutation);
    case 'runtime_recovery_policy':
      return persistRuntimeRecoveryPolicy(tx, workspaceId, mutation);
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

        async loadAgentProfile(
          token,
          agentProfileId
        ): Promise<AgentProfileConfiguration | null> {
          const state = requireClaim(token);
          if (!isUuid(agentProfileId)) return null;
          const [row] = await tx
            .select({
              id: schema.agentProfiles.id,
              workspaceId: schema.agentProfiles.workspaceId,
              actorId: schema.agentProfiles.actorId,
              runtimeId: schema.agentProfiles.runtimeId,
              runtimeProfile: schema.agentProfiles.runtimeProfile,
              allowedTools: schema.agentProfiles.allowedTools,
              forbiddenSurfaces: schema.agentProfiles.forbiddenSurfaces,
              instructions: schema.agentProfiles.instructions,
              settings: schema.agentProfiles.settings,
              enabled: schema.agentProfiles.enabled,
              version: schema.agentProfiles.version,
              configHash: schema.agentProfiles.configHash
            })
            .from(schema.agentProfiles)
            .where(and(
              eq(schema.agentProfiles.id, agentProfileId),
              eq(schema.agentProfiles.workspaceId, state.claim.workspaceId)
            ));
          return row === undefined ? null : {
            ...row,
            settings: row.settings as AgentProfileConfiguration['settings']
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
              contentHash: schema.taskPackets.contentHash,
              runtimeProfile: schema.taskPackets.runtimeProfile,
              agentProfileSnapshotId: schema.taskPackets.agentProfileSnapshotId,
              agentProfileSnapshotRuntimeId: schema.taskPackets.agentProfileSnapshotRuntimeId,
              agentProfileSnapshotAllowedTools: schema.taskPackets.agentProfileSnapshotAllowedTools,
              agentProfileSnapshotForbiddenSurfaces: schema.taskPackets.agentProfileSnapshotForbiddenSurfaces,
              agentProfileSnapshotEnabled: schema.taskPackets.agentProfileSnapshotEnabled,
              agentProfileSnapshotVersion: schema.taskPackets.agentProfileSnapshotVersion,
              agentProfileSnapshotHash: schema.taskPackets.agentProfileSnapshotHash,
              agentProfileSnapshotInstructions: schema.taskPackets.agentProfileSnapshotInstructions,
              agentProfileSnapshotSettings: schema.taskPackets.agentProfileSnapshotSettings
            })
            .from(schema.taskPackets)
            .where(and(
              eq(schema.taskPackets.id, taskPacketId),
              taskPacketScope(state.claim.workspaceId)
            ));
          if (row === undefined) return null;
          const hasSnapshot = row.agentProfileSnapshotId !== null;
          return {
            packetId: row.packetId,
            content: {
              approverActorId: row.approverActorId,
              agentProfileSnapshot: hasSnapshot ? {
                profileId: row.agentProfileSnapshotId!,
                runtimeId: row.agentProfileSnapshotRuntimeId!,
                runtimeProfile: row.runtimeProfile,
                allowedTools: row.agentProfileSnapshotAllowedTools!,
                forbiddenSurfaces: row.agentProfileSnapshotForbiddenSurfaces!,
                enabled: row.agentProfileSnapshotEnabled!,
                configVersion: row.agentProfileSnapshotVersion!,
                configHash: row.agentProfileSnapshotHash!,
                instructions: row.agentProfileSnapshotInstructions!,
                settings: row.agentProfileSnapshotSettings as AgentProfileConfiguration['settings']
              } : null
            },
            contentHash: row.contentHash,
            runtimeAvailable: isRuntimeAvailable(row.agentProfileSnapshotRuntimeId)
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
              retryOfAgentRunId: schema.agentRuns.retryOfAgentRunId,
              confirmedPacketHash: schema.agentRuns.confirmedPacketHash,
              baseCommit: schema.agentRuns.baseCommit,
              status: schema.agentRuns.status,
              failureCode: schema.agentRuns.failureCode,
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
              retryOfAgentRunId: row.retryOfAgentRunId,
              confirmedPacketHash: row.confirmedPacketHash,
              baseCommit: row.baseCommit,
              status: row.status as AgentRun['status'],
              failureCode: row.failureCode,
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

        async loadProjectMembership(token, membershipId): Promise<ProjectMembership | null> {
          const state = requireClaim(token);
          if (!isUuid(membershipId)) return null;
          const [row] = await tx.select({
            id: schema.projectMemberships.id,
            projectId: schema.projectMemberships.projectId,
            actorId: schema.projectMemberships.actorId,
            roles: schema.projectMemberships.roles,
            active: schema.projectMemberships.active,
            version: schema.projectMemberships.version
          }).from(schema.projectMemberships).innerJoin(
            schema.projects,
            eq(schema.projects.id, schema.projectMemberships.projectId)
          ).where(and(
            eq(schema.projectMemberships.id, membershipId),
            eq(schema.projects.workspaceId, state.claim.workspaceId)
          ));
          return row ?? null;
        },

        async loadActorOnboardingConflict(token, projectId, actorType, displayName) {
          const state = requireClaim(token);
          if (!isUuid(projectId) || !['human', 'agent'].includes(actorType) ||
            displayName.length < 1 || displayName.length > 120) return 'project_not_found';
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(
            ${state.claim.workspaceId} || ':' || ${actorType} || ':' || lower(${displayName})
          ))`);
          if (!await workspaceHasProject(tx, state.claim.workspaceId, projectId)) {
            return 'project_not_found';
          }
          const [duplicate] = await tx.select({id: schema.actors.id}).from(schema.actors).where(and(
            eq(schema.actors.workspaceId, state.claim.workspaceId),
            eq(schema.actors.type, actorType),
            sql`lower(${schema.actors.displayName}) = lower(${displayName})`
          )).limit(1);
          return duplicate === undefined ? null : 'duplicate';
        },

        async loadActorExternalIdentity(
          token,
          identityId
        ): Promise<ActorExternalIdentity | null> {
          const state = requireClaim(token);
          if (!isUuid(identityId)) return null;
          const [row] = await tx.select({
            id: schema.actorExternalIdentities.id,
            actorId: schema.actorExternalIdentities.actorId,
            provider: schema.actorExternalIdentities.provider,
            externalSubject: schema.actorExternalIdentities.externalSubject,
            active: schema.actorExternalIdentities.active,
            version: schema.actorExternalIdentities.version
          }).from(schema.actorExternalIdentities).innerJoin(
            schema.actors,
            eq(schema.actors.id, schema.actorExternalIdentities.actorId)
          ).where(and(
            eq(schema.actorExternalIdentities.id, identityId),
            eq(schema.actors.workspaceId, state.claim.workspaceId)
          ));
          return row ?? null;
        },

        async loadResourceAccessGrant(
          token,
          grantId
        ): Promise<ResourceAccessGrant | null> {
          const state = requireClaim(token);
          if (!isUuid(grantId)) return null;
          const [row] = await tx.select({
            id: schema.resourceAccessGrants.id,
            projectId: schema.resourceAccessGrants.projectId,
            actorId: schema.resourceAccessGrants.actorId,
            resourceType: schema.resourceAccessGrants.resourceType,
            resourceId: schema.resourceAccessGrants.resourceId,
            desiredLevel: schema.resourceAccessGrants.desiredLevel,
            observedProvider: schema.resourceAccessGrants.observedProvider,
            observedExternalResourceRef:
              schema.resourceAccessGrants.observedExternalResourceRef,
            observedLevel: schema.resourceAccessGrants.observedLevel,
            observedAt: schema.resourceAccessGrants.observedAt,
            version: schema.resourceAccessGrants.version
          }).from(schema.resourceAccessGrants).innerJoin(
            schema.projects,
            eq(schema.projects.id, schema.resourceAccessGrants.projectId)
          ).where(and(
            eq(schema.resourceAccessGrants.id, grantId),
            eq(schema.projects.workspaceId, state.claim.workspaceId)
          ));
          if (row === undefined) return null;
          return {
            id: row.id,
            projectId: row.projectId,
            actorId: row.actorId,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            desiredLevel: row.desiredLevel,
            providerObservation: row.observedProvider === null
              ? null
              : {
                  provider: row.observedProvider,
                  externalResourceRef: row.observedExternalResourceRef!,
                  confirmedLevel: row.observedLevel!,
                  observedAt: row.observedAt!.toISOString()
                },
            version: row.version
          };
        },

        async loadRuntimeRegistration(
          token,
          registrationId
        ): Promise<RuntimeRegistration | null> {
          const state = requireClaim(token);
          if (!isUuid(registrationId)) return null;
          const [row] = await tx.select({
            id: schema.runtimeRegistrations.id,
            projectId: schema.runtimeRegistrations.projectId,
            actorId: schema.runtimeRegistrations.actorId,
            agentProfileId: schema.runtimeRegistrations.agentProfileId,
            provider: schema.runtimeRegistrations.provider,
            runtimeKey: schema.runtimeRegistrations.runtimeKey,
            enabled: schema.runtimeRegistrations.enabled,
            version: schema.runtimeRegistrations.version
          }).from(schema.runtimeRegistrations)
            .innerJoin(
              schema.projects,
              eq(schema.projects.id, schema.runtimeRegistrations.projectId)
            )
            .innerJoin(
              schema.actors,
              eq(schema.actors.id, schema.runtimeRegistrations.actorId)
            )
            .innerJoin(
              schema.agentProfiles,
              eq(schema.agentProfiles.id, schema.runtimeRegistrations.agentProfileId)
            )
            .where(and(
              eq(schema.runtimeRegistrations.id, registrationId),
              eq(schema.projects.workspaceId, state.claim.workspaceId),
              eq(schema.actors.workspaceId, state.claim.workspaceId),
              eq(schema.agentProfiles.workspaceId, state.claim.workspaceId),
              eq(schema.agentProfiles.actorId, schema.runtimeRegistrations.actorId)
            ));
          return row ?? null;
        },

        async loadRuntimeRecoveryPolicy(token, registrationId) {
          const state = requireClaim(token);
          if (!isUuid(registrationId)) return null;
          const [row] = await tx.select({
            runtimeRegistrationId: schema.runtimeRecoveryPolicies.runtimeRegistrationId,
            enabled: schema.runtimeRecoveryPolicies.enabled,
            staleThresholdSeconds: schema.runtimeRecoveryPolicies.staleThresholdSeconds,
            maximumAttempts: schema.runtimeRecoveryPolicies.maximumAttempts,
            version: schema.runtimeRecoveryPolicies.version
          }).from(schema.runtimeRecoveryPolicies)
            .innerJoin(
              schema.runtimeRegistrations,
              eq(schema.runtimeRegistrations.id, schema.runtimeRecoveryPolicies.runtimeRegistrationId)
            )
            .innerJoin(schema.projects, eq(schema.projects.id, schema.runtimeRegistrations.projectId))
            .where(and(
              eq(schema.runtimeRecoveryPolicies.runtimeRegistrationId, registrationId),
              eq(schema.projects.workspaceId, state.claim.workspaceId)
            ));
          return row ?? null;
        },

        async loadRetirableAgent(token, agentId) {
          const state = requireClaim(token);
          if (!isUuid(agentId)) return null;
          const [row] = await tx.select({
            id: schema.actors.id,
            workspaceId: schema.actors.workspaceId,
            disabledAt: schema.actors.disabledAt
          }).from(schema.actors).where(and(
            eq(schema.actors.id, agentId),
            eq(schema.actors.workspaceId, state.claim.workspaceId),
            eq(schema.actors.type, 'agent')
          ));
          return row === undefined ? null : {
            ...row,
            disabledAt: row.disabledAt?.toISOString() ?? null
          };
        },

        async loadAccessCommandAuthority(token, actorId, projectId) {
          const state = requireClaim(token);
          if (!isUuid(actorId) || (projectId !== undefined && !isUuid(projectId))) {
            return null;
          }
          const [actor] = await tx.select({role: schema.actors.role})
            .from(schema.actors)
            .where(and(
              eq(schema.actors.id, actorId),
              eq(schema.actors.workspaceId, state.claim.workspaceId),
              isNull(schema.actors.disabledAt)
            ));
          if (actor === undefined) return null;
          if (projectId === undefined) {
            const [ownership] = await tx.select({roles: schema.projectMemberships.roles})
              .from(schema.projectMemberships)
              .innerJoin(schema.projects, eq(schema.projects.id, schema.projectMemberships.projectId))
              .where(and(
                eq(schema.projects.workspaceId, state.claim.workspaceId),
                eq(schema.projectMemberships.actorId, actorId),
                eq(schema.projectMemberships.active, true),
                projectMembershipHasRoleSql(schema.projectMemberships.roles, 'workspace_owner')
              ))
              .limit(1);
            return {
              workspaceAdmin: actor.role === 'workspace_admin',
              projectRoles: ownership?.roles ?? null
            };
          }
          if (!await workspaceHasProject(tx, state.claim.workspaceId, projectId)) {
            return null;
          }
          const [membership] = await tx.select({roles: schema.projectMemberships.roles})
            .from(schema.projectMemberships)
            .where(and(
              eq(schema.projectMemberships.projectId, projectId),
              eq(schema.projectMemberships.actorId, actorId),
              eq(schema.projectMemberships.active, true)
            ));
          return {
            workspaceAdmin: actor.role === 'workspace_admin',
            projectRoles: membership?.roles ?? null
          };
        },

        async loadProjectSetupContext(token, input) {
          const state = requireClaim(token);
          const ids = [input.productOwnerActorId, ...input.members.map(({actorId}) => actorId)];
          if (!isUuid(input.actorId) || !ids.every(isUuid) ||
            (input.agentProfileId !== null && !isUuid(input.agentProfileId))) return null;
          const [workspace] = await tx.select({id: schema.workspaces.id}).from(schema.workspaces)
            .where(eq(schema.workspaces.id, state.claim.workspaceId)).for('update');
          if (workspace === undefined) return null;
          const [operator, existing, candidates] = await Promise.all([
            tx.select({role: schema.actors.role}).from(schema.actors).where(and(
              eq(schema.actors.id, input.actorId), eq(schema.actors.workspaceId, state.claim.workspaceId),
              eq(schema.actors.type, 'human'), eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt)
            )).limit(1),
            tx.select({id: schema.projects.id}).from(schema.projects).where(and(
              eq(schema.projects.workspaceId, state.claim.workspaceId), eq(schema.projects.slug, input.slug)
            )).limit(1),
            tx.select({id: schema.actors.id, type: schema.actors.type}).from(schema.actors).where(and(
              eq(schema.actors.workspaceId, state.claim.workspaceId), inArray(schema.actors.id, ids),
              isNull(schema.actors.disabledAt)
            ))
          ]);
          if (operator[0] === undefined) return null;
          const actorType = new Map(candidates.map((candidate) => [candidate.id, candidate.type]));
          const validProductOwner = actorType.get(input.productOwnerActorId) === 'human';
          const validMembers = candidates.length === ids.length && input.members.every((member) =>
            member.roles.length === 1 && member.roles[0] === 'agent'
              ? actorType.get(member.actorId) === 'agent'
              : !member.roles.includes('agent') && actorType.get(member.actorId) === 'human');
          let validAgentProfile = input.agentProfileId === null;
          if (input.agentProfileId !== null) {
            const [profile] = await tx.select({actorId: schema.agentProfiles.actorId})
              .from(schema.agentProfiles).innerJoin(schema.actors, eq(schema.actors.id, schema.agentProfiles.actorId))
              .where(and(eq(schema.agentProfiles.id, input.agentProfileId),
                eq(schema.agentProfiles.workspaceId, state.claim.workspaceId), eq(schema.agentProfiles.enabled, true),
                eq(schema.actors.type, 'agent'), isNull(schema.actors.disabledAt)));
            validAgentProfile = profile !== undefined && input.members.some((member) =>
              member.actorId === profile.actorId && member.roles.length === 1 && member.roles[0] === 'agent');
          }
          return {
            workspaceAdmin: operator[0].role === 'workspace_admin',
            slugExists: existing[0] !== undefined,
            validProductOwner,
            validMembers,
            validAgentProfile
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
