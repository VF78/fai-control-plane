import {createHash, randomUUID} from 'node:crypto';
import {
  nextEnabledDeliveryStage,
  transitionWorkItem,
  validateDeliveryEvidenceReferences,
  validateDeliveryProtocolDefinition,
  type CommandError,
  type DeliveryEvidenceReference,
  type DeliveryProtocol,
  type DeliveryProtocolStage
} from '@fai-control-plane/domain';
import {and, eq, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import {resolveCurrentExecutionResponsibility, resolveProtocolResponsibility} from './work-item-responsibility';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

type CompletionPayload = Readonly<{
  runId: string;
  attempt: number;
  terminal: 'done' | 'failed';
  finalStatus: string;
  receiptSha256: string;
  receiptSizeBytes: number;
  artifactStore: Readonly<{provider: string; reference: string}>;
  receiptArtifact: Readonly<{reference: string; sha256: string; sizeBytes: number}>;
  pathManifest: Readonly<{reference: string; sha256: string; sizeBytes: number}>;
  summaryArtifact?: Readonly<{reference: string; sha256: string; sizeBytes: number}>;
  changedFiles: readonly string[];
  checks: readonly Readonly<{name: string; status: 'passed' | 'failed' | 'not_run'}>[];
  riskCount: number;
}>;
type RetainedArtifact = Readonly<{
  kind: 'receipt' | 'summary' | 'path_manifest';
  storageProvider: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  redacted: boolean;
}>;
type Command = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  actor: Readonly<{actorId: string}>;
  type: 'agent_run.accept_result.v1';
  payload: Readonly<{runId: string; receiptSha256: string; expectedWorkItemVersion: number}>;
}>;
type AcceptanceValue = Readonly<{
  projectId: string;
  workItemId: string;
  workItemStatus: string;
  workItemVersion: number;
  journeyStageKey: string;
  journeyVersion: number;
  executionStatus: 'paused';
  executionVersion: number;
  evidenceReferences: readonly DeliveryEvidenceReference[];
}>;

const errorResult = (code: CommandError['code'], message: string) => ({
  ok: false as const,
  error: {code, message}
});
const attemptReceiptKey = (command: Command, requestHash: string): string =>
  `agent-run-accept-attempt:v1:${createHash('sha256')
    .update(`${command.actor.actorId}:${requestHash}:${command.commandId}`)
    .digest('hex')}`;

const responsibilityResolved = async (
  tx: Transaction,
  workspaceId: string,
  projectId: string,
  stage: DeliveryProtocolStage
): Promise<boolean> => {
  return await resolveProtocolResponsibility(tx, {workspaceId, projectId,
    responsibility: stage.responsibility}) !== null;
};

export type PostgresAgentRunAcceptanceOptions = Readonly<{
  parseCompletion(value: unknown): CompletionPayload | null;
  evidenceFor(
    stage: DeliveryProtocolStage,
    payload: CompletionPayload,
    retained: readonly RetainedArtifact[]
  ): Readonly<{ok: true; value: readonly DeliveryEvidenceReference[]}> |
    Readonly<{ok: false; error: CommandError}>;
  now?: () => Date;
}>;

