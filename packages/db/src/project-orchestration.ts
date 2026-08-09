import {randomUUID} from 'node:crypto';
import {
  firstEnabledDeliveryStage,
  validateDeliveryProtocolDefinition,
  type CommandError,
  type DeliveryProtocolResponsibility,
  type ProjectDecisionQueueItem,
  type ProjectExecutionProjection,
  type ProjectExecutionSelection
} from '@fai-control-plane/domain';
import type {ProjectExecutionStore} from '@fai-control-plane/application';
import {and, asc, desc, eq, inArray, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Queryable = Database | Transaction;
type ExecutionRow = typeof schema.projectExecutions.$inferSelect;
type StoreResult = Readonly<{ok: true; value: ProjectExecutionProjection}> |
  Readonly<{ok: false; error: CommandError}>;
const failure = (code: CommandError['code'], message: string): StoreResult => ({ok: false, error: {code, message}});

const authority = async (tx: Queryable, workspaceId: string, projectId: string, actorId: string) => {
  const [actor] = await tx.select({role: schema.actors.role}).from(schema.actors).where(and(
    eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId),
    eq(schema.actors.type, 'human'), eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt)
  )).limit(1);
  if (actor === undefined) return false;
  const [membership] = await tx.select({role: schema.projectMemberships.role, active: schema.projectMemberships.active})
    .from(schema.projectMemberships).where(and(
      eq(schema.projectMemberships.projectId, projectId), eq(schema.projectMemberships.actorId, actorId)
    )).limit(1);
  return actor.role === 'workspace_admin' || actor.role === 'delivery_lead' ||
    membership?.active === true && (membership.role === 'workspace_owner' || membership.role === 'project_owner');
};

const responsibleActor = async (
  tx: Queryable,
  workspaceId: string,
  projectId: string,
  responsibility: DeliveryProtocolResponsibility
): Promise<ProjectExecutionSelection['responsibleActor'] | null> => {
  const roleActors = responsibility.kind === 'project_role'
    ? await tx.select({actorId: schema.projectMemberships.actorId}).from(schema.projectMemberships)
        .innerJoin(schema.actors, eq(schema.actors.id, schema.projectMemberships.actorId))
        .where(and(eq(schema.projectMemberships.projectId, projectId), eq(schema.projectMemberships.role, responsibility.role),
          eq(schema.projectMemberships.active, true), eq(schema.actors.workspaceId, workspaceId), eq(schema.actors.type, 'human'),
          isNull(schema.actors.disabledAt))).orderBy(asc(schema.actors.id)).limit(2)
    : [];
  if (responsibility.kind === 'project_role' && roleActors.length !== 1) return null;
  const actorId = responsibility.kind === 'project_role' ? roleActors[0]!.actorId : responsibility.actorId;
  if (actorId === undefined) return null;
  const [binding] = await tx.select({
    id: schema.actors.id, displayName: schema.actors.displayName, type: schema.actors.type,
    membershipActive: schema.projectMemberships.active
  }).from(schema.actors).innerJoin(schema.projectMemberships, and(
    eq(schema.projectMemberships.actorId, schema.actors.id), eq(schema.projectMemberships.projectId, projectId)
  )).where(and(eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId),
    eq(schema.projectMemberships.active, true), isNull(schema.actors.disabledAt))).limit(1);
  if (binding === undefined || (binding.type !== 'human' && binding.type !== 'agent')) return null;
  if (responsibility.kind === 'actor' && responsibility.actorType !== binding.type) return null;
  let agentProfileId: string | null = null;
  if (responsibility.kind === 'actor' && responsibility.actorType === 'agent') {
    const [profile] = await tx.select({id: schema.agentProfiles.id}).from(schema.agentProfiles)
      .innerJoin(schema.runtimeRegistrations, and(
        eq(schema.runtimeRegistrations.agentProfileId, schema.agentProfiles.id),
        eq(schema.runtimeRegistrations.actorId, schema.agentProfiles.actorId)
      )).where(and(eq(schema.agentProfiles.id, responsibility.agentProfileId),
        eq(schema.agentProfiles.actorId, binding.id), eq(schema.agentProfiles.workspaceId, workspaceId),
        eq(schema.agentProfiles.enabled, true), eq(schema.runtimeRegistrations.projectId, projectId),
        eq(schema.runtimeRegistrations.enabled, true))).limit(1);
    if (profile === undefined) return null;
    agentProfileId = profile.id;
  }
  return {id: binding.id, displayName: binding.displayName, type: binding.type, agentProfileId};
};

