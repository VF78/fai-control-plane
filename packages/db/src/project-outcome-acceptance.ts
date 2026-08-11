import {createHash, randomUUID} from 'node:crypto';
import {and, desc, eq, isNull} from 'drizzle-orm';
import {validateDeliveryProtocolDefinition, type CommandError} from '@fai-control-plane/domain';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Command = Readonly<{commandId: string; workspaceId: string; correlationId: string; idempotencyKey: string; actor: Readonly<{actorId: string}>; type: 'project_scope_outcome.accept.v1'; payload: Readonly<{projectId: string; baselineId: string; outcomeId: string; expectedExecutionVersion: number}>}>;
type Value = Readonly<{projectId: string; outcomeId: string; acceptedWeight: number; totalWeight: number; executionStatus: 'paused' | 'blocked'; executionVersion: number}>;
type Result = Readonly<{ok: true; value: Value}> | Readonly<{ok: false; error: CommandError}>;
const fail = (code: CommandError['code'], message: string): Result => ({ok: false, error: {code, message}});
const attemptReceiptKey = (command: Command, requestHash: string): string =>
  `project-outcome-accept-attempt:v1:${createHash('sha256')
    .update(`${command.actor.actorId}:${requestHash}:${command.commandId}`)
    .digest('hex')}`;
const attemptAuditCommandId = (command: Command, requestHash: string, reason: string): string =>
  `project-outcome-accept-attempt:v1:${createHash('sha256')
    .update(`${command.commandId}:${requestHash}:${reason}`)
    .digest('hex')}`;

const isOwner = async (tx: Parameters<Parameters<Database['transaction']>[0]>[0], workspaceId: string, projectId: string, actorId: string) => {
  const [actor] = await tx.select({id: schema.actors.id}).from(schema.actors).where(and(eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId), eq(schema.actors.type, 'human'), eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt))).limit(1);
  if (actor === undefined) return false;
  const [member] = await tx.select({roles: schema.projectMemberships.roles}).from(schema.projectMemberships).where(and(eq(schema.projectMemberships.projectId, projectId), eq(schema.projectMemberships.actorId, actorId), eq(schema.projectMemberships.active, true))).limit(1);
  return member?.roles.includes('project_owner') === true;
};

