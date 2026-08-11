import {createHash, randomUUID} from 'node:crypto';
import {
  canonicalJson,
  createTaskPacket,
  OPERATOR_CANCELLED_BEFORE_CLAIM,
  simulateAgentRunQueuePolicy,
  evaluateAgentRunRetryAdmission,
  validateDeliveryProtocolDefinition,
  type CommandError,
  type HermesCodexWorkOrder,
  type ProjectDecisionQueueItem,
  type ProjectExecutionProjection,
  type ProjectExecutionSelection
} from '@fai-control-plane/domain';
import type {
  AgentRunRetryContinuationStore,
  AgentRunRetryContinuationValue,
  ProjectExecutionStore
} from '@fai-control-plane/application';
import {and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import {isRuntimeAvailable} from './runtime-availability';
import {loadProjectAcceptanceProjection} from './project-acceptance';
import {resolveCurrentExecutionResponsibility} from './work-item-responsibility';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Queryable = Database | Transaction;
type ExecutionRow = typeof schema.projectExecutions.$inferSelect;
type StoreResult = Readonly<{ok: true; value: ProjectExecutionProjection}> |
  Readonly<{ok: false; error: CommandError}>;
const failure = (code: CommandError['code'], message: string): StoreResult => ({ok: false, error: {code, message}});
const recordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const authority = async (tx: Queryable, workspaceId: string, projectId: string, actorId: string) => {
  const [actor] = await tx.select({role: schema.actors.role}).from(schema.actors).where(and(
    eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId),
    eq(schema.actors.type, 'human'), eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt)
  )).limit(1);
  if (actor === undefined) return false;
  const [membership] = await tx.select({roles: schema.projectMemberships.roles, active: schema.projectMemberships.active})
    .from(schema.projectMemberships).where(and(
      eq(schema.projectMemberships.projectId, projectId), eq(schema.projectMemberships.actorId, actorId)
    )).limit(1);
  return actor.role === 'workspace_admin' || actor.role === 'delivery_lead' ||
    membership?.active === true && membership.roles.some((role) => role === 'workspace_owner' || role === 'project_owner');
};

const selectionFor = async (
  tx: Queryable,
  workspaceId: string,
  projectId: string,
  workItemId: string
): Promise<ProjectExecutionSelection | null> => {
  const resolved = await resolveCurrentExecutionResponsibility(tx, {workspaceId, projectId, workItemId});
  if (resolved === null) return null;
  const actor = resolved.actor;
  const boundary = resolved.executionMode === 'autonomous'
    ? actor.type === 'agent' && actor.agentProfileId !== null ? 'autonomous_ready' : 'autonomous_agent_required'
    : resolved.executionMode === 'human_approval' ? 'human_confirmation_required'
    : 'provider_handoff_required';
  return {
    planVersionId: resolved.planVersionId, workItemId, title: resolved.title,
    workItemVersion: resolved.workItemVersion,
    protocolId: resolved.protocolId, protocolVersion: resolved.protocolVersion,
    journeyVersion: resolved.journeyVersion, stageKey: resolved.stageKey, stageName: resolved.stageName,
    executionMode: resolved.executionMode, responsibilityHash: resolved.factHash,
    responsibleActor: actor, boundary
  };
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
      failureCode: schema.agentRuns.failureCode, updatedAt: schema.agentRuns.updatedAt,
      qaTaskPacketId: schema.qaTaskPackets.taskPacketId})
      .from(schema.agentRuns).innerJoin(schema.workItems, eq(schema.workItems.id, schema.agentRuns.workItemId))
      .leftJoin(schema.qaTaskPackets, eq(schema.qaTaskPackets.taskPacketId, schema.agentRuns.taskPacketId))
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
    run.status === 'done' && run.qaTaskPacketId === null && selection?.workItemId === run.workItemId
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
  if (blockReason === 'scope_acceptance_required') decisions.push({
    id: `scope:${projectId}:acceptance`, kind: 'approval', source: 'scope',
    workItemId: null, targetId: projectId,
    summary: 'Все задачи завершены, но утверждённый weighted scope ещё не принят полностью.',
    nextAction: 'Проверить финальные evidence и явно принять готовые результаты в разделе «Принятый скоп».',
    createdAt: null
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
    runtime_availability_unavailable: {
      summary: 'Для автономного QA нет полного свежего наблюдения runtime.',
      nextAction: 'Подтвердить доступность service, scheduler и delivery точными наблюдаемыми фактами; очередь не создаётся.'
    },
    autonomous_qa_transport_unavailable: {
      summary: 'Аутентифицированный transport Hermes для QA не настроен.',
      nextAction: 'Утвердить и подключить точную identity/data scope Hermes transport; локальный Codex runner не выдаётся за Hermes.'
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
    completedAt: schema.agentRuns.completedAt,
    qaReceiptId: schema.qaReviewReceipts.id,
    qaOutcome: schema.qaReviewReceipts.outcome,
    qaChecks: schema.qaReviewReceipts.checks,
    qaArtifacts: schema.qaReviewReceipts.artifacts,
    qaFailures: schema.qaReviewReceipts.failures,
    qaRisks: schema.qaReviewReceipts.risks,
    qaRecordedAt: schema.qaReviewReceipts.createdAt
  }).from(schema.projectExecutionDispatches)
    .innerJoin(schema.taskPackets, eq(schema.taskPackets.id, schema.projectExecutionDispatches.taskPacketId))
    .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, schema.projectExecutionDispatches.agentRunId))
    .leftJoin(schema.qaReviewReceipts, eq(schema.qaReviewReceipts.agentRunId, schema.agentRuns.id))
    .where(and(eq(schema.projectExecutionDispatches.projectId, projectId), or(
      eq(schema.projectExecutionDispatches.executionVersion, executionVersion),
      and(lte(schema.projectExecutionDispatches.executionVersion, executionVersion),
        isNotNull(schema.qaReviewReceipts.id))
    ))).orderBy(desc(schema.projectExecutionDispatches.executionVersion)).limit(1);
  if (dispatch === undefined) return null;
  const [qaApproval] = dispatch.qaReceiptId === null ? [] : await tx.select({
    id: schema.approvalRequests.id, status: schema.approvalRequests.status
  }).from(schema.approvalRequests).where(eq(
    schema.approvalRequests.agentRunId, dispatch.agentRunId
  )).orderBy(desc(schema.approvalRequests.createdAt), desc(schema.approvalRequests.id)).limit(1);
  const nextAction = dispatch.qaOutcome === 'passed' && qaApproval?.status === 'pending'
    ? 'Проверить структурированный QA receipt и явно принять его командой manager/Product Owner.'
    : dispatch.qaOutcome === 'failed'
      ? 'Исправить структурированные findings; задача возвращена только по разрешённому пути протокола либо заблокирована.'
      : dispatch.agentRunStatus === 'queued'
    ? 'Wait for an authorized isolated runner to claim this run.'
    : dispatch.agentRunStatus === 'running'
      ? 'Monitor the runner heartbeat and wait for its immutable receipt.'
      : dispatch.agentRunStatus === 'waiting_approval'
        ? 'Review the pending approval; the runner cannot cross it automatically.'
        : dispatch.agentRunStatus === 'failed'
          ? 'Inspect the receipt and failure code before choosing a safe retry.'
          : 'Review the receipt and required evidence; advance the protocol stage explicitly.';
  const qaReferenceLabel = (value: unknown): string => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'Некорректная внутренняя ссылка';
    const reference = value as Record<string, unknown>;
    return typeof reference.artifactId === 'string' && typeof reference.sha256 === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(reference.artifactId) && /^[0-9a-f]{64}$/.test(reference.sha256)
      ? `Артефакт ${reference.artifactId.slice(0, 8)} · sha256 ${reference.sha256.slice(0, 12)}…`
      : 'Некорректная внутренняя ссылка';
  };
  return {selectionHash: dispatch.selectionHash, taskPacketId: dispatch.taskPacketId,
    taskPacketHash: dispatch.taskPacketHash, agentRunId: dispatch.agentRunId,
    agentRunStatus: dispatch.agentRunStatus, attempt: dispatch.attempt,
    failureCode: dispatch.failureCode, queuedAt: dispatch.queuedAt.toISOString(),
    claimedAt: dispatch.claimedAt?.toISOString() ?? null,
    completedAt: dispatch.completedAt?.toISOString() ?? null, nextAction,
    qa: dispatch.qaReceiptId === null || dispatch.qaOutcome === null || dispatch.qaRecordedAt === null
      ? null : {receiptId: dispatch.qaReceiptId, outcome: dispatch.qaOutcome,
          checks: (dispatch.qaChecks as readonly {name: string; status: string; reference: unknown}[])
            .map((entry) => ({...entry, reference: qaReferenceLabel(entry.reference)})),
          artifacts: (dispatch.qaArtifacts as readonly {kind: string; reference: unknown}[])
            .map((entry) => ({...entry, reference: qaReferenceLabel(entry.reference)})),
          failures: (dispatch.qaFailures as readonly {summary: string; reference: unknown}[])
            .map((entry) => ({...entry, reference: qaReferenceLabel(entry.reference)})),
          risks: (dispatch.qaRisks as readonly {summary: string; reference: unknown}[])
            .map((entry) => ({...entry, reference: qaReferenceLabel(entry.reference)})),
          recordedAt: dispatch.qaRecordedAt.toISOString(), approvalId: qaApproval?.id ?? null,
          approvalStatus: qaApproval?.status ?? null}};
};

