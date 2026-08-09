import {createHash, randomUUID} from 'node:crypto';
import {
  canonicalJson,
  createTaskPacket,
  OPERATOR_CANCELLED_BEFORE_CLAIM,
  simulateAgentRunQueuePolicy,
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
import {isRuntimeAvailable} from './runtime-availability';

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
  if (record === undefined || record.planVersionId === null || record.workItemBlocked ||
    record.protocolState !== 'published' || !record.active) return null;
  const definition = validateDeliveryProtocolDefinition(record.definition);
  if (!definition.ok) return null;
  const stage = definition.value.stages.find(({key, enabled}) => enabled && key === record.stageKey) ?? null;
  if (stage === null || stage.taskStatus !== record.workItemStatus) return null;
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
  const current = stages.find((stage) => typeof stage === 'object' && stage !== null &&
    (stage as {enabled?: unknown; key?: unknown}).enabled === true &&
    (stage as {key?: unknown}).key === record.stageKey) as Record<string, unknown> | undefined;
  if (current === undefined || current.executionMode !== 'autonomous' ||
    typeof current.responsibility !== 'object' || current.responsibility === null) return false;
  const responsibility = current.responsibility as Record<string, unknown>;
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
  decisions.push(...[...latestRunByItem.values()].filter((run) =>
    run.status === 'done' && selection?.workItemId === run.workItemId
  ).map((run) => ({
    id: `agent_run:${run.id}:receipt_review`, kind: 'approval' as const,
    source: 'agent_run' as const, workItemId: run.workItemId, targetId: run.id,
    summary: 'Runner сохранил результат; прогресс ещё не принят Product Owner.',
    nextAction: 'Открыть run, проверить полный receipt и required evidence. Автоповтор и автопереход запрещены.',
    createdAt: run.updatedAt.toISOString()
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
  const dispatchBoundaries: Readonly<Record<string, Readonly<{summary: string; nextAction: string}>>> = {
    runner_queue_unavailable: {
      summary: 'Изолированная очередь запуска сейчас недоступна.',
      nextAction: 'Включить worker и transport изолированного runner, затем повторить Resume.'
    },
    runtime_registration_unavailable: {
      summary: 'Выбранный профиль или его runtime registration больше не доступны.',
      nextAction: 'Восстановить активные profile и runtime registration, затем повторить Resume.'
    },
    repository_base_commit_unavailable: {
      summary: 'Нет подтверждённого base commit для безопасного изолированного запуска.',
      nextAction: 'Обновить наблюдение default branch и проверить единственный repository scope, затем повторить Resume.'
    },
    dispatch_policy_denied: {
      summary: 'Каноническая политика запретила автоматическую постановку запуска.',
      nextAction: 'Проверить policy receipt и устранить недостающую capability или контекст; не обходить запрет вручную.'
    },
    dispatch_packet_invalid: {
      summary: 'Из точного плана и протокола нельзя собрать валидный Task Packet.',
      nextAction: 'Исправить план, протокол или профиль по dispatch receipt, затем повторить Resume.'
    },
    active_agent_run_exists: {
      summary: 'Для задачи уже существует активный запуск.',
      nextAction: 'Дождаться его результата или безопасно завершить его перед повторным Resume.'
    }
  };
  const dispatchBoundary = blockReason === null ? null : dispatchBoundaries[blockReason];
  if (dispatchBoundary !== null && dispatchBoundary !== undefined) decisions.push({
    id: `dispatch:${selection?.workItemId ?? projectId}:${blockReason}`,
    kind: 'failure', source: 'agent_run', workItemId: selection?.workItemId ?? null,
    targetId: selection?.workItemId ?? projectId,
    summary: dispatchBoundary.summary, nextAction: dispatchBoundary.nextAction, createdAt: null
  });
  return decisions.slice(0, 50);
};

const dispatchProjection = async (
  tx: Queryable,
  projectId: string,
  executionVersion: number
): Promise<ProjectExecutionProjection['dispatch']> => {
  if (executionVersion < 1) return null;
  const [dispatch] = await tx.select({
    selectionHash: schema.projectExecutionDispatches.selectionHash,
    taskPacketId: schema.projectExecutionDispatches.taskPacketId,
    taskPacketHash: schema.taskPackets.contentHash,
    agentRunId: schema.projectExecutionDispatches.agentRunId,
    agentRunStatus: schema.agentRuns.status,
    attempt: schema.agentRuns.attempt,
    failureCode: schema.agentRuns.failureCode,
    queuedAt: schema.projectExecutionDispatches.createdAt,
    claimedAt: schema.agentRuns.startedAt,
    completedAt: schema.agentRuns.completedAt
  }).from(schema.projectExecutionDispatches)
    .innerJoin(schema.taskPackets, eq(schema.taskPackets.id, schema.projectExecutionDispatches.taskPacketId))
    .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, schema.projectExecutionDispatches.agentRunId))
    .where(and(eq(schema.projectExecutionDispatches.projectId, projectId),
      eq(schema.projectExecutionDispatches.executionVersion, executionVersion))).limit(1);
  if (dispatch === undefined) return null;
  const nextAction = dispatch.agentRunStatus === 'queued'
    ? 'Wait for an authorized isolated runner to claim this run.'
    : dispatch.agentRunStatus === 'running'
      ? 'Monitor the runner heartbeat and wait for its immutable receipt.'
      : dispatch.agentRunStatus === 'waiting_approval'
        ? 'Review the pending approval; the runner cannot cross it automatically.'
        : dispatch.agentRunStatus === 'failed'
          ? 'Inspect the receipt and failure code before choosing a safe retry.'
          : 'Review the receipt and required evidence; advance the protocol stage explicitly.';
  return {...dispatch, queuedAt: dispatch.queuedAt.toISOString(),
    claimedAt: dispatch.claimedAt?.toISOString() ?? null,
    completedAt: dispatch.completedAt?.toISOString() ?? null, nextAction};
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
    dispatch: await dispatchProjection(tx, projectId, row?.version ?? 0),
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
    dispatch: null, decisions: [], startedAt: null, pausedAt: null, completedAt: null, updatedAt: null
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
  const candidates = items.filter((item) => item.status !== 'backlog' && item.status !== 'done' && !item.blocked &&
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
        const [dispatchRun] = await tx.select({id: schema.agentRuns.id, status: schema.agentRuns.status,
          version: schema.agentRuns.version, actorId: schema.agentProfiles.actorId})
          .from(schema.projectExecutionDispatches)
          .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, schema.projectExecutionDispatches.agentRunId))
          .innerJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.agentRuns.agentProfileId))
          .where(and(eq(schema.projectExecutionDispatches.projectId, project.id),
            eq(schema.projectExecutionDispatches.executionVersion, current.version))).limit(1)
          .for('update', {of: schema.agentRuns});
        if (dispatchRun?.status === 'running' || dispatchRun?.status === 'waiting_approval') {
          result = failure('INVALID_TRANSITION', 'A claimed AgentRun must reach a receipt boundary before project execution can pause.');
          return complete();
        }
        if (dispatchRun?.status === 'queued') {
          const [cancelled] = await tx.update(schema.agentRuns).set({status: 'failed',
            failureCode: OPERATOR_CANCELLED_BEFORE_CLAIM, completedAt: now,
            version: dispatchRun.version + 1, updatedAt: now}).where(and(
            eq(schema.agentRuns.id, dispatchRun.id), eq(schema.agentRuns.status, 'queued'),
            eq(schema.agentRuns.version, dispatchRun.version))).returning({version: schema.agentRuns.version});
          if (cancelled === undefined) {
            result = failure('VERSION_CONFLICT', 'The queued AgentRun changed while pausing.'); return complete();
          }
          const cancellationIdentity = `project-execution.pause:${project.id}:${current.version}:run:${dispatchRun.id}`;
          await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: command.workspaceId,
            projectId: project.id, actorId: command.actor.actorId, commandId: cancellationIdentity,
            actionCategory: 'write', action: 'agent_run.cancel_before_claim', targetType: 'agent_run',
            targetId: dispatchRun.id, policyDecision: 'allow', outcome: 'succeeded',
            reasonCode: OPERATOR_CANCELLED_BEFORE_CLAIM, expectedVersion: dispatchRun.version,
            resultVersion: cancelled.version, correlationId: command.correlationId, occurredAt: now, metadata: {}});
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