const selectionFor = async (
  tx: Queryable,
  workspaceId: string,
  projectId: string,
  workItemId: string
): Promise<ProjectExecutionSelection | null> => {
  const [record] = await tx.select({
    workItemId: schema.workItems.id, title: schema.workItems.title,
    workItemVersion: schema.workItems.version, planVersionId: schema.workItems.sourcePlanVersionId,
    workItemStatus: schema.workItems.status, workItemBlocked: schema.workItems.blocked,
    protocolId: schema.deliveryJourneys.protocolId,
    protocolVersion: schema.deliveryJourneys.protocolVersion, journeyVersion: schema.deliveryJourneys.version,
    stageKey: schema.deliveryJourneys.stageKey, definition: schema.runbooks.definition,
    protocolState: schema.runbooks.protocolState, active: schema.runbooks.active
  }).from(schema.workItems).innerJoin(schema.projects, eq(schema.projects.id, schema.workItems.projectId))
    .innerJoin(schema.deliveryJourneys, eq(schema.deliveryJourneys.workItemId, schema.workItems.id))
    .innerJoin(schema.runbooks, and(eq(schema.runbooks.id, schema.deliveryJourneys.protocolId),
      eq(schema.runbooks.version, schema.deliveryJourneys.protocolVersion)))
    .where(and(eq(schema.workItems.id, workItemId), eq(schema.workItems.projectId, projectId),
      eq(schema.projects.workspaceId, workspaceId), isNull(schema.workItems.deletedAt))).limit(1);
  if (record === undefined || record.planVersionId === null || record.workItemStatus !== 'ready' || record.workItemBlocked ||
    record.protocolState !== 'published' || !record.active) return null;
  const definition = validateDeliveryProtocolDefinition(record.definition);
  if (!definition.ok) return null;
  const stage = firstEnabledDeliveryStage({
    id: record.protocolId, projectId, name: '', version: record.protocolVersion, revision: 1,
    state: 'published', active: true, definition: definition.value, contentHash: ''
  });
  if (stage === null || stage.key !== record.stageKey) return null;
  const actor = await responsibleActor(tx, workspaceId, projectId, stage.responsibility);
  if (actor === null) return null;
  const boundary = stage.executionMode === 'autonomous'
    ? actor.type === 'agent' && actor.agentProfileId !== null ? 'autonomous_ready' : 'autonomous_agent_required'
    : stage.executionMode === 'human_approval' ? 'human_confirmation_required'
    : 'provider_handoff_required';
  return {
    planVersionId: record.planVersionId, workItemId: record.workItemId, title: record.title,
    workItemVersion: record.workItemVersion,
    protocolId: record.protocolId, protocolVersion: record.protocolVersion,
    journeyVersion: record.journeyVersion, stageKey: stage.key, stageName: stage.name,
    executionMode: stage.executionMode, responsibleActor: actor, boundary
  };
};

