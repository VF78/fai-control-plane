import {createHash} from 'node:crypto';
import {and, desc, eq, inArray, isNull, max, or} from 'drizzle-orm';
import {
  CANONICAL_COMMAND_POLICY,
  parseRunnerCompletionPayload
} from '@fai-control-plane/application';
import {
  accessRequests,
  actorExternalIdentities,
  actors,
  agentProfiles,
  agentProfileInstructionVersions,
  agentRunReceipts,
  agentRuns,
  approvalRequests,
  artifacts,
  auditEvents,
  commandReceipts,
  deliveryJourneys,
  deliveryJourneyEvidence,
  COST_LEDGER_COMMAND,
  createDatabase,
  isRuntimeAvailable,
  isTaskPacketProfileEligible,
  dashboardSnapshots,
  healthcheckStaleAfterMs,
  milestones,
  outboxEvents,
  projectShareGrants,
  projectShareWorkItems,
  projectScopeBaselineVersions,
  projectScopeOutcomeObservations,
  projectScopeOutcomes,
  projectTrackerRepositoryScopes,
  projects,
  projectMemberships,
  resourceAccessGrants,
  runtimeAvailabilityObservations,
  runtimeRegistrations,
  runbooks,
  riskSignalDispositionEvents,
  riskSignals,
  scheduledJobs,
  secretRefs,
  taskPackets,
  trackerBindings,
  trackerSnapshotOperations,
  workspaceInstructionVersions,
  statusTransitions,
  VALUE_LEDGER_COMMAND,
  workItems,
  ledgerRoi,
  loadConversationRows,
  loadFailedNotificationDeliveryFacts,
  parseLedgerRecord,
  type LedgerCost,
  type LedgerRecord,
  type LedgerRoi,
  type RiskSignalDispositionReason,
  type ValueEvidence
} from '@fai-control-plane/db';
import {
  CURRENT_POLICY_VERSION,
  actionCategories,
  actorTypes,
  canonicalJson,
  deriveRuntimeAvailability,
  effectiveInstructions,
  environments,
  policyDecisionFor,
  policyMatrix,
  policySurfaces,
  validateDeliveryProtocolDefinition,
  type DeliveryProtocol,
  type CanonicalJson,
  type PolicyDecision,
  type RuntimeAvailabilityProjection
} from '@fai-control-plane/domain';
import {
  activeRiskDisposition,
  rankAttentionQueue,
  type AttentionQueueItem
} from './attention-queue';

export const operatorProjectSlugs = ['msa', 'ascon'] as const;
export type OperatorProjectSlug = (typeof operatorProjectSlugs)[number];
export const isOperatorProjectSlug = (value: string): value is OperatorProjectSlug =>
  (operatorProjectSlugs as readonly string[]).includes(value);

export type OperatorLoad<T> =
  | Readonly<{state: 'ready'; data: T}>
  | Readonly<{state: 'unconfigured' | 'unavailable'}>;

type Database = ReturnType<typeof createDatabase>['db'];
type Project = Readonly<{
  id: string;
  workspaceId: string;
  name: string;
  slug: OperatorProjectSlug;
  description: string | null;
  defaultBranch: string;
  updatedAt: Date;
}>;

export const workItemStatuses = ['backlog', 'ready', 'in_dev', 'qa', 'acceptance', 'done'] as const;

export type ConversationsData = Readonly<{
  projects: readonly Readonly<{
    id: string;
    name: string;
    slug: OperatorProjectSlug;
    channels: readonly Readonly<{
      conversationClass: 'internal' | 'client';
      state: 'not_configured' | 'empty' | 'ready' | 'degraded';
      freshnessAt: Date | null;
      failure: Readonly<{code: string; at: Date; count: number}> | null;
      participants: readonly Readonly<{
        id: string;
        displayName: string;
        resolution: 'resolved' | 'unresolved';
        controlPlaneAccess: string;
        lastObservedAt: Date;
      }>[];
      messages: readonly Readonly<{
        id: string;
        participantId: string;
        author: string;
        sentAt: Date;
        text: string | null;
        attachmentSummary: string | null;
        reply: boolean;
        threaded: boolean;
      }>[];
    }>[];
  }>[];
}>;

export type AgentRunQueuePolicyPreview = Readonly<{
  actorType: 'human';
  actionCategory: 'write';
  surface: 'control_plane';
  environment: 'development';
  decision: PolicyDecision;
  policyVersion: number;
  actionHash: string;
  baseCommit: string;
  requiredHumanPacketHash: string;
  stopFactors: readonly string[];
  runnable: boolean;
}>;

export const buildAgentRunQueuePolicyPreview = (input: Readonly<{
  packetId: string;
  contentHash: string;
  agentProfileId: string;
  baseCommit: string;
  approverActorId: string;
}>): AgentRunQueuePolicyPreview => {
  const actorType = 'human' as const;
  const decision = policyDecisionFor(actorType, CANONICAL_COMMAND_POLICY);
  const hashInput: CanonicalJson = {
    action: 'agent_run.queue',
    actorType,
    packetId: input.packetId,
    contentHash: input.contentHash,
    agentProfileId: input.agentProfileId,
    baseCommit: input.baseCommit,
    approverActorId: input.approverActorId,
    policyVersion: CURRENT_POLICY_VERSION,
    policyRequest: CANONICAL_COMMAND_POLICY
  };
  const stopFactors = decision === 'allow'
    ? []
    : [decision === 'ask'
      ? 'Canonical policy requires approval; direct queueing is stopped.'
      : 'Canonical policy denies this queue action.'];
  return {
    actorType,
    ...CANONICAL_COMMAND_POLICY,
    decision,
    policyVersion: CURRENT_POLICY_VERSION,
    actionHash: createHash('sha256').update(canonicalJson(hashInput)).digest('hex'),
    baseCommit: input.baseCommit,
    requiredHumanPacketHash: input.contentHash,
    stopFactors,
    runnable: stopFactors.length === 0
  };
};

const readDatabase = async <T>(loader: (db: Database) => Promise<T>): Promise<OperatorLoad<T>> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return {state: 'unconfigured'};
  let database: ReturnType<typeof createDatabase>;
  try {
    database = createDatabase(databaseUrl);
  } catch {
    return {state: 'unavailable'};
  }
  try {
    return {state: 'ready', data: await loader(database.db)};
  } catch {
    return {state: 'unavailable'};
  } finally {
    await database.pool.end().catch(() => undefined);
  }
};

const scopedProjects = async (db: Database, slug?: OperatorProjectSlug): Promise<Project[]> => {
  const rows = await db.select({
    id: projects.id,
    workspaceId: projects.workspaceId,
    name: projects.name,
    slug: projects.slug,
    description: projects.description,
    defaultBranch: projects.defaultBranch,
    updatedAt: projects.updatedAt
  }).from(projects).where(slug === undefined
    ? inArray(projects.slug, operatorProjectSlugs)
    : eq(projects.slug, slug)).orderBy(projects.slug);
  return rows.flatMap((project): Project[] =>
    isOperatorProjectSlug(project.slug) ? [{...project, slug: project.slug}] : []);
};

export const loadConversationsData = (
  scope?: OperatorProjectSlug
): Promise<OperatorLoad<ConversationsData>> => readDatabase(async (db) => {
  const configuredProjects = await scopedProjects(db, scope);
  const projectIds = configuredProjects.map(({id}) => id);
  const rows = await loadConversationRows(db, projectIds);
  const actorIds = [...new Set(rows.participants.flatMap(({actorId}) =>
    actorId === null ? [] : [actorId]))];
  const [resolvedActors, memberships] = actorIds.length === 0
    ? [[], []]
    : await Promise.all([
      db.select({id: actors.id, displayName: actors.displayName, disabledAt: actors.disabledAt})
        .from(actors).where(inArray(actors.id, actorIds)),
      db.select({
        projectId: projectMemberships.projectId,
        actorId: projectMemberships.actorId,
        role: projectMemberships.role,
        active: projectMemberships.active
      }).from(projectMemberships).where(and(
        inArray(projectMemberships.projectId, projectIds),
        inArray(projectMemberships.actorId, actorIds)
      ))
    ]);
  const actorById = new Map(resolvedActors.map((actor) => [actor.id, actor]));
  return {
    projects: configuredProjects.map((project) => ({
      id: project.id,
      name: project.name,
      slug: project.slug,
      channels: (['internal', 'client'] as const).map((conversationClass) => {
        const binding = rows.bindings.find((candidate) =>
          candidate.projectId === project.id &&
          candidate.conversationClass === conversationClass);
        if (binding === undefined) return {
          conversationClass,
          state: 'not_configured' as const,
          freshnessAt: null,
          failure: null,
          participants: [],
          messages: []
        };
        const channelParticipants = rows.participants.filter(({bindingId}) => bindingId === binding.id);
        const channelMessages = rows.messages.filter(({bindingId}) => bindingId === binding.id);
        const participantViews = channelParticipants.map((participant) => {
          const actor = participant.actorId === null ? undefined : actorById.get(participant.actorId);
          const membership = participant.actorId === null ? undefined : memberships.find((candidate) =>
            candidate.projectId === project.id && candidate.actorId === participant.actorId);
          const resolved = actor !== undefined;
          return {
            id: participant.id,
            displayName: resolved ? actor.displayName : 'Unresolved',
            resolution: resolved ? 'resolved' as const : 'unresolved' as const,
            controlPlaneAccess: actor?.disabledAt === null && membership?.active === true
              ? membership.role.replaceAll('_', ' ')
              : 'No current access',
            lastObservedAt: participant.lastObservedAt
          };
        });
        const participantViewById = new Map(participantViews.map((participant) => [participant.id, participant]));
        const messages = channelMessages.map((message) => {
          const attachmentCounts = new Map<string, number>();
          for (const item of message.attachments) {
            attachmentCounts.set(item.kind, (attachmentCounts.get(item.kind) ?? 0) + 1);
          }
          return {
            id: message.id,
            participantId: message.participantId,
            author: participantViewById.get(message.participantId)?.displayName ?? 'Unresolved',
            sentAt: message.sentAt,
            text: message.text,
            attachmentSummary: attachmentCounts.size === 0 ? null :
              [...attachmentCounts].map(([kind, count]) => `${count} ${kind}`).join(', '),
            reply: message.replyToMessageRef !== null,
            threaded: message.threadRef !== null
          };
        });
        return {
          conversationClass,
          state: binding.lastFailureAt !== null
            ? 'degraded' as const
            : messages.length === 0 ? 'empty' as const : 'ready' as const,
          freshnessAt: binding.lastObservedAt,
          failure: binding.lastFailureAt === null || binding.lastFailureCode === null ? null : {
            code: binding.lastFailureCode,
            at: binding.lastFailureAt,
            count: binding.failureCount
          },
          participants: participantViews,
          messages
        };
      })
    }))
  };
});

const safeExternalUrlValue = (candidate: unknown): string | null => {
  if (typeof candidate !== 'string' || candidate.length > 2048) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.toString() : null;
  } catch {
    return null;
  }
};

const safeExternalUrl = (metadata: Record<string, unknown>): string | null =>
  safeExternalUrlValue(metadata.htmlUrl);

const confirmedGitHubIssueUrl = (
  metadata: Record<string, unknown>,
  repository: Readonly<{owner: string; name: string}> | null
): string | null => {
  const number = metadata.number;
  const candidate = safeExternalUrl(metadata);
  if (repository === null || typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || candidate === null) return null;
  const url = new URL(candidate);
  return url.hostname === 'github.com' && url.port === '' && url.search === '' && url.hash === '' &&
    url.pathname === `/${repository.owner}/${repository.name}/issues/${number}`
    ? url.toString()
    : null;
};

const latestByProject = <T extends Readonly<{projectId: string}>>(rows: readonly T[]): Map<string, T> => {
  const result = new Map<string, T>();
  for (const row of rows) if (!result.has(row.projectId)) result.set(row.projectId, row);
  return result;
};
const outboxWorkItemId = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const workItemId = (payload as Record<string, unknown>).workItemId;
  return typeof workItemId === 'string' ? workItemId : null;
};

export type PortfolioData = Readonly<{
  projects: readonly Readonly<{
    id: string;
    name: string;
    slug: OperatorProjectSlug;
    health: 'green' | 'yellow' | 'red' | 'unknown';
    snapshotAt: Date | null;
    synchronizedAt: Date | null;
    unresolvedRiskCount: number;
    metrics: PortfolioProjectMetrics;
  }>[];
  attention: readonly AttentionQueueItem[];
}>;

const portfolioStages = ['backlog', 'ready', 'in_dev', 'qa', 'acceptance', 'done'] as const;
type PortfolioStage = (typeof portfolioStages)[number];
const activePortfolioStages = new Set<PortfolioStage>(['in_dev', 'qa', 'acceptance']);
const staleActiveWorkAfterMs = 7 * 24 * 60 * 60 * 1_000;
const trendWindowMs = 28 * 24 * 60 * 60 * 1_000;
const minimumTrendSamples = 3;

export type PortfolioProjectMetrics = Readonly<{
  stages: Readonly<Record<PortfolioStage, number>>;
  activeWip: number;
  blockedWork: number;
  staleActiveWork: number;
  pendingApprovals: Readonly<{count: number; oldestAt: Date | null}>;
  integrationFreshness: Date | null;
  milestoneOutlook: Readonly<{state: 'unknown' | 'dated'; due: number; overdue: number}>;
  throughputTrend: Readonly<{state: 'not_enough_history' | 'ready'; recent: number; previous: number}>;
  cycleTime: Readonly<{state: 'not_enough_history' | 'ready'; averageHours: number | null; samples: number}>;
}>;