const selectionSnapshot = (selection: ProjectExecutionSelection | null) => selection === null ? {
  selectedWorkItemId: null, selectedPlanVersionId: null, selectedWorkItemVersion: null,
  selectedProtocolId: null, selectedProtocolVersion: null, selectedJourneyVersion: null,
  selectedStageKey: null, selectedResponsibleActorId: null, selectedAgentProfileId: null,
  selectedResponsibilityHash: null
} : {
  selectedWorkItemId: selection.workItemId, selectedPlanVersionId: selection.planVersionId,
  selectedWorkItemVersion: selection.workItemVersion, selectedProtocolId: selection.protocolId,
  selectedProtocolVersion: selection.protocolVersion, selectedJourneyVersion: selection.journeyVersion,
  selectedStageKey: selection.stageKey, selectedResponsibleActorId: selection.responsibleActor.id,
  selectedAgentProfileId: selection.responsibleActor.agentProfileId,
  selectedResponsibilityHash: selection.responsibilityHash
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
    row.selectedAgentProfileId === snapshot.selectedAgentProfileId &&
    row.selectedResponsibilityHash === snapshot.selectedResponsibilityHash;
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
    completedAt: row?.completedAt?.toISOString() ?? null, updatedAt: row?.updatedAt.toISOString() ?? null,
    acceptance: await loadProjectAcceptanceProjection(tx, workspaceId, projectId)
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
    dispatch: null, decisions: [], startedAt: null, pausedAt: null, completedAt: null, updatedAt: null,
    acceptance: null
  };
  const [row] = await db.select().from(schema.projectExecutions)
    .where(eq(schema.projectExecutions.projectId, projectId)).limit(1);
  return projectionFrom(db, workspaceId, projectId, row);
};

const calculatedCost = (result: unknown, runId: string, currency: string): number | null => {
  if (typeof result !== 'object' || result === null) return null;
  const value = (result as {value?: unknown}).value;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as {kind?: unknown; agentRunId?: unknown; cost?: unknown};
  if (record.kind !== 'cost' || record.agentRunId !== runId ||
    typeof record.cost !== 'object' || record.cost === null) return null;
  const cost = record.cost as {state?: unknown; amountMinor?: unknown; currency?: unknown};
  return cost.state === 'calculated' && cost.currency === currency &&
    Number.isSafeInteger(cost.amountMinor) && (cost.amountMinor as number) >= 0
    ? cost.amountMinor as number : null;
};

/**
 * Atomically replaces the current failed dispatch with one bounded retry, or
 * records one canonical ask/attention boundary. It never invokes a runner or
 * crosses a non-autonomous delivery stage.
 */