const hasHumanOwnedAutonomousStage = async (
  tx: Queryable,
  workspaceId: string,
  projectId: string,
  workItemId: string
) => {
  const [record] = await tx.select({definition: schema.runbooks.definition, stageKey: schema.deliveryJourneys.stageKey})
    .from(schema.workItems).innerJoin(schema.projects, eq(schema.projects.id, schema.workItems.projectId))
    .innerJoin(schema.deliveryJourneys, eq(schema.deliveryJourneys.workItemId, schema.workItems.id))
    .innerJoin(schema.runbooks, and(eq(schema.runbooks.id, schema.deliveryJourneys.protocolId),
      eq(schema.runbooks.version, schema.deliveryJourneys.protocolVersion)))
    .where(and(eq(schema.workItems.id, workItemId), eq(schema.workItems.projectId, projectId),
      eq(schema.projects.workspaceId, workspaceId), eq(schema.runbooks.protocolState, 'published'),
      eq(schema.runbooks.active, true), isNull(schema.workItems.deletedAt))).limit(1);
  if (record === undefined || typeof record.definition !== 'object' || record.definition === null) return false;
  const stages = (record.definition as {stages?: unknown}).stages;
  if (!Array.isArray(stages)) return false;
  const first = stages.find((stage) => typeof stage === 'object' && stage !== null &&
    (stage as {enabled?: unknown}).enabled === true) as Record<string, unknown> | undefined;
  if (first === undefined || first.key !== record.stageKey || first.executionMode !== 'autonomous' ||
    typeof first.responsibility !== 'object' || first.responsibility === null) return false;
  const responsibility = first.responsibility as Record<string, unknown>;
  return responsibility.kind !== 'actor' || responsibility.actorType !== 'agent';
};

