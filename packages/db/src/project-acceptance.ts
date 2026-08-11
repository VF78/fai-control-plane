import {createHash, randomUUID} from 'node:crypto';
import {
  canonicalJson, validateDeliveryProtocolDefinition, validateDeploymentObservation, validateProjectUatCheckResults,
  type CommandError, type ProjectAcceptanceProjection, type ProjectUatChecklistItem
} from '@fai-control-plane/domain';
import type {ProjectAcceptanceCommand, ProjectAcceptanceStore} from '@fai-control-plane/application';
import {and, asc, desc, eq, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const PROJECT_UAT_PREPARE_COMMAND = 'project_uat.prepare.v1' as const;
const PROJECT_UAT_RECORD_RESULT_COMMAND = 'project_uat.record_result.v1' as const;
const PROJECT_UAT_SIGNOFF_COMMAND = 'project_uat.signoff.v1' as const;
const PROJECT_RELEASE_NOT_REQUIRED_COMMAND = 'project_release.not_required.v1' as const;
const PROJECT_EXECUTION_COMPLETE_COMMAND = 'project_execution.complete.v1' as const;

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Queryable = Database | Transaction;
type Result = Readonly<{ok: true; value: ProjectAcceptanceProjection}> |
  Readonly<{ok: false; error: CommandError}>;
const fail = (code: CommandError['code'], message: string): Result => ({ok: false, error: {code, message}});
const attemptReceiptKey = (command: ProjectAcceptanceCommand, requestHash: string): string =>
  `project-acceptance-attempt:v1:${createHash('sha256')
    .update(`${command.actor.actorId}:${requestHash}:${command.commandId}`)
    .digest('hex')}`;
const attemptAuditCommandId = (command: ProjectAcceptanceCommand, requestHash: string, reason: string): string =>
  `project-acceptance-attempt:v1:${createHash('sha256')
    .update(`${command.commandId}:${requestHash}:${reason}`)
    .digest('hex')}`;

const roleFor = async (tx: Queryable, workspaceId: string, projectId: string, actorId: string) => {
  const [actor] = await tx.select({id: schema.actors.id}).from(schema.actors).where(and(
    eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId), eq(schema.actors.type, 'human'),
    eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt))).limit(1);
  if (actor === undefined) return null;
  const [membership] = await tx.select({roles: schema.projectMemberships.roles}).from(schema.projectMemberships)
    .where(and(eq(schema.projectMemberships.projectId, projectId), eq(schema.projectMemberships.actorId, actorId),
      eq(schema.projectMemberships.active, true))).limit(1);
  return membership?.roles ?? null;
};

type ProtocolRow = typeof schema.projectUatProtocols.$inferSelect;
const releaseFact = async (tx: Queryable, protocol: ProtocolRow): Promise<ProjectAcceptanceProjection['release']> => {
  const deployments = await tx.select({id: schema.deployments.id, observedResult: schema.deployments.observedResult,
    smokeChecks: schema.deployments.smokeChecks, rollbackEvidence: schema.deployments.rollbackEvidence,
    startedAt: schema.deployments.startedAt, completedAt: schema.deployments.completedAt,
    observedAt: schema.deployments.observedAt})
    .from(schema.deployments).where(and(eq(schema.deployments.workspaceId, protocol.workspaceId),
      eq(schema.deployments.projectId, protocol.projectId), eq(schema.deployments.planVersionId, protocol.planVersionId),
      eq(schema.deployments.materializationId, protocol.materializationId), eq(schema.deployments.lifecycleVersion, 1),
      eq(schema.deployments.environment, protocol.requiredDeploymentEnvironment),
      eq(schema.deployments.status, 'observed'))).orderBy(desc(schema.deployments.observedAt), desc(schema.deployments.id));
  const successful = deployments.find((deployment) => {
    if (deployment.observedResult === null || deployment.smokeChecks === null ||
      deployment.rollbackEvidence === null || deployment.startedAt === null || deployment.completedAt === null) return false;
    const observation = validateDeploymentObservation({outcome: deployment.observedResult.outcome,
      reference: deployment.observedResult.reference, startedAt: deployment.startedAt.toISOString(),
      completedAt: deployment.completedAt.toISOString(), smokeChecks: deployment.smokeChecks,
      rollback: deployment.rollbackEvidence});
    return observation.ok && observation.value.outcome === 'succeeded' &&
      protocol.requiredSmokeChecks.every((required) => observation.value.smokeChecks.some((check) =>
        check.name === required && check.status === 'passed'));
  });
  if (successful !== undefined) return {state: 'deployment_observed', deploymentId: successful.id, waiver: null};
  const [waiver] = await tx.select().from(schema.projectReleaseWaivers)
    .where(eq(schema.projectReleaseWaivers.protocolId, protocol.id)).limit(1);
  return waiver === undefined ? {state: 'pending', deploymentId: null, waiver: null} : {
    state: 'not_required', deploymentId: null,
    waiver: {actorId: waiver.waivedByActorId, reason: waiver.reason, waivedAt: waiver.createdAt.toISOString()}
  };
};