type PortfolioMetricItem = Readonly<{id: string; projectId: string; status: PortfolioStage; blocked: boolean; updatedAt: Date}>;
type PortfolioMetricApproval = Readonly<{projectId: string; createdAt: Date}>;
type PortfolioMetricMilestone = Readonly<{projectId: string; targetAt: Date | null; closedAt: Date | null}>;
type PortfolioMetricDeadline = Readonly<{projectId: string; deadlineAt: Date | null; status: PortfolioStage}>;
type PortfolioMetricTransition = Readonly<{workItemId: string; projectId: string; toStatus: PortfolioStage; createdAt: Date}>;

export const derivePortfolioProjectMetrics = (input: Readonly<{
  projectId: string;
  items: readonly PortfolioMetricItem[];
  approvals: readonly PortfolioMetricApproval[];
  milestones: readonly PortfolioMetricMilestone[];
  deadlines: readonly PortfolioMetricDeadline[];
  transitions: readonly PortfolioMetricTransition[];
  integrationFreshness: Date | null;
  asOf: Date;
}>): PortfolioProjectMetrics => {
  const projectItems = input.items.filter((item) => item.projectId === input.projectId);
  const stages = Object.fromEntries(portfolioStages.map((stage) => [stage, 0])) as Record<PortfolioStage, number>;
  for (const item of projectItems) stages[item.status] += 1;
  const activeItems = projectItems.filter((item) => activePortfolioStages.has(item.status));
  const pendingApprovals = input.approvals.filter((approval) => approval.projectId === input.projectId);
  const openDatedMilestones = input.milestones.filter((milestone) =>
    milestone.projectId === input.projectId && milestone.closedAt === null && milestone.targetAt !== null);
  const openDatedDeadlines = input.deadlines.filter((deadline) =>
    deadline.projectId === input.projectId && deadline.status !== 'done' && deadline.deadlineAt !== null);
  const outlookDates = [...openDatedMilestones.map((milestone) => milestone.targetAt!), ...openDatedDeadlines.map((deadline) => deadline.deadlineAt!)];
  const projectTransitions = input.transitions.filter((transition) => transition.projectId === input.projectId)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  const recentStart = input.asOf.getTime() - trendWindowMs;
  const previousStart = recentStart - trendWindowMs;
  const recent = projectTransitions.filter((transition) => transition.toStatus === 'done' && transition.createdAt.getTime() >= recentStart).length;
  const previous = projectTransitions.filter((transition) =>
    transition.toStatus === 'done' && transition.createdAt.getTime() >= previousStart && transition.createdAt.getTime() < recentStart).length;
  const enteredDevelopmentAt = new Map<string, Date>();
  const cycleHours = projectTransitions.flatMap((transition) => {
    if (transition.toStatus === 'in_dev') {
      enteredDevelopmentAt.set(transition.workItemId, transition.createdAt);
      return [];
    }
    if (transition.toStatus !== 'done') return [];
    const startedAt = enteredDevelopmentAt.get(transition.workItemId);
    enteredDevelopmentAt.delete(transition.workItemId);
    return startedAt === undefined || startedAt >= transition.createdAt ? [] : [(transition.createdAt.getTime() - startedAt.getTime()) / 3_600_000];
  });
  const hasTrendHistory = recent >= minimumTrendSamples && previous >= minimumTrendSamples;
  const hasCycleHistory = cycleHours.length >= minimumTrendSamples;
  return {
    stages,
    activeWip: activeItems.length,
    blockedWork: projectItems.filter((item) => item.blocked && item.status !== 'done').length,
    staleActiveWork: activeItems.filter((item) => input.asOf.getTime() - item.updatedAt.getTime() > staleActiveWorkAfterMs).length,
    pendingApprovals: {count: pendingApprovals.length, oldestAt: pendingApprovals.reduce<Date | null>((oldest, approval) =>
      oldest === null || approval.createdAt < oldest ? approval.createdAt : oldest, null)},
    integrationFreshness: input.integrationFreshness,
    milestoneOutlook: {state: outlookDates.length === 0 ? 'unknown' : 'dated', due: outlookDates.filter((date) => date.getTime() >= input.asOf.getTime()).length, overdue: outlookDates.filter((date) => date.getTime() < input.asOf.getTime()).length},
    throughputTrend: {state: hasTrendHistory ? 'ready' : 'not_enough_history', recent, previous},
    cycleTime: {state: hasCycleHistory ? 'ready' : 'not_enough_history', averageHours: hasCycleHistory ? Math.round(cycleHours.reduce((total, value) => total + value, 0) / cycleHours.length) : null, samples: cycleHours.length}
  };
};

export const loadPortfolioData = (): Promise<OperatorLoad<PortfolioData>> => readDatabase(async (db) => {
  const configuredProjects = await scopedProjects(db);
  if (configuredProjects.length === 0) return {projects: [], attention: []};
  const projectIds = configuredProjects.map(({id}) => id);
  const latestDispositionVersions = db.select({
    riskSignalId: riskSignalDispositionEvents.riskSignalId,
    latestVersion: max(riskSignalDispositionEvents.version)
      .as('latest_version')
  }).from(riskSignalDispositionEvents)
    .where(inArray(riskSignalDispositionEvents.projectId, projectIds))
    .groupBy(riskSignalDispositionEvents.riskSignalId)
    .as('latest_risk_disposition_versions');
  const [snapshots, operations, signals, dispositions, failedNotifications, failedOutbox, unhealthyJobs, items, bindings, metricItems, pendingApprovals, projectMilestones, projectDeadlines, transitions, projectOwners] = await Promise.all([
    db.select({projectId: dashboardSnapshots.projectId, health: dashboardSnapshots.health, capturedAt: dashboardSnapshots.capturedAt})
      .from(dashboardSnapshots).where(inArray(dashboardSnapshots.projectId, projectIds)).orderBy(desc(dashboardSnapshots.capturedAt)),
    db.select({projectId: trackerSnapshotOperations.projectId, createdAt: trackerSnapshotOperations.createdAt})
      .from(trackerSnapshotOperations).where(inArray(trackerSnapshotOperations.projectId, projectIds)).orderBy(desc(trackerSnapshotOperations.createdAt)),
    db.select({
      id: riskSignals.id, projectId: riskSignals.projectId, workItemId: riskSignals.workItemId,
      severity: riskSignals.severity, signalClass: riskSignals.signalClass, summary: riskSignals.summary,
      impact: riskSignals.impact, nextAction: riskSignals.nextAction, observedAt: riskSignals.observedAt,
      evidenceReferences: riskSignals.evidenceReferences, workItemTitle: workItems.title,
      stage: deliveryJourneys.stageKey, owner: actors.displayName
    }).from(riskSignals)
      .leftJoin(workItems, and(eq(riskSignals.workItemId, workItems.id), eq(riskSignals.projectId, workItems.projectId)))
      .leftJoin(deliveryJourneys, eq(riskSignals.workItemId, deliveryJourneys.workItemId))
      .leftJoin(actors, or(
        eq(riskSignals.ownerActorId, actors.id),
        and(isNull(riskSignals.ownerActorId), eq(workItems.ownerActorId, actors.id))
      ))
      .where(and(inArray(riskSignals.projectId, projectIds), isNull(riskSignals.resolvedAt)))
      .orderBy(desc(riskSignals.updatedAt), riskSignals.id),
    db.select({
      riskSignalId: riskSignalDispositionEvents.riskSignalId,
      kind: riskSignalDispositionEvents.kind,
      reason: riskSignalDispositionEvents.reason,
      expiresAt: riskSignalDispositionEvents.expiresAt,
      reentryCondition: riskSignalDispositionEvents.reentryCondition,
      version: riskSignalDispositionEvents.version
    }).from(riskSignalDispositionEvents)
      .innerJoin(latestDispositionVersions, and(
        eq(
          latestDispositionVersions.riskSignalId,
          riskSignalDispositionEvents.riskSignalId
        ),
        eq(
          latestDispositionVersions.latestVersion,
          riskSignalDispositionEvents.version
        )
      )),
    loadFailedNotificationDeliveryFacts(db, projectIds),
    db.select({
      id: outboxEvents.id, projectId: outboxEvents.projectId, payload: outboxEvents.payload,
      attemptCount: outboxEvents.attemptCount, failureCode: outboxEvents.failureCode, updatedAt: outboxEvents.updatedAt
    }).from(outboxEvents).where(and(
      inArray(outboxEvents.projectId, projectIds), eq(outboxEvents.destination, 'github'),
      eq(outboxEvents.eventType, 'github.project_status.write.v1'), eq(outboxEvents.status, 'failed')
    )).orderBy(desc(outboxEvents.updatedAt), outboxEvents.id),
    db.select({id: scheduledJobs.id, projectId: scheduledJobs.projectId, name: scheduledJobs.name, updatedAt: scheduledJobs.updatedAt, heartbeatAt: scheduledJobs.heartbeatAt})
      .from(scheduledJobs).where(and(inArray(scheduledJobs.projectId, projectIds), eq(scheduledJobs.status, 'unhealthy')))
      .orderBy(desc(scheduledJobs.updatedAt), scheduledJobs.id),
    db.select({id: workItems.id, projectId: workItems.projectId, title: workItems.title})
      .from(workItems).where(and(inArray(workItems.projectId, projectIds), isNull(workItems.deletedAt))),
    db.select({entityId: trackerBindings.entityId, metadata: trackerBindings.metadata})
      .from(trackerBindings).where(and(inArray(trackerBindings.projectId, projectIds), eq(trackerBindings.entityType, 'work_item'))),
    db.select({id: workItems.id, projectId: workItems.projectId, status: workItems.status, blocked: workItems.blocked, updatedAt: workItems.updatedAt})
      .from(workItems).where(and(inArray(workItems.projectId, projectIds), isNull(workItems.deletedAt))),
    db.select({projectId: approvalRequests.projectId, createdAt: approvalRequests.createdAt})
      .from(approvalRequests).where(and(inArray(approvalRequests.projectId, projectIds), eq(approvalRequests.status, 'pending'))),
    db.select({projectId: milestones.projectId, targetAt: milestones.targetAt, closedAt: milestones.closedAt})
      .from(milestones).where(inArray(milestones.projectId, projectIds)),
    db.select({projectId: workItems.projectId, deadlineAt: deliveryJourneys.deadlineAt, status: workItems.status})
      .from(deliveryJourneys).innerJoin(workItems, eq(deliveryJourneys.workItemId, workItems.id))
      .where(and(inArray(workItems.projectId, projectIds), isNull(workItems.deletedAt))),
    db.select({workItemId: statusTransitions.workItemId, projectId: workItems.projectId, toStatus: statusTransitions.toStatus, createdAt: statusTransitions.createdAt})
      .from(statusTransitions).innerJoin(workItems, eq(statusTransitions.workItemId, workItems.id))
      .where(and(inArray(workItems.projectId, projectIds), isNull(workItems.deletedAt))),
    db.select({projectId: projectMemberships.projectId, owner: actors.displayName})
      .from(projectMemberships).innerJoin(actors, eq(projectMemberships.actorId, actors.id))
      .where(and(
        inArray(projectMemberships.projectId, projectIds),
        eq(projectMemberships.role, 'project_owner'),
        eq(projectMemberships.active, true),
        isNull(actors.disabledAt)
      )).orderBy(projectMemberships.projectId, actors.id)
  ]);
  const projectById = new Map(configuredProjects.map((project) => [project.id, project]));
  const ownerByProjectId = new Map<string, string>();
  for (const owner of projectOwners) {
    if (!ownerByProjectId.has(owner.projectId)) ownerByProjectId.set(owner.projectId, owner.owner);
  }
  const itemById = new Map(items.map((item) => [item.id, item]));
  const urlByItemId = new Map(bindings.map((binding) => [binding.entityId, safeExternalUrl(binding.metadata)]));
  const dispositionByRiskSignalId = new Map(
    dispositions.map((disposition) => [
      disposition.riskSignalId,
      {
        ...disposition,
        reason: disposition.reason as RiskSignalDispositionReason,
        reentryCondition: 'risk_unresolved_at_expiry' as const
      }
    ])
  );
  const signalById = new Map(signals.map((signal) => [signal.id, signal]));
  const now = Date.now();
  const attention = rankAttentionQueue([
    ...signals.flatMap((signal): AttentionQueueItem[] => {
      const project = projectById.get(signal.projectId);
      if (project === undefined) return [];
      const recordedDisposition =
        dispositionByRiskSignalId.get(signal.id) ?? null;
      const disposition = activeRiskDisposition(
        recordedDisposition,
        new Date(now)
      );
      if (disposition?.kind === 'snoozed') return [];
      const url = signal.workItemId === null ? null : urlByItemId.get(signal.workItemId) ?? null;
      return [{
        id: `risk:${signal.id}`, riskSignalId: signal.id, projectId: signal.projectId, severity: signal.severity, project: project.name,
        workItemId: signal.workItemId,
        object: signal.workItemTitle ?? 'Project risk signal', reason: signal.summary,
        stage: signal.stage, signalClass: signal.signalClass, impact: signal.impact,
        freshness: signal.observedAt, owner: signal.owner ?? ownerByProjectId.get(signal.projectId) ?? null, evidenceReferences: signal.evidenceReferences,
        nextAction: signal.nextAction, sourceUrl: url,
        evidence: signal.evidenceReferences.length === 0 ? 'No evidence references recorded' : signal.evidenceReferences.map((reference) => `${reference.type}: ${reference.id}`).join(' · '),
        action: {label: url === null ? 'No external record' : 'Open source', href: url},
        dispositionVersion: recordedDisposition?.version ?? 0,
        disposition
      }];
    }),
    ...failedNotifications.flatMap((failure): AttentionQueueItem[] => {
      const project = projectById.get(failure.projectId);
      const signal = signalById.get(failure.riskSignalId);
      if (project === undefined || signal === undefined) return [];
      const url = signal.workItemId === null
        ? null
        : urlByItemId.get(signal.workItemId) ?? null;
      return [{
        id: `notification:${failure.notificationIntentId}`,
        riskSignalId: null,
        projectId: failure.projectId,
        workItemId: signal.workItemId,
        severity: failure.severity,
        project: project.name,
        object: signal.workItemTitle ?? failure.summary,
        reason: `Notification delivery failed: ${failure.failureCode}`,
        stage: signal.stage,
        signalClass: 'fact',
        impact: failure.summary,
        freshness: failure.failedAt,
        owner: signal.owner ?? ownerByProjectId.get(failure.projectId) ?? null,
        evidenceReferences: failure.evidenceReferences,
        nextAction: failure.nextAction,
        sourceUrl: url,
        evidence: `Notification receipt v${failure.receiptVersion} failed: ${failure.failureCode}`,
        action: {
          label: url === null ? 'No external record' : 'Open source',
          href: url
        },
        dispositionVersion: 0,
        disposition: null
      }];
    }),
    ...failedOutbox.flatMap((event): AttentionQueueItem[] => {
      if (event.projectId === null) return [];
      const project = projectById.get(event.projectId);
      if (project === undefined) return [];
      const workItemId = outboxWorkItemId(event.payload);
      const item = workItemId === null ? undefined : itemById.get(workItemId);
      const url = workItemId === null ? null : urlByItemId.get(workItemId) ?? null;
      return [{
        id: `outbox:${event.id}`, riskSignalId: null, projectId: event.projectId, severity: 'red', project: project.name,
        workItemId,
        object: item?.title ?? 'GitHub project status write', reason: event.failureCode ?? 'GitHub status write failed',
        stage: null, signalClass: 'fact',
        impact: 'Canonical delivery status was not published to the tracker.',
        freshness: event.updatedAt, owner: ownerByProjectId.get(event.projectId) ?? null,
        evidenceReferences: [{type: 'outbox_event', id: event.id}],
        nextAction: 'inspect_failed_status_writeback', sourceUrl: url,
        evidence: `Outbox failed after ${event.attemptCount} attempts`, action: {label: url === null ? 'No external record' : 'Open source', href: url},
        dispositionVersion: 0,
        disposition: null
      }];
    }),
    ...unhealthyJobs.flatMap((job): AttentionQueueItem[] => {
      if (job.projectId === null) return [];
      const project = projectById.get(job.projectId);
      if (project === undefined) return [];
      return [{
        id: `job:${job.id}`, riskSignalId: null, projectId: job.projectId, severity: 'red', project: project.name, object: job.name,
        workItemId: null,
        reason: 'Scheduled job is unhealthy', stage: null, signalClass: 'fact',
        impact: 'Required recurring control-plane work is not healthy.',
        freshness: job.heartbeatAt ?? job.updatedAt, owner: ownerByProjectId.get(job.projectId) ?? null,
        evidenceReferences: [{type: 'scheduled_job', id: job.id}],
        nextAction: 'inspect_or_recover_scheduled_job',
        sourceUrl: null, evidence: 'Scheduled job status', action: {label: 'No external record', href: null},
        dispositionVersion: 0,
        disposition: null
      }];
    })
  ]);
  const snapshotsByProject = latestByProject(snapshots);
  const operationsByProject = latestByProject(operations);
  return {
    projects: configuredProjects.map((project) => {
      const projectSignals = signals.filter((signal) => signal.projectId === project.id);
      const synchronizedAt = operationsByProject.get(project.id)?.createdAt ?? null;
      const hasCurrentFailure =
        projectSignals.some((signal) => signal.severity === 'red') ||
        failedOutbox.some((event) => event.projectId === project.id) ||
        unhealthyJobs.some((job) => job.projectId === project.id);
      const health = hasCurrentFailure
        ? 'red'
        : synchronizedAt === null
          ? 'unknown'
          : projectSignals.some((signal) => signal.severity === 'yellow') ||
              now - synchronizedAt.getTime() > healthcheckStaleAfterMs
            ? 'yellow'
            : 'green';
      return {
        id: project.id, name: project.name, slug: project.slug, health,
        snapshotAt: snapshotsByProject.get(project.id)?.capturedAt ?? null,
        synchronizedAt,
        unresolvedRiskCount: projectSignals.length,
        metrics: derivePortfolioProjectMetrics({
          projectId: project.id, items: metricItems, approvals: pendingApprovals,
          milestones: projectMilestones, deadlines: projectDeadlines, transitions, integrationFreshness: synchronizedAt, asOf: new Date(now)
        })
      };
    }),
    attention
  };
});