const decisionQueue = async (
  tx: Queryable,
  projectId: string,
  selection: ProjectExecutionSelection | null,
  blockReason: string | null,
  staleWorkItemId: string | null
): Promise<readonly ProjectDecisionQueueItem[]> => {
  const [approvals, runHistory, publications] = await Promise.all([
    tx.select({id: schema.approvalRequests.id, workItemId: schema.approvalRequests.workItemId,
      agentRunId: schema.approvalRequests.agentRunId, createdAt: schema.approvalRequests.createdAt})
      .from(schema.approvalRequests).where(and(eq(schema.approvalRequests.projectId, projectId),
        eq(schema.approvalRequests.status, 'pending'))).orderBy(schema.approvalRequests.createdAt, schema.approvalRequests.id),
    tx.select({id: schema.agentRuns.id, workItemId: schema.agentRuns.workItemId,
      status: schema.agentRuns.status,
      failureCode: schema.agentRuns.failureCode, updatedAt: schema.agentRuns.updatedAt})
      .from(schema.agentRuns).innerJoin(schema.workItems, eq(schema.workItems.id, schema.agentRuns.workItemId))
      .where(and(eq(schema.workItems.projectId, projectId), isNull(schema.workItems.deletedAt)))
      .orderBy(desc(schema.agentRuns.updatedAt), desc(schema.agentRuns.id)),
    selection === null ? Promise.resolve([]) : tx.select({id: schema.projectPublicationIntents.id,
      surface: schema.projectPublicationIntents.surface, createdAt: schema.projectPublicationIntents.createdAt})
      .from(schema.projectPublicationIntents).where(and(
        eq(schema.projectPublicationIntents.projectId, projectId),
        eq(schema.projectPublicationIntents.resourceKind, 'work_item'),
        eq(schema.projectPublicationIntents.canonicalId, selection.workItemId),
        eq(schema.projectPublicationIntents.state, 'desired')
      )).orderBy(schema.projectPublicationIntents.createdAt, schema.projectPublicationIntents.id)
  ]);
  const approvalRunIds = approvals.flatMap(({agentRunId}) => agentRunId === null ? [] : [agentRunId]);
  const approvalWorkItemIds = approvals.flatMap(({workItemId}) => workItemId === null ? [] : [workItemId]);
  const approvalRunTargets = approvalRunIds.length === 0 ? [] : await tx.select({id: schema.agentRuns.id, workItemId: schema.agentRuns.workItemId})
    .from(schema.agentRuns).innerJoin(schema.workItems, eq(schema.workItems.id, schema.agentRuns.workItemId))
    .where(and(inArray(schema.agentRuns.id, approvalRunIds), eq(schema.workItems.projectId, projectId),
      isNull(schema.workItems.deletedAt)));
  const approvalWorkItemTargets = approvalWorkItemIds.length === 0 ? [] : await tx.select({id: schema.workItems.id})
    .from(schema.workItems).where(and(inArray(schema.workItems.id, approvalWorkItemIds),
      eq(schema.workItems.projectId, projectId), isNull(schema.workItems.deletedAt)));
  const workItemByRun = new Map(approvalRunTargets.map(({id, workItemId}) => [id, workItemId]));
  const ownedWorkItemIds = new Set(approvalWorkItemTargets.map(({id}) => id));
  const latestRunByItem = new Map<string, (typeof runHistory)[number]>();
  for (const run of runHistory) if (!latestRunByItem.has(run.workItemId)) latestRunByItem.set(run.workItemId, run);
  const decisions: ProjectDecisionQueueItem[] = approvals.filter((approval) => approval.workItemId === null
    ? approval.agentRunId !== null && workItemByRun.has(approval.agentRunId)
    : ownedWorkItemIds.has(approval.workItemId)).map((approval) => ({
    id: `approval:${approval.id}`, kind: 'approval', source: 'approval',
    workItemId: approval.workItemId ?? (approval.agentRunId === null ? null : workItemByRun.get(approval.agentRunId) ?? null),
    targetId: approval.id, summary: 'Требуется явное решение по запросу на подтверждение.',
    nextAction: 'Открыть задачу и принять или отклонить запрос.', createdAt: approval.createdAt.toISOString()
  }));
  decisions.push(...[...latestRunByItem.values()].filter(({status}) => status === 'failed').map((run) => ({
    id: `agent_run:${run.id}`, kind: 'failure' as const, source: 'agent_run' as const,
    workItemId: run.workItemId, targetId: run.id,
    summary: run.failureCode === null ? 'Последний запуск завершился ошибкой.' : `Последний запуск завершился ошибкой: ${run.failureCode}.`,
    nextAction: 'Проверить receipt и выбрать безопасное следующее действие.', createdAt: run.updatedAt.toISOString()
  })));
  if (selection?.boundary === 'human_confirmation_required') decisions.push({
    id: `protocol:${selection.workItemId}:${selection.stageKey}:approval`, kind: 'approval', source: 'delivery_protocol',
    workItemId: selection.workItemId, targetId: selection.workItemId,
    summary: `Этап «${selection.stageName}» требует подтверждения человека.`,
    nextAction: `Получить явное подтверждение от ${selection.responsibleActor.displayName}; автоматический переход запрещён.`, createdAt: null
  });
  if (selection?.boundary === 'autonomous_agent_required') decisions.push({
    id: `protocol:${selection.workItemId}:${selection.stageKey}:agent_required`, kind: 'failure', source: 'delivery_protocol',
    workItemId: selection.workItemId, targetId: selection.workItemId,
    summary: `Автономный этап «${selection.stageName}» назначен не ИИ-агенту.`,
    nextAction: 'Назначить активного ИИ-агента с включёнными profile и runtime registration для этого проекта.', createdAt: null
  });
  if (selection === null && blockReason === 'autonomous_agent_required') decisions.push({
    id: `protocol:${projectId}:agent_required`, kind: 'failure', source: 'delivery_protocol',
    workItemId: null, targetId: projectId,
    summary: 'Автономный этап назначен человеку или роли, не являющейся ИИ-агентом.',
    nextAction: 'Исправить протокол: назначить активного ИИ-агента с включёнными profile и runtime registration.', createdAt: null
  });
  if (selection?.boundary === 'provider_handoff_required') decisions.push({
    id: `protocol:${selection.workItemId}:${selection.stageKey}:handoff`, kind: 'provider_handoff', source: 'delivery_protocol',
    workItemId: selection.workItemId, targetId: selection.workItemId,
    summary: `Этап «${selection.stageName}» выполняется вручную.`,
    nextAction: `Передать работу ответственному: ${selection.responsibleActor.displayName}. Внешняя запись ещё не выполнялась.`, createdAt: null
  });
  decisions.push(...publications.map((publication) => ({
    id: `publication:${publication.id}`, kind: 'provider_handoff' as const, source: 'publication' as const,
    workItemId: selection?.workItemId ?? null, targetId: publication.id,
    summary: `Желаемая публикация в ${publication.surface} ещё не подтверждена наблюдением.`,
    nextAction: 'Подключить или проверить provider adapter; каноническая команда не выполняет внешнюю запись.',
    createdAt: publication.createdAt.toISOString()
  })));
  if (blockReason === 'selection_preconditions_stale') decisions.push({
    id: `selection:${staleWorkItemId ?? projectId}:stale`, kind: 'failure', source: 'delivery_protocol',
    workItemId: staleWorkItemId, targetId: staleWorkItemId ?? projectId,
    summary: 'Сохранённый выбор больше не соответствует плану, протоколу, пути или ответственному.',
    nextAction: 'Повторить Resume с актуальной версией после проверки новых условий; работа не считается запущенной.', createdAt: null
  });
  return decisions.slice(0, 50);
};