export const createPostgresProjectOutcomeAcceptanceStore = (db: Database, options: Readonly<{now?: () => Date}> = {}) => ({
  async execute(input: Readonly<{command: Command; requestHash: string; authorized: boolean; policyError?: CommandError}>) {
    return db.transaction(async (tx) => {
      const {command} = input;
      let result: Result = fail('INVALID_COMMAND', 'Outcome acceptance was not evaluated.'); let resultVersion: number | undefined;
      const complete = async (projectId: string | undefined, policyDecision: 'allow' | 'deny' = input.authorized ? 'allow' : 'deny', successReceipt?: typeof schema.commandReceipts.$inferSelect) => {
        const now = options.now?.() ?? new Date();
        let stored = successReceipt;
        let idempotencyKey = command.idempotencyKey;
        if (!result.ok) {
          idempotencyKey = attemptReceiptKey(command, input.requestHash);
          const [inserted] = await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId, idempotencyKey, requestHash: input.requestHash, commandId: command.commandId, correlationId: command.correlationId, commandType: command.type, state: 'completed', aggregateType: 'project_scope_outcome', aggregateId: command.payload.outcomeId, expectedVersion: command.payload.expectedExecutionVersion, resultVersion, result, completedAt: now}).onConflictDoNothing({target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]}).returning();
          [stored] = inserted === undefined ? await tx.select().from(schema.commandReceipts).where(and(eq(schema.commandReceipts.workspaceId, command.workspaceId), eq(schema.commandReceipts.idempotencyKey, idempotencyKey))).limit(1).for('update') : [inserted];
          if (stored === undefined || stored.state !== 'completed' || stored.result === null || stored.requestHash !== input.requestHash) throw new Error('project_outcome_acceptance_attempt_receipt_incomplete');
        } else {
          if (stored === undefined) throw new Error('project_outcome_acceptance_success_receipt_unclaimed');
          await tx.update(schema.commandReceipts).set({state: 'completed', aggregateType: 'project_scope_outcome', aggregateId: command.payload.outcomeId, expectedVersion: command.payload.expectedExecutionVersion, resultVersion, result, completedAt: now}).where(eq(schema.commandReceipts.id, stored.id));
        }
        const completedResult = stored.result === null ? result : stored.result as Result;
        await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: command.workspaceId, projectId, actorId: command.actor.actorId, commandId: completedResult.ok ? command.commandId : attemptAuditCommandId(command, input.requestHash, completedResult.error.code), actionCategory: 'write', action: command.type, targetType: 'project_scope_outcome', targetId: command.payload.outcomeId, policyDecision, outcome: completedResult.ok ? 'succeeded' : policyDecision === 'deny' ? 'rejected' : 'failed', ...(!completedResult.ok ? {reasonCode: completedResult.error.code} : {}), expectedVersion: command.payload.expectedExecutionVersion, resultVersion, correlationId: command.correlationId, occurredAt: now, metadata: {}}).onConflictDoNothing({target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]});
        return {status: 'completed' as const, receipt: {commandId: stored.commandId, workspaceId: command.workspaceId, correlationId: stored.correlationId, idempotencyKey, requestHash: stored.requestHash, commandType: command.type, result: completedResult, createdAt: stored.createdAt.toISOString()}};
      };
      if (!input.authorized) { result = fail(input.policyError?.code ?? 'POLICY_DENIED', input.policyError?.message ?? 'Policy denies outcome acceptance.'); return complete(undefined, 'deny'); }
      const [project] = await tx.select({id: schema.projects.id}).from(schema.projects).where(and(eq(schema.projects.id, command.payload.projectId), eq(schema.projects.workspaceId, command.workspaceId))).limit(1).for('update');
      if (project === undefined) { result = fail('NOT_FOUND', 'Project was not found.'); return complete(undefined); }
      if (!await isOwner(tx, command.workspaceId, project.id, command.actor.actorId)) { result = fail('CAPABILITY_DENIED', 'Only the active Product Owner can accept a weighted outcome.'); return complete(project.id, 'deny'); }
      const [baseline] = await tx.select().from(schema.projectScopeBaselineVersions).where(and(eq(schema.projectScopeBaselineVersions.id, command.payload.baselineId), eq(schema.projectScopeBaselineVersions.projectId, project.id), eq(schema.projectScopeBaselineVersions.active, true))).limit(1).for('update');
      const [execution] = await tx.select().from(schema.projectExecutions).where(eq(schema.projectExecutions.projectId, project.id)).limit(1).for('update');
      if (baseline === undefined || execution === undefined) { result = fail('NOT_FOUND', 'The active scope baseline or project execution was not found.'); return complete(project.id); }
      if (baseline.sourcePlanVersionId === null) { result = fail('INVALID_COMMAND', 'Outcome acceptance requires a materialized approved project plan.'); return complete(project.id); }
      const [outcome] = await tx.select().from(schema.projectScopeOutcomes).where(and(eq(schema.projectScopeOutcomes.id, command.payload.outcomeId), eq(schema.projectScopeOutcomes.baselineId, baseline.id), eq(schema.projectScopeOutcomes.sourcePlanVersionId, baseline.sourcePlanVersionId))).limit(1).for('update');
      if (outcome === undefined) { result = fail('NOT_FOUND', 'Outcome does not belong to the active approved scope baseline.'); return complete(project.id); }
      const [existingSuccess] = await tx.select().from(schema.commandReceipts).where(and(eq(schema.commandReceipts.workspaceId, command.workspaceId), eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey))).limit(1).for('update');
      if (existingSuccess !== undefined) {
        if (existingSuccess.requestHash !== input.requestHash) return {status: 'key_reused' as const, existingRequestHash: existingSuccess.requestHash};
        if (existingSuccess.state !== 'completed' || existingSuccess.result === null) throw new Error('project_outcome_acceptance_receipt_incomplete');
        return {status: 'replayed' as const, receipt: {commandId: existingSuccess.commandId, workspaceId: command.workspaceId, correlationId: existingSuccess.correlationId, idempotencyKey: command.idempotencyKey, requestHash: existingSuccess.requestHash, commandType: command.type, result: existingSuccess.result as never, createdAt: existingSuccess.createdAt.toISOString()}};
      }
      if (execution.version !== command.payload.expectedExecutionVersion) { resultVersion = execution.version; result = fail('VERSION_CONFLICT', 'Project execution version conflicts.'); return complete(project.id); }
      if (execution.status !== 'paused' && execution.status !== 'blocked') { result = fail('INVALID_TRANSITION', 'Outcomes can be accepted only at a paused or decision boundary.'); return complete(project.id); }
      if (outcome.state === 'accepted') { result = fail('INVALID_TRANSITION', 'Outcome was already accepted.'); return complete(project.id); }
      const linked = await tx.select({id: schema.workItems.id, status: schema.workItems.status, journeyStageKey: schema.deliveryJourneys.stageKey, definition: schema.runbooks.definition, protocolState: schema.runbooks.protocolState, requirement: schema.deliveryJourneyEvidence.requirement})
        .from(schema.workItemScopeOutcomes).innerJoin(schema.workItems, eq(schema.workItems.id, schema.workItemScopeOutcomes.workItemId)).innerJoin(schema.deliveryJourneys, eq(schema.deliveryJourneys.workItemId, schema.workItems.id)).innerJoin(schema.runbooks, and(eq(schema.runbooks.id, schema.deliveryJourneys.protocolId), eq(schema.runbooks.version, schema.deliveryJourneys.protocolVersion))).leftJoin(schema.deliveryJourneyEvidence, and(eq(schema.deliveryJourneyEvidence.workItemId, schema.workItems.id), eq(schema.deliveryJourneyEvidence.stageKey, schema.deliveryJourneys.stageKey)))
        .where(and(eq(schema.workItemScopeOutcomes.outcomeId, outcome.id), eq(schema.workItemScopeOutcomes.sourcePlanVersionId, baseline.sourcePlanVersionId), isNull(schema.workItems.deletedAt))).for('update', {of: schema.workItems});
      if (linked.length === 0) { result = fail('INVALID_COMMAND', 'Approved outcome has no canonical work-item evidence binding.'); return complete(project.id); }
      const requirements = new Map<string, {status: string; stageKey: string; definition: unknown; protocolState: string | null; evidence: Set<string>}>();
      for (const row of linked) {
        const current = requirements.get(row.id) ?? {status: row.status, stageKey: row.journeyStageKey, definition: row.definition, protocolState: row.protocolState, evidence: new Set<string>()};
        if (row.requirement !== null) current.evidence.add(row.requirement); requirements.set(row.id, current);
      }
      for (const [workItemId, item] of requirements) {
        const definition = validateDeliveryProtocolDefinition(item.definition);
        const finalStage = definition.ok ? definition.value.stages.find((stage) => stage.enabled && stage.key === item.stageKey) : undefined;
        if (item.status !== 'done' || !['published', 'retired'].includes(item.protocolState ?? '') || finalStage === undefined || finalStage.taskStatus !== 'done' || finalStage.allowedNextStageKey !== null || finalStage.requiredEvidence.some((requirement) => !item.evidence.has(requirement))) {
          result = fail('INVALID_TRANSITION', `Work item ${workItemId} has not reached final acceptance with all required evidence.`); return complete(project.id);
        }
      }
      const nowBase = options.now?.() ?? new Date();
      const outcomes = await tx.select({id: schema.projectScopeOutcomes.id,
        weight: schema.projectScopeOutcomes.weight, state: schema.projectScopeOutcomes.state,
        acceptedByActorId: schema.projectScopeOutcomes.acceptedByActorId,
        acceptedAt: schema.projectScopeOutcomes.acceptedAt,
        evidenceReference: schema.projectScopeOutcomes.evidenceReference})
        .from(schema.projectScopeOutcomes)
        .where(eq(schema.projectScopeOutcomes.baselineId, baseline.id))
        .orderBy(schema.projectScopeOutcomes.id).for('update');
      const totalWeight = outcomes.reduce((total, item) => total + item.weight, 0);
      if (outcomes.length === 0 || totalWeight !== 100) {
        result = fail('INVALID_COMMAND', 'The active weighted scope must total exactly 100 before acceptance.');
        return complete(project.id);
      }
      const isAccepted = (item: typeof outcomes[number]) => item.state === 'accepted' &&
        item.acceptedByActorId !== null && item.acceptedAt !== null && item.evidenceReference !== null;
      const acceptedWeight = outcomes.reduce((total, item) =>
        total + (isAccepted(item) || item.id === outcome.id ? item.weight : 0), 0);
      const everyOutcomeAccepted = outcomes.every((item) => isAccepted(item) || item.id === outcome.id);
      const claimed = (await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId, idempotencyKey: command.idempotencyKey, requestHash: input.requestHash, commandId: command.commandId, correlationId: command.correlationId, commandType: command.type}).onConflictDoNothing({target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]}).returning())[0];
      if (claimed === undefined) {
        const [concurrent] = await tx.select().from(schema.commandReceipts).where(and(eq(schema.commandReceipts.workspaceId, command.workspaceId), eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey))).limit(1).for('update');
        if (concurrent === undefined || concurrent.requestHash !== input.requestHash) return {status: 'key_reused' as const, existingRequestHash: concurrent?.requestHash ?? ''};
        if (concurrent.state !== 'completed' || concurrent.result === null) throw new Error('project_outcome_acceptance_receipt_incomplete');
        return {status: 'replayed' as const, receipt: {commandId: concurrent.commandId, workspaceId: command.workspaceId, correlationId: concurrent.correlationId, idempotencyKey: command.idempotencyKey, requestHash: concurrent.requestHash, commandType: command.type, result: concurrent.result as never, createdAt: concurrent.createdAt.toISOString()}};
      }
      const outcomeEvidenceReference = `project-outcome-acceptance:${outcome.id}:${command.commandId}`;
      const [acceptedOutcome] = await tx.update(schema.projectScopeOutcomes).set({state: 'accepted', acceptedByActorId: command.actor.actorId, acceptedAt: nowBase, evidenceReference: outcomeEvidenceReference}).where(and(eq(schema.projectScopeOutcomes.id, outcome.id), eq(schema.projectScopeOutcomes.state, outcome.state))).returning({id: schema.projectScopeOutcomes.id});
      if (acceptedOutcome === undefined) throw new Error('project_outcome_acceptance_outcome_cas');
      const [previous] = await tx.select({observedAt: schema.projectScopeOutcomeObservations.observedAt})
        .from(schema.projectScopeOutcomeObservations)
        .where(eq(schema.projectScopeOutcomeObservations.projectId, project.id))
        .orderBy(desc(schema.projectScopeOutcomeObservations.observedAt)).limit(1).for('update');
      const observedAt = previous !== undefined && previous.observedAt >= nowBase
        ? new Date(previous.observedAt.getTime() + 1) : nowBase;
      if (!everyOutcomeAccepted) {
        await tx.insert(schema.projectScopeOutcomeObservations).values({id: randomUUID(), projectId: project.id, baselineId: baseline.id, acceptedWeight, totalWeight, observedAt, evidenceReference: `outcome-acceptance:${outcome.id}:${command.commandId}`});
        resultVersion = execution.version; result = {ok: true, value: {projectId: project.id, outcomeId: outcome.id, acceptedWeight, totalWeight, executionStatus: execution.status, executionVersion: execution.version}};
        return complete(project.id, 'allow', claimed);
      }
      const [updated] = await tx.update(schema.projectExecutions).set({status: 'blocked', blockReason: 'uat_required', selectedWorkItemId: null, selectedPlanVersionId: null, selectedWorkItemVersion: null, selectedProtocolId: null, selectedProtocolVersion: null, selectedJourneyVersion: null, selectedStageKey: null, selectedResponsibleActorId: null, selectedAgentProfileId: null, selectedResponsibilityHash: null, pausedAt: null, completedAt: null, version: execution.version + 1, updatedAt: nowBase}).where(and(eq(schema.projectExecutions.projectId, project.id), eq(schema.projectExecutions.version, execution.version), eq(schema.projectExecutions.status, execution.status))).returning({version: schema.projectExecutions.version});
      if (updated === undefined) throw new Error('project_outcome_acceptance_execution_cas');
      await tx.insert(schema.projectScopeOutcomeObservations).values({id: randomUUID(), projectId: project.id, baselineId: baseline.id, acceptedWeight, totalWeight, observedAt, evidenceReference: `outcome-acceptance:${outcome.id}:${command.commandId}`});
      resultVersion = updated.version; result = {ok: true, value: {projectId: project.id, outcomeId: outcome.id, acceptedWeight, totalWeight, executionStatus: 'blocked', executionVersion: updated.version}};
      return complete(project.id, 'allow', claimed);
    });
  }
});