export type ProjectData = Readonly<{
  project: Project;
  agentProfiles: readonly Readonly<{id: string; runtimeId: string}>[];
  snapshot: Readonly<{health: 'green' | 'yellow' | 'red'; capturedAt: Date}> | null;
  synchronizedAt: Date | null;
  scopeBaseline?: Readonly<{
    id: string;
    version: number;
    approvedAt: Date | null;
    updatedAt: Date;
    outcomes: readonly Readonly<{
      key: string;
      title: string;
      weight: number;
      state: 'accepted' | 'review' | 'in_progress' | 'not_started' | 'not_configured';
      acceptedBy: string | null;
      acceptedAt: Date | null;
      evidenceReference: string | null;
    }>[];
    checkpoint: Readonly<{
      title: string;
      status: (typeof workItemStatuses)[number];
      owner: string | null;
      targetAt: Date | null;
    }> | null;
    observations: readonly Readonly<{acceptedWeight: number; totalWeight: number; observedAt: Date}>[];
  }> | null;
  protocol?: DeliveryProtocol | null;
  workItems: readonly Readonly<{
    id: string; title: string; summary: string | null; status: (typeof workItemStatuses)[number];
    blocked: boolean; owner: string | null; updatedAt: Date; externalUrl: string | null;
    version?: number;
    journey?: Readonly<{
      protocolId: string; protocolVersion: number; stageKey: string; version: number;
      deadlineAt: Date | null;
      stage: Readonly<{
        name: string; taskStatus: (typeof workItemStatuses)[number]; executionMode: string;
        responsibility: string; nextStage: string | null;
        actor: Readonly<{displayName: string; type: 'human' | 'agent'}> | null;
      }> | null;
      evidence: readonly Readonly<{stageKey: string; requirement: string; reference: string}>[];
      requiredEvidence: readonly string[];
    }> | null;
    canBuildPacket: boolean;
    handoff: Readonly<{
      label: string;
      state: 'pending' | 'queued' | 'running' | 'waiting_approval' | 'done' | 'failed';
      kind: 'approval' | 'packet' | 'run';
      targetId: string;
      href: string;
    }> | null;
  }>[];
}>;

export type DeliveryLifecycleData = Readonly<{
  packet: Readonly<{id: string; contentHash: string; createdAt: Date}> | null;
  approval: Readonly<{status: string; policyVersion: number; environment: string; decidedAt: Date | null; createdAt: Date}> | null;
  run: Readonly<{id: string; status: string; createdAt: Date; startedAt: Date | null; completedAt: Date | null}> | null;
  receipt: Readonly<{terminal: string; completedAt: Date}> | null;
  artifactCount: number;
  journeyEvidenceCount: number;
  writeBack: Readonly<{destination: string; eventType: string; status: string; updatedAt: Date; failureCode: string | null}> | null;
  audit: Readonly<{action: string; outcome: string; occurredAt: Date}> | null;
}>;

/** A deliberately small, task-scoped read model for the delivery-detail lifecycle rail. */
export const loadDeliveryLifecycleData = (
  slug: OperatorProjectSlug,
  workItemId: string
): Promise<OperatorLoad<DeliveryLifecycleData | null>> => readDatabase(async (db) => {
  const [project] = await scopedProjects(db, slug);
  if (project === undefined) return null;
  const [task] = await db.select({id: workItems.id}).from(workItems).where(and(
    eq(workItems.id, workItemId), eq(workItems.projectId, project.id), isNull(workItems.deletedAt)
  )).limit(1);
  if (task === undefined) return null;

  const [packets, runs, approvals, evidence, writeBackEvents, audits] = await Promise.all([
    db.select({id: taskPackets.id, contentHash: taskPackets.contentHash, createdAt: taskPackets.createdAt})
      .from(taskPackets).where(and(eq(taskPackets.projectId, project.id), eq(taskPackets.workItemId, task.id)))
      .orderBy(desc(taskPackets.createdAt), taskPackets.id),
    db.select({id: agentRuns.id, status: agentRuns.status, createdAt: agentRuns.createdAt, startedAt: agentRuns.startedAt, completedAt: agentRuns.completedAt, updatedAt: agentRuns.updatedAt})
      .from(agentRuns).where(eq(agentRuns.workItemId, task.id)).orderBy(desc(agentRuns.updatedAt), agentRuns.id),
    db.select({workItemId: approvalRequests.workItemId, agentRunId: approvalRequests.agentRunId, status: approvalRequests.status, policyVersion: approvalRequests.policyVersion, environment: approvalRequests.environment, decidedAt: approvalRequests.decidedAt, createdAt: approvalRequests.createdAt, updatedAt: approvalRequests.updatedAt})
      .from(approvalRequests).where(eq(approvalRequests.projectId, project.id)).orderBy(desc(approvalRequests.updatedAt), approvalRequests.id),
    db.select({id: deliveryJourneyEvidence.id}).from(deliveryJourneyEvidence)
      .where(eq(deliveryJourneyEvidence.workItemId, task.id)),
    db.select({destination: outboxEvents.destination, eventType: outboxEvents.eventType, payload: outboxEvents.payload, status: outboxEvents.status, updatedAt: outboxEvents.updatedAt, failureCode: outboxEvents.failureCode})
      .from(outboxEvents).where(and(
        eq(outboxEvents.projectId, project.id), eq(outboxEvents.destination, 'github'),
        eq(outboxEvents.eventType, 'github.project_status.write.v1')
      )).orderBy(desc(outboxEvents.updatedAt), outboxEvents.id),
    db.select({targetId: auditEvents.targetId, action: auditEvents.action, outcome: auditEvents.outcome, occurredAt: auditEvents.occurredAt})
      .from(auditEvents).where(eq(auditEvents.projectId, project.id)).orderBy(desc(auditEvents.occurredAt), auditEvents.id)
  ]);
  const run = runs[0] ?? null;
  const runIds = new Set(runs.map((entry) => entry.id));
  const [receipts, runArtifacts] = runIds.size === 0
    ? [[], []] as const
    : await Promise.all([
      db.select({agentRunId: agentRunReceipts.agentRunId, terminal: agentRunReceipts.terminal, completedAt: agentRunReceipts.completedAt})
        .from(agentRunReceipts).where(inArray(agentRunReceipts.agentRunId, [...runIds])),
      db.select({agentRunId: artifacts.agentRunId}).from(artifacts).where(inArray(artifacts.agentRunId, [...runIds]))
    ]);
  const approval = approvals.find((entry) => entry.workItemId === task.id || (entry.agentRunId !== null && runIds.has(entry.agentRunId))) ?? null;
  const receipt = run === null ? null : receipts.find((entry) => entry.agentRunId === run.id) ?? null;
  const writeBack = writeBackEvents.find((entry) => outboxWorkItemId(entry.payload) === task.id) ?? null;
  const audited = audits.find((entry) => entry.targetId === task.id || (entry.targetId !== null && runIds.has(entry.targetId))) ?? null;
  const audit: DeliveryLifecycleData['audit'] = audited === null || audited.outcome === null ? null : {
    action: audited.action, outcome: audited.outcome, occurredAt: audited.occurredAt
  };
  return {
    packet: packets[0] ?? null,
    approval,
    run,
    receipt,
    artifactCount: run === null ? 0 : runArtifacts.filter((entry) => entry.agentRunId === run.id).length,
    journeyEvidenceCount: evidence.length,
    writeBack,
    audit
  };
});