const dispatchCommandType = 'project_execution.dispatch.v1';
const sha1Pattern = /^[0-9a-f]{40}$/;

const stableUuid = (value: string): string => {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${
    (Number.parseInt(hex[16]!, 16) & 0x3 | 0x8).toString(16)
  }${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const evidenceReference = (evidence: unknown): string | null => {
  if (typeof evidence !== 'object' || evidence === null) return null;
  const value = evidence as Record<string, unknown>;
  if (value.kind !== 'citation' || typeof value.artifactId !== 'string' ||
    typeof value.locator !== 'object' || value.locator === null) return null;
  const locator = value.locator as Record<string, unknown>;
  if (locator.kind === 'whole_artifact') return `artifact:${value.artifactId}`;
  if (locator.kind === 'line_range' && Number.isSafeInteger(locator.startLine) &&
    Number.isSafeInteger(locator.endLine)) {
    return `artifact:${value.artifactId}#L${locator.startLine}-L${locator.endLine}`;
  }
  return locator.kind === 'json_pointer' && typeof locator.pointer === 'string'
    ? `artifact:${value.artifactId}#${locator.pointer}` : null;
};

type DispatchBlockReason =
  | 'selection_preconditions_stale'
  | 'runner_queue_unavailable'
  | 'runtime_registration_unavailable'
  | 'repository_base_commit_unavailable'
  | 'dispatch_policy_denied'
  | 'dispatch_packet_invalid'
  | 'active_agent_run_exists';

type DispatchOptions = Readonly<{
  now?: () => Date;
  runnerQueueEnabled?: boolean;
  runtimeEnvironment?: Readonly<Record<string, string | undefined>>;
}>;

export type ProjectExecutionDispatchResult = Readonly<{
  dispatched: number;
  blocked: number;
  replayed: number;
  denied: number;
}>;

export type ProjectExecutionDispatchInput = Readonly<{
  workspaceId: string;
  projectId: string;
  expectedVersion: number;
  requestedByActorId: string;
}>;

export const createPostgresProjectExecutionDispatcher = (
  db: Database,
  options: DispatchOptions = {}
): Readonly<{run(input: ProjectExecutionDispatchInput): Promise<ProjectExecutionDispatchResult>}> => ({
  async run(input) {
    const result = {dispatched: 0, blocked: 0, replayed: 0, denied: 0};
    const outcome = await db.transaction(async (tx) => {
        const [project] = await tx.select({workspaceId: schema.projects.workspaceId})
          .from(schema.projects).where(and(eq(schema.projects.id, input.projectId),
            eq(schema.projects.workspaceId, input.workspaceId))).limit(1);
        if (project === undefined) return 'none' as const;
        const now = options.now?.() ?? new Date();
        const [requester] = await tx.select({id: schema.actors.id}).from(schema.actors).where(and(
          eq(schema.actors.id, input.requestedByActorId), eq(schema.actors.workspaceId, input.workspaceId),
          eq(schema.actors.type, 'human'), eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt)
        )).limit(1);
        if (requester === undefined ||
          !await authority(tx, project.workspaceId, input.projectId, input.requestedByActorId)) {
          const identity = `project-execution-dispatch-denied:v1:${input.projectId}:${input.expectedVersion}:${input.requestedByActorId}`;
          const commandId = stableUuid(`${identity}:command`);
          const requestHash = createHash('sha256').update(canonicalJson({workspaceId: input.workspaceId,
            projectId: input.projectId, executionVersion: input.expectedVersion,
            requestedByActorId: input.requestedByActorId})).digest('hex');
          await tx.insert(schema.commandReceipts).values({workspaceId: project.workspaceId,
            idempotencyKey: identity, requestHash, commandId, correlationId: commandId,
            state: 'completed', commandType: dispatchCommandType,
            aggregateType: 'project_execution', aggregateId: input.projectId,
            expectedVersion: input.expectedVersion,
            result: {ok: false, error: {code: 'CAPABILITY_DENIED',
              message: 'Only an active project owner or delivery administrator can dispatch execution.'}},
            completedAt: now
          }).onConflictDoNothing({target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]});
          await tx.insert(schema.auditEvents).values({id: stableUuid(`${identity}:audit`),
            workspaceId: project.workspaceId, projectId: input.projectId,
            ...(requester === undefined ? {} : {actorId: requester.id}),
            commandId, actionCategory: 'write', action: dispatchCommandType,
            targetType: 'project_execution', targetId: input.projectId,
            policyDecision: 'deny', outcome: 'rejected', reasonCode: 'CAPABILITY_DENIED',
            expectedVersion: input.expectedVersion, correlationId: commandId, occurredAt: now, metadata: {}
          }).onConflictDoNothing({target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]});
          return 'denied' as const;
        }
        const [execution] = await tx.select().from(schema.projectExecutions)
          .where(eq(schema.projectExecutions.projectId, input.projectId)).limit(1)
          .for('update');
        if (execution === undefined || execution.status !== 'running' ||
          execution.version !== input.expectedVersion) {
          return 'replayed' as const;
        }
        const [existing] = await tx.select({id: schema.projectExecutionDispatches.id})
          .from(schema.projectExecutionDispatches).where(and(
            eq(schema.projectExecutionDispatches.workspaceId, input.workspaceId),
            eq(schema.projectExecutionDispatches.projectId, execution.projectId),
            eq(schema.projectExecutionDispatches.executionVersion, execution.version)
          )).limit(1);
        if (existing !== undefined) return 'replayed' as const;
        const persisted = await persistedSelection(tx, project.workspaceId, execution.projectId, execution);
        const block = async (reason: DispatchBlockReason, code: CommandError['code'], message: string) => {
          const nextVersion = execution.version + 1;
          const identity = `project-execution-dispatch:v1:${execution.projectId}:${execution.version}`;
          const commandId = stableUuid(`${identity}:command`);
          const requestHash = createHash('sha256').update(canonicalJson({
            projectId: execution.projectId, executionVersion: execution.version,
            requestedByActorId: input.requestedByActorId, reason
          })).digest('hex');
          await tx.update(schema.projectExecutions).set({status: 'blocked', blockReason: reason,
            version: nextVersion, updatedAt: now}).where(and(
            eq(schema.projectExecutions.projectId, execution.projectId),
            eq(schema.projectExecutions.version, execution.version),
            eq(schema.projectExecutions.status, 'running')
          ));
          await tx.insert(schema.commandReceipts).values({
            workspaceId: project.workspaceId, idempotencyKey: identity, requestHash, commandId,
            correlationId: commandId, state: 'completed', commandType: dispatchCommandType,
            aggregateType: 'project_execution', aggregateId: execution.projectId,
            expectedVersion: execution.version, resultVersion: nextVersion,
            result: {ok: false, error: {code, message}}, completedAt: now
          }).onConflictDoNothing({target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]});
          await tx.insert(schema.auditEvents).values({
            id: stableUuid(`${identity}:audit`), workspaceId: project.workspaceId,
            projectId: execution.projectId, actorId: input.requestedByActorId,
            commandId, actionCategory: 'write', action: dispatchCommandType,
            targetType: 'project_execution', targetId: execution.projectId,
            policyDecision: code === 'POLICY_DENIED' ? 'deny' : 'allow',
            outcome: code === 'POLICY_DENIED' ? 'rejected' : 'failed',
            reasonCode: reason, expectedVersion: execution.version, resultVersion: nextVersion,
            correlationId: commandId, occurredAt: now, metadata: {}
          }).onConflictDoNothing({target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]});
          await tx.insert(schema.canonicalEvents).values({
            id: stableUuid(`${identity}:event`), workspaceId: project.workspaceId,
            projectId: execution.projectId, eventType: 'project_execution.dispatch_blocked.v1',
            aggregateType: 'project_execution', aggregateId: execution.projectId,
            deduplicationKey: `${identity}:blocked`, payload: {schemaVersion: 1, reason,
              executionVersion: execution.version, requestedByActorId: input.requestedByActorId}, occurredAt: now
          }).onConflictDoNothing({target: [schema.canonicalEvents.workspaceId, schema.canonicalEvents.deduplicationKey]});
          return 'blocked' as const;
        };
        if (persisted.stale || persisted.selection === null) {
          return block('selection_preconditions_stale', 'VERSION_CONFLICT',
            'The autonomous selection no longer matches canonical prerequisites.');
        }
        const selection = persisted.selection;
        if (selection.boundary !== 'autonomous_ready' || selection.responsibleActor.agentProfileId === null) {
          return block('dispatch_policy_denied', 'POLICY_DENIED',
            'Only an autonomous-ready agent selection may be dispatched.');
        }
        if (options.runnerQueueEnabled !== true) {
          return block('runner_queue_unavailable', 'POLICY_DENIED',
            'The isolated runner queue is not enabled.');
        }
        const [work, plan, protocol, profileRows, registrations, repositoryScopes] = await Promise.all([
          tx.select({title: schema.workItems.title, summary: schema.workItems.summary,
            version: schema.workItems.version, sourceTaskKey: schema.workItems.sourceTaskKey,
            acceptanceEvidence: schema.workItems.acceptanceEvidence})
            .from(schema.workItems).where(and(eq(schema.workItems.id, selection.workItemId),
              eq(schema.workItems.projectId, execution.projectId), isNull(schema.workItems.deletedAt))).limit(1),
          tx.select({contentHash: schema.projectPlanVersions.contentHash,
            definition: schema.projectPlanVersions.definition,
            approvedByActorId: schema.projectPlanVersions.approvedByActorId})
            .from(schema.projectPlanVersions).where(and(
              eq(schema.projectPlanVersions.id, selection.planVersionId),
              eq(schema.projectPlanVersions.projectId, execution.projectId))).limit(1),
          tx.select({definition: schema.runbooks.definition, contentHash: schema.runbooks.contentHash})
            .from(schema.runbooks).where(and(eq(schema.runbooks.id, selection.protocolId),
              eq(schema.runbooks.version, selection.protocolVersion), eq(schema.runbooks.active, true),
              eq(schema.runbooks.protocolState, 'published'))).limit(1),
          tx.select({profileId: schema.agentProfiles.id, actorId: schema.agentProfiles.actorId,
            runtimeId: schema.agentProfiles.runtimeId, runtimeProfile: schema.agentProfiles.runtimeProfile,
            allowedTools: schema.agentProfiles.allowedTools, forbiddenSurfaces: schema.agentProfiles.forbiddenSurfaces,
            instructions: schema.agentProfiles.instructions, settings: schema.agentProfiles.settings,
            enabled: schema.agentProfiles.enabled, version: schema.agentProfiles.version,
            configHash: schema.agentProfiles.configHash, actorType: schema.actors.type,
            actorAuthMode: schema.actors.authMode, actorDisabledAt: schema.actors.disabledAt})
            .from(schema.agentProfiles).innerJoin(schema.actors, eq(schema.actors.id, schema.agentProfiles.actorId))
            .where(and(eq(schema.agentProfiles.id, selection.responsibleActor.agentProfileId),
              eq(schema.agentProfiles.workspaceId, project.workspaceId))).limit(1),
          tx.select({id: schema.runtimeRegistrations.id, version: schema.runtimeRegistrations.version})
            .from(schema.runtimeRegistrations).where(and(
              eq(schema.runtimeRegistrations.projectId, execution.projectId),
              eq(schema.runtimeRegistrations.actorId, selection.responsibleActor.id),
              eq(schema.runtimeRegistrations.agentProfileId, selection.responsibleActor.agentProfileId),
              eq(schema.runtimeRegistrations.enabled, true))).orderBy(asc(schema.runtimeRegistrations.id)).limit(2),
          tx.select({id: schema.projectTrackerRepositoryScopes.id,
            provider: schema.projectTrackerRepositoryScopes.provider,
            repositoryExternalId: schema.projectTrackerRepositoryScopes.repositoryExternalId})
            .from(schema.projectTrackerRepositoryScopes)
            .where(eq(schema.projectTrackerRepositoryScopes.projectId, execution.projectId)).limit(2)
        ]);
        const profile = profileRows[0];
        if (profile === undefined || !profile.enabled || profile.actorId !== selection.responsibleActor.id ||
          profile.actorType !== 'agent' || profile.actorAuthMode !== 'agent' || profile.actorDisabledAt !== null ||
          registrations.length !== 1 || !isRuntimeAvailable(profile.runtimeId, options.runtimeEnvironment)) {
          return block('runtime_registration_unavailable', 'POLICY_DENIED',
            'The selected active agent profile and runtime registration are not available.');
        }
        if (work[0] === undefined || work[0].version !== selection.workItemVersion || plan[0] === undefined ||
          protocol[0] === undefined || repositoryScopes.length !== 1) {
          return block('selection_preconditions_stale', 'VERSION_CONFLICT',
            'The exact plan, work item, protocol, or repository scope changed.');
        }
        const protocolDefinition = validateDeliveryProtocolDefinition(protocol[0].definition);
        const stage = protocolDefinition.ok
          ? protocolDefinition.value.stages.find(({key}) => key === selection.stageKey) : undefined;
        const planTask = plan[0].definition.tasks.find(({key}) => key === work[0]!.sourceTaskKey);
        if (stage === undefined || !stage.enabled || stage.executionMode !== 'autonomous' ||
          planTask === undefined || work[0].acceptanceEvidence === null ||
          canonicalJson(work[0].acceptanceEvidence as never) !==
            canonicalJson(planTask.acceptanceEvidence as never)) {
          return block('selection_preconditions_stale', 'VERSION_CONFLICT',
            'The selected plan task or autonomous protocol stage is no longer exact.');
        }
        const [binding] = await tx.select({metadata: schema.trackerBindings.metadata})
          .from(schema.trackerBindings).where(and(
            eq(schema.trackerBindings.projectId, execution.projectId),
            eq(schema.trackerBindings.provider, repositoryScopes[0]!.provider),
            eq(schema.trackerBindings.externalId, repositoryScopes[0]!.repositoryExternalId),
            eq(schema.trackerBindings.surface, 'repository'), eq(schema.trackerBindings.entityType, 'project'),
            eq(schema.trackerBindings.entityId, execution.projectId))).limit(1);
        const baseCommit = binding?.metadata.headSha;
        if (typeof binding?.metadata.defaultBranch !== 'string' || binding.metadata.defaultBranch.length === 0 ||
          typeof baseCommit !== 'string' || !sha1Pattern.test(baseCommit)) {
          return block('repository_base_commit_unavailable', 'POLICY_DENIED',
            'A confirmed repository default-branch base commit is required.');
        }
        const [approver] = await tx.select({id: schema.actors.id, capabilities: schema.actors.capabilities})
          .from(schema.actors).where(and(eq(schema.actors.id, plan[0].approvedByActorId),
            eq(schema.actors.workspaceId, project.workspaceId), eq(schema.actors.type, 'human'),
            eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt))).limit(1);
        if (approver === undefined) {
          return block('dispatch_policy_denied', 'POLICY_DENIED',
            'The approved plan is not bound to an active human approver.');
        }
        const selectionHash = createHash('sha256').update(canonicalJson({
          schemaVersion: 1, projectId: execution.projectId, executionVersion: execution.version,
          planVersionId: selection.planVersionId, workItemId: selection.workItemId,
          workItemVersion: selection.workItemVersion, protocolId: selection.protocolId,
          protocolVersion: selection.protocolVersion, journeyVersion: selection.journeyVersion,
          stageKey: selection.stageKey, responsibleActorId: selection.responsibleActor.id,
          agentProfileId: profile.profileId
        })).digest('hex');
        const identity = `project-execution-dispatch:v1:${execution.projectId}:${execution.version}:${selectionHash}`;
        const eventId = stableUuid(`${identity}:event`);
        const packetId = stableUuid(`${identity}:packet`);
        const runId = stableUuid(`${identity}:run`);
        const acceptanceEvidence = planTask.acceptanceEvidence;
        const acceptanceCriteria = [...new Set([
          ...acceptanceEvidence.map(({description}) => description), ...stage.requiredEvidence
        ])];
        const packetResult = createTaskPacket(packetId, {
          projectId: execution.projectId, workItemId: selection.workItemId,
          workItemVersion: selection.workItemVersion, goal: work[0].summary?.trim() || work[0].title,
          acceptanceCriteria,
          inScope: [`plan:${selection.planVersionId}`, `work_item:${selection.workItemId}@${selection.workItemVersion}`,
            `protocol:${selection.protocolId}@${selection.protocolVersion}`, `stage:${selection.stageKey}`,
            ...stage.entryCriteria],
          outOfScope: ['manual_stage_transition', 'external_provider_write', 'merge', 'release', 'deploy', 'production'],
          relevantLinks: acceptanceEvidence.map(({evidence}) => evidenceReference(evidence))
            .filter((value): value is string => value !== null),
          relevantFiles: [], allowedTools: profile.allowedTools,
          forbiddenSurfaces: [...new Set([...profile.forbiddenSurfaces,
            'external_provider_write', 'merge', 'release', 'deploy', 'production'])],
          dataPolicy: {source: 'canonical_db_only', planVersionId: selection.planVersionId,
            planHash: plan[0].contentHash, workItemVersion: selection.workItemVersion,
            protocolId: selection.protocolId, protocolVersion: selection.protocolVersion,
            protocolHash: protocol[0].contentHash, journeyVersion: selection.journeyVersion,
            stageKey: selection.stageKey, planAcceptanceEvidence: acceptanceEvidence,
            protocolRequiredEvidence: stage.requiredEvidence},
          timeboxMinutes: 120,
          expectedOutputSchema: {schemaVersion: 1, resultFormat: 'structured_v1',
            requiredEvidence: acceptanceCriteria, stageTransition: 'explicit_human_or_canonical_command'},
          reviewerActorId: approver.id, approverActorId: approver.id,
          runtimeProfile: profile.runtimeProfile, authMode: 'agent', secretsRef: null,
          agentProfileSnapshot: {profileId: profile.profileId, runtimeId: profile.runtimeId,
            runtimeProfile: profile.runtimeProfile, allowedTools: profile.allowedTools,
            forbiddenSurfaces: profile.forbiddenSurfaces, enabled: profile.enabled,
            configVersion: profile.version, configHash: profile.configHash,
            instructions: profile.instructions, settings: profile.settings as never},
          createdFromEventId: eventId, createdByActorId: input.requestedByActorId
        });
        if (!packetResult.ok) {
          return block('dispatch_packet_invalid', packetResult.error.code, packetResult.error.message);
        }
        const policy = simulateAgentRunQueuePolicy({taskPacketId: packetId, profileId: profile.profileId,
          context: {operatorActorId: approver.id,
            operatorCapabilities: Object.entries(approver.capabilities).flatMap(([capability, enabled]) => enabled ? [capability] : []),
            runnerQueueEnabled: true, runtimeAvailable: true,
            packet: {packetId, contentHash: packetResult.value.contentHash, approverActorId: approver.id,
              runtimeProfile: profile.runtimeProfile, workItemVersion: selection.workItemVersion,
              currentWorkItemVersion: work[0].version, workItemDeleted: false,
              agentProfileSnapshotId: profile.profileId, agentProfileSnapshotVersion: profile.version,
              agentProfileSnapshotHash: profile.configHash, hasAgentRun: false, repositoryBaseCommit: baseCommit},
            profile: {profileId: profile.profileId, runtimeId: profile.runtimeId,
              runtimeProfile: profile.runtimeProfile, enabled: profile.enabled, version: profile.version,
              configHash: profile.configHash, actorType: profile.actorType,
              actorAuthMode: profile.actorAuthMode, actorDisabled: false}}, simulatedAt: now});
        if (policy.decision !== 'allow') {
          return block('dispatch_policy_denied', 'POLICY_DENIED',
            `Dispatch policy denied the queue action: ${policy.missingContext.join(', ') || 'policy_matrix'}.`);
        }
        const [activeRun] = await tx.select({id: schema.agentRuns.id}).from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.workItemId, selection.workItemId),
            eq(schema.agentRuns.repositoryScopeId, repositoryScopes[0]!.id),
            inArray(schema.agentRuns.status, ['queued', 'running', 'waiting_approval']))).limit(1).for('update');
        if (activeRun !== undefined) {
          return block('active_agent_run_exists', 'INVALID_TRANSITION',
            'Another active agent run already owns this work item and repository scope.');
        }
        await tx.insert(schema.canonicalEvents).values({id: eventId, workspaceId: project.workspaceId,
          projectId: execution.projectId, eventType: 'project_execution.dispatch_requested.v1',
          aggregateType: 'project_execution', aggregateId: execution.projectId,
          deduplicationKey: `${identity}:requested`, payload: {schemaVersion: 1,
            executionVersion: execution.version, selectionHash,
            requestedByActorId: input.requestedByActorId}, occurredAt: now});
        const packet = packetResult.value;
        await tx.insert(schema.taskPackets).values({id: packet.packetId, projectId: packet.content.projectId,
          workItemId: packet.content.workItemId, workItemVersion: packet.content.workItemVersion,
          goal: packet.content.goal, acceptanceCriteria: [...packet.content.acceptanceCriteria],
          inScope: [...packet.content.inScope], outOfScope: [...packet.content.outOfScope],
          relevantLinks: [...packet.content.relevantLinks], relevantFiles: [...packet.content.relevantFiles],
          allowedTools: [...packet.content.allowedTools], forbiddenSurfaces: [...packet.content.forbiddenSurfaces],
          dataPolicy: packet.content.dataPolicy as never, timeboxMinutes: packet.content.timeboxMinutes,
          expectedOutputSchema: packet.content.expectedOutputSchema as never,
          reviewerActorId: packet.content.reviewerActorId, approverActorId: packet.content.approverActorId,
          runtimeProfile: packet.content.runtimeProfile, authMode: packet.content.authMode,
          agentProfileSnapshotId: profile.profileId, agentProfileSnapshotRuntimeId: profile.runtimeId,
          agentProfileSnapshotAllowedTools: [...profile.allowedTools],
          agentProfileSnapshotForbiddenSurfaces: [...profile.forbiddenSurfaces],
          agentProfileSnapshotEnabled: profile.enabled, agentProfileSnapshotVersion: profile.version,
          agentProfileSnapshotHash: profile.configHash, agentProfileSnapshotInstructions: profile.instructions,
          agentProfileSnapshotSettings: profile.settings, createdFromEventId: eventId,
          contentHash: packet.contentHash, createdByActorId: input.requestedByActorId, createdAt: now});
        const runIdempotencyKey = `${project.workspaceId}:project-execution-dispatch:v1:${execution.projectId}:${execution.version}`;
        await tx.insert(schema.agentRuns).values({id: runId, taskPacketId: packet.packetId,
          agentProfileId: profile.profileId, workItemId: selection.workItemId,
          repositoryScopeId: repositoryScopes[0]!.id, confirmedPacketHash: packet.contentHash,
          baseCommit, status: 'queued', idempotencyKey: runIdempotencyKey, createdAt: now, updatedAt: now});
        await tx.insert(schema.projectExecutionDispatches).values({id: stableUuid(`${identity}:link`),
          workspaceId: project.workspaceId, projectId: execution.projectId,
          executionVersion: execution.version, selectionHash,
          taskPacketId: packet.packetId, agentRunId: runId,
          runtimeRegistrationId: registrations[0]!.id,
          runtimeRegistrationVersion: registrations[0]!.version,
          requestedByActorId: input.requestedByActorId, createdAt: now});
        const commandId = stableUuid(`${identity}:command`);
        const requestHash = createHash('sha256').update(canonicalJson({
          projectId: execution.projectId, executionVersion: execution.version,
          requestedByActorId: input.requestedByActorId, selectionHash
        })).digest('hex');
        await tx.insert(schema.commandReceipts).values({workspaceId: project.workspaceId,
          idempotencyKey: `project-execution-dispatch:v1:${execution.projectId}:${execution.version}`,
          requestHash, commandId, correlationId: eventId, state: 'completed', commandType: dispatchCommandType,
          aggregateType: 'agent_run', aggregateId: runId, expectedVersion: execution.version,
          resultVersion: 1, result: {ok: true, value: {selectionHash, taskPacketId: packet.packetId,
            taskPacketHash: packet.contentHash, agentRunId: runId, agentRunStatus: 'queued'}}, completedAt: now});
        await tx.insert(schema.auditEvents).values({id: stableUuid(`${identity}:audit`),
          workspaceId: project.workspaceId, projectId: execution.projectId,
          actorId: input.requestedByActorId,
          commandId, actionCategory: 'write', action: dispatchCommandType, targetType: 'agent_run',
          targetId: runId, policyDecision: 'allow', outcome: 'succeeded', expectedVersion: execution.version,
          resultVersion: 1, correlationId: eventId, occurredAt: now, metadata: {}});
        return 'dispatched' as const;
      });
    if (outcome !== 'none') result[outcome] += 1;
    return result;
  }
});