export const createPostgresAgentRunRetryContinuationStore = (
  db: Database,
  options: Readonly<{
    now?: () => Date;
    runnerQueueEnabled?: boolean;
    runtimeEnvironment?: Readonly<Record<string, string | undefined>>;
    autonomousQaClaimTransport?: AutonomousQaClaimTransport;
  }> = {}
): AgentRunRetryContinuationStore => ({
  async execute(input) {
    return db.transaction(async (tx) => {
      const {command} = input;
      const now = options.now?.() ?? new Date();
      const denialAuditCommandId = (reason: string) => `agent-run-retry-denied:v1:${createHash('sha256')
        .update(`${command.commandId}:${input.requestHash}:${reason}`)
        .digest('hex')}`;
      if (!input.authorized) {
        const error = input.policyError ?? {code: 'POLICY_DENIED' as const,
          message: 'Policy denies AgentRun retry continuation.'};
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(), workspaceId: command.workspaceId,
          commandId: denialAuditCommandId(error.code), actionCategory: 'write', action: command.type,
          targetType: 'agent_run', targetId: command.payload.failedRunId,
          policyDecision: 'deny', outcome: 'rejected', reasonCode: error.code,
          expectedVersion: command.payload.expectedExecutionVersion,
          correlationId: command.correlationId, occurredAt: now, metadata: {}
        }).onConflictDoNothing({
          target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]
        });
        return {status: 'rejected' as const, error};
      }
      const [claimed] = await tx.insert(schema.commandReceipts).values({
        workspaceId: command.workspaceId,
        idempotencyKey: command.idempotencyKey,
        requestHash: input.requestHash,
        commandId: command.commandId,
        correlationId: command.correlationId,
        commandType: command.type
      }).onConflictDoNothing({
        target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
      }).returning();
      if (claimed === undefined) {
        const [existing] = await tx.select().from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.workspaceId, command.workspaceId),
          eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
        )).limit(1).for('update');
        if (existing === undefined || existing.requestHash !== input.requestHash) {
          return {status: 'key_reused' as const, existingRequestHash: existing?.requestHash ?? ''};
        }
        if (existing.state !== 'completed' || existing.result === null) {
          throw new Error('agent_run_retry_continuation_receipt_incomplete');
        }
        return {status: 'replayed' as const, receipt: {
          commandId: existing.commandId,
          workspaceId: command.workspaceId,
          correlationId: existing.correlationId,
          idempotencyKey: command.idempotencyKey,
          requestHash: existing.requestHash,
          commandType: command.type,
          result: existing.result as never,
          createdAt: existing.createdAt.toISOString()
        }};
      }
      const projectLink: {value: string | undefined} = {value: undefined};
      let resultVersion: number | undefined;
      const complete = async (result: Readonly<{ok: true; value: AgentRunRetryContinuationValue}> |
        Readonly<{ok: false; error: CommandError}>, policyDecision: 'allow' | 'deny' = 'allow') => {
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(), workspaceId: command.workspaceId, projectId: projectLink.value,
          actorId: command.actor.actorId, commandId: command.commandId,
          actionCategory: 'write', action: command.type, targetType: 'agent_run',
          targetId: command.payload.failedRunId, policyDecision,
          outcome: result.ok ? 'succeeded' : policyDecision === 'deny' ? 'rejected' : 'failed',
          ...(!result.ok ? {reasonCode: result.error.code} : {}),
          expectedVersion: command.payload.expectedExecutionVersion, resultVersion,
          correlationId: command.correlationId, occurredAt: now, metadata: {}
        });
        await tx.update(schema.commandReceipts).set({
          state: 'completed', aggregateType: 'project_execution',
          aggregateId: projectLink.value ?? command.payload.projectId,
          expectedVersion: command.payload.expectedExecutionVersion,
          resultVersion, result, completedAt: now
        }).where(eq(schema.commandReceipts.id, claimed.id));
        return {status: 'completed' as const, receipt: {
          commandId: command.commandId, workspaceId: command.workspaceId,
          correlationId: command.correlationId, idempotencyKey: command.idempotencyKey,
          requestHash: input.requestHash, commandType: command.type, result,
          createdAt: claimed.createdAt.toISOString()
        }};
      };
      const [project] = await tx.select({id: schema.projects.id}).from(schema.projects).where(and(
        eq(schema.projects.id, command.payload.projectId),
        eq(schema.projects.workspaceId, command.workspaceId)
      )).limit(1).for('update');
      if (project === undefined) return complete({ok: false, error: {code: 'NOT_FOUND', message: 'Project was not found.'}});
      projectLink.value = project.id;
      if (!await authority(tx, command.workspaceId, project.id, command.actor.actorId)) {
        const error = {code: 'CAPABILITY_DENIED' as const,
          message: 'Only an active project owner or delivery administrator can retry execution.'};
        await tx.delete(schema.commandReceipts).where(eq(schema.commandReceipts.id, claimed.id));
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(), workspaceId: command.workspaceId, projectId: project.id,
          actorId: command.actor.actorId, commandId: denialAuditCommandId(error.code),
          actionCategory: 'write', action: command.type, targetType: 'agent_run',
          targetId: command.payload.failedRunId, policyDecision: 'deny', outcome: 'rejected',
          reasonCode: error.code, expectedVersion: command.payload.expectedExecutionVersion,
          correlationId: command.correlationId, occurredAt: now, metadata: {}
        }).onConflictDoNothing({
          target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]
        });
        return {status: 'rejected' as const, error};
      }
      const [execution] = await tx.select().from(schema.projectExecutions).where(
        eq(schema.projectExecutions.projectId, project.id)
      ).limit(1).for('update');
      if (execution === undefined || execution.version !== command.payload.expectedExecutionVersion) {
        resultVersion = execution?.version;
        return complete({ok: false, error: {code: 'VERSION_CONFLICT', message: 'Project execution version conflicts.'}});
      }
      if (execution.status !== 'running') {
        return complete({ok: false, error: {code: 'INVALID_TRANSITION',
          message: 'Only the failed dispatch of a running autonomous stage can be retried.'}});
      }
      const persisted = await persistedSelection(tx, command.workspaceId, project.id, execution);
      if (persisted.stale || persisted.selection === null ||
        persisted.selection.boundary !== 'autonomous_ready') {
        return complete({ok: false, error: {code: 'INVALID_TRANSITION',
          message: 'Retry continuation stops before human, production, release, and stale selection boundaries.'}});
      }
      const [dispatch] = await tx.select().from(schema.projectExecutionDispatches).where(and(
        eq(schema.projectExecutionDispatches.projectId, project.id),
        eq(schema.projectExecutionDispatches.executionVersion, execution.version),
        eq(schema.projectExecutionDispatches.agentRunId, command.payload.failedRunId)
      )).limit(1).for('update');
      const [failedRun] = await tx.select().from(schema.agentRuns).where(and(
        eq(schema.agentRuns.id, command.payload.failedRunId),
        eq(schema.agentRuns.workItemId, persisted.selection.workItemId)
      )).limit(1).for('update');
      if (dispatch === undefined || failedRun === undefined) {
        return complete({ok: false, error: {code: 'NOT_FOUND', message: 'The exact failed dispatch was not found.'}});
      }
      if (failedRun.status !== 'failed') {
        return complete({ok: false, error: {code: 'INVALID_TRANSITION', message: 'Only a failed AgentRun can be retried.'}});
      }
      if (options.runnerQueueEnabled !== true) {
        return complete({ok: false, error: {code: 'POLICY_DENIED',
          message: 'Retry admission requires the enabled isolated runner queue and local transport.'}});
      }
      const [profileBinding] = await tx.select({
        profileId: schema.agentProfiles.id,
        profileActorId: schema.agentProfiles.actorId,
        profileRuntimeId: schema.agentProfiles.runtimeId,
        profileRuntimeProfile: schema.agentProfiles.runtimeProfile,
        profileEnabled: schema.agentProfiles.enabled,
        profileVersion: schema.agentProfiles.version,
        profileConfigHash: schema.agentProfiles.configHash,
        actorType: schema.actors.type,
        actorAuthMode: schema.actors.authMode,
        actorDisabledAt: schema.actors.disabledAt,
        registrationId: schema.runtimeRegistrations.id,
        registrationVersion: schema.runtimeRegistrations.version,
        registrationEnabled: schema.runtimeRegistrations.enabled,
        registrationRuntimeKey: schema.runtimeRegistrations.runtimeKey,
        serviceMaxAgeSeconds: schema.runtimeRegistrations.serviceMaxAgeSeconds,
        schedulerMaxAgeSeconds: schema.runtimeRegistrations.schedulerMaxAgeSeconds,
        deliveryMaxAgeSeconds: schema.runtimeRegistrations.deliveryMaxAgeSeconds,
        packetProfileId: schema.taskPackets.agentProfileSnapshotId,
        packetProfileRuntimeId: schema.taskPackets.agentProfileSnapshotRuntimeId,
        packetProfileRuntimeProfile: schema.taskPackets.runtimeProfile,
        packetProfileEnabled: schema.taskPackets.agentProfileSnapshotEnabled,
        packetProfileVersion: schema.taskPackets.agentProfileSnapshotVersion,
        packetProfileHash: schema.taskPackets.agentProfileSnapshotHash,
        packetDataPolicy: schema.taskPackets.dataPolicy,
        qaTaskPacketId: schema.qaTaskPackets.taskPacketId,
        repositoryOwner: schema.projectTrackerRepositoryScopes.repositoryOwner,
        repositoryName: schema.projectTrackerRepositoryScopes.repositoryName
      }).from(schema.agentProfiles)
        .innerJoin(schema.actors, eq(schema.actors.id, schema.agentProfiles.actorId))
        .innerJoin(schema.runtimeRegistrations, and(
          eq(schema.runtimeRegistrations.id, dispatch.runtimeRegistrationId),
          eq(schema.runtimeRegistrations.projectId, project.id),
          eq(schema.runtimeRegistrations.agentProfileId, schema.agentProfiles.id),
          eq(schema.runtimeRegistrations.actorId, schema.agentProfiles.actorId)
        ))
        .innerJoin(schema.taskPackets, eq(schema.taskPackets.id, failedRun.taskPacketId))
        .leftJoin(schema.qaTaskPackets, eq(schema.qaTaskPackets.taskPacketId, schema.taskPackets.id))
        .innerJoin(schema.projectTrackerRepositoryScopes, eq(
          schema.projectTrackerRepositoryScopes.id, failedRun.repositoryScopeId))
        .where(and(
          eq(schema.agentProfiles.id, failedRun.agentProfileId),
          eq(schema.agentProfiles.workspaceId, command.workspaceId)
        )).limit(1).for('update', {of: schema.runtimeRegistrations});
      if (profileBinding === undefined ||
        profileBinding.profileId !== persisted.selection.responsibleActor.agentProfileId ||
        profileBinding.profileActorId !== persisted.selection.responsibleActor.id ||
        !profileBinding.profileEnabled || profileBinding.actorType !== 'agent' ||
        profileBinding.actorAuthMode !== 'agent' || profileBinding.actorDisabledAt !== null ||
        !profileBinding.registrationEnabled ||
        profileBinding.registrationVersion !== dispatch.runtimeRegistrationVersion ||
        !isRuntimeAvailable(profileBinding.profileRuntimeId, options.runtimeEnvironment) ||
        profileBinding.packetProfileId !== profileBinding.profileId ||
        profileBinding.packetProfileRuntimeId !== profileBinding.profileRuntimeId ||
        profileBinding.packetProfileRuntimeProfile !== profileBinding.profileRuntimeProfile ||
        profileBinding.packetProfileEnabled !== true ||
        profileBinding.packetProfileVersion !== profileBinding.profileVersion ||
        profileBinding.packetProfileHash !== profileBinding.profileConfigHash) {
        return complete({ok: false, error: {code: 'POLICY_DENIED',
          message: 'The exact enabled profile, runtime registration, or Task Packet snapshot is unavailable.'}});
      }
      if (profileBinding.profileRuntimeId === 'hermes') {
        const frozen = dispatch.workOrder;
        const canonicalHash = recordValue(frozen)
          ? createHash('sha256').update(canonicalJson(frozen as never)).digest('hex') : null;
        const runtime = recordValue(frozen) && recordValue(frozen.runtime) ? frozen.runtime : null;
        if (canonicalHash === null || canonicalHash !== dispatch.workOrderHash ||
          dispatch.orchestratorRuntimeId !== 'hermes' || dispatch.executorRuntimeId !== 'codex-cli' ||
          runtime?.hermesVersion !== options.runtimeEnvironment?.HERMES_ORCHESTRATOR_VERSION ||
          runtime?.hermesConfigSha256 !== options.runtimeEnvironment?.HERMES_ORCHESTRATOR_CONFIG_SHA256) {
          return complete({ok: false, error: {code: 'POLICY_DENIED',
            message: 'The immutable Hermes work order or runtime binding drifted before retry.'}});
        }
        const admission = await autonomousQaAdmission(tx, {at: now,
          transport: options.autonomousQaClaimTransport, workspaceId: command.workspaceId,
          projectId: project.id, repository: {owner: profileBinding.repositoryOwner,
            name: profileBinding.repositoryName}, runtimeId: 'hermes',
          registration: {id: profileBinding.registrationId, version: profileBinding.registrationVersion,
            runtimeKey: profileBinding.registrationRuntimeKey,
            serviceMaxAgeSeconds: profileBinding.serviceMaxAgeSeconds,
            schedulerMaxAgeSeconds: profileBinding.schedulerMaxAgeSeconds,
            deliveryMaxAgeSeconds: profileBinding.deliveryMaxAgeSeconds}});
        if (admission !== 'available') return complete({ok: false, error: {code: 'POLICY_DENIED',
          message: 'Hermes retry requires the exact authenticated transport and fresh observations.'}});
      }
      if (profileBinding.qaTaskPacketId !== null) {
        const policy = typeof profileBinding.packetDataPolicy === 'object' &&
          profileBinding.packetDataPolicy !== null && !Array.isArray(profileBinding.packetDataPolicy) &&
          typeof profileBinding.packetDataPolicy.governedQa === 'object' &&
          profileBinding.packetDataPolicy.governedQa !== null &&
          !Array.isArray(profileBinding.packetDataPolicy.governedQa)
          ? profileBinding.packetDataPolicy.governedQa as Record<string, unknown> : null;
        const admission = await autonomousQaAdmission(tx, {at: now,
          transport: options.autonomousQaClaimTransport, workspaceId: command.workspaceId,
          projectId: project.id, repository: {owner: profileBinding.repositoryOwner,
            name: profileBinding.repositoryName}, runtimeId: profileBinding.profileRuntimeId,
          registration: {id: profileBinding.registrationId, version: profileBinding.registrationVersion,
            runtimeKey: profileBinding.registrationRuntimeKey,
            serviceMaxAgeSeconds: profileBinding.serviceMaxAgeSeconds,
            schedulerMaxAgeSeconds: profileBinding.schedulerMaxAgeSeconds,
            deliveryMaxAgeSeconds: profileBinding.deliveryMaxAgeSeconds}});
        const transport = options.autonomousQaClaimTransport?.status === 'available'
          ? options.autonomousQaClaimTransport.identity : null;
        if (policy === null || policy.mode !== 'autonomous' || policy.runtimeId !== 'hermes' ||
          policy.runtimeRegistrationId !== profileBinding.registrationId ||
          policy.runtimeRegistrationVersion !== profileBinding.registrationVersion ||
          policy.runtimeRegistrationKey !== profileBinding.registrationRuntimeKey ||
          policy.claimTransportKind !== 'hermes_authenticated_claim_v1' ||
          transport === null || policy.claimTransportRunnerId !== transport.runnerId ||
          admission !== 'available') {
          return complete({ok: false, error: {code: 'POLICY_DENIED',
            message: admission === 'availability_unavailable'
              ? 'Autonomous QA retry requires fresh service, scheduler, and delivery observations.'
              : 'Autonomous QA retry requires the exact authenticated Hermes transport identity.'}});
        }
      }
      const history = await tx.select({id: schema.agentRuns.id, status: schema.agentRuns.status,
        createdAt: schema.agentRuns.createdAt}).from(schema.agentRuns).where(
        eq(schema.agentRuns.taskPacketId, failedRun.taskPacketId)
      ).orderBy(asc(schema.agentRuns.createdAt), asc(schema.agentRuns.id)).for('update');
      if (history.some(({status}) => status === 'queued' || status === 'running' || status === 'waiting_approval')) {
        return complete({ok: false, error: {code: 'VERSION_CONFLICT', message: 'An active AgentRun already exists for this retry chain.'}});
      }
      for (const runId of history.map(({id}) => id).sort()) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`);
      }
      const costReceipts = await tx.select({id: schema.commandReceipts.id,
        aggregateId: schema.commandReceipts.aggregateId, result: schema.commandReceipts.result,
        completedAt: schema.commandReceipts.completedAt,
        createdAt: schema.commandReceipts.createdAt}).from(schema.commandReceipts).where(and(
        eq(schema.commandReceipts.workspaceId, command.workspaceId),
        eq(schema.commandReceipts.commandType, 'agent_run.cost.record.v1'),
        eq(schema.commandReceipts.state, 'completed'),
        inArray(schema.commandReceipts.aggregateId, history.map(({id}) => id))
      )).orderBy(desc(schema.commandReceipts.completedAt), desc(schema.commandReceipts.createdAt),
        desc(schema.commandReceipts.id));
      const latestCostByRun = new Map<string, unknown>();
      for (const receipt of costReceipts) {
        if (receipt.aggregateId !== null && !latestCostByRun.has(receipt.aggregateId)) {
          latestCostByRun.set(receipt.aggregateId, receipt.result);
        }
      }
      let observedCostMinor: number | null = 0;
      let observedCostExceeded = false;
      for (const run of history) {
        const cost = calculatedCost(latestCostByRun.get(run.id), run.id, input.policy.currency);
        if (cost === null) { observedCostMinor = null; break; }
        if (!Number.isSafeInteger(observedCostMinor + cost)) {
          observedCostMinor = input.policy.maxObservedPriorCostMinor;
          observedCostExceeded = true;
          break;
        }
        observedCostMinor += cost;
        if (observedCostMinor >= input.policy.maxObservedPriorCostMinor) {
          observedCostExceeded = true;
          observedCostMinor = Math.min(observedCostMinor,
            input.policy.maxObservedPriorCostMinor);
          break;
        }
      }
      const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - history[0]!.createdAt.getTime()) / 60_000));
      const attemptsUsed = history.length;
      const costFact = observedCostMinor;
      const stopReason = evaluateAgentRunRetryAdmission({attemptsUsed, elapsedMinutes,
        observedPriorCostMinor: costFact,
        observedPriorCostExceeded: observedCostExceeded}, input.policy);
      resultVersion = execution.version + 1;
      if (stopReason !== null) {
        const [updated] = await tx.update(schema.projectExecutions).set({
          status: 'blocked', blockReason: `retry_${stopReason}`, version: resultVersion, updatedAt: now
        }).where(and(eq(schema.projectExecutions.projectId, project.id),
          eq(schema.projectExecutions.version, execution.version), eq(schema.projectExecutions.status, 'running')))
          .returning({version: schema.projectExecutions.version});
        if (updated === undefined) throw new Error('agent_run_retry_continuation_execution_cas');
        const deduplicationKey = `agent_run_retry_stop:v1:${failedRun.id}`;
        const [insertedAttention] = await tx.insert(schema.riskSignals).values({
          projectId: project.id, workItemId: failedRun.workItemId, agentRunId: failedRun.id,
          code: `retry_${stopReason}`, ruleId: 'agent_run_retry_policy', ruleVersion: 'v1',
          signalClass: 'fact', severity: 'yellow',
          summary: `AgentRun retry stopped: ${stopReason}.`,
          details: {attemptsUsed, elapsedMinutes, observedCostMinor: costFact,
            policy: input.policy},
          evidenceReferences: [{type: 'agent_run', id: failedRun.id},
            {type: 'command_receipt', id: command.commandId}],
          impact: 'Autonomous continuation is paused until a human reviews the bounded retry facts.',
          ownerActorId: command.actor.actorId,
          nextAction: 'Review the failed receipt and retry policy facts; explicitly stop or issue a new governed decision.',
          observedAt: now, deduplicationKey
        }).onConflictDoNothing().returning({id: schema.riskSignals.id});
        const [attention] = insertedAttention === undefined
          ? await tx.select({id: schema.riskSignals.id}).from(schema.riskSignals).where(and(
              eq(schema.riskSignals.projectId, project.id),
              eq(schema.riskSignals.deduplicationKey, deduplicationKey),
              isNull(schema.riskSignals.resolvedAt)
            )).limit(1)
          : [insertedAttention];
        return complete({ok: true, value: {disposition: 'ask', projectId: project.id,
          failedRunId: failedRun.id, retryRunId: null, executionVersion: resultVersion,
          attemptsUsed, elapsedMinutes, observedCostMinor: costFact,
          currency: input.policy.currency, stopReason,
          attentionId: attention?.id ?? null,
          nextAction: 'Human review is required; no AgentRun was queued.',
          policy: input.policy}});
      }
      const [newRun] = await tx.insert(schema.agentRuns).values({
        id: command.payload.retryRunId, taskPacketId: failedRun.taskPacketId,
        agentProfileId: failedRun.agentProfileId, workItemId: failedRun.workItemId,
        repositoryScopeId: failedRun.repositoryScopeId, retryOfAgentRunId: failedRun.id,
        confirmedPacketHash: failedRun.confirmedPacketHash, baseCommit: failedRun.baseCommit,
        status: 'queued', idempotencyKey: command.idempotencyKey, attempt: 0, version: 1,
        createdAt: now, updatedAt: now
      }).returning({id: schema.agentRuns.id});
      if (newRun === undefined) throw new Error('agent_run_retry_continuation_insert');
      const [updated] = await tx.update(schema.projectExecutions).set({
        version: resultVersion, updatedAt: now
      }).where(and(eq(schema.projectExecutions.projectId, project.id),
        eq(schema.projectExecutions.version, execution.version), eq(schema.projectExecutions.status, 'running')))
        .returning({version: schema.projectExecutions.version});
      if (updated === undefined) throw new Error('agent_run_retry_continuation_execution_cas');
      await tx.insert(schema.projectExecutionDispatches).values({
        workspaceId: command.workspaceId, projectId: project.id, executionVersion: resultVersion,
        selectionHash: dispatch.selectionHash, taskPacketId: dispatch.taskPacketId,
        agentRunId: newRun.id, runtimeRegistrationId: dispatch.runtimeRegistrationId,
        runtimeRegistrationVersion: dispatch.runtimeRegistrationVersion,
        workOrder: dispatch.workOrder, workOrderHash: dispatch.workOrderHash,
        orchestratorRuntimeId: dispatch.orchestratorRuntimeId,
        executorRuntimeId: dispatch.executorRuntimeId,
        requestedByActorId: command.actor.actorId, createdAt: now
      });
      return complete({ok: true, value: {disposition: 'queued', projectId: project.id,
        failedRunId: failedRun.id, retryRunId: newRun.id, executionVersion: resultVersion,
        attemptsUsed, elapsedMinutes, observedCostMinor: costFact,
        currency: input.policy.currency, stopReason: null, attentionId: null,
        nextAction: 'Wait for an authorized isolated runner to claim the queued retry.',
        policy: input.policy}});
    });
  }
});

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
    const [baseline] = await tx.select({id: schema.projectScopeBaselineVersions.id})
      .from(schema.projectScopeBaselineVersions).where(and(
        eq(schema.projectScopeBaselineVersions.projectId, projectId),
        eq(schema.projectScopeBaselineVersions.sourcePlanVersionId, materialization.planVersionId),
        eq(schema.projectScopeBaselineVersions.active, true)
      )).limit(1).for('update');
    const outcomes = baseline === undefined ? [] : await tx.select({
      weight: schema.projectScopeOutcomes.weight,
      state: schema.projectScopeOutcomes.state,
      acceptedByActorId: schema.projectScopeOutcomes.acceptedByActorId,
      acceptedAt: schema.projectScopeOutcomes.acceptedAt,
      evidenceReference: schema.projectScopeOutcomes.evidenceReference
    }).from(schema.projectScopeOutcomes)
      .where(eq(schema.projectScopeOutcomes.baselineId, baseline.id))
      .orderBy(schema.projectScopeOutcomes.id).for('update');
    const totalWeight = outcomes.reduce((total, outcome) => total + outcome.weight, 0);
    const accepted = outcomes.length > 0 && totalWeight === 100 && outcomes.every((outcome) =>
      outcome.state === 'accepted' && outcome.acceptedByActorId !== null &&
      outcome.acceptedAt !== null && outcome.evidenceReference !== null);
    return accepted
      ? {status: 'blocked' as const, selection: null, blockReason: 'uat_required'}
      : {status: 'blocked' as const, selection: null, blockReason: 'scope_acceptance_required'};
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
    if (selection === null) continue;
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
          startedAt: now, completedAt: null, updatedAt: now});
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
          completedAt: null, version: resultVersion, updatedAt: now})
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
  | 'runtime_availability_unavailable'
  | 'autonomous_qa_transport_unavailable'
  | 'repository_base_commit_unavailable'
  | 'dispatch_policy_denied'
  | 'dispatch_packet_invalid'
  | 'active_agent_run_exists';

export type AutonomousQaClaimTransportIdentity = Readonly<{
  kind: 'hermes_authenticated_claim_v1';
  runnerId: string;
  workspaceId: string;
  projectIds: readonly string[];
  repositories: readonly Readonly<{owner: string; name: string}>[];
  runtimeIds: readonly string[];
  runtimeRegistrationKeys: readonly string[];
}>;
export type AutonomousQaClaimTransport =
  | Readonly<{status: 'unavailable'; reason: string}>
  | Readonly<{status: 'available'; identity: AutonomousQaClaimTransportIdentity}>;

type AutonomousQaAdmission = 'available' | 'transport_unavailable' | 'availability_unavailable';
const autonomousQaAdmission = async (tx: Queryable, input: Readonly<{
  at: Date;
  transport: AutonomousQaClaimTransport | undefined;
  workspaceId: string;
  projectId: string;
  repository: Readonly<{owner: string; name: string}>;
  runtimeId: string;
  registration: Readonly<{id: string; version: number; runtimeKey: string;
    serviceMaxAgeSeconds: number | null; schedulerMaxAgeSeconds: number | null;
    deliveryMaxAgeSeconds: number | null}>;
}>): Promise<AutonomousQaAdmission> => {
  const transport = input.transport?.status === 'available' ? input.transport.identity : null;
  if (input.runtimeId !== 'hermes' || transport === null ||
    transport.kind !== 'hermes_authenticated_claim_v1' ||
    transport.workspaceId !== input.workspaceId || !transport.projectIds.includes(input.projectId) ||
    !transport.runtimeIds.includes(input.runtimeId) ||
    !transport.runtimeRegistrationKeys.includes(input.registration.runtimeKey) ||
    !transport.repositories.some(({owner, name}) => owner === input.repository.owner &&
      name === input.repository.name)) return 'transport_unavailable';
  const observations = await tx.select({component: schema.runtimeAvailabilityObservations.component,
    state: schema.runtimeAvailabilityObservations.state,
    observedAt: schema.runtimeAvailabilityObservations.observedAt,
    ttlSeconds: schema.runtimeAvailabilityObservations.ttlSeconds
  }).from(schema.runtimeAvailabilityObservations).where(eq(
    schema.runtimeAvailabilityObservations.runtimeRegistrationId, input.registration.id
  )).orderBy(schema.runtimeAvailabilityObservations.component,
    desc(schema.runtimeAvailabilityObservations.observedAt),
    desc(schema.runtimeAvailabilityObservations.id));
  const latest = new Map<string, (typeof observations)[number]>();
  for (const observation of observations) if (!latest.has(observation.component)) {
    latest.set(observation.component, observation);
  }
  const thresholds = new Map<string, number | null>([
    ['service', input.registration.serviceMaxAgeSeconds],
    ['scheduler', input.registration.schedulerMaxAgeSeconds],
    ['delivery', input.registration.deliveryMaxAgeSeconds]
  ]);
  return ['service', 'scheduler', 'delivery'].every((component) => {
    const threshold = thresholds.get(component); const observation = latest.get(component);
    if (threshold === null || threshold === undefined || observation === undefined ||
      observation.state !== 'available' || observation.ttlSeconds === null) return false;
    const ageMs = input.at.getTime() - observation.observedAt.getTime();
    return ageMs >= 0 && ageMs <= Math.min(threshold, observation.ttlSeconds) * 1_000;
  }) ? 'available' : 'availability_unavailable';
};

type DispatchOptions = Readonly<{
  now?: () => Date;
  runnerQueueEnabled?: boolean;
  runtimeEnvironment?: Readonly<Record<string, string | undefined>>;
  autonomousQaClaimTransport?: AutonomousQaClaimTransport;
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
        const [work, plan, protocol, profileRows, registrations, repositoryScopes,
          materializations, memberships, dossierArtifacts] = await Promise.all([
          tx.select({title: schema.workItems.title, summary: schema.workItems.summary,
            version: schema.workItems.version, sourceTaskKey: schema.workItems.sourceTaskKey,
            acceptanceEvidence: schema.workItems.acceptanceEvidence})
            .from(schema.workItems).where(and(eq(schema.workItems.id, selection.workItemId),
              eq(schema.workItems.projectId, execution.projectId), isNull(schema.workItems.deletedAt))).limit(1),
          tx.select({contentHash: schema.projectPlanVersions.contentHash,
            version: schema.projectPlanVersions.version,
            sourceManifest: schema.projectPlanVersions.sourceManifest,
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
          tx.select({id: schema.runtimeRegistrations.id, version: schema.runtimeRegistrations.version,
            provider: schema.runtimeRegistrations.provider, runtimeKey: schema.runtimeRegistrations.runtimeKey,
            serviceMaxAgeSeconds: schema.runtimeRegistrations.serviceMaxAgeSeconds,
            schedulerMaxAgeSeconds: schema.runtimeRegistrations.schedulerMaxAgeSeconds,
            deliveryMaxAgeSeconds: schema.runtimeRegistrations.deliveryMaxAgeSeconds})
            .from(schema.runtimeRegistrations).where(and(
              eq(schema.runtimeRegistrations.projectId, execution.projectId),
              eq(schema.runtimeRegistrations.actorId, selection.responsibleActor.id),
              eq(schema.runtimeRegistrations.agentProfileId, selection.responsibleActor.agentProfileId),
              eq(schema.runtimeRegistrations.enabled, true))).orderBy(asc(schema.runtimeRegistrations.id)).limit(2),
          tx.select({id: schema.projectTrackerRepositoryScopes.id,
            provider: schema.projectTrackerRepositoryScopes.provider,
            repositoryOwner: schema.projectTrackerRepositoryScopes.repositoryOwner,
            repositoryName: schema.projectTrackerRepositoryScopes.repositoryName,
            repositoryExternalId: schema.projectTrackerRepositoryScopes.repositoryExternalId})
            .from(schema.projectTrackerRepositoryScopes)
            .where(eq(schema.projectTrackerRepositoryScopes.projectId, execution.projectId)).limit(2),
          tx.select({id: schema.projectPlanMaterializations.id,
            planHash: schema.projectPlanMaterializations.planHash,
            sourceManifestHash: schema.projectPlanMaterializations.sourceManifestHash,
            planVersion: schema.projectPlanMaterializations.planVersion})
            .from(schema.projectPlanMaterializations).where(and(
              eq(schema.projectPlanMaterializations.projectId, execution.projectId),
              eq(schema.projectPlanMaterializations.planVersionId, selection.planVersionId))).limit(2),
          tx.select({id: schema.projectMemberships.id, version: schema.projectMemberships.version,
            roles: schema.projectMemberships.roles})
            .from(schema.projectMemberships).where(and(
              eq(schema.projectMemberships.projectId, execution.projectId),
              eq(schema.projectMemberships.actorId, selection.responsibleActor.id),
              eq(schema.projectMemberships.active, true))).limit(2),
          tx.select({id: schema.projectSourceArtifacts.id, version: schema.projectSourceArtifacts.version,
            sha256: schema.projectSourceArtifacts.sha256,
            sourceKind: schema.projectSourceArtifacts.sourceKind,
            mediaType: schema.projectSourceArtifacts.mediaType})
            .from(schema.projectSourceArtifacts).where(and(
              eq(schema.projectSourceArtifacts.workspaceId, project.workspaceId),
              eq(schema.projectSourceArtifacts.projectId, execution.projectId))).limit(100)
        ]);
        const profile = profileRows[0];
        if (profile === undefined || !profile.enabled || profile.actorId !== selection.responsibleActor.id ||
          profile.actorType !== 'agent' || profile.actorAuthMode !== 'agent' || profile.actorDisabledAt !== null ||
          registrations.length !== 1 || !isRuntimeAvailable(profile.runtimeId, options.runtimeEnvironment)) {
          return block('runtime_registration_unavailable', 'POLICY_DENIED',
            'The selected active agent profile and runtime registration are not available.');
        }
        if (work[0] === undefined || work[0].version !== selection.workItemVersion || plan[0] === undefined ||
          protocol[0] === undefined || protocol[0].contentHash === null ||
          repositoryScopes.length !== 1 || materializations.length !== 1 ||
          memberships.length !== 1) {
          return block('selection_preconditions_stale', 'VERSION_CONFLICT',
            'The exact plan, materialization, work item, responsibility, protocol, or repository scope changed.');
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
        const dossierById = new Map(dossierArtifacts.map((artifact) => [artifact.id, artifact]));
        const sourceManifest = plan[0].sourceManifest;
        const frozenDossier = sourceManifest.map((entry) => dossierById.get(entry.artifactId));
        const sourceManifestHash = createHash('sha256')
          .update(canonicalJson(sourceManifest as never)).digest('hex');
        if (profile.runtimeId === 'hermes' && (
          new Set(sourceManifest.map(({artifactId}) => artifactId)).size !== sourceManifest.length ||
          frozenDossier.some((artifact, index) => artifact === undefined ||
            artifact.version !== sourceManifest[index]!.version ||
            artifact.sha256 !== sourceManifest[index]!.sha256) ||
          materializations[0]!.planVersion !== plan[0].version ||
          materializations[0]!.planHash !== plan[0].contentHash ||
          materializations[0]!.sourceManifestHash !== sourceManifestHash)) {
          return block('selection_preconditions_stale', 'VERSION_CONFLICT',
            'The exact dossier manifest or approved plan materialization changed.');
        }
        const autonomousQa = stage.taskStatus === 'qa';
        const autonomousQaTransportIdentity = options.autonomousQaClaimTransport?.status === 'available'
          ? options.autonomousQaClaimTransport.identity : null;
        if (autonomousQa || profile.runtimeId === 'hermes') {
          const registration = registrations[0]!;
          const repository = repositoryScopes[0]!;
          const admission = await autonomousQaAdmission(tx, {at: now,
            transport: options.autonomousQaClaimTransport, workspaceId: project.workspaceId,
            projectId: execution.projectId,
            repository: {owner: repository.repositoryOwner, name: repository.repositoryName},
            runtimeId: profile.runtimeId, registration});
          if (admission === 'transport_unavailable') {
            return block('autonomous_qa_transport_unavailable', 'POLICY_DENIED',
              'Hermes execution requires an exact authenticated claim transport identity and allowlists.');
          }
          if (admission === 'availability_unavailable') {
            return block('runtime_availability_unavailable', 'POLICY_DENIED',
              'Hermes execution requires fresh available service, scheduler, and delivery observations.');
          }
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
          agentProfileId: profile.profileId, responsibilityHash: selection.responsibilityHash
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
            protocolRequiredEvidence: stage.requiredEvidence,
            ...(autonomousQa ? {governedQa: {
              mode: 'autonomous', runtimeId: profile.runtimeId,
              runtimeRegistrationId: registrations[0]!.id,
              runtimeRegistrationVersion: registrations[0]!.version,
              runtimeRegistrationKey: registrations[0]!.runtimeKey,
              claimTransportKind: autonomousQaTransportIdentity!.kind,
              claimTransportRunnerId: autonomousQaTransportIdentity!.runnerId
            }} : {})},
          timeboxMinutes: 120,
          expectedOutputSchema: autonomousQa
            ? {schemaVersion: 1, resultFormat: 'governed_qa_receipt_v1',
                checks: {maximum: 50}, artifacts: {maximum: 25}, failures: {maximum: 25},
                risks: {maximum: 25}, requiredEvidence: stage.requiredEvidence,
                stageTransition: 'explicit_human_manager_command_after_pass'}
            : {schemaVersion: 1, resultFormat: 'structured_v1',
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
        const allowedActions = profile.runtimeProfile === 'read_safe'
          ? ['read_repository', 'run_scoped_checks', 'produce_structured_receipt']
          : ['read_repository', 'write_isolated_worktree', 'run_scoped_checks', 'produce_structured_receipt'];
        const forbiddenActions = ['external_provider_write', 'merge', 'release', 'deploy', 'production_access'];
        const registration = registrations[0]!;
        const membership = memberships[0]!;
        const repository = repositoryScopes[0]!;
        const materialization = materializations[0]!;
        const workOrder: HermesCodexWorkOrder = {
          schemaVersion: 1,
          runtime: {hermesVersion: '0.18.2', hermesConfigSha256:
            options.runtimeEnvironment?.HERMES_ORCHESTRATOR_CONFIG_SHA256 ?? ''},
          project: {id: execution.projectId},
          dossierManifest: sourceManifest.map((entry, index) => ({
            artifactId: entry.artifactId,
            version: entry.version,
            sha256: entry.sha256,
            sourceKind: frozenDossier[index]!.sourceKind,
            mediaType: frozenDossier[index]!.mediaType
          })),
          plan: {versionId: selection.planVersionId, version: plan[0].version,
            sha256: plan[0].contentHash, sourceManifestSha256: sourceManifestHash,
            materializationId: materialization.id},
          protocol: {id: selection.protocolId, version: selection.protocolVersion,
            sha256: protocol[0].contentHash, stageKey: selection.stageKey,
            requiredEvidence: [...stage.requiredEvidence]},
          execution: {version: execution.version, selectionSha256: selectionHash,
            journeyVersion: selection.journeyVersion, workItemId: selection.workItemId,
            workItemVersion: selection.workItemVersion,
            responsibility: stage.responsibility as never,
            responsibilitySha256: selection.responsibilityHash},
          actor: {id: selection.responsibleActor.id, membershipId: membership.id,
            membershipVersion: membership.version, membershipRoles: [...membership.roles],
            profileId: profile.profileId, profileVersion: profile.version,
            profileConfigSha256: profile.configHash, registrationId: registration.id,
            registrationVersion: registration.version},
          repository: {owner: repository.repositoryOwner, name: repository.repositoryName,
            baseCommit},
          orchestration: {
            strategyOptions: ['evidence_first', 'risk_first', 'minimal_change'],
            stepIds: profile.runtimeProfile === 'read_safe'
              ? ['step.inspect_scope', 'step.verify_evidence', 'step.report']
              : ['step.inspect_scope', 'step.implement_scoped_change', 'step.verify_evidence', 'step.report'],
            checkCandidates: acceptanceCriteria.map((_, index) => ({
              id: `check.acceptance.${String(index + 1).padStart(3, '0')}`,
              requirementIndex: index
            })),
            riskControlIds: ['risk.no_external_provider_write', 'risk.no_merge',
              'risk.no_release', 'risk.no_deploy', 'risk.no_production_access']
          },
          taskPacket: {id: packetId, sha256: packetResult.value.contentHash,
            goal: packetResult.value.content.goal,
            acceptanceCriteria: [...packetResult.value.content.acceptanceCriteria],
            timeboxMinutes: packetResult.value.content.timeboxMinutes,
            allowedActions, forbiddenActions,
            dataPolicySha256: createHash('sha256')
              .update(canonicalJson(packetResult.value.content.dataPolicy)).digest('hex'),
            expectedOutput: packetResult.value.content.expectedOutputSchema}
        };
        const workOrderHash = createHash('sha256')
          .update(canonicalJson(workOrder as never)).digest('hex');
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
        if (autonomousQa) {
          await tx.insert(schema.qaTaskPackets).values({taskPacketId: packet.packetId,
            projectId: execution.projectId, planVersionId: selection.planVersionId,
            workItemId: selection.workItemId, workItemVersion: selection.workItemVersion,
            protocolId: selection.protocolId, protocolVersion: selection.protocolVersion,
            journeyVersion: selection.journeyVersion, stageKey: selection.stageKey,
            responsibility: stage.responsibility, requiredEvidence: [...stage.requiredEvidence],
            preparedByActorId: input.requestedByActorId, createdAt: now});
        }
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
          ...(profile.runtimeId === 'hermes' ? {workOrder: workOrder as never, workOrderHash,
            orchestratorRuntimeId: 'hermes', executorRuntimeId: 'codex-cli'} : {}),
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