export const loadProjectData = (slug: OperatorProjectSlug): Promise<OperatorLoad<ProjectData | null>> => readDatabase(async (db) => {
  const [project] = await scopedProjects(db, slug);
  if (project === undefined) return null;
  const [snapshots, operations, items, bindings, repositoryScopes, availableProfiles, packetFacts, runFacts, approvalFacts, protocolRows, journeys, journeyEvidence, members, scopeBaselines, scopeOutcomes, scopeObservations] = await Promise.all([
    db.select({health: dashboardSnapshots.health, capturedAt: dashboardSnapshots.capturedAt})
      .from(dashboardSnapshots).where(eq(dashboardSnapshots.projectId, project.id)).orderBy(desc(dashboardSnapshots.capturedAt)).limit(1),
    db.select({createdAt: trackerSnapshotOperations.createdAt})
      .from(trackerSnapshotOperations).where(eq(trackerSnapshotOperations.projectId, project.id)).orderBy(desc(trackerSnapshotOperations.createdAt)).limit(1),
    db.select({
      id: workItems.id, title: workItems.title, summary: workItems.summary, status: workItems.status, version: workItems.version,
      blocked: workItems.blocked, owner: actors.displayName, updatedAt: workItems.updatedAt
    }).from(workItems).leftJoin(actors, eq(workItems.ownerActorId, actors.id))
      .where(and(eq(workItems.projectId, project.id), isNull(workItems.deletedAt))).orderBy(desc(workItems.updatedAt), workItems.id),
    db.select({
      entityId: trackerBindings.entityId,
      provider: trackerBindings.provider,
      surface: trackerBindings.surface,
      metadata: trackerBindings.metadata
    })
      .from(trackerBindings).where(and(eq(trackerBindings.projectId, project.id), eq(trackerBindings.entityType, 'work_item'))),
    db.select({owner: projectTrackerRepositoryScopes.repositoryOwner, name: projectTrackerRepositoryScopes.repositoryName})
      .from(projectTrackerRepositoryScopes).where(and(
        eq(projectTrackerRepositoryScopes.projectId, project.id),
        eq(projectTrackerRepositoryScopes.provider, 'github')
      )),
    db.select({id: agentProfiles.id, runtimeId: agentProfiles.runtimeId}).from(agentProfiles).where(and(
      eq(agentProfiles.workspaceId, project.workspaceId),
      eq(agentProfiles.enabled, true)
    ))
    ,
    db.select({
      id: taskPackets.id, workItemId: taskPackets.workItemId, createdAt: taskPackets.createdAt
    }).from(taskPackets).where(eq(taskPackets.projectId, project.id))
      .orderBy(desc(taskPackets.createdAt), taskPackets.id),
    db.select({
      id: agentRuns.id, taskPacketId: agentRuns.taskPacketId, workItemId: taskPackets.workItemId,
      status: agentRuns.status, updatedAt: agentRuns.updatedAt
    }).from(agentRuns).innerJoin(taskPackets, eq(agentRuns.taskPacketId, taskPackets.id))
      .where(eq(taskPackets.projectId, project.id)).orderBy(desc(agentRuns.updatedAt), agentRuns.id),
    db.select({
      id: approvalRequests.id, workItemId: approvalRequests.workItemId,
      agentRunId: approvalRequests.agentRunId, status: approvalRequests.status,
      updatedAt: approvalRequests.updatedAt
    }).from(approvalRequests).where(eq(approvalRequests.projectId, project.id))
      .orderBy(desc(approvalRequests.updatedAt), approvalRequests.id),
    db.select({
      id: runbooks.id, projectId: runbooks.projectId, name: runbooks.name,
      version: runbooks.version, revision: runbooks.revision, state: runbooks.protocolState,
      active: runbooks.active, definition: runbooks.definition, contentHash: runbooks.contentHash
    }).from(runbooks).where(and(
      eq(runbooks.projectId, project.id),
      inArray(runbooks.protocolState, ['draft', 'published', 'retired'])
    )).orderBy(desc(runbooks.active), desc(runbooks.updatedAt), desc(runbooks.version)),
    db.select({
      workItemId: deliveryJourneys.workItemId, protocolId: deliveryJourneys.protocolId,
      protocolVersion: deliveryJourneys.protocolVersion, stageKey: deliveryJourneys.stageKey,
      version: deliveryJourneys.version, deadlineAt: deliveryJourneys.deadlineAt
    }).from(deliveryJourneys).innerJoin(workItems, eq(workItems.id, deliveryJourneys.workItemId))
      .where(and(eq(workItems.projectId, project.id), isNull(workItems.deletedAt))),
    db.select({
      workItemId: deliveryJourneyEvidence.workItemId, stageKey: deliveryJourneyEvidence.stageKey,
      requirement: deliveryJourneyEvidence.requirement, reference: deliveryJourneyEvidence.evidenceReference
    }).from(deliveryJourneyEvidence).innerJoin(workItems, eq(workItems.id, deliveryJourneyEvidence.workItemId))
      .where(and(eq(workItems.projectId, project.id), isNull(workItems.deletedAt))),
    db.select({
      actorId: actors.id, displayName: actors.displayName, type: actors.type,
      role: projectMemberships.role
    }).from(projectMemberships).innerJoin(actors, eq(actors.id, projectMemberships.actorId))
      .where(and(eq(projectMemberships.projectId, project.id), eq(projectMemberships.active, true), isNull(actors.disabledAt)))
      .orderBy(actors.id),
    db.select({
      id: projectScopeBaselineVersions.id,
      version: projectScopeBaselineVersions.version,
      approvedAt: projectScopeBaselineVersions.approvedAt,
      checkpointTitle: projectScopeBaselineVersions.checkpointTitle,
      checkpointStatus: projectScopeBaselineVersions.checkpointStatus,
      checkpointTargetAt: projectScopeBaselineVersions.checkpointTargetAt,
      checkpointOwner: actors.displayName,
      updatedAt: projectScopeBaselineVersions.updatedAt
    }).from(projectScopeBaselineVersions)
      .leftJoin(actors, eq(projectScopeBaselineVersions.checkpointOwnerActorId, actors.id))
      .where(and(eq(projectScopeBaselineVersions.projectId, project.id), eq(projectScopeBaselineVersions.active, true)))
      .orderBy(desc(projectScopeBaselineVersions.version)).limit(1),
    db.select({
      baselineId: projectScopeOutcomes.baselineId,
      key: projectScopeOutcomes.key,
      title: projectScopeOutcomes.title,
      weight: projectScopeOutcomes.weight,
      state: projectScopeOutcomes.state,
      acceptedBy: actors.displayName,
      acceptedAt: projectScopeOutcomes.acceptedAt,
      evidenceReference: projectScopeOutcomes.evidenceReference
    }).from(projectScopeOutcomes)
      .innerJoin(projectScopeBaselineVersions, eq(projectScopeOutcomes.baselineId, projectScopeBaselineVersions.id))
      .leftJoin(actors, eq(projectScopeOutcomes.acceptedByActorId, actors.id))
      .where(and(eq(projectScopeBaselineVersions.projectId, project.id), eq(projectScopeBaselineVersions.active, true)))
      .orderBy(projectScopeOutcomes.key),
    db.select({
      baselineId: projectScopeOutcomeObservations.baselineId,
      acceptedWeight: projectScopeOutcomeObservations.acceptedWeight,
      totalWeight: projectScopeOutcomeObservations.totalWeight,
      observedAt: projectScopeOutcomeObservations.observedAt
    }).from(projectScopeOutcomeObservations)
      .where(eq(projectScopeOutcomeObservations.projectId, project.id))
      .orderBy(projectScopeOutcomeObservations.observedAt, projectScopeOutcomeObservations.id)
  ]);
  const externalUrlByItem = new Map(bindings.map((binding) => [binding.entityId, safeExternalUrl(binding.metadata)]));
  const repository = repositoryScopes.length === 1 ? repositoryScopes[0]! : null;
  const workItemByRunId = new Map(runFacts.map((run) => [run.id, run.workItemId]));
  const runPacketIds = new Set(runFacts.map((run) => run.taskPacketId));
  const pendingApprovalByItem = new Map<string, (typeof approvalFacts)[number]>();
  for (const approval of approvalFacts) {
    if (approval.status !== 'pending') continue;
    const workItemId = approval.workItemId ?? (approval.agentRunId === null ? undefined : workItemByRunId.get(approval.agentRunId));
    if (workItemId !== undefined && !pendingApprovalByItem.has(workItemId)) pendingApprovalByItem.set(workItemId, approval);
  }
  const activeRunByItem = new Map<string, (typeof runFacts)[number]>();
  const latestRunByItem = new Map<string, (typeof runFacts)[number]>();
  for (const run of runFacts) {
    if (!latestRunByItem.has(run.workItemId)) latestRunByItem.set(run.workItemId, run);
    if (run.status === 'queued' || run.status === 'running' || run.status === 'waiting_approval') {
      if (!activeRunByItem.has(run.workItemId)) activeRunByItem.set(run.workItemId, run);
    }
  }
  const unconfirmedPacketByItem = new Map<string, (typeof packetFacts)[number]>();
  for (const packet of packetFacts) {
    if (!runPacketIds.has(packet.id) && !unconfirmedPacketByItem.has(packet.workItemId)) unconfirmedPacketByItem.set(packet.workItemId, packet);
  }
  const packetEligibleItems = new Set(bindings.flatMap((binding) =>
    binding.provider === 'github' && binding.surface === 'issue' && confirmedGitHubIssueUrl(binding.metadata, repository) !== null
      ? [binding.entityId]
      : []));
  const protocols = protocolRows.flatMap((row): DeliveryProtocol[] => {
    if (row.state === null || row.revision === null || row.contentHash === null) return [];
    const definition = validateDeliveryProtocolDefinition(row.definition);
    return definition.ok ? [{
      id: row.id, projectId: row.projectId, name: row.name, version: row.version,
      revision: row.revision, state: row.state, active: row.active,
      definition: definition.value, contentHash: row.contentHash
    }] : [];
  });
  const protocol = protocols[0] ?? null;
  const baseline = scopeBaselines[0] ?? null;
  const protocolByJourney = new Map(protocols.map((item) => [`${item.id}:${item.version}`, item]));
  const memberById = new Map(members.flatMap((member) => member.type === 'human' || member.type === 'agent'
    ? [[member.actorId, {displayName: member.displayName, type: member.type}] as const] : []));
  const memberByRole = new Map<string, Readonly<{displayName: string; type: 'human' | 'agent'}>>();
  for (const member of members) {
    if ((member.type === 'human' || member.type === 'agent') && !memberByRole.has(member.role)) {
      memberByRole.set(member.role, {displayName: member.displayName, type: member.type});
    }
  }
  const evidenceByJourney = new Map<string, Readonly<{stageKey: string; requirement: string; reference: string}>[]>();
  for (const evidence of journeyEvidence) {
    evidenceByJourney.set(evidence.workItemId, [...(evidenceByJourney.get(evidence.workItemId) ?? []), {
      stageKey: evidence.stageKey,
      requirement: evidence.requirement,
      reference: evidence.reference
    }]);
  }
  const journeyByItem = new Map(journeys.map((journey) => {
    const boundProtocol = protocolByJourney.get(`${journey.protocolId}:${journey.protocolVersion}`) ?? null;
    const stage = boundProtocol?.definition.stages.find((item) => item.key === journey.stageKey) ?? null;
    const actor = stage === null ? null : stage.responsibility.kind === 'project_role'
      ? memberByRole.get(stage.responsibility.role) ?? null
      : memberById.get(stage.responsibility.actorId) ?? null;
    const nextStage = stage?.allowedNextStageKey === null || stage === null ? null
      : boundProtocol?.definition.stages.find((item) => item.key === stage.allowedNextStageKey)?.name ?? null;
    return [journey.workItemId, {
      ...journey,
      stage: stage === null ? null : {
        name: stage.name, taskStatus: stage.taskStatus, executionMode: stage.executionMode,
        responsibility: stage.responsibility.kind === 'project_role' ? stage.responsibility.role : stage.responsibility.actorType,
        nextStage, actor
      },
      evidence: evidenceByJourney.get(journey.workItemId) ?? [],
      requiredEvidence: stage?.requiredEvidence ?? []
    }] as const;
  }));
  return {
    project,
    agentProfiles: availableProfiles.filter((profile) => isRuntimeAvailable(profile.runtimeId)),
    snapshot: snapshots[0] ?? null,
    synchronizedAt: operations[0]?.createdAt ?? null,
    scopeBaseline: baseline === null ? null : {
      id: baseline.id,
      version: baseline.version,
      approvedAt: baseline.approvedAt,
      updatedAt: baseline.updatedAt,
      outcomes: scopeOutcomes.filter((outcome) => outcome.baselineId === baseline.id),
      checkpoint: baseline.checkpointTitle === null || baseline.checkpointStatus === null ? null : {
        title: baseline.checkpointTitle,
        status: baseline.checkpointStatus as (typeof workItemStatuses)[number],
        owner: baseline.checkpointOwner,
        targetAt: baseline.checkpointTargetAt
      },
      observations: scopeObservations
        .filter((observation) => observation.baselineId === baseline.id)
        .map((observation) => ({acceptedWeight: observation.acceptedWeight, totalWeight: observation.totalWeight, observedAt: observation.observedAt}))
    },
    protocol,
    workItems: items.flatMap((item) => {
      if (!workItemStatuses.includes(item.status)) return [];
      const approval = pendingApprovalByItem.get(item.id);
      const activeRun = activeRunByItem.get(item.id);
      const latestRun = latestRunByItem.get(item.id);
      const completedRun = latestRun?.status === 'done' ? latestRun : undefined;
      const failedRun = latestRun?.status === 'failed' ? latestRun : undefined;
      const packet = unconfirmedPacketByItem.get(item.id);
      const handoff = approval !== undefined
        ? {label: 'Approval pending', state: 'pending' as const, kind: 'approval' as const, targetId: approval.id, href: `/projects/${slug}/tasks/${item.id}`}
        : activeRun !== undefined
          ? {
              label: activeRun.status === 'waiting_approval'
                ? 'Run waiting approval'
                : activeRun.status === 'running' ? 'Run running' : 'Run queued',
              state: activeRun.status === 'waiting_approval'
                ? 'waiting_approval' as const
                : activeRun.status === 'running' ? 'running' as const : 'queued' as const,
              kind: 'run' as const,
              targetId: activeRun.id,
              href: `/projects/${slug}/runs/${activeRun.id}`
            }
          : completedRun !== undefined
            ? {label: 'Run completed', state: 'done' as const, kind: 'run' as const, targetId: completedRun.id, href: `/projects/${slug}/runs/${completedRun.id}`}
          : failedRun !== undefined && (packet === undefined || failedRun.updatedAt >= packet.createdAt)
            ? {label: 'Run failed', state: 'failed' as const, kind: 'run' as const, targetId: failedRun.id, href: `/projects/${slug}/runs/${failedRun.id}`}
            : packet !== undefined
              ? {label: 'Packet needs confirmation', state: 'queued' as const, kind: 'packet' as const, targetId: packet.id, href: `/projects/${slug}/tasks/${item.id}#packet-${packet.id}`}
              : null;
      return [{
        ...item,
        version: item.version,
        journey: journeyByItem.get(item.id) ?? null,
        externalUrl: externalUrlByItem.get(item.id) ?? null,
        canBuildPacket: (item.status === 'ready' || item.status === 'in_dev') && packetEligibleItems.has(item.id),
        handoff
      }];
    })
  };
});