const selectionSnapshot = (selection: ProjectExecutionSelection | null) => selection === null ? {
  selectedWorkItemId: null, selectedPlanVersionId: null, selectedWorkItemVersion: null,
  selectedProtocolId: null, selectedProtocolVersion: null, selectedJourneyVersion: null,
  selectedStageKey: null, selectedResponsibleActorId: null, selectedAgentProfileId: null
} : {
  selectedWorkItemId: selection.workItemId, selectedPlanVersionId: selection.planVersionId,
  selectedWorkItemVersion: selection.workItemVersion, selectedProtocolId: selection.protocolId,
  selectedProtocolVersion: selection.protocolVersion, selectedJourneyVersion: selection.journeyVersion,
  selectedStageKey: selection.stageKey, selectedResponsibleActorId: selection.responsibleActor.id,
  selectedAgentProfileId: selection.responsibleActor.agentProfileId
};

const persistedSelection = async (
  tx: Queryable,
  workspaceId: string,
  projectId: string,
  row: ExecutionRow
): Promise<Readonly<{selection: ProjectExecutionSelection | null; stale: boolean}>> => {
  if (row.selectedWorkItemId === null) return {selection: null, stale: false};
  const selection = await selectionFor(tx, workspaceId, projectId, row.selectedWorkItemId);
  if (selection === null) return {selection: null, stale: true};
  const [materializations, dependencies] = await Promise.all([
    tx.select({planVersionId: schema.projectPlanMaterializations.planVersionId})
      .from(schema.projectPlanMaterializations).where(and(
        eq(schema.projectPlanMaterializations.workspaceId, workspaceId),
        eq(schema.projectPlanMaterializations.projectId, projectId)
      )).orderBy(desc(schema.projectPlanMaterializations.createdAt), desc(schema.projectPlanMaterializations.id)).limit(1),
    tx.select({status: schema.workItems.status}).from(schema.workItemDependencies)
      .innerJoin(schema.workItems, eq(schema.workItems.id, schema.workItemDependencies.dependsOnWorkItemId))
      .where(eq(schema.workItemDependencies.workItemId, row.selectedWorkItemId))
  ]);
  const snapshot = selectionSnapshot(selection);
  const matches = materializations[0]?.planVersionId === selection.planVersionId &&
    dependencies.every(({status}) => status === 'done') &&
    row.selectedPlanVersionId === snapshot.selectedPlanVersionId &&
    row.selectedWorkItemVersion === snapshot.selectedWorkItemVersion &&
    row.selectedProtocolId === snapshot.selectedProtocolId &&
    row.selectedProtocolVersion === snapshot.selectedProtocolVersion &&
    row.selectedJourneyVersion === snapshot.selectedJourneyVersion &&
    row.selectedStageKey === snapshot.selectedStageKey &&
    row.selectedResponsibleActorId === snapshot.selectedResponsibleActorId &&
    row.selectedAgentProfileId === snapshot.selectedAgentProfileId;
  return matches ? {selection, stale: false} : {selection: null, stale: true};
};