export const loadProjectAcceptanceProjection = async (
  tx: Queryable, workspaceId: string, projectId: string
): Promise<ProjectAcceptanceProjection | null> => {
  const [protocol] = await tx.select().from(schema.projectUatProtocols).where(and(
    eq(schema.projectUatProtocols.workspaceId, workspaceId), eq(schema.projectUatProtocols.projectId, projectId)
  )).limit(1);
  if (protocol === undefined) return null;
  const [session] = await tx.select().from(schema.projectAcceptanceSessions)
    .where(and(eq(schema.projectAcceptanceSessions.protocolId, protocol.id),
      eq(schema.projectAcceptanceSessions.projectId, projectId))).limit(1);
  if (session === undefined) return null;
  const [latest] = await tx.select().from(schema.projectUatResults)
    .where(eq(schema.projectUatResults.protocolId, protocol.id))
    .orderBy(desc(schema.projectUatResults.sequence), desc(schema.projectUatResults.id)).limit(1);
  const signoffs = latest === undefined ? [] : await tx.select().from(schema.projectUatSignoffs)
    .where(and(eq(schema.projectUatSignoffs.protocolId, protocol.id), eq(schema.projectUatSignoffs.resultId, latest.id)));
  const productOwner = signoffs.find(({kind}) => kind === 'product_owner');
  const client = signoffs.find(({kind}) => kind === 'client_representative');
  const release = await releaseFact(tx, protocol);
  const scope = await completionScope(tx, protocol);
  const scopeBlockers = scope.valid && canonicalJson(scope.checklist as never) === canonicalJson(protocol.checklist as never)
    ? [] : scope.blockers.length > 0 ? scope.blockers : ['uat_protocol_binding_changed'];
  const blockers = [
    ...scopeBlockers,
    ...(latest?.outcome === 'passed' ? [] : ['uat_passed_required']),
    ...(productOwner === undefined ? ['product_owner_signoff_required'] : []),
    ...(client === undefined ? ['client_representative_signoff_required'] : []),
    ...(release.state === 'pending' ? ['release_evidence_or_waiver_required'] : [])
  ];
  return {
    protocol: {id: protocol.id, planVersionId: protocol.planVersionId,
      materializationId: protocol.materializationId, baselineId: protocol.baselineId,
      contentHash: protocol.contentHash, checklist: protocol.checklist,
      requiredSmokeChecks: protocol.requiredSmokeChecks,
      requiredDeploymentEnvironment: protocol.requiredDeploymentEnvironment,
      preparedByActorId: protocol.preparedByActorId,
      preparedAt: protocol.createdAt.toISOString()}, version: session.version,
    latestResult: latest === undefined ? null : {id: latest.id, outcome: latest.outcome, checks: latest.checks,
      recordedByActorId: latest.recordedByActorId, recordedAt: latest.createdAt.toISOString()},
    signoffs: {
      productOwner: productOwner === undefined ? null : {actorId: productOwner.actorId,
        evidenceReference: productOwner.evidenceReference, signedAt: productOwner.createdAt.toISOString()},
      clientRepresentative: client === undefined ? null : {actorId: client.actorId,
        evidenceReference: client.evidenceReference, signedAt: client.createdAt.toISOString()}
    }, release, completionReady: blockers.length === 0, blockers
  };
};