export type RunsData = Readonly<{
  runs: readonly Readonly<{
    id: string; project: string; projectSlug: OperatorProjectSlug; workItemId: string | null; workItem: string | null; agent: string | null;
    status: 'queued' | 'running' | 'waiting_approval' | 'done' | 'failed'; runtimeProfile: string; attempt: number;
    packetGoal: string; timeboxMinutes: number; startedAt: Date | null; completedAt: Date | null;
    heartbeatAt: Date | null; failureCode: string | null; version: number;
    workItemVersion: number | null; canAcceptReceipt: boolean;
    receipt: Readonly<{
      terminal: string; completedAt: Date; runtimeId: string | null; runtimeProfile: string | null;
      durationMs: number | null; receiptSha256: string;
      cost: Readonly<Record<string, unknown>> | null;
      usage: Readonly<Record<string, unknown>> | null;
    }> | null;
    ledger: Readonly<{
      records: readonly LedgerRecord[];
      latestCost: LedgerCost;
      latestValueEvidence: ValueEvidence | null;
      roi: LedgerRoi;
    }>;
    artifacts: readonly Readonly<{kind: string; sizeBytes: number; redacted: boolean; createdAt: Date}>[];
  }>[];
  approvals: readonly Readonly<{
    id: string; project: string; projectSlug: OperatorProjectSlug; workItemId: string | null; agentRunId: string | null; actionCategory: string; surface: string;
    environment: string; status: string; policyVersion: number; expiresAt: Date; decidedAt: Date | null;
  }>[];
  packets: readonly Readonly<{
    id: string; project: string; projectSlug: OperatorProjectSlug; workItemId: string; workItemTitle: string;
    frozenWorkItemVersion: number; currentWorkItemVersion: number; goal: string;
    acceptanceCriteria: readonly string[]; inScope: readonly string[]; outOfScope: readonly string[];
    relevantLinks: readonly string[]; relevantFiles: readonly string[]; allowedTools: readonly string[];
    forbiddenSurfaces: readonly string[]; dataPolicy: Record<string, unknown>;
    expectedOutputSchema: Record<string, unknown>; timeboxMinutes: number; reviewer: string;
    approver: string; approverActorId: string; authMode: string; runtimeProfile: string;
    agentProfileSnapshotVersion: number | null; agentProfileSnapshotHash: string | null;
    contentHash: string; profiles: readonly Readonly<{
      id: string; name: string; runtimeId: string; policyPreview: AgentRunQueuePolicyPreview | null;
    }>[];
    runnable: boolean; nonRunnableReason: string | null;
  }> [];
}>;

export const loadRunsData = (scope?: OperatorProjectSlug): Promise<OperatorLoad<RunsData>> => readDatabase(async (db) => {
  const configuredProjects = await scopedProjects(db, scope);
  if (configuredProjects.length === 0) return {runs: [], approvals: [], packets: []};
  const projectIds = configuredProjects.map(({id}) => id);
  const workspaceIds = [...new Set(configuredProjects.map(({workspaceId}) => workspaceId))];
  const projectById = new Map(configuredProjects.map((project) => [project.id, project]));
  const [runs, approvals, packetRows, profiles, repositoryBindings] = await Promise.all([
    db.select({
      id: agentRuns.id, projectId: taskPackets.projectId, workItemId: taskPackets.workItemId, workItem: workItems.title,
      workItemStatus: workItems.status, workItemVersion: workItems.version,
      agent: actors.displayName, runAttempt: agentRuns.attempt,
      confirmedPacketHash: agentRuns.confirmedPacketHash, packetContentHash: taskPackets.contentHash,
      status: agentRuns.status, runtimeProfile: taskPackets.runtimeProfile, packetGoal: taskPackets.goal,
      timeboxMinutes: taskPackets.timeboxMinutes, startedAt: agentRuns.startedAt, completedAt: agentRuns.completedAt,
      heartbeatAt: agentRuns.heartbeatAt, failureCode: agentRuns.failureCode, version: agentRuns.version
    }).from(agentRuns).innerJoin(taskPackets, eq(agentRuns.taskPacketId, taskPackets.id))
      .leftJoin(workItems, eq(taskPackets.workItemId, workItems.id)).leftJoin(agentProfiles, eq(agentRuns.agentProfileId, agentProfiles.id))
      .leftJoin(actors, eq(agentProfiles.actorId, actors.id)).where(inArray(taskPackets.projectId, projectIds)).orderBy(desc(agentRuns.updatedAt), agentRuns.id),
    db.select({
      id: approvalRequests.id, projectId: approvalRequests.projectId, workItemId: approvalRequests.workItemId, agentRunId: approvalRequests.agentRunId, actionCategory: approvalRequests.actionCategory,
      surface: approvalRequests.surface, environment: approvalRequests.environment, status: approvalRequests.status,
      policyVersion: approvalRequests.policyVersion, expiresAt: approvalRequests.expiresAt, decidedAt: approvalRequests.decidedAt
    }).from(approvalRequests).where(inArray(approvalRequests.projectId, projectIds)).orderBy(desc(approvalRequests.updatedAt), approvalRequests.id)
    ,
    db.select({
      id: taskPackets.id, projectId: taskPackets.projectId, workItemId: taskPackets.workItemId,
      workItemTitle: workItems.title, frozenWorkItemVersion: taskPackets.workItemVersion,
      currentWorkItemVersion: workItems.version, goal: taskPackets.goal,
      acceptanceCriteria: taskPackets.acceptanceCriteria, inScope: taskPackets.inScope,
      outOfScope: taskPackets.outOfScope, relevantLinks: taskPackets.relevantLinks,
      relevantFiles: taskPackets.relevantFiles, allowedTools: taskPackets.allowedTools,
      forbiddenSurfaces: taskPackets.forbiddenSurfaces, dataPolicy: taskPackets.dataPolicy,
      expectedOutputSchema: taskPackets.expectedOutputSchema, timeboxMinutes: taskPackets.timeboxMinutes,
      reviewerActorId: taskPackets.reviewerActorId, approverActorId: taskPackets.approverActorId,
      authMode: taskPackets.authMode, runtimeProfile: taskPackets.runtimeProfile,
      agentProfileSnapshotId: taskPackets.agentProfileSnapshotId,
      agentProfileSnapshotVersion: taskPackets.agentProfileSnapshotVersion,
      agentProfileSnapshotHash: taskPackets.agentProfileSnapshotHash,
      contentHash: taskPackets.contentHash
    }).from(taskPackets).innerJoin(workItems, eq(workItems.id, taskPackets.workItemId))
      .leftJoin(agentRuns, eq(agentRuns.taskPacketId, taskPackets.id))
      .where(and(inArray(taskPackets.projectId, projectIds), isNull(agentRuns.id)))
      .orderBy(desc(taskPackets.createdAt), taskPackets.id),
    db.select({id: agentProfiles.id, name: actors.displayName, runtimeId: agentProfiles.runtimeId, runtimeProfile: agentProfiles.runtimeProfile, workspaceId: agentProfiles.workspaceId})
      .from(agentProfiles).innerJoin(actors, eq(actors.id, agentProfiles.actorId))
      .where(and(inArray(agentProfiles.workspaceId, workspaceIds), eq(agentProfiles.enabled, true), isNull(actors.disabledAt)))
      .orderBy(agentProfiles.runtimeProfile, agentProfiles.runtimeId),
    db.select({
      projectId: trackerBindings.projectId,
      entityId: trackerBindings.entityId,
      metadata: trackerBindings.metadata
    })
      .from(trackerBindings)
      .where(and(
        inArray(trackerBindings.projectId, projectIds),
        eq(trackerBindings.provider, 'github'),
        eq(trackerBindings.surface, 'repository'),
        eq(trackerBindings.entityType, 'project')
      ))
  ]);
  const actorIds = [...new Set(packetRows.flatMap((packet) => [packet.reviewerActorId, packet.approverActorId]))];
  const packetActors = actorIds.length === 0 ? [] : await db.select({id: actors.id, name: actors.displayName})
    .from(actors).where(inArray(actors.id, actorIds));
  const runIds = runs.map(({id}) => id);
  const [receipts, evidenceArtifacts, ledgerRows] = runIds.length === 0 ? [[], [], []] : await Promise.all([
    db.select({
      agentRunId: agentRunReceipts.agentRunId,
      runnerId: agentRunReceipts.runnerId,
      attempt: agentRunReceipts.attempt,
      terminal: agentRunReceipts.terminal,
      completedAt: agentRunReceipts.completedAt,
      receiptSha256: agentRunReceipts.receiptSha256,
      receiptSizeBytes: agentRunReceipts.receiptSizeBytes,
      metadata: agentRunReceipts.metadata
    })
      .from(agentRunReceipts).where(inArray(agentRunReceipts.agentRunId, runIds)),
    db.select({agentRunId: artifacts.agentRunId, kind: artifacts.kind, sizeBytes: artifacts.sizeBytes, redacted: artifacts.redacted, createdAt: artifacts.createdAt})
      .from(artifacts).where(inArray(artifacts.agentRunId, runIds)).orderBy(desc(artifacts.createdAt), artifacts.id),
    db.select({
      agentRunId: commandReceipts.aggregateId,
      result: commandReceipts.result
    }).from(commandReceipts).where(and(
      inArray(commandReceipts.aggregateId, runIds),
      inArray(commandReceipts.commandType, [
        COST_LEDGER_COMMAND,
        VALUE_LEDGER_COMMAND
      ])
    )).orderBy(commandReceipts.completedAt, commandReceipts.id)
  ]);
  const objectValue = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  const receiptByRun = new Map(receipts.map(({
    agentRunId, runnerId, attempt, terminal, completedAt, receiptSha256,
    receiptSizeBytes, metadata
  }) => [agentRunId, {
    runnerId,
    attempt,
    terminal,
    completedAt,
    receiptSha256,
    receiptSizeBytes,
    parsed: parseRunnerCompletionPayload(metadata),
    runtimeId: typeof metadata.runtimeId === 'string' ? metadata.runtimeId : null,
    runtimeProfile: typeof metadata.runtimeProfile === 'string' ? metadata.runtimeProfile : null,
    durationMs: typeof metadata.durationMs === 'number' && Number.isSafeInteger(metadata.durationMs) && metadata.durationMs >= 0
      ? metadata.durationMs : null,
    cost: objectValue(metadata.cost),
    usage: objectValue(metadata.usage)
  }]));
  const ledgerByRun = new Map<string, LedgerRecord[]>();
  for (const row of ledgerRows) {
    if (row.agentRunId === null) continue;
    const record = parseLedgerRecord(row.result);
    if (record === null) continue;
    ledgerByRun.set(row.agentRunId, [
      ...(ledgerByRun.get(row.agentRunId) ?? []),
      record
    ]);
  }
  const artifactsByRun = new Map<string, typeof evidenceArtifacts>();
  for (const artifact of evidenceArtifacts) artifactsByRun.set(artifact.agentRunId, [...(artifactsByRun.get(artifact.agentRunId) ?? []), artifact]);
  const actorNameById = new Map(packetActors.map((actor) => [actor.id, actor.name]));
  const profilesByWorkspaceRuntime = new Map<string, typeof profiles>();
  const profileKey = (workspaceId: string, runtimeProfile: string): string => `${workspaceId}:${runtimeProfile}`;
  for (const profile of profiles) {
    const key = profileKey(profile.workspaceId, profile.runtimeProfile);
    profilesByWorkspaceRuntime.set(key, [...(profilesByWorkspaceRuntime.get(key) ?? []), profile]);
  }
  const repositoryBindingByProject = new Map(
    repositoryBindings
      .filter((binding) => binding.entityId === binding.projectId)
      .map((binding) => [binding.projectId, binding])
  );
  const baseCommitFrom = (binding: typeof repositoryBindings[number] | undefined): string | null => {
    if (binding === undefined || typeof binding.metadata.defaultBranch !== 'string' ||
      binding.metadata.defaultBranch.length === 0) return null;
    return typeof binding.metadata.headSha === 'string' &&
      /^[0-9a-f]{40}$/.test(binding.metadata.headSha) ? binding.metadata.headSha : null;
  };
  const runnerQueueEnabled = process.env.RUNNER_ENABLED === 'true' &&
    process.env.LOCAL_RUNNER_TRANSPORT_ENABLED === 'true';
  return {
    runs: runs.flatMap((run) => {
      const project = projectById.get(run.projectId);
      if (project === undefined) return [];
      const persistedReceipt = receiptByRun.get(run.id);
      const receiptIsValid = persistedReceipt !== undefined &&
        run.status === 'done' &&
        run.failureCode === null &&
        run.completedAt !== null &&
        run.runAttempt > 0 &&
        run.confirmedPacketHash === run.packetContentHash &&
        persistedReceipt.runnerId.length > 0 &&
        persistedReceipt.attempt === run.runAttempt &&
        persistedReceipt.terminal === 'done' &&
        persistedReceipt.completedAt.getTime() === run.completedAt.getTime() &&
        persistedReceipt.parsed !== null &&
        persistedReceipt.parsed.runId === run.id &&
        persistedReceipt.parsed.attempt === run.runAttempt &&
        persistedReceipt.parsed.terminal === 'done' &&
        persistedReceipt.parsed.finalStatus === 'succeeded' &&
        persistedReceipt.parsed.receiptSha256 === persistedReceipt.receiptSha256 &&
        persistedReceipt.parsed.receiptSizeBytes === persistedReceipt.receiptSizeBytes;
      const records = ledgerByRun.get(run.id) ?? [];
      const latestCost = records.flatMap((record) =>
        record.kind === 'cost' && record.cost !== undefined
          ? [record.cost]
          : []).at(-1) ?? {
            state: 'unknown' as const,
            reason: 'no_cost_record'
          };
      const latestValueEvidence = records.flatMap((record) =>
        record.kind === 'value_evidence' && record.valueEvidence !== undefined
          ? [record.valueEvidence]
          : []).at(-1) ?? null;
      return [{
        ...run,
        attempt: run.runAttempt,
        project: project.name,
        projectSlug: project.slug,
        canAcceptReceipt: receiptIsValid && run.workItemStatus === 'in_dev',
        receipt: persistedReceipt === undefined ? null : {
          terminal: persistedReceipt.terminal,
          completedAt: persistedReceipt.completedAt,
          receiptSha256: persistedReceipt.receiptSha256,
          runtimeId: persistedReceipt.runtimeId,
          runtimeProfile: persistedReceipt.runtimeProfile,
          durationMs: persistedReceipt.durationMs,
          cost: persistedReceipt.cost,
          usage: persistedReceipt.usage
        },
        ledger: {
          records,
          latestCost,
          latestValueEvidence,
          roi: ledgerRoi(latestCost, latestValueEvidence)
        },
        artifacts: artifactsByRun.get(run.id) ?? []
      }];
    }),
    approvals: approvals.flatMap((approval) => {
      const project = projectById.get(approval.projectId);
      return project === undefined ? [] : [{...approval, project: project.name, projectSlug: project.slug}];
    }),
    packets: packetRows.flatMap((packet) => {
      const project = projectById.get(packet.projectId);
      if (project === undefined) return [];
      const eligibleProfiles = (profilesByWorkspaceRuntime.get(profileKey(project.workspaceId, packet.runtimeProfile)) ?? [])
        .filter((profile) =>
          isTaskPacketProfileEligible(
            profile.runtimeId,
            packet.agentProfileSnapshotId,
            profile.id
          ));
      const repositoryBinding = repositoryBindingByProject.get(packet.projectId);
      const baseCommit = baseCommitFrom(repositoryBinding);
      const nonRunnableReason = packet.frozenWorkItemVersion !== packet.currentWorkItemVersion
        ? 'The WorkItem changed after this packet was frozen. Build a new packet.'
        : !runnerQueueEnabled
        ? 'Agent runner is disabled.'
        : baseCommit === null
        ? (repositoryBinding === undefined
          ? 'No repository default branch head is recorded.'
          : 'The repository default branch head is not recorded as a lowercase 40-character commit.')
        : (eligibleProfiles.length === 0
          ? packet.agentProfileSnapshotId === null
            ? 'No enabled agent profile matches the packet runtime profile.'
            : 'The frozen profile is unavailable or its runtime is disabled.'
          : null);
      const packetProfiles = eligibleProfiles.map(({id, name, runtimeId}) => ({
        id,
        name,
        runtimeId,
        policyPreview: !runnerQueueEnabled || baseCommit === null ? null : buildAgentRunQueuePolicyPreview({
          packetId: packet.id,
          contentHash: packet.contentHash,
          agentProfileId: id,
          baseCommit,
          approverActorId: packet.approverActorId
        })
      }));
      const effectiveNonRunnableReason = nonRunnableReason ?? (
        packetProfiles.length > 0 &&
          packetProfiles.every(({policyPreview}) => policyPreview !== null && !policyPreview.runnable)
          ? 'Canonical policy stops every enabled profile for this queue action.'
          : null
      );
      return [{
        ...packet,
        project: project.name,
        projectSlug: project.slug,
        reviewer: actorNameById.get(packet.reviewerActorId) ?? 'No recorded reviewer',
        approver: actorNameById.get(packet.approverActorId) ?? 'No recorded approver',
        profiles: packetProfiles,
        runnable: effectiveNonRunnableReason === null,
        nonRunnableReason: effectiveNonRunnableReason
      }];
    })
  };
});