const projectionFrom = async (
  tx: Queryable,
  workspaceId: string,
  projectId: string,
  row: ExecutionRow | undefined
): Promise<ProjectExecutionProjection> => {
  const persisted = row === undefined ? {selection: null, stale: false} : await persistedSelection(tx, workspaceId, projectId, row);
  const staleRunningSelection = persisted.stale && (row?.status === 'running' || row?.status === 'blocked');
  const status = staleRunningSelection ? 'blocked' : row?.status ?? 'stopped';
  const blockReason = staleRunningSelection ? 'selection_preconditions_stale' : row?.blockReason ?? null;
  return {
    projectId, status, version: row?.version ?? 0,
    selection: persisted.selection, blockReason,
    decisions: await decisionQueue(tx, projectId, persisted.selection,
      persisted.stale ? 'selection_preconditions_stale' : blockReason, row?.selectedWorkItemId ?? null),
    startedAt: row?.startedAt.toISOString() ?? null, pausedAt: row?.pausedAt?.toISOString() ?? null,
    completedAt: row?.completedAt?.toISOString() ?? null, updatedAt: row?.updatedAt.toISOString() ?? null
  };
};

export const loadProjectExecutionProjection = async (
  db: Queryable,
  workspaceId: string,
  projectId: string
): Promise<ProjectExecutionProjection> => {
  const [project] = await db.select({id: schema.projects.id}).from(schema.projects).where(and(
    eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, workspaceId)
  )).limit(1);
  if (project === undefined) return {
    projectId, status: 'stopped', version: 0, selection: null, blockReason: null,
    decisions: [], startedAt: null, pausedAt: null, completedAt: null, updatedAt: null
  };
  const [row] = await db.select().from(schema.projectExecutions)
    .where(eq(schema.projectExecutions.projectId, projectId)).limit(1);
  return projectionFrom(db, workspaceId, projectId, row);
};

const nextState = async (tx: Transaction, workspaceId: string, projectId: string) => {
  const [materialization] = await tx.select({planVersionId: schema.projectPlanMaterializations.planVersionId})
    .from(schema.projectPlanMaterializations).where(and(
      eq(schema.projectPlanMaterializations.workspaceId, workspaceId),
      eq(schema.projectPlanMaterializations.projectId, projectId)
    )).orderBy(desc(schema.projectPlanMaterializations.createdAt), desc(schema.projectPlanMaterializations.id)).limit(1);
  if (materialization === undefined) return {status: 'blocked' as const, selection: null, blockReason: 'plan_not_materialized'};
  const items = await tx.select({id: schema.workItems.id, status: schema.workItems.status,
    blocked: schema.workItems.blocked, sourceTaskKey: schema.workItems.sourceTaskKey})
    .from(schema.workItems).where(and(eq(schema.workItems.projectId, projectId),
      eq(schema.workItems.sourcePlanVersionId, materialization.planVersionId), isNull(schema.workItems.deletedAt)))
    .orderBy(asc(schema.workItems.sourceTaskKey), asc(schema.workItems.id)).for('update');
  if (items.length > 0 && items.every(({status}) => status === 'done')) {
    return {status: 'completed' as const, selection: null, blockReason: null};
  }
  const dependencies = items.length === 0 ? [] : await tx.select({
    workItemId: schema.workItemDependencies.workItemId,
    dependsOnWorkItemId: schema.workItemDependencies.dependsOnWorkItemId
  }).from(schema.workItemDependencies).where(inArray(schema.workItemDependencies.workItemId, items.map(({id}) => id)));
  const statusById = new Map(items.map(({id, status}) => [id, status]));
  const candidates = items.filter((item) => item.status === 'ready' && !item.blocked &&
    dependencies.filter(({workItemId}) => workItemId === item.id)
      .every(({dependsOnWorkItemId}) => statusById.get(dependsOnWorkItemId) === 'done'));
  for (const candidate of candidates) {
    const selection = await selectionFor(tx, workspaceId, projectId, candidate.id);
    if (selection === null) {
      if (await hasHumanOwnedAutonomousStage(tx, workspaceId, projectId, candidate.id)) {
        return {status: 'blocked' as const, selection: null, blockReason: 'autonomous_agent_required'};
      }
      continue;
    }
    return selection.boundary === 'autonomous_ready'
      ? {status: 'running' as const, selection, blockReason: null}
      : {status: 'blocked' as const,
          selection: selection.boundary === 'autonomous_agent_required' ? null : selection,
          blockReason: selection.boundary === 'human_confirmation_required'
            ? 'human_confirmation_required' : selection.boundary === 'autonomous_agent_required'
              ? 'autonomous_agent_required' : 'provider_handoff_required'};
  }
  return {status: 'blocked' as const, selection: null,
    blockReason: candidates.length === 0 ? 'no_ready_unblocked_work_item' : 'delivery_protocol_not_ready'};
};