const completionScope = async (tx: Queryable, protocol: ProtocolRow): Promise<Readonly<{
  valid: boolean; blockers: readonly string[]; checklist: readonly ProjectUatChecklistItem[];
}>> => {
  const [materialization] = await tx.select().from(schema.projectPlanMaterializations).where(and(
    eq(schema.projectPlanMaterializations.id, protocol.materializationId),
    eq(schema.projectPlanMaterializations.workspaceId, protocol.workspaceId),
    eq(schema.projectPlanMaterializations.projectId, protocol.projectId),
    eq(schema.projectPlanMaterializations.planVersionId, protocol.planVersionId))).limit(1);
  const [baseline] = await tx.select().from(schema.projectScopeBaselineVersions).where(and(
    eq(schema.projectScopeBaselineVersions.id, protocol.baselineId),
    eq(schema.projectScopeBaselineVersions.projectId, protocol.projectId),
    eq(schema.projectScopeBaselineVersions.sourcePlanVersionId, protocol.planVersionId),
    eq(schema.projectScopeBaselineVersions.active, true))).limit(1);
  if (materialization === undefined || baseline === undefined) return {valid: false,
    blockers: ['active_approved_scope_binding_changed'], checklist: []};
  const outcomes = await tx.select().from(schema.projectScopeOutcomes).where(and(
    eq(schema.projectScopeOutcomes.baselineId, baseline.id),
    eq(schema.projectScopeOutcomes.sourcePlanVersionId, protocol.planVersionId)))
    .orderBy(asc(schema.projectScopeOutcomes.key), asc(schema.projectScopeOutcomes.id));
  const totalWeight = outcomes.reduce((total, outcome) => total + outcome.weight, 0);
  const outcomesAccepted = outcomes.length > 0 && totalWeight === 100 && outcomes.every((outcome) =>
    outcome.state === 'accepted' && outcome.acceptedByActorId !== null && outcome.acceptedAt !== null &&
    outcome.evidenceReference !== null);
  const items = await tx.select({id: schema.workItems.id, title: schema.workItems.title,
    sourceTaskKey: schema.workItems.sourceTaskKey, status: schema.workItems.status,
    blocked: schema.workItems.blocked, stageKey: schema.deliveryJourneys.stageKey,
    definition: schema.runbooks.definition, protocolState: schema.runbooks.protocolState,
    requirement: schema.deliveryJourneyEvidence.requirement})
    .from(schema.workItems).leftJoin(schema.deliveryJourneys, eq(schema.deliveryJourneys.workItemId, schema.workItems.id))
    .leftJoin(schema.runbooks, and(eq(schema.runbooks.id, schema.deliveryJourneys.protocolId),
      eq(schema.runbooks.version, schema.deliveryJourneys.protocolVersion)))
    .leftJoin(schema.deliveryJourneyEvidence, and(eq(schema.deliveryJourneyEvidence.workItemId, schema.workItems.id),
      eq(schema.deliveryJourneyEvidence.stageKey, schema.deliveryJourneys.stageKey)))
    .where(and(eq(schema.workItems.projectId, protocol.projectId),
      eq(schema.workItems.sourcePlanVersionId, protocol.planVersionId), isNull(schema.workItems.deletedAt)))
    .orderBy(asc(schema.workItems.sourceTaskKey), asc(schema.workItems.id));
  const grouped = new Map<string, {title: string; sourceTaskKey: string | null; status: string; blocked: boolean;
    stageKey: string | null; definition: unknown; protocolState: string | null; evidence: Set<string>}>();
  for (const item of items) {
    const current = grouped.get(item.id) ?? {...item, evidence: new Set<string>()};
    if (item.requirement !== null) current.evidence.add(item.requirement); grouped.set(item.id, current);
  }
  let journeysTerminal = grouped.size === materialization.workItemCount && grouped.size > 0;
  const journeyChecklist: ProjectUatChecklistItem[] = [];
  for (const [workItemId, item] of grouped) {
    const definition = validateDeliveryProtocolDefinition(item.definition);
    const stage = definition.ok && item.stageKey !== null
      ? definition.value.stages.find((candidate) => candidate.enabled && candidate.key === item.stageKey) : undefined;
    const terminal = stage !== undefined && item.status === 'done' && !item.blocked && stage.taskStatus === 'done' &&
      stage.allowedNextStageKey === null && ['published', 'retired'].includes(item.protocolState ?? '') &&
      stage.requiredEvidence.every((requirement) => item.evidence.has(requirement));
    journeysTerminal &&= terminal;
    journeyChecklist.push({key: `journey:${item.sourceTaskKey ?? workItemId}`, title: item.title,
      requiredEvidence: stage?.requiredEvidence ?? []});
  }
  const checklist: ProjectUatChecklistItem[] = [
    ...outcomes.map((outcome) => ({key: `outcome:${outcome.key}`, title: outcome.title,
      requiredEvidence: ['accepted_outcome_evidence']})), ...journeyChecklist
  ];
  const blockers = [...(!outcomesAccepted ? ['weighted_scope_acceptance_required'] : []),
    ...(!journeysTerminal ? ['terminal_delivery_evidence_required'] : [])];
  return {valid: blockers.length === 0, blockers, checklist};
};