export type AccessData = Readonly<{
  canRetireAgents: boolean;
  instructionBaselines: readonly Readonly<{
    workspaceId: string;
    current: Readonly<{id: string; version: number; instructions: string; createdAt: Date; rollbackOfVersionId: string | null}> | null;
    previous: Readonly<{id: string; version: number; instructions: string; createdAt: Date; rollbackOfVersionId: string | null}> | null;
  }>[];
  actors: readonly Readonly<{id: string; displayName: string; type: 'human' | 'agent' | 'system'; role: string; disabledAt: Date | null; capabilities: Record<string, boolean>}>[];
  memberships: readonly Readonly<{id: string; projectId: string; project: string; projectSlug: OperatorProjectSlug; actorId: string; role: string; active: boolean; version: number; canManage: boolean}>[];
  externalIdentities: readonly Readonly<{actorId: string; provider: string; active: boolean}>[];
  resourceGrants: readonly Readonly<{id: string; projectId: string; project: string; projectSlug: OperatorProjectSlug; actorId: string; resourceType: string; desiredLevel: string; observedProvider: string | null; observedLevel: string | null; observedAt: Date | null; providerAccessUrl: string | null; version: number}>[];
  agentSystems: readonly Readonly<{
    actorId: string;
    profiles: readonly Readonly<{
      id: string;
      runtimeId: string;
      runtimeProfile: string;
      enabled: boolean;
      configHash: string;
      allowedTools: readonly string[];
      forbiddenSurfaces: readonly string[];
      instructions: string;
      settings: Readonly<{resultFormat: 'structured_v1'; includeEvidence: boolean}>;
      version: number;
      registrations: readonly Readonly<{
        id: string;
        projectId: string;
        project: string;
        projectSlug: OperatorProjectSlug;
        provider: string;
        runtimeKey: string;
        enabled: boolean;
        version: number;
        updatedAt: Date;
        availability: RuntimeAvailabilityProjection;
        canManage: boolean;
      }>[];
      instruction: Readonly<{workspaceVersion: number; profileVersion: number | null; hash: string; provenance: string; history?: Readonly<{
        workspace: Readonly<{id: string; version: number; instructions: string; createdAt: Date; rollbackOfVersionId: string | null}>;
        override: Readonly<{id: string; version: number; instructions: string; createdAt: Date; rollbackOfVersionId: string | null}> | null;
        previousOverride: Readonly<{id: string; version: number; instructions: string; createdAt: Date; rollbackOfVersionId: string | null}> | null;
      }>} > | null;
      latestRun: Readonly<{id: string; status: string; updatedAt: Date; completedAt: Date | null; receipt: Readonly<{terminal: string; completedAt: Date}> | null}> | null;
      fleet: Readonly<{
        health: 'healthy' | 'stale' | 'unknown' | 'not_configured' | 'disabled';
        freshnessAt: Date | null;
        currentWork: Readonly<{id: string; version: number; status: string; title: string; project: string; projectSlug: OperatorProjectSlug; startedAt: Date | null}> | null;
        lastReceipt: Readonly<{terminal: string; completedAt: Date; title: string; project: string; projectSlug: OperatorProjectSlug}> | null;
      }>;
    }>[];
  }>[];
  requests: readonly Readonly<{id: string; requester: string; targetSurface: string; requestedScope: readonly string[]; status: string; expiresAt: Date | null; decidedAt: Date | null}>[];
  secretRefs: readonly Readonly<{id: string; provider: string; scope: readonly string[]; lastRotatedAt: Date | null}>[];
  policy: readonly Readonly<{actorType: string; allow: number; ask: number; deny: number}>[];
  sharing: Readonly<{
    enabled: boolean;
    projects: readonly Readonly<{
      name: string;
      slug: OperatorProjectSlug;
      workItems: readonly Readonly<{
        id: string;
        title: string;
        status: (typeof workItemStatuses)[number];
      }>[];
    }>[];
    grants: readonly Readonly<{
      shareId: string;
      project: string;
      projectSlug: OperatorProjectSlug;
      createdAt: Date;
      expiresAt: Date;
      revokedAt: Date | null;
      accessCount: number;
      scopedItemCount: number;
      active: boolean;
    }>[];
  }>;
}>;

export const deriveRuntimeAvailabilityAlerts = (
  access: AccessData
): AttentionQueueItem[] => {
  const actorById = new Map(access.actors.map((actor) => [actor.id, actor]));
  const activeAgentMemberships = access.memberships.filter((membership) =>
    membership.active && membership.role === 'agent');
  return access.agentSystems.flatMap((system) => {
    const actor = actorById.get(system.actorId);
    if (actor === undefined || actor.type !== 'agent' || actor.disabledAt !== null) return [];
    return system.profiles.flatMap((profile) => profile.registrations.flatMap((registration) => {
      const membership = activeAgentMemberships.find((item) =>
        item.actorId === system.actorId && item.projectId === registration.projectId);
      const health = registration.availability.health;
      if (membership === undefined || !registration.enabled || !profile.enabled ||
        health === 'healthy' || health === 'disabled') return [];
      const affectedComponents = Object.entries(registration.availability.components)
        .filter(([, component]) => component.state === 'stale' || component.state === 'unknown')
        .map(([component, fact]) => `${component}: ${fact.state}`);
      const ownerMembership = access.memberships.find((item) =>
        item.projectId === registration.projectId &&
        item.active &&
        (item.role === 'project_owner' || item.role === 'workspace_owner'));
      const owner = ownerMembership === undefined ? null : actorById.get(ownerMembership.actorId)?.displayName ?? null;
      const evidenceReferences = Object.entries(registration.availability.components).flatMap(([component, fact]) =>
        fact.evidenceReference === null ? [] : [{type: `runtime_${component}`, id: fact.evidenceReference}]);
      const reason = health === 'not_configured'
        ? 'Provider-neutral availability monitoring is not configured.'
        : affectedComponents.length === 0
          ? 'Runtime availability evidence is incomplete.'
          : affectedComponents.join(' · ');
      return [{
        id: `runtime-availability:${registration.id}`,
        riskSignalId: null,
        projectId: registration.projectId,
        workItemId: null,
        severity: health === 'stale' ? 'red' as const : 'yellow' as const,
        project: registration.project,
        object: `${actor.displayName} availability`,
        reason,
        stage: null,
        signalClass: 'fact' as const,
        impact: 'Automated project support may be unavailable or its freshness is unproven.',
        freshness: registration.availability.freshnessAt ?? registration.updatedAt,
        owner,
        evidenceReferences,
        nextAction: health === 'not_configured'
          ? 'Configure observation thresholds and a script-only runtime adapter.'
          : 'Refresh the provider-neutral observations and inspect stale components.',
        sourceUrl: null,
        evidence: evidenceReferences.length === 0 ? 'No runtime observation recorded' : 'Persisted runtime availability observations',
        action: {label: 'Open Agents & Systems', href: null},
        dispositionVersion: 0,
        disposition: null
      }];
    }));
  });
};

const policySummary = () => actorTypes.map((actorType) => {
  const count = {allow: 0, ask: 0, deny: 0};
  for (const actionCategory of actionCategories) for (const surface of policySurfaces) {
    for (const environment of environments) count[policyMatrix[actorType][actionCategory][surface][environment]] += 1;
  }
  return {actorType, ...count};
});

export {CURRENT_POLICY_VERSION};

type FleetRunFact = Readonly<{
  status: string;
  heartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
}>;

/** Fresh provider-neutral component evidence keeps an idle runtime healthy; run leases remain a compatibility fallback. */
export const deriveFleetHealth = (input: Readonly<{
  actorDisabled: boolean;
  profileEnabled: boolean;
  registrations: readonly Readonly<{enabled: boolean; availability?: RuntimeAvailabilityProjection}>[];
  currentRun: FleetRunFact | null;
  asOf: Date;
}>): 'healthy' | 'stale' | 'unknown' | 'not_configured' | 'disabled' => {
  if (input.actorDisabled || !input.profileEnabled ||
    (input.registrations.length > 0 && input.registrations.every((registration) => !registration.enabled))) {
    return 'disabled';
  }
  const monitored = input.registrations
    .filter((registration) => registration.enabled)
    .flatMap((registration) => registration.availability === undefined ||
      registration.availability.health === 'not_configured' ? [] : [registration.availability]);
  if (monitored.some(({health}) => health === 'stale')) return 'stale';
  if (monitored.some(({health}) => health === 'unknown')) return 'unknown';
  if (monitored.length > 0 && monitored.every(({health}) => health === 'healthy')) return 'healthy';
  if (input.currentRun?.status !== 'running' || input.currentRun.heartbeatAt === null || input.currentRun.leaseExpiresAt === null) {
    return input.registrations.length === 0 ? 'not_configured' : 'unknown';
  }
  return input.currentRun.leaseExpiresAt.getTime() > input.asOf.getTime() ? 'healthy' : 'stale';
};