export const createPostgresProjectExecutionStore = (db: Database): ProjectExecutionStore => ({
  async execute(input) {
    return db.transaction(async (tx) => {
      const {command} = input;
      const [claimed] = await tx.insert(schema.commandReceipts).values({
        workspaceId: command.workspaceId, idempotencyKey: command.idempotencyKey,
        requestHash: input.requestHash, commandId: command.commandId,
        correlationId: command.correlationId, commandType: command.type
      }).onConflictDoNothing({target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]}).returning();
      if (claimed === undefined) {
        const [existing] = await tx.select().from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.workspaceId, command.workspaceId),
          eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
        )).for('update');
        if (existing === undefined || existing.requestHash !== input.requestHash) {
          return {status: 'key_reused' as const, existingRequestHash: existing?.requestHash ?? ''};
        }
        if (existing.state !== 'completed' || existing.result === null) throw new Error('project_execution_receipt_incomplete');
        return {status: 'replayed' as const, receipt: {
          commandId: existing.commandId, workspaceId: command.workspaceId,
          correlationId: existing.correlationId, idempotencyKey: command.idempotencyKey,
          requestHash: existing.requestHash, commandType: command.type,
          result: existing.result as never, createdAt: existing.createdAt.toISOString()
        }};
      }
      let result: StoreResult;
      let resultVersion: number | undefined;
      const complete = async () => {
        const now = new Date();
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(), workspaceId: command.workspaceId, projectId: command.payload.projectId,
          actorId: command.actor.actorId, commandId: command.commandId,
          actionCategory: 'write', action: command.type, targetType: 'project_execution',
          targetId: command.payload.projectId, policyDecision: input.authorized ? 'allow' : 'deny',
          outcome: result.ok ? 'succeeded' : input.authorized ? 'failed' : 'rejected',
          ...(!result.ok ? {reasonCode: result.error.code} : {}),
          expectedVersion: command.payload.expectedVersion, resultVersion,
          correlationId: command.correlationId, occurredAt: now
        });
        await tx.update(schema.commandReceipts).set({
          state: 'completed', aggregateType: 'project_execution', aggregateId: command.payload.projectId,
          expectedVersion: command.payload.expectedVersion, resultVersion, result, completedAt: now
        }).where(eq(schema.commandReceipts.id, claimed.id));
        return {status: 'completed' as const, receipt: {
          commandId: command.commandId, workspaceId: command.workspaceId,
          correlationId: command.correlationId, idempotencyKey: command.idempotencyKey,
          requestHash: input.requestHash, commandType: command.type, result,
          createdAt: claimed.createdAt.toISOString()
        }};
      };
      if (!input.authorized) {
        result = failure(input.policyError?.code ?? 'POLICY_DENIED', input.policyError?.message ?? 'Policy denies this command.');
        return complete();
      }
      const [project] = await tx.select({id: schema.projects.id}).from(schema.projects).where(and(
        eq(schema.projects.id, command.payload.projectId), eq(schema.projects.workspaceId, command.workspaceId)
      )).limit(1).for('update');
      if (project === undefined) { result = failure('NOT_FOUND', 'Project was not found.'); return complete(); }
      if (!await authority(tx, command.workspaceId, project.id, command.actor.actorId)) {
        result = failure('CAPABILITY_DENIED', 'Only an active project owner or delivery administrator can control execution.');
        return complete();
      }
      const [current] = await tx.select().from(schema.projectExecutions)
        .where(eq(schema.projectExecutions.projectId, project.id)).limit(1).for('update');
      if ((current?.version ?? 0) !== command.payload.expectedVersion) {
        resultVersion = current?.version ?? 0; result = failure('VERSION_CONFLICT', 'Project execution version conflicts.'); return complete();
      }
      const now = new Date();
      if (current !== undefined && (current.status === 'running' || current.status === 'blocked')) {
        const persisted = await persistedSelection(tx, command.workspaceId, project.id, current);
        if (persisted.stale) {
          resultVersion = current.version + 1;
          await tx.update(schema.projectExecutions).set({status: 'blocked', blockReason: 'selection_preconditions_stale',
            ...selectionSnapshot(null), pausedAt: null, completedAt: null, version: resultVersion, updatedAt: now})
            .where(and(eq(schema.projectExecutions.projectId, project.id), eq(schema.projectExecutions.version, current.version)));
          result = failure('VERSION_CONFLICT', 'Selection preconditions changed; execution was reconciled to blocked.');
          return complete();
        }
      }
      if (command.type === 'project_execution.start') {
        if (current !== undefined) { result = failure('INVALID_TRANSITION', 'Project execution was already started.'); return complete(); }
        const state = await nextState(tx, command.workspaceId, project.id);
        [resultVersion] = [1];
        await tx.insert(schema.projectExecutions).values({projectId: project.id, status: state.status,
          blockReason: state.blockReason, ...selectionSnapshot(state.selection), version: 1,
          startedAt: now, completedAt: state.status === 'completed' ? now : null, updatedAt: now});
      } else if (command.type === 'project_execution.pause') {
        if (current === undefined || (current.status !== 'running' && current.status !== 'blocked')) {
          result = failure('INVALID_TRANSITION', 'Only running or blocked project execution can be paused.'); return complete();
        }
        resultVersion = current.version + 1;
        await tx.update(schema.projectExecutions).set({status: 'paused', blockReason: null,
          pausedAt: now, completedAt: null, version: resultVersion, updatedAt: now})
          .where(and(eq(schema.projectExecutions.projectId, project.id), eq(schema.projectExecutions.version, current.version)));
      } else {
        if (current === undefined || current.status !== 'paused') {
          result = failure('INVALID_TRANSITION', 'Only paused project execution can be resumed.'); return complete();
        }
        const state = await nextState(tx, command.workspaceId, project.id);
        resultVersion = current.version + 1;
        await tx.update(schema.projectExecutions).set({status: state.status, blockReason: state.blockReason,
          ...selectionSnapshot(state.selection), pausedAt: null,
          completedAt: state.status === 'completed' ? now : null, version: resultVersion, updatedAt: now})
          .where(and(eq(schema.projectExecutions.projectId, project.id), eq(schema.projectExecutions.version, current.version)));
      }
      const [updated] = await tx.select().from(schema.projectExecutions)
        .where(eq(schema.projectExecutions.projectId, project.id)).limit(1);
      result = {ok: true, value: await projectionFrom(tx, command.workspaceId, project.id, updated)};
      return complete();
    });
  }
});
