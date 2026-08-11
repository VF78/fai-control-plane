import {createHash, randomUUID} from 'node:crypto';
import {
  createTaskPacket,
  nextEnabledDeliveryStage,
  transitionWorkItem,
  validateDeliveryEvidenceReferences,
  validateDeliveryProtocolDefinition,
  validateQaReviewEvidence,
  type CommandError,
  type DeliveryProtocol,
  type DeliveryProtocolResponsibility,
  type DeliveryProtocolStage,
  type WorkItemStatus
} from '@fai-control-plane/domain';
import type {GovernedQaStore, GovernedQaValue} from '@fai-control-plane/application';
import {and, asc, eq, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import {reconcileRiskSignal} from './risk-signal';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Command = Parameters<GovernedQaStore['execute']>[0]['command'];
type Result = Readonly<{ok: true; value: GovernedQaValue}> |
  Readonly<{ok: false; error: CommandError}>;
const failed = (code: CommandError['code'], message: string): Result => ({ok: false, error: {code, message}});
const uuid = (value: string): string => {
  const hex = createHash('sha256').update(value).digest('hex').split('');
  hex[12] = '5'; hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20, 32)}`;
};
const attemptKey = (command: Command, requestHash: string) => `governed-qa-attempt:v1:${createHash('sha256')
  .update(`${command.actor.actorId}:${command.commandId}:${requestHash}`).digest('hex')}`;
const attemptAuditId = (command: Command, requestHash: string, code: string) => `governed-qa-attempt:v1:${createHash('sha256')
  .update(`${command.commandId}:${requestHash}:${code}`).digest('hex')}`;
const authority = async (tx: Transaction, workspaceId: string, projectId: string, actorId: string) => {
  const [actor] = await tx.select({role: schema.actors.role}).from(schema.actors).where(and(
    eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId),
    eq(schema.actors.type, 'human'), eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt)
  )).limit(1);
  if (actor === undefined) return false;
  if (actor.role === 'workspace_admin' || actor.role === 'delivery_lead') return true;
  const [membership] = await tx.select({role: schema.projectMemberships.role}).from(schema.projectMemberships)
    .where(and(eq(schema.projectMemberships.projectId, projectId),
      eq(schema.projectMemberships.actorId, actorId), eq(schema.projectMemberships.active, true))).limit(1);
  return membership?.role === 'workspace_owner' || membership?.role === 'project_owner';
};
const responsibleHuman = async (tx: Transaction, workspaceId: string, projectId: string,
  responsibility: DeliveryProtocolResponsibility): Promise<string | null> => {
  if (responsibility.kind === 'actor') {
    if (responsibility.actorType !== 'human') return null;
    const [row] = await tx.select({id: schema.actors.id}).from(schema.actors)
      .innerJoin(schema.projectMemberships, and(eq(schema.projectMemberships.actorId, schema.actors.id),
        eq(schema.projectMemberships.projectId, projectId), eq(schema.projectMemberships.active, true)))
      .where(and(eq(schema.actors.id, responsibility.actorId), eq(schema.actors.workspaceId, workspaceId),
        eq(schema.actors.type, 'human'), isNull(schema.actors.disabledAt))).limit(1);
    return row?.id ?? null;
  }
  const rows = await tx.select({id: schema.actors.id}).from(schema.projectMemberships)
    .innerJoin(schema.actors, eq(schema.actors.id, schema.projectMemberships.actorId))
    .where(and(eq(schema.projectMemberships.projectId, projectId),
      eq(schema.projectMemberships.role, responsibility.role), eq(schema.projectMemberships.active, true),
      eq(schema.actors.workspaceId, workspaceId), eq(schema.actors.type, 'human'),
      isNull(schema.actors.disabledAt))).orderBy(asc(schema.actors.id)).limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
};
const protocolFrom = (row: typeof schema.runbooks.$inferSelect): DeliveryProtocol | null => {
  if ((row.protocolState !== 'published' && row.protocolState !== 'retired') ||
    row.revision === null || row.contentHash === null) return null;
  const definition = validateDeliveryProtocolDefinition(row.definition);
  return !definition.ok ? null : {id: row.id, projectId: row.projectId, name: row.name,
    version: row.version, revision: row.revision, state: row.protocolState, active: row.active,
    definition: definition.value, contentHash: row.contentHash};
};
const pauseExecution = async (tx: Transaction, projectId: string, now: Date): Promise<'paused' | 'blocked' | 'not_started'> => {
  const [execution] = await tx.select().from(schema.projectExecutions)
    .where(eq(schema.projectExecutions.projectId, projectId)).limit(1).for('update');
  if (execution === undefined || execution.status === 'stopped') return 'not_started';
  if (execution.status === 'completed') return 'blocked';
  if (execution.status === 'paused') return 'paused';
  const target = execution.status === 'running' || execution.status === 'blocked' ? 'paused' : 'blocked';
  const [updated] = await tx.update(schema.projectExecutions).set({
    status: target, blockReason: null, selectedWorkItemId: null, selectedPlanVersionId: null,
    selectedWorkItemVersion: null, selectedProtocolId: null, selectedProtocolVersion: null,
    selectedJourneyVersion: null, selectedStageKey: null, selectedResponsibleActorId: null,
    selectedAgentProfileId: null, pausedAt: now, updatedAt: now, version: execution.version + 1
  }).where(and(eq(schema.projectExecutions.projectId, projectId), eq(schema.projectExecutions.version, execution.version)))
    .returning({id: schema.projectExecutions.projectId});
  if (updated === undefined) throw new Error('governed_qa_execution_cas');
  return target;
};
const blockExecution = async (tx: Transaction, projectId: string, now: Date): Promise<'blocked' | 'not_started'> => {
  const [execution] = await tx.select().from(schema.projectExecutions)
    .where(eq(schema.projectExecutions.projectId, projectId)).limit(1).for('update');
  if (execution === undefined || execution.status === 'stopped') return 'not_started';
  if (execution.status === 'completed') return 'blocked';
  if (execution.status === 'blocked') return 'blocked';
  const [updated] = await tx.update(schema.projectExecutions).set({status: 'blocked',
    blockReason: 'qa_review_failed', selectedWorkItemId: null, selectedPlanVersionId: null,
    selectedWorkItemVersion: null, selectedProtocolId: null, selectedProtocolVersion: null,
    selectedJourneyVersion: null, selectedStageKey: null, selectedResponsibleActorId: null,
    selectedAgentProfileId: null, pausedAt: null, updatedAt: now, version: execution.version + 1
  }).where(and(eq(schema.projectExecutions.projectId, projectId), eq(schema.projectExecutions.version, execution.version)))
    .returning({id: schema.projectExecutions.projectId});
  if (updated === undefined) throw new Error('governed_qa_execution_block_cas');
  return 'blocked';
};

export const createPostgresGovernedQaStore = (db: Database): GovernedQaStore => ({
  async execute(input) {
    return db.transaction(async (tx) => {
      const {command} = input;
      const scope: {projectId: string | undefined} = {projectId: undefined};
      let result: Result;
      let resultVersion: number | undefined;
      const completeAttempt = async (outcome: Result, policyDecision: 'allow' | 'deny',
        aggregateId: string, expectedVersion: number) => {
        const now = new Date(); const key = attemptKey(command, input.requestHash);
        const [inserted] = await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId,
          idempotencyKey: key, requestHash: input.requestHash, commandId: command.commandId,
          correlationId: command.correlationId, commandType: command.type, state: 'completed',
          aggregateType: 'governed_qa', aggregateId, expectedVersion, resultVersion, result: outcome, completedAt: now
        }).onConflictDoNothing({target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]}).returning();
        const [stored] = inserted === undefined ? await tx.select().from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.workspaceId, command.workspaceId), eq(schema.commandReceipts.idempotencyKey, key)
        )).limit(1).for('update') : [inserted];
        if (stored === undefined || stored.result === null || stored.requestHash !== input.requestHash) throw new Error('governed_qa_attempt_receipt');
        const storedResult = stored.result as Result;
        await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: command.workspaceId,
          projectId: scope.projectId, actorId: command.actor.actorId, commandId: storedResult.ok ? command.commandId :
            attemptAuditId(command, input.requestHash, storedResult.error.code), actionCategory: 'write', action: command.type,
          targetType: 'governed_qa', targetId: aggregateId, policyDecision,
          outcome: storedResult.ok ? 'succeeded' : policyDecision === 'deny' ? 'rejected' : 'failed',
          ...(!storedResult.ok ? {reasonCode: storedResult.error.code} : {}), expectedVersion, resultVersion,
          correlationId: command.correlationId, occurredAt: now, metadata: {}}
        ).onConflictDoNothing({target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]});
        return {status: inserted === undefined ? 'replayed' as const : 'completed' as const, receipt: {
          commandId: stored.commandId, workspaceId: command.workspaceId, correlationId: stored.correlationId,
          idempotencyKey: key, requestHash: stored.requestHash, commandType: command.type,
          result: storedResult, createdAt: stored.createdAt.toISOString()
        }};
      };
      const fail = (code: CommandError['code'], message: string, aggregateId = command.payload.workItemId,
        policyDecision: 'allow' | 'deny' = 'allow') => completeAttempt(failed(code, message), policyDecision,
          aggregateId, command.payload.expectedWorkItemVersion);
      if (!input.authorized) return fail(input.policyError?.code ?? 'POLICY_DENIED',
        input.policyError?.message ?? 'Policy denies governed QA.', command.payload.workItemId, 'deny');
      const [binding] = await tx.select({item: schema.workItems, project: schema.projects})
        .from(schema.workItems).innerJoin(schema.projects, eq(schema.projects.id, schema.workItems.projectId))
        .where(and(eq(schema.workItems.id, command.payload.workItemId),
          eq(schema.projects.workspaceId, command.workspaceId), isNull(schema.workItems.deletedAt))).limit(1).for('update');
      if (binding === undefined) return fail('NOT_FOUND', 'Work item was not found.');
      const item = binding.item; scope.projectId = item.projectId;
      if (!await authority(tx, command.workspaceId, item.projectId, command.actor.actorId)) {
        return fail('CAPABILITY_DENIED', 'Only an active manager or Product Owner may govern QA.', item.id, 'deny');
      }
      const [existing] = await tx.select().from(schema.commandReceipts).where(and(
        eq(schema.commandReceipts.workspaceId, command.workspaceId), eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
      )).limit(1).for('update');
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash) return {status: 'key_reused', existingRequestHash: existing.requestHash};
        if (existing.result === null || existing.state !== 'completed') throw new Error('governed_qa_receipt_incomplete');
        return {status: 'replayed', receipt: {commandId: existing.commandId, workspaceId: command.workspaceId,
          correlationId: existing.correlationId, idempotencyKey: command.idempotencyKey, requestHash: existing.requestHash,
          commandType: command.type, result: existing.result as Result, createdAt: existing.createdAt.toISOString()}};
      }
      if (item.version !== command.payload.expectedWorkItemVersion) return fail('VERSION_CONFLICT', 'Work item version conflicts.');
      if (item.sourcePlanVersionId === null) return fail('INVALID_COMMAND', 'QA requires a materialized immutable plan task.');
      const [journey] = await tx.select().from(schema.deliveryJourneys)
        .where(eq(schema.deliveryJourneys.workItemId, item.id)).limit(1).for('update');
      if (journey === undefined || journey.version !== command.payload.expectedJourneyVersion) {
        resultVersion = journey?.version; return fail(journey === undefined ? 'NOT_FOUND' : 'VERSION_CONFLICT',
          journey === undefined ? 'Delivery journey is not configured.' : 'Delivery journey version conflicts.');
      }
      const [protocolRow] = await tx.select().from(schema.runbooks).where(and(
        eq(schema.runbooks.id, journey.protocolId), eq(schema.runbooks.version, journey.protocolVersion),
        eq(schema.runbooks.projectId, item.projectId))).limit(1).for('update');
      const protocol = protocolRow === undefined ? null : protocolFrom(protocolRow);
      const stage = protocol?.definition.stages.find((candidate) => candidate.enabled && candidate.key === journey.stageKey);
      if (protocol === null || stage === undefined || stage.taskStatus !== 'qa' ||
        !['manual', 'human_approval'].includes(stage.executionMode) || item.status !== 'qa' || item.blocked) {
        return fail('INVALID_TRANSITION', 'An enabled, unblocked human-governed QA stage is required.');
      }
      const [executionState] = await tx.select({status: schema.projectExecutions.status})
        .from(schema.projectExecutions).where(eq(schema.projectExecutions.projectId, item.projectId))
        .limit(1).for('update');
      if (executionState?.status === 'completed') {
        return fail('INVALID_TRANSITION', 'Completed project execution cannot accept a new QA packet or review.');
      }
      const reviewerActorId = await responsibleHuman(tx, command.workspaceId, item.projectId, stage.responsibility);
      if (reviewerActorId === null) return fail('INVALID_COMMAND', 'QA stage responsibility must resolve to exactly one active human.');
      if (command.type === 'qa_task_packet.prepare.v1') {
        const packetId = uuid(`governed-qa-packet:v1:${item.id}:${item.version}:${journey.version}:${stage.key}`);
        const [prepared] = await tx.select({taskPacketId: schema.qaTaskPackets.taskPacketId})
          .from(schema.qaTaskPackets).where(eq(schema.qaTaskPackets.taskPacketId, packetId))
          .limit(1).for('update');
        if (prepared !== undefined) {
          return fail('INVALID_TRANSITION', 'An immutable QA packet already exists for this work item and journey version.');
        }
        const eventId = randomUUID(); const packet = createTaskPacket(packetId, {
          projectId: item.projectId, workItemId: item.id, workItemVersion: item.version,
          goal: `Governed QA review: ${item.title}`,
          acceptanceCriteria: [...stage.requiredEvidence], inScope: [...stage.entryCriteria, ...stage.requiredEvidence],
          outOfScope: ['agent_run', 'provider_write', 'merge', 'release', 'deploy', 'production'],
          relevantLinks: [], relevantFiles: [], allowedTools: [],
          forbiddenSurfaces: ['runner', 'provider_write', 'merge', 'release', 'deploy', 'production'],
          dataPolicy: {kind: 'governed_qa', source: 'canonical_postgresql_only'}, timeboxMinutes: 30,
          expectedOutputSchema: {kind: 'governed_qa_receipt', outcome: 'passed_or_failed'},
          reviewerActorId, approverActorId: command.actor.actorId, runtimeProfile: 'human_qa_review', authMode: 'user',
          secretsRef: null, createdFromEventId: eventId, createdByActorId: command.actor.actorId
        });
        if (!packet.ok) return fail('INVALID_COMMAND', 'QA task packet could not be made canonical.');
        const [claimed] = await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId,
          idempotencyKey: command.idempotencyKey, requestHash: input.requestHash, commandId: command.commandId,
          correlationId: command.correlationId, commandType: command.type}).onConflictDoNothing({
          target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
        }).returning();
        if (claimed === undefined) throw new Error('governed_qa_prepare_receipt_claim');
        const now = new Date();
        await tx.insert(schema.canonicalEvents).values({id: eventId, workspaceId: command.workspaceId,
          projectId: item.projectId, eventType: 'governed_qa.packet_prepared.v1', aggregateType: 'qa_task_packet',
          aggregateId: packetId, deduplicationKey: `governed_qa.packet:${packetId}`, payload: {schemaVersion: 1}, occurredAt: now});
        const packetRow: typeof schema.taskPackets.$inferInsert = {id: packetId, projectId: item.projectId, workItemId: item.id,
          workItemVersion: item.version, goal: packet.value.content.goal, acceptanceCriteria: [...packet.value.content.acceptanceCriteria],
          inScope: [...packet.value.content.inScope], outOfScope: [...packet.value.content.outOfScope], relevantLinks: [],
          relevantFiles: [], allowedTools: [], forbiddenSurfaces: [...packet.value.content.forbiddenSurfaces],
          dataPolicy: packet.value.content.dataPolicy as Record<string, unknown>, timeboxMinutes: packet.value.content.timeboxMinutes,
          expectedOutputSchema: packet.value.content.expectedOutputSchema as Record<string, unknown>, reviewerActorId, approverActorId: command.actor.actorId,
          runtimeProfile: packet.value.content.runtimeProfile, authMode: 'user', createdFromEventId: eventId,
          contentHash: packet.value.contentHash, createdByActorId: command.actor.actorId};
        await tx.insert(schema.taskPackets).values(packetRow);
        await tx.insert(schema.qaTaskPackets).values({taskPacketId: packetId, projectId: item.projectId,
          planVersionId: item.sourcePlanVersionId, workItemId: item.id, workItemVersion: item.version,
          protocolId: journey.protocolId, protocolVersion: journey.protocolVersion, journeyVersion: journey.version,
          stageKey: stage.key, responsibility: stage.responsibility, requiredEvidence: [...stage.requiredEvidence],
          preparedByActorId: command.actor.actorId});
        const value: GovernedQaValue = {projectId: item.projectId, workItemId: item.id, taskPacketId: packetId,
          workItemStatus: item.status, workItemVersion: item.version, journeyStageKey: stage.key,
          journeyVersion: journey.version, executionStatus: 'not_started', remediation: 'Запуск агента не создавался; зафиксируйте QA evidence.'};
        result = {ok: true, value}; resultVersion = item.version;
        await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: command.workspaceId, projectId: item.projectId,
          actorId: command.actor.actorId, commandId: command.commandId, actionCategory: 'write', action: command.type,
          targetType: 'qa_task_packet', targetId: packetId, policyDecision: 'allow', outcome: 'succeeded',
          expectedVersion: item.version, resultVersion, correlationId: command.correlationId, occurredAt: now, metadata: {}});
        await tx.update(schema.commandReceipts).set({state: 'completed', aggregateType: 'qa_task_packet', aggregateId: packetId,
          expectedVersion: item.version, resultVersion, result, completedAt: now}).where(eq(schema.commandReceipts.id, claimed.id));
        return {status: 'completed', receipt: {commandId: command.commandId, workspaceId: command.workspaceId,
          correlationId: command.correlationId, idempotencyKey: command.idempotencyKey, requestHash: input.requestHash,
          commandType: command.type, result, createdAt: claimed.createdAt.toISOString()}};
      }
      const evidence = validateQaReviewEvidence(command.payload.evidence);
      if (!evidence.ok) return fail(evidence.error.code, evidence.error.message);
      const [packetBinding] = await tx.select({qa: schema.qaTaskPackets, packet: schema.taskPackets})
        .from(schema.qaTaskPackets).innerJoin(schema.taskPackets, eq(schema.taskPackets.id, schema.qaTaskPackets.taskPacketId))
        .where(eq(schema.qaTaskPackets.taskPacketId, command.payload.taskPacketId)).limit(1).for('update');
      if (packetBinding === undefined || packetBinding.qa.projectId !== item.projectId ||
        packetBinding.qa.planVersionId !== item.sourcePlanVersionId || packetBinding.qa.workItemId !== item.id ||
        packetBinding.qa.workItemVersion !== item.version || packetBinding.qa.protocolId !== journey.protocolId ||
        packetBinding.qa.protocolVersion !== journey.protocolVersion || packetBinding.qa.journeyVersion !== journey.version ||
        packetBinding.qa.stageKey !== stage.key || packetBinding.packet.workItemVersion !== item.version ||
        packetBinding.packet.approverActorId !== command.actor.actorId) return fail('VERSION_CONFLICT', 'Immutable QA packet binding is no longer current.');
      const [reviewed] = await tx.select({id: schema.qaReviewReceipts.id}).from(schema.qaReviewReceipts)
        .where(eq(schema.qaReviewReceipts.taskPacketId, command.payload.taskPacketId)).limit(1).for('update');
      if (reviewed !== undefined) return fail('INVALID_TRANSITION', 'This immutable QA packet already has a retained review.');
      const validEvidence = validateDeliveryEvidenceReferences(stage, evidence.value.evidenceReferences);
      if (evidence.value.outcome === 'passed' && !validEvidence.ok) return fail(validEvidence.error.code, validEvidence.error.message);
      const now = new Date(); let nextStage: DeliveryProtocolStage = stage; let nextStatus: WorkItemStatus = item.status; let nextJourneyVersion = journey.version;
      let remediation: string | null = null; let executionStatus: GovernedQaValue['executionStatus'];
      if (evidence.value.outcome === 'passed') {
        const next = nextEnabledDeliveryStage(protocol, stage.key);
        if (next === null) return fail('INVALID_TRANSITION', 'QA pass requires an enabled next delivery stage.');
        const moved = item.status === next.taskStatus ? {ok: true as const, value: {...item, version: item.version}} : transitionWorkItem(item, next.taskStatus);
        if (!moved.ok) return fail(moved.error.code, moved.error.message);
        nextStage = next; nextStatus = moved.value.status; resultVersion = moved.value.version; nextJourneyVersion = journey.version + 1;
        if (nextStatus !== item.status) {
          const [updated] = await tx.update(schema.workItems).set({status: nextStatus, version: moved.value.version, updatedAt: now})
            .where(and(eq(schema.workItems.id, item.id), eq(schema.workItems.version, item.version))).returning({id: schema.workItems.id});
          if (updated === undefined) throw new Error('governed_qa_pass_work_item_cas');
          await tx.insert(schema.statusTransitions).values({workItemId: item.id, fromStatus: item.status, toStatus: nextStatus,
            actorId: command.actor.actorId, reason: 'governed_qa_passed', idempotencyKey: command.idempotencyKey});
        }
        const [updatedJourney] = await tx.update(schema.deliveryJourneys).set({stageKey: next.key, version: nextJourneyVersion, updatedAt: now})
          .where(and(eq(schema.deliveryJourneys.workItemId, item.id), eq(schema.deliveryJourneys.version, journey.version))).returning({workItemId: schema.deliveryJourneys.workItemId});
        if (updatedJourney === undefined) throw new Error('governed_qa_pass_journey_cas');
        executionStatus = await pauseExecution(tx, item.projectId, now);
        await reconcileRiskSignal(tx, {projectId: item.projectId, workItemId: item.id,
          deduplicationKey: `governed_qa_failure:${item.id}`, observedAt: now, condition: null});
      } else {
        const priorCandidates = protocol.definition.stages.filter((candidate) =>
          candidate.enabled && candidate.allowedNextStageKey === stage.key
        );
        const prior = priorCandidates.length === 1 ? priorCandidates[0]! : null;
        const moved = prior === null ? null : transitionWorkItem(item, prior.taskStatus);
        if (prior !== null && moved !== null && moved.ok) {
          nextStage = prior; nextStatus = moved.value.status; resultVersion = moved.value.version; nextJourneyVersion = journey.version + 1;
          if (nextStatus !== item.status) {
            const [updated] = await tx.update(schema.workItems).set({status: nextStatus, version: moved.value.version, updatedAt: now})
              .where(and(eq(schema.workItems.id, item.id), eq(schema.workItems.version, item.version))).returning({id: schema.workItems.id});
            if (updated === undefined) throw new Error('governed_qa_failure_work_item_cas');
            await tx.insert(schema.statusTransitions).values({workItemId: item.id, fromStatus: item.status, toStatus: nextStatus,
              actorId: command.actor.actorId, reason: 'governed_qa_failed_returned', idempotencyKey: command.idempotencyKey});
          }
          const [updatedJourney] = await tx.update(schema.deliveryJourneys).set({stageKey: prior.key, version: nextJourneyVersion, updatedAt: now})
            .where(and(eq(schema.deliveryJourneys.workItemId, item.id), eq(schema.deliveryJourneys.version, journey.version))).returning({workItemId: schema.deliveryJourneys.workItemId});
          if (updatedJourney === undefined) throw new Error('governed_qa_failure_journey_cas');
          remediation = `Исправьте QA findings и повторно пройдите этап «${prior.name}».`;
        } else {
          const [updated] = await tx.update(schema.workItems).set({blocked: true, version: item.version + 1, updatedAt: now})
            .where(and(eq(schema.workItems.id, item.id), eq(schema.workItems.version, item.version))).returning({id: schema.workItems.id});
          if (updated === undefined) throw new Error('governed_qa_failure_block_cas');
          resultVersion = item.version + 1; remediation = 'QA failure has no protocol-allowed return route; unblock only after manager remediation.';
        }
        executionStatus = await blockExecution(tx, item.projectId, now);
        await reconcileRiskSignal(tx, {projectId: item.projectId, workItemId: item.id,
          deduplicationKey: `governed_qa_failure:${item.id}`, observedAt: now, condition: {
            code: 'governed_qa_failed', ruleId: 'governed_qa_failure', ruleVersion: '1', signalClass: 'fact', severity: 'red',
            summary: 'QA evidence reported a failure or risk.', details: {failures: evidence.value.failures, risks: evidence.value.risks},
            evidenceReferences: [{type: 'qa_task_packet', id: command.payload.taskPacketId}],
            impact: 'The work item cannot advance until QA findings are remediated.', ownerActorId: command.actor.actorId,
            nextAction: remediation
          }});
      }
      const [claimed] = await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId,
        idempotencyKey: command.idempotencyKey, requestHash: input.requestHash, commandId: command.commandId,
        correlationId: command.correlationId, commandType: command.type}).onConflictDoNothing({
        target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
      }).returning();
      if (claimed === undefined) throw new Error('governed_qa_review_receipt_claim');
      await tx.insert(schema.qaReviewReceipts).values({taskPacketId: command.payload.taskPacketId, outcome: evidence.value.outcome,
        checks: evidence.value.checks, artifacts: evidence.value.artifacts, failures: evidence.value.failures, risks: evidence.value.risks,
        evidenceReferences: evidence.value.evidenceReferences, recordedByActorId: command.actor.actorId, commandId: command.commandId});
      if (evidence.value.outcome === 'passed' && validEvidence.ok) await tx.insert(schema.deliveryJourneyEvidence).values(validEvidence.value.map((entry) => ({
        workItemId: item.id, stageKey: stage.key, requirement: entry.requirement, evidenceReference: entry.reference, commandId: command.commandId
      })));
      const value: GovernedQaValue = {projectId: item.projectId, workItemId: item.id, taskPacketId: command.payload.taskPacketId,
        workItemStatus: nextStatus, workItemVersion: resultVersion ?? item.version, journeyStageKey: nextStage.key,
        journeyVersion: nextJourneyVersion, executionStatus, remediation};
      result = {ok: true, value};
      await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: command.workspaceId, projectId: item.projectId,
        actorId: command.actor.actorId, commandId: command.commandId, actionCategory: 'write', action: command.type,
        targetType: 'qa_review', targetId: command.payload.taskPacketId, policyDecision: 'allow', outcome: 'succeeded',
        expectedVersion: item.version, resultVersion: value.workItemVersion, correlationId: command.correlationId, occurredAt: now, metadata: {}});
      await tx.update(schema.commandReceipts).set({state: 'completed', aggregateType: 'qa_review', aggregateId: command.payload.taskPacketId,
        expectedVersion: item.version, resultVersion: value.workItemVersion, result, completedAt: now}).where(eq(schema.commandReceipts.id, claimed.id));
      return {status: 'completed', receipt: {commandId: command.commandId, workspaceId: command.workspaceId,
        correlationId: command.correlationId, idempotencyKey: command.idempotencyKey, requestHash: input.requestHash,
        commandType: command.type, result, createdAt: claimed.createdAt.toISOString()}};
    });
  }
});