export const loadAccessData = (operatorActorId?: string): Promise<OperatorLoad<AccessData>> => readDatabase(async (db) => {
  const configuredProjects = await scopedProjects(db);
  const workspaceIds = [...new Set(configuredProjects.map(({workspaceId}) => workspaceId))];
  const sharingEnabled = process.env.PUBLIC_SHARING_ENABLED === 'true';
  if (workspaceIds.length === 0) {
    return {
      canRetireAgents: false,
      instructionBaselines: [],
      actors: [],
      memberships: [],
      externalIdentities: [],
      resourceGrants: [],
      agentSystems: [],
      requests: [],
      secretRefs: [],
      policy: policySummary(),
      sharing: {enabled: sharingEnabled, projects: [], grants: []}
    };
  }
  const projectIds = configuredProjects.map(({id}) => id);
  const [persistedActors, requests, persistedSecretRefs, shareItems, grants, persistedProfiles, registrations, availabilityObservations, workspaceInstructions, profileInstructions, profileRuns, memberships, externalIdentities, resourceGrants] = await Promise.all([
    db.select({id: actors.id, displayName: actors.displayName, type: actors.type, role: actors.role, disabledAt: actors.disabledAt, capabilities: actors.capabilities})
      .from(actors).where(inArray(actors.workspaceId, workspaceIds)).orderBy(actors.displayName),
    db.select({id: accessRequests.id, requester: actors.displayName, targetSurface: accessRequests.targetSurface, requestedScope: accessRequests.requestedScope, status: accessRequests.status, expiresAt: accessRequests.expiresAt, decidedAt: accessRequests.decidedAt})
      .from(accessRequests).leftJoin(actors, eq(accessRequests.requesterActorId, actors.id)).where(inArray(accessRequests.workspaceId, workspaceIds)).orderBy(desc(accessRequests.updatedAt), accessRequests.id),
    db.select({id: secretRefs.id, provider: secretRefs.provider, scope: secretRefs.scope, lastRotatedAt: secretRefs.lastRotatedAt})
      .from(secretRefs).where(inArray(secretRefs.workspaceId, workspaceIds)).orderBy(secretRefs.provider, secretRefs.id),
    db.select({
      id: workItems.id,
      projectId: workItems.projectId,
      title: workItems.title,
      status: workItems.status
    }).from(workItems).where(and(
      inArray(workItems.projectId, projectIds),
      isNull(workItems.deletedAt)
    )).orderBy(workItems.status, workItems.title, workItems.id),
    db.select({
      shareId: projectShareGrants.id,
      projectId: projectShareGrants.projectId,
      createdAt: projectShareGrants.createdAt,
      expiresAt: projectShareGrants.expiresAt,
      revokedAt: projectShareGrants.revokedAt,
      accessCount: projectShareGrants.accessCount
    }).from(projectShareGrants)
      .where(inArray(projectShareGrants.projectId, projectIds))
      .orderBy(desc(projectShareGrants.createdAt), projectShareGrants.id),
    db.select({
      id: agentProfiles.id, actorId: agentProfiles.actorId, workspaceId: agentProfiles.workspaceId,
      runtimeId: agentProfiles.runtimeId, runtimeProfile: agentProfiles.runtimeProfile,
      allowedTools: agentProfiles.allowedTools, forbiddenSurfaces: agentProfiles.forbiddenSurfaces,
      instructions: agentProfiles.instructions, settings: agentProfiles.settings,
      enabled: agentProfiles.enabled, version: agentProfiles.version, configHash: agentProfiles.configHash
    }).from(agentProfiles).where(inArray(agentProfiles.workspaceId, workspaceIds)),
    db.select({
      id: runtimeRegistrations.id, agentProfileId: runtimeRegistrations.agentProfileId, actorId: runtimeRegistrations.actorId,
      projectId: runtimeRegistrations.projectId, provider: runtimeRegistrations.provider,
      runtimeKey: runtimeRegistrations.runtimeKey, enabled: runtimeRegistrations.enabled,
      serviceMaxAgeSeconds: runtimeRegistrations.serviceMaxAgeSeconds,
      schedulerMaxAgeSeconds: runtimeRegistrations.schedulerMaxAgeSeconds,
      deliveryMaxAgeSeconds: runtimeRegistrations.deliveryMaxAgeSeconds,
      version: runtimeRegistrations.version, updatedAt: runtimeRegistrations.updatedAt
    }).from(runtimeRegistrations).where(inArray(runtimeRegistrations.projectId, projectIds)),
    db.selectDistinctOn([
      runtimeAvailabilityObservations.runtimeRegistrationId,
      runtimeAvailabilityObservations.component
    ], {
      id: runtimeAvailabilityObservations.id,
      runtimeRegistrationId: runtimeAvailabilityObservations.runtimeRegistrationId,
      component: runtimeAvailabilityObservations.component,
      state: runtimeAvailabilityObservations.state,
      observedAt: runtimeAvailabilityObservations.observedAt,
      evidenceReference: runtimeAvailabilityObservations.evidenceReference
    }).from(runtimeAvailabilityObservations)
      .innerJoin(runtimeRegistrations, eq(runtimeRegistrations.id, runtimeAvailabilityObservations.runtimeRegistrationId))
      .where(inArray(runtimeRegistrations.projectId, projectIds))
      .orderBy(
        runtimeAvailabilityObservations.runtimeRegistrationId,
        runtimeAvailabilityObservations.component,
        desc(runtimeAvailabilityObservations.observedAt),
        desc(runtimeAvailabilityObservations.id)
      ),
    db.select({id: workspaceInstructionVersions.id, workspaceId: workspaceInstructionVersions.workspaceId, version: workspaceInstructionVersions.version, instructions: workspaceInstructionVersions.instructions, settings: workspaceInstructionVersions.settings, createdAt: workspaceInstructionVersions.createdAt, rollbackOfVersionId: workspaceInstructionVersions.rollbackOfVersionId})
      .from(workspaceInstructionVersions).where(inArray(workspaceInstructionVersions.workspaceId, workspaceIds)).orderBy(desc(workspaceInstructionVersions.version)),
    db.select({id: agentProfileInstructionVersions.id, agentProfileId: agentProfileInstructionVersions.agentProfileId, version: agentProfileInstructionVersions.version, instructions: agentProfileInstructionVersions.instructions, settings: agentProfileInstructionVersions.settings, createdAt: agentProfileInstructionVersions.createdAt, rollbackOfVersionId: agentProfileInstructionVersions.rollbackOfVersionId})
      .from(agentProfileInstructionVersions).where(inArray(agentProfileInstructionVersions.workspaceId, workspaceIds)).orderBy(desc(agentProfileInstructionVersions.version)),
    db.select({
      id: agentRuns.id, agentProfileId: agentRuns.agentProfileId, status: agentRuns.status,
      version: agentRuns.version,
      updatedAt: agentRuns.updatedAt, completedAt: agentRuns.completedAt, startedAt: agentRuns.startedAt,
      heartbeatAt: agentRuns.heartbeatAt, leaseExpiresAt: agentRuns.leaseExpiresAt,
      workItemId: workItems.id, workItemTitle: workItems.title, projectId: taskPackets.projectId,
      receiptTerminal: agentRunReceipts.terminal, receiptCompletedAt: agentRunReceipts.completedAt
    }).from(agentRuns).innerJoin(agentProfiles, eq(agentProfiles.id, agentRuns.agentProfileId))
      .innerJoin(taskPackets, eq(taskPackets.id, agentRuns.taskPacketId))
      .innerJoin(workItems, eq(workItems.id, agentRuns.workItemId))
      .leftJoin(agentRunReceipts, eq(agentRunReceipts.agentRunId, agentRuns.id))
      .where(and(inArray(agentProfiles.workspaceId, workspaceIds), inArray(taskPackets.projectId, projectIds)))
      .orderBy(desc(agentRuns.updatedAt), agentRuns.id),
    db.select({id: projectMemberships.id, projectId: projectMemberships.projectId, actorId: projectMemberships.actorId, role: projectMemberships.role, active: projectMemberships.active, version: projectMemberships.version})
      .from(projectMemberships).where(inArray(projectMemberships.projectId, projectIds))
      .orderBy(projectMemberships.projectId, projectMemberships.actorId),
    db.select({actorId: actorExternalIdentities.actorId, provider: actorExternalIdentities.provider, active: actorExternalIdentities.active})
      .from(actorExternalIdentities).innerJoin(actors, eq(actors.id, actorExternalIdentities.actorId))
      .where(inArray(actors.workspaceId, workspaceIds))
      .orderBy(actorExternalIdentities.actorId, actorExternalIdentities.provider),
    db.select({id: resourceAccessGrants.id, projectId: resourceAccessGrants.projectId, actorId: resourceAccessGrants.actorId, resourceType: resourceAccessGrants.resourceType, desiredLevel: resourceAccessGrants.desiredLevel, observedProvider: resourceAccessGrants.observedProvider, observedExternalResourceRef: resourceAccessGrants.observedExternalResourceRef, observedLevel: resourceAccessGrants.observedLevel, observedAt: resourceAccessGrants.observedAt, version: resourceAccessGrants.version})
      .from(resourceAccessGrants).where(inArray(resourceAccessGrants.projectId, projectIds))
      .orderBy(resourceAccessGrants.projectId, resourceAccessGrants.actorId, resourceAccessGrants.resourceType)
  ]);
  const grantIds = grants.map(({shareId}) => shareId);
  const scopeRows = grantIds.length === 0
    ? []
    : await db.select({shareId: projectShareWorkItems.grantId})
        .from(projectShareWorkItems)
        .where(inArray(projectShareWorkItems.grantId, grantIds));
  const scopedItemCounts = new Map<string, number>();
  for (const row of scopeRows) {
    scopedItemCounts.set(
      row.shareId,
      (scopedItemCounts.get(row.shareId) ?? 0) + 1
    );
  }
  const projectById = new Map(
    configuredProjects.map((project) => [project.id, project])
  );
  const latestWorkspaceInstruction = new Map<string, (typeof workspaceInstructions)[number]>();
  for (const instruction of workspaceInstructions) if (!latestWorkspaceInstruction.has(instruction.workspaceId)) latestWorkspaceInstruction.set(instruction.workspaceId, instruction);
  const latestProfileInstruction = new Map<string, (typeof profileInstructions)[number]>();
  for (const instruction of profileInstructions) if (!latestProfileInstruction.has(instruction.agentProfileId)) latestProfileInstruction.set(instruction.agentProfileId, instruction);
  const workspaceInstructionHistory = new Map<string, (typeof workspaceInstructions)[number][]>();
  for (const instruction of workspaceInstructions) workspaceInstructionHistory.set(instruction.workspaceId, [...(workspaceInstructionHistory.get(instruction.workspaceId) ?? []), instruction]);
  const profileInstructionHistory = new Map<string, (typeof profileInstructions)[number][]>();
  for (const instruction of profileInstructions) profileInstructionHistory.set(instruction.agentProfileId, [...(profileInstructionHistory.get(instruction.agentProfileId) ?? []), instruction]);
  const latestRunByProfile = new Map<string, (typeof profileRuns)[number]>();
  for (const run of profileRuns) if (!latestRunByProfile.has(run.agentProfileId)) latestRunByProfile.set(run.agentProfileId, run);
  const currentRunByProfile = new Map<string, (typeof profileRuns)[number]>();
  const latestReceiptByProfile = new Map<string, (typeof profileRuns)[number]>();
  for (const run of profileRuns) {
    if (!currentRunByProfile.has(run.agentProfileId) && ['queued', 'running', 'waiting_approval'].includes(run.status)) {
      currentRunByProfile.set(run.agentProfileId, run);
    }
    const priorReceipt = latestReceiptByProfile.get(run.agentProfileId);
    if (run.receiptCompletedAt !== null && (priorReceipt === undefined ||
      priorReceipt.receiptCompletedAt === null || priorReceipt.receiptCompletedAt < run.receiptCompletedAt)) {
      latestReceiptByProfile.set(run.agentProfileId, run);
    }
  }
  const availabilityByRegistration = new Map<string, (typeof availabilityObservations)[number][]>();
  for (const observation of availabilityObservations) {
    availabilityByRegistration.set(observation.runtimeRegistrationId, [
      ...(availabilityByRegistration.get(observation.runtimeRegistrationId) ?? []),
      observation
    ]);
  }
  const asOf = new Date();
  const actorById = new Map(persistedActors.map((actor) => [actor.id, actor]));
  const operator = operatorActorId === undefined ? undefined : actorById.get(operatorActorId);
  const manageableProjectIds = new Set(
    memberships.flatMap((membership) =>
      membership.actorId === operatorActorId &&
      membership.active &&
      (membership.role === 'workspace_owner' || membership.role === 'project_owner')
        ? [membership.projectId]
        : [])
  );
  const canRetireAgents = operator?.type === 'human' && operator.disabledAt === null &&
    (operator.role === 'workspace_admin' ||
      memberships.some((membership) =>
        membership.actorId === operatorActorId &&
        membership.active &&
        membership.role === 'workspace_owner'));
  const profilesByActor = new Map<string, AccessData['agentSystems'][number]['profiles'][number][]>();
  for (const profile of persistedProfiles) {
    const baseline = latestWorkspaceInstruction.get(profile.workspaceId);
    const override = latestProfileInstruction.get(profile.id);
    const effective = baseline === undefined ? null : effectiveInstructions(
      {instructions: baseline.instructions, settings: baseline.settings as Record<string, CanonicalJson>},
      override === undefined ? null : {instructions: override.instructions, settings: override.settings as Record<string, CanonicalJson>}
    );
    const run = latestRunByProfile.get(profile.id) ?? null;
    const currentRun = currentRunByProfile.get(profile.id) ?? null;
    const receiptRun = latestReceiptByProfile.get(profile.id) ?? null;
    const profileRegistrations = registrations.flatMap((registration) => {
      const project = projectById.get(registration.projectId);
      return registration.agentProfileId !== profile.id || registration.actorId !== profile.actorId || project === undefined ? [] : [{
        id: registration.id, projectId: registration.projectId,
        project: project.name, projectSlug: project.slug, provider: registration.provider,
        runtimeKey: registration.runtimeKey, enabled: registration.enabled,
        version: registration.version, updatedAt: registration.updatedAt,
        availability: deriveRuntimeAvailability({
          enabled: registration.enabled && profile.enabled &&
            (actorById.get(profile.actorId)?.disabledAt ?? null) === null,
          thresholds: {
            service: registration.serviceMaxAgeSeconds,
            scheduler: registration.schedulerMaxAgeSeconds,
            delivery: registration.deliveryMaxAgeSeconds
          },
          observations: availabilityByRegistration.get(registration.id) ?? [],
          asOf
        }),
        canManage: operator?.type === 'human' && operator.disabledAt === null &&
          (operator.role === 'workspace_admin' || manageableProjectIds.has(registration.projectId))
      }];
    });
    const currentProject = currentRun === null ? undefined : projectById.get(currentRun.projectId);
    const receiptProject = receiptRun === null ? undefined : projectById.get(receiptRun.projectId);
    const projected = {
        id: profile.id, runtimeId: profile.runtimeId, runtimeProfile: profile.runtimeProfile,
        allowedTools: profile.allowedTools, forbiddenSurfaces: profile.forbiddenSurfaces,
        instructions: profile.instructions,
        settings: profile.settings as Readonly<{resultFormat: 'structured_v1'; includeEvidence: boolean}>,
        enabled: profile.enabled, version: profile.version, configHash: profile.configHash,
        registrations: profileRegistrations,
        instruction: effective === null ? null : {
          workspaceVersion: baseline!.version, profileVersion: override?.version ?? null,
          hash: effective.hash,
          provenance: override === undefined ? `workspace v${baseline!.version}` : `workspace v${baseline!.version} + profile v${override.version}`,
          history: {
            workspace: baseline!,
            override: override ?? null,
            previousOverride: profileInstructionHistory.get(profile.id)?.[1] ?? null
          }
        },
        latestRun: run === null ? null : {
          id: run.id, status: run.status, updatedAt: run.updatedAt, completedAt: run.completedAt,
          receipt: run.receiptTerminal === null || run.receiptCompletedAt === null ? null : {terminal: run.receiptTerminal, completedAt: run.receiptCompletedAt}
        },
        fleet: {
          health: deriveFleetHealth({
            actorDisabled: (actorById.get(profile.actorId)?.disabledAt ?? null) !== null,
            profileEnabled: profile.enabled,
            registrations: profileRegistrations,
            currentRun,
            asOf
          }),
          freshnessAt: profileRegistrations.flatMap(({availability}) =>
            availability.freshnessAt === null ? [] : [availability.freshnessAt])
            .sort((left, right) => right.getTime() - left.getTime())[0] ?? currentRun?.heartbeatAt ?? null,
          currentWork: currentRun === null || currentProject === undefined ? null : {
            id: currentRun.id, version: currentRun.version, status: currentRun.status, title: currentRun.workItemTitle,
            project: currentProject.name, projectSlug: currentProject.slug, startedAt: currentRun.startedAt
          },
          lastReceipt: receiptRun === null || receiptRun.receiptTerminal === null || receiptRun.receiptCompletedAt === null || receiptProject === undefined ? null : {
            terminal: receiptRun.receiptTerminal, completedAt: receiptRun.receiptCompletedAt,
            title: receiptRun.workItemTitle, project: receiptProject.name, projectSlug: receiptProject.slug
          }
        }
      };
    const profiles = profilesByActor.get(profile.actorId) ?? [];
    profiles.push(projected);
    profilesByActor.set(profile.actorId, profiles);
  }
  const agentSystems = [...profilesByActor.entries()].map(([actorId, profiles]) => ({
    actorId,
    profiles
  }));
  return {
    canRetireAgents,
    instructionBaselines: workspaceIds.map((workspaceId) => ({
      workspaceId,
      current: workspaceInstructionHistory.get(workspaceId)?.[0] ?? null,
      previous: workspaceInstructionHistory.get(workspaceId)?.[1] ?? null
    })),
    actors: persistedActors,
    memberships: memberships.flatMap((membership) => {
      const project = projectById.get(membership.projectId);
      return project === undefined ? [] : [{
        ...membership,
        project: project.name,
        projectSlug: project.slug,
        canManage: operator?.type === 'human' && operator.disabledAt === null &&
          (operator.role === 'workspace_admin' || manageableProjectIds.has(membership.projectId))
      }];
    }),
    // Provider subjects are deliberately omitted: they are locators, not operator-facing access facts.
    externalIdentities,
    resourceGrants: resourceGrants.flatMap((grant) => {
      const project = projectById.get(grant.projectId);
      return project === undefined ? [] : [{
        ...grant,
        project: project.name,
        projectSlug: project.slug,
        // A provider locator is never shown. It becomes a link only when the
        // provider-confirmed observation itself carries a safe HTTPS URL.
        providerAccessUrl: grant.observedProvider === null
          ? null
          : safeExternalUrlValue(grant.observedExternalResourceRef)
      }];
    }),
    agentSystems,
    requests: requests.map((request) => ({...request, requester: request.requester ?? 'No recorded requester'})),
    secretRefs: persistedSecretRefs,
    policy: policySummary(),
    sharing: {
      enabled: sharingEnabled,
      projects: configuredProjects.map((project) => ({
        name: project.name,
        slug: project.slug,
        workItems: shareItems.filter((item) => item.projectId === project.id)
          .map(({id, title, status}) => ({id, title, status}))
      })),
      grants: grants.flatMap((grant) => {
        const project = projectById.get(grant.projectId);
        return project === undefined ? [] : [{
          shareId: grant.shareId,
          project: project.name,
          projectSlug: project.slug,
          createdAt: grant.createdAt,
          expiresAt: grant.expiresAt,
          revokedAt: grant.revokedAt,
          accessCount: grant.accessCount,
          scopedItemCount: scopedItemCounts.get(grant.shareId) ?? 0,
          active: grant.revokedAt === null && grant.expiresAt.getTime() > Date.now()
        }];
      })
    }
  };
});