const protocolFor = async (tx: Queryable, workspaceId: string, projectId: string, protocolId: string) => {
  const [protocol] = await tx.select().from(schema.projectUatProtocols).where(and(
    eq(schema.projectUatProtocols.id, protocolId), eq(schema.projectUatProtocols.workspaceId, workspaceId),
    eq(schema.projectUatProtocols.projectId, projectId))).limit(1);
  return protocol;
};

export const createPostgresProjectAcceptanceStore = (
  db: Database, options: Readonly<{now?: () => Date}> = {}
): ProjectAcceptanceStore => ({
  async execute(input) {
    return db.transaction(async (tx) => {
      const {command} = input; let result: Result = fail('INVALID_COMMAND', 'Project acceptance was not evaluated.');
      let resultVersion: number | undefined; let successReceipt: typeof schema.commandReceipts.$inferSelect | undefined;
      const complete = async (projectId?: string, policyDecision: 'allow' | 'deny' = input.authorized ? 'allow' : 'deny') => {
        const now = options.now?.() ?? new Date(); let stored = successReceipt; let idempotencyKey = command.idempotencyKey;
        if (!result.ok) {
          idempotencyKey = attemptReceiptKey(command, input.requestHash);
          const [inserted] = await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId,
            idempotencyKey, requestHash: input.requestHash, commandId: command.commandId,
            correlationId: command.correlationId, commandType: command.type, state: 'completed',
            aggregateType: 'project_acceptance', aggregateId: command.payload.projectId,
            expectedVersion: 'expectedVersion' in command.payload ? command.payload.expectedVersion : command.payload.expectedExecutionVersion,
            resultVersion, result, completedAt: now}).onConflictDoNothing({target: [schema.commandReceipts.workspaceId,
              schema.commandReceipts.idempotencyKey]}).returning();
          [stored] = inserted === undefined ? await tx.select().from(schema.commandReceipts).where(and(
            eq(schema.commandReceipts.workspaceId, command.workspaceId), eq(schema.commandReceipts.idempotencyKey, idempotencyKey)
          )).limit(1).for('update') : [inserted];
          if (stored === undefined || stored.state !== 'completed' || stored.result === null ||
            stored.requestHash !== input.requestHash) throw new Error('project_acceptance_attempt_receipt_incomplete');
        } else {
          if (stored === undefined) throw new Error('project_acceptance_success_receipt_unclaimed');
          await tx.update(schema.commandReceipts).set({state: 'completed', aggregateType: 'project_acceptance',
            aggregateId: command.payload.projectId,
            expectedVersion: 'expectedVersion' in command.payload ? command.payload.expectedVersion : command.payload.expectedExecutionVersion,
            resultVersion, result, completedAt: now}).where(eq(schema.commandReceipts.id, stored.id));
        }
        const completedResult = stored.result === null ? result : stored.result as Result;
        await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: command.workspaceId, projectId,
          actorId: command.actor.actorId, commandId: completedResult.ok ? command.commandId :
            attemptAuditCommandId(command, input.requestHash, completedResult.error.code), actionCategory: 'write',
          action: command.type, targetType: 'project_acceptance', targetId: command.payload.projectId,
          policyDecision, outcome: completedResult.ok ? 'succeeded' : policyDecision === 'deny' ? 'rejected' : 'failed',
          ...(!completedResult.ok ? {reasonCode: completedResult.error.code} : {}),
          expectedVersion: 'expectedVersion' in command.payload ? command.payload.expectedVersion : command.payload.expectedExecutionVersion,
          resultVersion, correlationId: command.correlationId, occurredAt: now, metadata: {}}
        ).onConflictDoNothing({target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]});
        return {status: 'completed' as const, receipt: {commandId: stored.commandId,
          workspaceId: command.workspaceId, correlationId: stored.correlationId, idempotencyKey,
          requestHash: stored.requestHash, commandType: command.type, result: completedResult,
          createdAt: stored.createdAt.toISOString()}};
      };
      if (!input.authorized) { result = fail(input.policyError?.code ?? 'POLICY_DENIED',
        input.policyError?.message ?? 'Policy denies project acceptance.'); return complete(undefined, 'deny'); }
      const [project] = await tx.select({id: schema.projects.id}).from(schema.projects).where(and(
        eq(schema.projects.id, command.payload.projectId), eq(schema.projects.workspaceId, command.workspaceId)
      )).limit(1).for('update');
      if (project === undefined) { result = fail('NOT_FOUND', 'Project was not found.'); return complete(); }
      const roles = await roleFor(tx, command.workspaceId, project.id, command.actor.actorId);
      const requiredRole = command.type === PROJECT_UAT_SIGNOFF_COMMAND &&
        command.payload.kind === 'client_representative' ? 'client_viewer' : 'project_owner';
      if (roles?.includes(requiredRole) !== true) { result = fail('CAPABILITY_DENIED', requiredRole === 'client_viewer'
        ? 'Only an active client representative can record the client signoff.'
        : 'Only the active Product Owner can perform this acceptance action.'); return complete(project.id, 'deny'); }
      const [existing] = await tx.select().from(schema.commandReceipts).where(and(
        eq(schema.commandReceipts.workspaceId, command.workspaceId),
        eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey))).limit(1).for('update');
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash) return {status: 'key_reused' as const,
          existingRequestHash: existing.requestHash};
        if (existing.state !== 'completed' || existing.result === null) throw new Error('project_acceptance_receipt_incomplete');
        return {status: 'replayed' as const, receipt: {commandId: existing.commandId,
          workspaceId: command.workspaceId, correlationId: existing.correlationId,
          idempotencyKey: command.idempotencyKey, requestHash: existing.requestHash,
          commandType: command.type, result: existing.result as never, createdAt: existing.createdAt.toISOString()}};
      }
      const now = options.now?.() ?? new Date();
      if (command.type === PROJECT_UAT_PREPARE_COMMAND) {
        const [execution] = await tx.select().from(schema.projectExecutions).where(
          eq(schema.projectExecutions.projectId, project.id)).limit(1).for('update');
        if (execution === undefined) { result = fail('NOT_FOUND', 'Project execution was not found.'); return complete(project.id); }
        if (execution.version !== command.payload.expectedExecutionVersion) { resultVersion = execution.version;
          result = fail('VERSION_CONFLICT', 'Project execution version conflicts.'); return complete(project.id); }
        if (!['blocked', 'paused'].includes(execution.status)) { result = fail('INVALID_TRANSITION',
          'UAT can be prepared only at a paused or blocked completion boundary.'); return complete(project.id); }
        const [existingProtocol] = await tx.select({id: schema.projectUatProtocols.id})
          .from(schema.projectUatProtocols).where(eq(schema.projectUatProtocols.projectId, project.id)).limit(1).for('update');
        if (existingProtocol !== undefined) { result = fail('INVALID_TRANSITION',
          'An immutable UAT protocol is already bound to this project.'); return complete(project.id); }
        const [materialization] = await tx.select().from(schema.projectPlanMaterializations).where(and(
          eq(schema.projectPlanMaterializations.workspaceId, command.workspaceId),
          eq(schema.projectPlanMaterializations.projectId, project.id)))
          .orderBy(desc(schema.projectPlanMaterializations.createdAt), desc(schema.projectPlanMaterializations.id)).limit(1);
        if (materialization === undefined) { result = fail('NOT_FOUND', 'Approved plan materialization was not found.');
          return complete(project.id); }
        const candidate = {id: command.payload.protocolId, workspaceId: command.workspaceId, projectId: project.id,
          planVersionId: materialization.planVersionId, materializationId: materialization.id,
          baselineId: materialization.baselineId} as ProtocolRow;
        const scope = await completionScope(tx, candidate);
        if (!scope.valid) { result = fail('INVALID_TRANSITION', `UAT prerequisites are incomplete: ${scope.blockers.join(', ')}.`);
          return complete(project.id); }
        const contentHash = createHash('sha256').update(canonicalJson({projectId: project.id,
          planVersionId: materialization.planVersionId, materializationId: materialization.id,
          baselineId: materialization.baselineId, checklist: scope.checklist,
          requiredSmokeChecks: command.payload.requiredSmokeChecks,
          requiredDeploymentEnvironment: command.payload.requiredDeploymentEnvironment} as never)).digest('hex');
        successReceipt = (await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId,
          idempotencyKey: command.idempotencyKey, requestHash: input.requestHash, commandId: command.commandId,
          correlationId: command.correlationId, commandType: command.type}).returning())[0];
        await tx.insert(schema.projectUatProtocols).values({id: command.payload.protocolId,
          workspaceId: command.workspaceId, projectId: project.id, planVersionId: materialization.planVersionId,
          materializationId: materialization.id, baselineId: materialization.baselineId,
          checklist: scope.checklist, requiredSmokeChecks: [...command.payload.requiredSmokeChecks],
          requiredDeploymentEnvironment: command.payload.requiredDeploymentEnvironment,
          contentHash, preparedByActorId: command.actor.actorId, commandId: command.commandId, createdAt: now});
        await tx.insert(schema.projectAcceptanceSessions).values({protocolId: command.payload.protocolId,
          projectId: project.id, version: 1, updatedAt: now}); resultVersion = 1;
      } else {
        const protocol = await protocolFor(tx, command.workspaceId, project.id, command.payload.protocolId);
        if (protocol === undefined) { result = fail('NOT_FOUND', 'Bound UAT protocol was not found.'); return complete(project.id); }
        const [session] = await tx.select().from(schema.projectAcceptanceSessions).where(and(
          eq(schema.projectAcceptanceSessions.protocolId, protocol.id),
          eq(schema.projectAcceptanceSessions.projectId, project.id))).limit(1).for('update');
        if (session === undefined) { result = fail('NOT_FOUND', 'Project acceptance session was not found.'); return complete(project.id); }
        if (session.version !== command.payload.expectedVersion) { resultVersion = session.version;
          result = fail('VERSION_CONFLICT', 'Project acceptance version conflicts.'); return complete(project.id); }
        const scope = await completionScope(tx, protocol);
        if (!scope.valid || canonicalJson(scope.checklist as never) !== canonicalJson(protocol.checklist as never)) {
          result = fail('INVALID_TRANSITION', 'The approved scope or terminal delivery evidence no longer matches the immutable UAT protocol.');
          return complete(project.id);
        }
        if (command.type === PROJECT_UAT_RECORD_RESULT_COMMAND) {
          const [latest] = await tx.select().from(schema.projectUatResults).where(
            eq(schema.projectUatResults.protocolId, protocol.id)).orderBy(desc(schema.projectUatResults.sequence)).limit(1);
          if (latest?.outcome === 'passed') { result = fail('INVALID_TRANSITION', 'A passed UAT result is already immutable.');
            return complete(project.id); }
          if (!validateProjectUatCheckResults(protocol.checklist, command.payload.outcome, command.payload.checks)) {
            result = fail('INVALID_COMMAND', 'UAT result must cover every checklist item with required evidence and artifacts.');
            return complete(project.id); }
          successReceipt = (await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId,
            idempotencyKey: command.idempotencyKey, requestHash: input.requestHash, commandId: command.commandId,
            correlationId: command.correlationId, commandType: command.type}).returning())[0];
          await tx.insert(schema.projectUatResults).values({id: command.payload.resultId, protocolId: protocol.id,
            sequence: (latest?.sequence ?? 0) + 1, outcome: command.payload.outcome, checks: command.payload.checks,
            recordedByActorId: command.actor.actorId, commandId: command.commandId, createdAt: now});
        } else if (command.type === PROJECT_UAT_SIGNOFF_COMMAND) {
          const [uatResult] = await tx.select().from(schema.projectUatResults).where(and(
            eq(schema.projectUatResults.id, command.payload.resultId),
            eq(schema.projectUatResults.protocolId, protocol.id), eq(schema.projectUatResults.outcome, 'passed')))
            .limit(1);
          const [latest] = await tx.select({id: schema.projectUatResults.id}).from(schema.projectUatResults)
            .where(eq(schema.projectUatResults.protocolId, protocol.id)).orderBy(desc(schema.projectUatResults.sequence)).limit(1);
          if (uatResult === undefined || latest?.id !== uatResult.id) { result = fail('INVALID_TRANSITION',
            'Signoff must bind to the latest passed UAT result.'); return complete(project.id); }
          const [existingSignoff] = await tx.select({id: schema.projectUatSignoffs.id})
            .from(schema.projectUatSignoffs).where(and(eq(schema.projectUatSignoffs.resultId, uatResult.id),
              eq(schema.projectUatSignoffs.kind, command.payload.kind))).limit(1);
          if (existingSignoff !== undefined) { result = fail('INVALID_TRANSITION',
            'This UAT result already has the requested immutable signoff.'); return complete(project.id); }
          successReceipt = (await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId,
            idempotencyKey: command.idempotencyKey, requestHash: input.requestHash, commandId: command.commandId,
            correlationId: command.correlationId, commandType: command.type}).returning())[0];
          await tx.insert(schema.projectUatSignoffs).values({protocolId: protocol.id, resultId: uatResult.id,
            kind: command.payload.kind, actorId: command.actor.actorId,
            evidenceReference: command.payload.evidenceReference, commandId: command.commandId, createdAt: now});
        } else if (command.type === PROJECT_RELEASE_NOT_REQUIRED_COMMAND) {
          const [existingWaiver] = await tx.select({id: schema.projectReleaseWaivers.id})
            .from(schema.projectReleaseWaivers).where(eq(schema.projectReleaseWaivers.protocolId, protocol.id)).limit(1);
          if (existingWaiver !== undefined) { result = fail('INVALID_TRANSITION',
            'This UAT protocol already has an immutable release waiver.'); return complete(project.id); }
          successReceipt = (await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId,
            idempotencyKey: command.idempotencyKey, requestHash: input.requestHash, commandId: command.commandId,
            correlationId: command.correlationId, commandType: command.type}).returning())[0];
          await tx.insert(schema.projectReleaseWaivers).values({protocolId: protocol.id, reason: command.payload.reason,
            waivedByActorId: command.actor.actorId, commandId: command.commandId, createdAt: now});
        } else if (command.type === PROJECT_EXECUTION_COMPLETE_COMMAND) {
          const [execution] = await tx.select().from(schema.projectExecutions).where(
            eq(schema.projectExecutions.projectId, project.id)).limit(1).for('update');
          if (execution === undefined) { result = fail('NOT_FOUND', 'Project execution was not found.');
            return complete(project.id); }
          if (execution.version !== command.payload.expectedExecutionVersion) { resultVersion = execution.version;
            result = fail('VERSION_CONFLICT', 'Project execution version conflicts.');
            return complete(project.id); }
          if (execution.status !== 'blocked' && execution.status !== 'paused') { result = fail('INVALID_TRANSITION',
            'Project completion requires a paused or blocked execution boundary.');
            return complete(project.id); }
          const projection = await loadProjectAcceptanceProjection(tx, command.workspaceId, project.id);
          if (projection === null || !projection.completionReady) { result = fail('INVALID_TRANSITION',
            `Project completion prerequisites are incomplete: ${projection?.blockers.join(', ') ?? 'uat_protocol_required'}.`);
            return complete(project.id); }
          successReceipt = (await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId,
            idempotencyKey: command.idempotencyKey, requestHash: input.requestHash, commandId: command.commandId,
            correlationId: command.correlationId, commandType: command.type}).returning())[0];
          const [updated] = await tx.update(schema.projectExecutions).set({status: 'completed', blockReason: null,
            selectedWorkItemId: null, selectedPlanVersionId: null, selectedWorkItemVersion: null,
            selectedProtocolId: null, selectedProtocolVersion: null, selectedJourneyVersion: null,
            selectedStageKey: null, selectedResponsibleActorId: null, selectedAgentProfileId: null,
            selectedResponsibilityHash: null,
            pausedAt: null, completedAt: now, version: execution.version + 1, updatedAt: now})
            .where(and(eq(schema.projectExecutions.projectId, project.id),
              eq(schema.projectExecutions.version, execution.version), eq(schema.projectExecutions.status, execution.status)))
            .returning({version: schema.projectExecutions.version});
          if (updated === undefined) throw new Error('project_acceptance_execution_cas');
        }
        const [updatedSession] = await tx.update(schema.projectAcceptanceSessions).set({version: session.version + 1,
          updatedAt: now}).where(and(eq(schema.projectAcceptanceSessions.protocolId, protocol.id),
          eq(schema.projectAcceptanceSessions.version, session.version))).returning({version: schema.projectAcceptanceSessions.version});
        if (updatedSession === undefined) throw new Error('project_acceptance_session_cas');
        resultVersion = updatedSession.version;
      }
      const projection = await loadProjectAcceptanceProjection(tx, command.workspaceId, project.id);
      if (projection === null) throw new Error('project_acceptance_projection_missing');
      result = {ok: true, value: projection}; return complete(project.id);
    });
  }
});