export const createPostgresAgentRunAcceptanceStore = (
  db: Database,
  options: PostgresAgentRunAcceptanceOptions
) => ({
  async execute(input: Readonly<{
    command: Command;
    requestHash: string;
    authorized: boolean;
    policyError?: CommandError;
  }>) {
    const {command} = input;
    return db.transaction(async (tx) => {
      const [auditActor] = await tx.select({id: schema.actors.id}).from(schema.actors).where(and(
        eq(schema.actors.id, command.actor.actorId),
        eq(schema.actors.workspaceId, command.workspaceId)
      )).limit(1);
      const optionsNow = () => options.now?.() ?? new Date();
      const audit = async (result: Readonly<{ok: boolean; error?: CommandError}>, options: Readonly<{
        projectId?: string;
        policyDecision: 'allow' | 'deny';
        outcome: 'succeeded' | 'failed' | 'rejected';
        resultVersion?: number;
      }>) => {
        const now = optionsNow();
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(),
          workspaceId: command.workspaceId,
          projectId: options.projectId,
          actorId: auditActor?.id,
          commandId: command.commandId,
          actionCategory: 'write',
          action: command.type,
          targetType: 'agent_run',
          targetId: command.payload.runId,
          policyDecision: options.policyDecision,
          outcome: options.outcome,
          ...(!result.ok && result.error !== undefined ? {reasonCode: result.error.code} : {}),
          expectedVersion: command.payload.expectedWorkItemVersion,
          resultVersion: options.resultVersion,
          correlationId: command.correlationId,
          occurredAt: now,
          metadata: {}
        }).onConflictDoNothing({
          target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]
        });
        return now;
      };
      const completeAttempt = async (
        result: Readonly<{ok: true; value: AcceptanceValue}> |
          Readonly<{ok: false; error: CommandError}>,
        completion: Readonly<{
          projectId?: string;
          policyDecision: 'allow' | 'deny';
          outcome: 'succeeded' | 'failed' | 'rejected';
          resultVersion?: number;
        }>
      ) => {
        const now = optionsNow();
        const idempotencyKey = attemptReceiptKey(command, input.requestHash);
        const [inserted] = await tx.insert(schema.commandReceipts).values({
          workspaceId: command.workspaceId,
          idempotencyKey,
          requestHash: input.requestHash,
          commandId: command.commandId,
          correlationId: command.correlationId,
          state: 'completed',
          commandType: command.type,
          aggregateType: 'agent_run',
          aggregateId: command.payload.runId,
          expectedVersion: command.payload.expectedWorkItemVersion,
          resultVersion: completion.resultVersion,
          result,
          completedAt: now
        }).onConflictDoNothing({
          target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
        }).returning();
        const [stored] = inserted === undefined
          ? await tx.select().from(schema.commandReceipts).where(and(
              eq(schema.commandReceipts.workspaceId, command.workspaceId),
              eq(schema.commandReceipts.idempotencyKey, idempotencyKey)
            )).limit(1).for('update')
          : [inserted];
        if (stored === undefined || stored.state !== 'completed' || stored.result === null ||
          stored.requestHash !== input.requestHash) {
          throw new Error('agent_run_acceptance_attempt_receipt_incomplete');
        }
        await audit(result, completion);
        return {status: inserted === undefined ? 'replayed' as const : 'completed' as const, receipt: {
          commandId: stored.commandId,
          workspaceId: command.workspaceId,
          correlationId: stored.correlationId,
          idempotencyKey,
          requestHash: stored.requestHash,
          commandType: command.type,
          result: stored.result as never,
          createdAt: stored.createdAt.toISOString()
        }};
      };
      const fail = (
        code: CommandError['code'],
        message: string,
        projectId?: string,
        policyDecision: 'allow' | 'deny' = 'allow'
      ) => completeAttempt(errorResult(code, message), {
        ...(projectId === undefined ? {} : {projectId}),
        policyDecision,
        outcome: policyDecision === 'deny' ? 'rejected' : 'failed'
      });
      if (!input.authorized) {
        return completeAttempt(errorResult(
          input.policyError?.code ?? 'POLICY_DENIED',
          input.policyError?.message ?? 'Policy denies AgentRun acceptance.'
        ), {policyDecision: 'deny', outcome: 'rejected'});
      }
      // Keep the same aggregate lock prefix as delivery_journey.advance: WorkItem -> journey.
      const [binding] = await tx.select({
        projectId: schema.workItems.projectId,
        workItemId: schema.workItems.id,
        workItemStatus: schema.workItems.status,
        workItemBlocked: schema.workItems.blocked,
        workItemVersion: schema.workItems.version,
        workItemPlanVersionId: schema.workItems.sourcePlanVersionId,
        workItemDeletedAt: schema.workItems.deletedAt,
        packetId: schema.taskPackets.id,
        packetProjectId: schema.taskPackets.projectId,
        packetWorkItemId: schema.taskPackets.workItemId,
        packetWorkItemVersion: schema.taskPackets.workItemVersion,
        packetContentHash: schema.taskPackets.contentHash,
        packetAgentProfileId: schema.taskPackets.agentProfileSnapshotId,
        approverActorId: schema.taskPackets.approverActorId
      }).from(schema.workItems)
        .innerJoin(schema.taskPackets, eq(schema.taskPackets.workItemId, schema.workItems.id))
        .innerJoin(schema.agentRuns, and(
          eq(schema.agentRuns.id, command.payload.runId),
          eq(schema.agentRuns.taskPacketId, schema.taskPackets.id),
          eq(schema.agentRuns.workItemId, schema.workItems.id)
        ))
        .innerJoin(schema.projects, and(
          eq(schema.projects.id, schema.workItems.projectId),
          eq(schema.projects.workspaceId, command.workspaceId)
        ))
        .limit(1)
        .for('update', {of: schema.workItems});
      if (binding === undefined || binding.workItemDeletedAt !== null) {
        return fail('NOT_FOUND', 'The exact workspace/run/work item binding was not found.');
      }
      const [qaPacket] = await tx.select({taskPacketId: schema.qaTaskPackets.taskPacketId})
        .from(schema.qaTaskPackets).where(eq(schema.qaTaskPackets.taskPacketId, binding.packetId))
        .limit(1).for('update');
      if (qaPacket !== undefined) {
        return fail('INVALID_TRANSITION',
          'Governed QA receipts may be accepted only through qa_review.record.v1.', binding.projectId);
      }

      const [journey] = await tx.select().from(schema.deliveryJourneys)
        .where(eq(schema.deliveryJourneys.workItemId, binding.workItemId)).limit(1).for('update');
      const [execution] = await tx.select().from(schema.projectExecutions)
        .where(eq(schema.projectExecutions.projectId, binding.projectId)).limit(1).for('update');
      const [run] = await tx.select().from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, command.payload.runId)).limit(1).for('update');
      const [receipt] = await tx.select().from(schema.agentRunReceipts)
        .where(eq(schema.agentRunReceipts.agentRunId, command.payload.runId)).limit(1).for('update');
      const [operator] = await tx.select({id: schema.actors.id, role: schema.actors.role})
        .from(schema.actors).where(and(
          eq(schema.actors.id, command.actor.actorId),
          eq(schema.actors.workspaceId, command.workspaceId),
          eq(schema.actors.type, 'human'),
          eq(schema.actors.authMode, 'user'),
          isNull(schema.actors.disabledAt)
        )).limit(1);
      const [membership] = await tx.select({roles: schema.projectMemberships.roles})
        .from(schema.projectMemberships).where(and(
          eq(schema.projectMemberships.projectId, binding.projectId),
          eq(schema.projectMemberships.actorId, command.actor.actorId),
          eq(schema.projectMemberships.active, true)
        )).limit(1);
      const isOwner = operator !== undefined && (
        ['workspace_admin', 'delivery_lead'].includes(operator.role) ||
        membership?.roles.includes('workspace_owner') === true || membership?.roles.includes('project_owner') === true
      );
      if (!isOwner || command.actor.actorId !== binding.approverActorId) {
        return completeAttempt(errorResult('CAPABILITY_DENIED',
          'Only the recorded active Product Owner may accept this AgentRun result.'), {
          projectId: binding.projectId, policyDecision: 'deny', outcome: 'rejected'
        });
      }
      if (journey === undefined || execution === undefined || run === undefined || receipt === undefined) {
        return fail('NOT_FOUND', 'The exact execution/journey/run/receipt binding is incomplete.',
          binding.projectId);
      }
      if (binding.packetProjectId !== binding.projectId ||
        binding.packetWorkItemId !== binding.workItemId ||
        binding.packetAgentProfileId !== run.agentProfileId ||
        run.confirmedPacketHash !== binding.packetContentHash ||
        run.status !== 'done' || run.failureCode !== null || run.completedAt === null ||
        run.attempt < 1 || run.attempt > 2 || receipt.runnerId.length === 0 ||
        receipt.attempt !== run.attempt || receipt.terminal !== 'done' ||
        receipt.receiptSha256 !== command.payload.receiptSha256 ||
        receipt.completedAt.getTime() !== run.completedAt.getTime()) {
        return fail('INVALID_COMMAND', 'The exact successful terminal receipt is not acceptable.',
          binding.projectId);
      }
      const payload = options.parseCompletion(receipt.metadata);
      if (payload === null || payload.runId !== run.id || payload.attempt !== run.attempt ||
        payload.terminal !== 'done' || payload.finalStatus !== 'succeeded' ||
        payload.receiptSha256 !== receipt.receiptSha256 ||
        payload.receiptSizeBytes !== receipt.receiptSizeBytes) {
        return fail('INVALID_COMMAND', 'The retained structured receipt is invalid or mismatched.',
          binding.projectId);
      }
      const [existingSuccess] = await tx.select().from(schema.commandReceipts).where(and(
        eq(schema.commandReceipts.workspaceId, command.workspaceId),
        eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
      )).limit(1).for('update');
      if (existingSuccess !== undefined) {
        if (existingSuccess.requestHash !== input.requestHash ||
          existingSuccess.expectedVersion !== command.payload.expectedWorkItemVersion) {
          return fail('IDEMPOTENCY_KEY_REUSED', 'The acceptance key was already used.',
            binding.projectId);
        }
        if (existingSuccess.state !== 'completed' || existingSuccess.result === null) {
          throw new Error('agent_run_acceptance_receipt_incomplete');
        }
        return {status: 'replayed' as const, receipt: {
          commandId: existingSuccess.commandId,
          workspaceId: command.workspaceId,
          correlationId: existingSuccess.correlationId,
          idempotencyKey: command.idempotencyKey,
          requestHash: existingSuccess.requestHash,
          commandType: command.type,
          result: existingSuccess.result as never,
          createdAt: existingSuccess.createdAt.toISOString()
        }};
      }

      const [dispatch] = await tx.select().from(schema.projectExecutionDispatches).where(and(
        eq(schema.projectExecutionDispatches.workspaceId, command.workspaceId),
        eq(schema.projectExecutionDispatches.projectId, binding.projectId),
        eq(schema.projectExecutionDispatches.executionVersion, execution.version),
        eq(schema.projectExecutionDispatches.taskPacketId, binding.packetId),
        eq(schema.projectExecutionDispatches.agentRunId, run.id)
      )).limit(1);
      const [runProfile] = await tx.select({actorId: schema.agentProfiles.actorId})
        .from(schema.agentProfiles).where(eq(schema.agentProfiles.id, run.agentProfileId)).limit(1);
      const currentResponsibility = await resolveCurrentExecutionResponsibility(tx, {
        workspaceId: command.workspaceId, projectId: binding.projectId, workItemId: binding.workItemId});
      if (dispatch === undefined || execution.status !== 'running' ||
        currentResponsibility === null ||
        execution.selectedWorkItemId !== binding.workItemId ||
        execution.selectedPlanVersionId !== currentResponsibility.planVersionId ||
        execution.selectedWorkItemVersion !== currentResponsibility.workItemVersion ||
        execution.selectedProtocolId !== currentResponsibility.protocolId ||
        execution.selectedProtocolVersion !== currentResponsibility.protocolVersion ||
        execution.selectedJourneyVersion !== currentResponsibility.journeyVersion ||
        execution.selectedStageKey !== currentResponsibility.stageKey ||
        runProfile === undefined || execution.selectedResponsibleActorId !== runProfile.actorId ||
        execution.selectedResponsibleActorId !== currentResponsibility.actor.id ||
        execution.selectedAgentProfileId !== run.agentProfileId ||
        currentResponsibility.actor.agentProfileId !== run.agentProfileId ||
        execution.selectedResponsibilityHash !== currentResponsibility.factHash ||
        binding.workItemVersion !== command.payload.expectedWorkItemVersion ||
        binding.packetWorkItemVersion !== binding.workItemVersion ||
        binding.packetAgentProfileId !== run.agentProfileId) {
        return fail('VERSION_CONFLICT',
          'The current dispatch selection no longer matches the exact acceptance facts.',
          binding.projectId);
      }
      const [protocolRow] = await tx.select().from(schema.runbooks).where(and(
        eq(schema.runbooks.id, journey.protocolId),
        eq(schema.runbooks.projectId, binding.projectId),
        eq(schema.runbooks.version, journey.protocolVersion)
      )).limit(1);
      const definition = protocolRow === undefined
        ? null
        : validateDeliveryProtocolDefinition(protocolRow.definition);
      if (protocolRow === undefined || definition === null || !definition.ok ||
        protocolRow.protocolState !== 'published' || !protocolRow.active) {
        return fail('INVALID_COMMAND', 'The bound delivery protocol is not active and published.',
          binding.projectId);
      }
      const protocol: DeliveryProtocol = {
        id: protocolRow.id,
        projectId: protocolRow.projectId,
        name: protocolRow.name,
        version: protocolRow.version,
        revision: protocolRow.revision!,
        state: protocolRow.protocolState,
        active: protocolRow.active,
        definition: definition.value,
        contentHash: protocolRow.contentHash!
      };
      const stage = protocol.definition.stages.find(({key, enabled}) =>
        enabled && key === journey.stageKey);
      const next = stage === undefined ? null : nextEnabledDeliveryStage(protocol, stage.key);
      if (stage === undefined || stage.executionMode !== 'autonomous' ||
        stage.taskStatus !== binding.workItemStatus || next === null ||
        !await responsibilityResolved(tx, command.workspaceId, binding.projectId, next)) {
        return fail('INVALID_TRANSITION', 'The allowed next delivery stage is not ready.',
          binding.projectId);
      }
      const retained = await tx.select({
        kind: schema.artifacts.kind,
        storageProvider: schema.artifacts.storageProvider,
        storageKey: schema.artifacts.storageKey,
        sha256: schema.artifacts.sha256,
        sizeBytes: schema.artifacts.sizeBytes,
        redacted: schema.artifacts.redacted
      }).from(schema.artifacts).where(eq(schema.artifacts.agentRunId, run.id));
      const evidence = options.evidenceFor(stage, payload, retained as readonly RetainedArtifact[]);
      if (!evidence.ok) return fail(evidence.error.code, evidence.error.message, binding.projectId);
      const validatedEvidence = validateDeliveryEvidenceReferences(stage, evidence.value);
      if (!validatedEvidence.ok) {
        return fail(validatedEvidence.error.code, validatedEvidence.error.message,
          binding.projectId);
      }
      const acceptedEvidence = validatedEvidence.value;

      let transitionedStatus = binding.workItemStatus;
      let transitionedVersion = binding.workItemVersion;
      if (binding.workItemStatus !== next.taskStatus) {
        const transitioned = transitionWorkItem({
          id: binding.workItemId,
          projectId: binding.projectId,
          status: binding.workItemStatus,
          blocked: binding.workItemBlocked,
          version: binding.workItemVersion
        }, next.taskStatus);
        if (!transitioned.ok) {
          return fail(transitioned.error.code, transitioned.error.message, binding.projectId);
        }
        transitionedStatus = transitioned.value.status;
        transitionedVersion = transitioned.value.version;
      }

      const [claimedSuccess] = await tx.insert(schema.commandReceipts).values({
        workspaceId: command.workspaceId,
        idempotencyKey: command.idempotencyKey,
        requestHash: input.requestHash,
        commandId: command.commandId,
        correlationId: command.correlationId,
        commandType: command.type
      }).onConflictDoNothing({
        target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
      }).returning();
      if (claimedSuccess === undefined) {
        const [winner] = await tx.select().from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.workspaceId, command.workspaceId),
          eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
        )).limit(1).for('update');
        if (winner === undefined || winner.requestHash !== input.requestHash ||
          winner.expectedVersion !== command.payload.expectedWorkItemVersion) {
          return fail('IDEMPOTENCY_KEY_REUSED', 'The acceptance key was already used.',
            binding.projectId);
        }
        if (winner.state !== 'completed' || winner.result === null) {
          throw new Error('agent_run_acceptance_receipt_incomplete');
        }
        return {status: 'replayed' as const, receipt: {
          commandId: winner.commandId,
          workspaceId: command.workspaceId,
          correlationId: winner.correlationId,
          idempotencyKey: command.idempotencyKey,
          requestHash: winner.requestHash,
          commandType: command.type,
          result: winner.result as never,
          createdAt: winner.createdAt.toISOString()
        }};
      }

      const now = options.now?.() ?? new Date();
      if (acceptedEvidence.length > 0) {
        await tx.insert(schema.deliveryJourneyEvidence).values(acceptedEvidence.map((entry) => ({
          workItemId: binding.workItemId,
          stageKey: stage.key,
          requirement: entry.requirement,
          evidenceReference: entry.reference,
          commandId: command.commandId
        }))).onConflictDoNothing({
          target: [schema.deliveryJourneyEvidence.workItemId,
            schema.deliveryJourneyEvidence.stageKey,
            schema.deliveryJourneyEvidence.requirement]
        });
        const persisted = await tx.select({
          requirement: schema.deliveryJourneyEvidence.requirement,
          reference: schema.deliveryJourneyEvidence.evidenceReference
        }).from(schema.deliveryJourneyEvidence).where(and(
          eq(schema.deliveryJourneyEvidence.workItemId, binding.workItemId),
          eq(schema.deliveryJourneyEvidence.stageKey, stage.key)
        ));
        if (acceptedEvidence.some((entry) => !persisted.some((stored) =>
          stored.requirement === entry.requirement && stored.reference === entry.reference))) {
          throw new Error('agent_run_acceptance_evidence_conflict');
        }
      }
      let updatedItem = {status: binding.workItemStatus, version: binding.workItemVersion};
      if (binding.workItemStatus !== transitionedStatus) {
        const [persistedItem] = await tx.update(schema.workItems).set({
          status: transitionedStatus,
          version: transitionedVersion,
          updatedAt: now
        }).where(and(
          eq(schema.workItems.id, binding.workItemId),
          eq(schema.workItems.version, binding.workItemVersion)
        )).returning({status: schema.workItems.status, version: schema.workItems.version});
        if (persistedItem === undefined) throw new Error('agent_run_acceptance_work_item_cas');
        updatedItem = persistedItem;
        await tx.insert(schema.statusTransitions).values({
          workItemId: binding.workItemId,
          fromStatus: binding.workItemStatus,
          toStatus: updatedItem.status,
          actorId: command.actor.actorId,
          reason: 'product_owner_accepted_agent_run',
          idempotencyKey: command.idempotencyKey
        });
      }
      const [updatedJourney] = await tx.update(schema.deliveryJourneys).set({
        stageKey: next.key,
        version: journey.version + 1,
        updatedAt: now
      }).where(and(
        eq(schema.deliveryJourneys.workItemId, binding.workItemId),
        eq(schema.deliveryJourneys.version, journey.version)
      )).returning({stageKey: schema.deliveryJourneys.stageKey, version: schema.deliveryJourneys.version});
      if (updatedJourney === undefined) throw new Error('agent_run_acceptance_journey_cas');
      const [updatedExecution] = await tx.update(schema.projectExecutions).set({
        status: 'paused',
        selectedWorkItemId: null,
        selectedPlanVersionId: null,
        selectedWorkItemVersion: null,
        selectedProtocolId: null,
        selectedProtocolVersion: null,
        selectedJourneyVersion: null,
        selectedStageKey: null,
        selectedResponsibleActorId: null,
        selectedAgentProfileId: null,
        selectedResponsibilityHash: null,
        blockReason: null,
        pausedAt: now,
        completedAt: null,
        version: execution.version + 1,
        updatedAt: now
      }).where(and(
        eq(schema.projectExecutions.projectId, binding.projectId),
        eq(schema.projectExecutions.version, execution.version),
        eq(schema.projectExecutions.status, 'running')
      )).returning({version: schema.projectExecutions.version});
      if (updatedExecution === undefined) throw new Error('agent_run_acceptance_execution_cas');

      const value: AcceptanceValue = {
        projectId: binding.projectId,
        workItemId: binding.workItemId,
        workItemStatus: updatedItem.status,
        workItemVersion: updatedItem.version,
        journeyStageKey: updatedJourney.stageKey,
        journeyVersion: updatedJourney.version,
        executionStatus: 'paused',
        executionVersion: updatedExecution.version,
        evidenceReferences: acceptedEvidence
      };
      const result = {ok: true as const, value};
      const completedAt = await audit(result, {
        projectId: binding.projectId,
        policyDecision: 'allow',
        outcome: 'succeeded',
        resultVersion: updatedItem.version
      });
      await tx.update(schema.commandReceipts).set({
        state: 'completed',
        aggregateType: 'agent_run',
        aggregateId: command.payload.runId,
        expectedVersion: command.payload.expectedWorkItemVersion,
        resultVersion: updatedItem.version,
        result,
        completedAt
      }).where(eq(schema.commandReceipts.id, claimedSuccess.id));
      return {status: 'completed' as const, receipt: {
        commandId: command.commandId,
        workspaceId: command.workspaceId,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        requestHash: input.requestHash,
        commandType: command.type,
        result,
        createdAt: claimedSuccess.createdAt.toISOString()
      }};
    });
  }
});