export type HealthData = Readonly<{
  jobs: readonly Readonly<{id: string; project: string; projectSlug: OperatorProjectSlug; name: string; status: string; heartbeatAt: Date | null; lastSuccessAt: Date | null; nextRunAt: Date | null}>[];
  integrations: readonly Readonly<{id: string; project: string; projectSlug: OperatorProjectSlug; provider: string; mode: string; createdAt: Date}>[];
  risks: readonly Readonly<{id: string; project: string; projectSlug: OperatorProjectSlug; severity: 'green' | 'yellow' | 'red'; summary: string; updatedAt: Date}>[];
  audit: readonly Readonly<{id: string; project: string; projectSlug: OperatorProjectSlug; actor: string | null; action: string; targetType: string; targetId: string | null; policyDecision: string | null; outcome: string | null; reasonCode: string | null; occurredAt: Date}>[];
  costLedger: readonly Readonly<{
    runType: string;
    currency: string | null;
    state: 'unknown' | 'pending' | 'calculated' | 'error';
    count: number;
  }>[];
}>;

export const loadHealthData = (scope?: OperatorProjectSlug): Promise<OperatorLoad<HealthData>> => readDatabase(async (db) => {
  const configuredProjects = await scopedProjects(db, scope);
  if (configuredProjects.length === 0) return {jobs: [], integrations: [], risks: [], audit: [], costLedger: []};
  const projectIds = configuredProjects.map(({id}) => id);
  const projectById = new Map(configuredProjects.map((project) => [project.id, project]));
  const [jobs, integrations, risks, audit, runCosts] = await Promise.all([
    db.select({id: scheduledJobs.id, projectId: scheduledJobs.projectId, name: scheduledJobs.name, status: scheduledJobs.status, heartbeatAt: scheduledJobs.heartbeatAt, lastSuccessAt: scheduledJobs.lastSuccessAt, nextRunAt: scheduledJobs.nextRunAt})
      .from(scheduledJobs).where(inArray(scheduledJobs.projectId, projectIds)).orderBy(scheduledJobs.name),
    db.select({id: trackerSnapshotOperations.id, projectId: trackerSnapshotOperations.projectId, provider: trackerSnapshotOperations.provider, mode: trackerSnapshotOperations.mode, createdAt: trackerSnapshotOperations.createdAt})
      .from(trackerSnapshotOperations).where(inArray(trackerSnapshotOperations.projectId, projectIds)).orderBy(desc(trackerSnapshotOperations.createdAt), trackerSnapshotOperations.id).limit(20),
    db.select({id: riskSignals.id, projectId: riskSignals.projectId, severity: riskSignals.severity, summary: riskSignals.summary, updatedAt: riskSignals.updatedAt})
      .from(riskSignals).where(and(inArray(riskSignals.projectId, projectIds), isNull(riskSignals.resolvedAt))).orderBy(desc(riskSignals.updatedAt), riskSignals.id),
    db.select({
      id: auditEvents.id,
      projectId: auditEvents.projectId,
      actor: actors.displayName,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      policyDecision: auditEvents.policyDecision,
      outcome: auditEvents.outcome,
      reasonCode: auditEvents.reasonCode,
      occurredAt: auditEvents.occurredAt
    }).from(auditEvents).leftJoin(actors, eq(auditEvents.actorId, actors.id))
      .where(inArray(auditEvents.projectId, projectIds))
      .orderBy(desc(auditEvents.occurredAt), auditEvents.id).limit(20),
    db.select({
      runId: agentRuns.id,
      runType: taskPackets.runtimeProfile,
      rawCost: agentRunReceipts.metadata,
      result: commandReceipts.result
    }).from(agentRuns)
      .innerJoin(taskPackets, eq(taskPackets.id, agentRuns.taskPacketId))
      .leftJoin(
        agentRunReceipts,
        eq(agentRunReceipts.agentRunId, agentRuns.id)
      )
      .leftJoin(commandReceipts, and(
        eq(commandReceipts.aggregateId, agentRuns.id),
        eq(commandReceipts.commandType, COST_LEDGER_COMMAND)
      ))
      .where(inArray(taskPackets.projectId, projectIds))
      .orderBy(agentRuns.id, commandReceipts.completedAt, commandReceipts.id)
  ]);
  const scopeRow = <T extends Readonly<{projectId: string | null}>>(row: T) => {
    if (row.projectId === null) return [];
    const project = projectById.get(row.projectId);
    return project === undefined ? [] : [{...row, project: project.name, projectSlug: project.slug}];
  };
  const latestCostByRun = new Map<string, {
    runType: string;
    cost: LedgerCost;
  }>();
  for (const row of runCosts) {
    const rawCost = row.rawCost !== null &&
      typeof row.rawCost.cost === 'object' &&
      row.rawCost.cost !== null &&
      !Array.isArray(row.rawCost.cost) &&
      'state' in row.rawCost.cost &&
      ['unknown', 'pending', 'calculated', 'error'].includes(
        String(row.rawCost.cost.state)
      )
      ? row.rawCost.cost as LedgerCost
      : {state: 'unknown' as const, reason: 'no_cost_record'};
    const record = parseLedgerRecord(row.result);
    latestCostByRun.set(row.runId, {
      runType: row.runType,
      cost: record?.kind === 'cost' && record.cost !== undefined
        ? record.cost
        : latestCostByRun.get(row.runId)?.cost ?? rawCost
    });
  }
  const costGroups = new Map<string, HealthData['costLedger'][number]>();
  for (const {runType, cost} of latestCostByRun.values()) {
    const currency = cost.state === 'calculated' ? cost.currency : null;
    const key = `${runType}\0${currency ?? ''}\0${cost.state}`;
    const current = costGroups.get(key);
    costGroups.set(key, {
      runType,
      currency,
      state: cost.state,
      count: (current?.count ?? 0) + 1
    });
  }
  return {
    jobs: jobs.flatMap(scopeRow),
    integrations: integrations.flatMap(scopeRow),
    risks: risks.flatMap(scopeRow),
    audit: audit.flatMap(scopeRow),
    costLedger: [...costGroups.values()].sort((left, right) =>
      left.runType.localeCompare(right.runType) ||
      (left.currency ?? '').localeCompare(right.currency ?? '') ||
      left.state.localeCompare(right.state))
  };
});
