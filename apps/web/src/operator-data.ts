import {createHash} from 'node:crypto';
import {and, desc, eq, inArray, isNull} from 'drizzle-orm';
import {
  CANONICAL_COMMAND_POLICY,
  parseRunnerCompletionPayload
} from '@fai-control-plane/application';
import {
  accessRequests,
  actors,
  agentProfiles,
  agentRunReceipts,
  agentRuns,
  approvalRequests,
  artifacts,
  auditEvents,
  commandReceipts,
  COST_LEDGER_COMMAND,
  createDatabase,
  dashboardSnapshots,
  healthcheckStaleAfterMs,
  outboxEvents,
  projectShareGrants,
  projectShareWorkItems,
  projectTrackerRepositoryScopes,
  projects,
  riskSignals,
  scheduledJobs,
  secretRefs,
  taskPackets,
  trackerBindings,
  trackerSnapshotOperations,
  VALUE_LEDGER_COMMAND,
  workItems,
  ledgerRoi,
  parseLedgerRecord,
  type LedgerCost,
  type LedgerRecord,
  type LedgerRoi,
  type ValueEvidence
} from '@fai-control-plane/db';
import {
  CURRENT_POLICY_VERSION,
  actionCategories,
  actorTypes,
  canonicalJson,
  environments,
  policyDecisionFor,
  policyMatrix,
  policySurfaces,
  type CanonicalJson,
  type PolicyDecision
} from '@fai-control-plane/domain';
import {rankAttentionQueue, type AttentionQueueItem} from './attention-queue';

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

const safeExternalUrl = (metadata: Record<string, unknown>): string | null => {
  const candidate = metadata.htmlUrl;
  if (typeof candidate !== 'string' || candidate.length > 2048) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.toString() : null;
  } catch {
    return null;
  }
};

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
const outboxWorkItemId = (payload: Record<string, unknown>): string | null =>
  typeof payload.workItemId === 'string' ? payload.workItemId : null;

export type PortfolioData = Readonly<{
  projects: readonly Readonly<{
    id: string;
    name: string;
    slug: OperatorProjectSlug;
    health: 'green' | 'yellow' | 'red' | 'unknown';
    snapshotAt: Date | null;
    synchronizedAt: Date | null;
    unresolvedRiskCount: number;
  }>[];
  attention: readonly AttentionQueueItem[];
}>;

export const loadPortfolioData = (): Promise<OperatorLoad<PortfolioData>> => readDatabase(async (db) => {
  const configuredProjects = await scopedProjects(db);
  if (configuredProjects.length === 0) return {projects: [], attention: []};
  const projectIds = configuredProjects.map(({id}) => id);
  const [snapshots, operations, signals, failedOutbox, unhealthyJobs, items, bindings] = await Promise.all([
    db.select({projectId: dashboardSnapshots.projectId, health: dashboardSnapshots.health, capturedAt: dashboardSnapshots.capturedAt})
      .from(dashboardSnapshots).where(inArray(dashboardSnapshots.projectId, projectIds)).orderBy(desc(dashboardSnapshots.capturedAt)),
    db.select({projectId: trackerSnapshotOperations.projectId, createdAt: trackerSnapshotOperations.createdAt})
      .from(trackerSnapshotOperations).where(inArray(trackerSnapshotOperations.projectId, projectIds)).orderBy(desc(trackerSnapshotOperations.createdAt)),
    db.select({
      id: riskSignals.id, projectId: riskSignals.projectId, workItemId: riskSignals.workItemId,
      code: riskSignals.code, severity: riskSignals.severity, summary: riskSignals.summary,
      updatedAt: riskSignals.updatedAt, workItemTitle: workItems.title, owner: actors.displayName
    }).from(riskSignals)
      .leftJoin(workItems, and(eq(riskSignals.workItemId, workItems.id), eq(riskSignals.projectId, workItems.projectId)))
      .leftJoin(actors, eq(workItems.ownerActorId, actors.id))
      .where(and(inArray(riskSignals.projectId, projectIds), isNull(riskSignals.resolvedAt)))
      .orderBy(desc(riskSignals.updatedAt), riskSignals.id),
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
      .from(trackerBindings).where(and(inArray(trackerBindings.projectId, projectIds), eq(trackerBindings.entityType, 'work_item')))
  ]);
  const projectById = new Map(configuredProjects.map((project) => [project.id, project]));
  const itemById = new Map(items.map((item) => [item.id, item]));
  const urlByItemId = new Map(bindings.map((binding) => [binding.entityId, safeExternalUrl(binding.metadata)]));
  const attention = rankAttentionQueue([
    ...signals.flatMap((signal): AttentionQueueItem[] => {
      const project = projectById.get(signal.projectId);
      if (project === undefined) return [];
      const url = signal.workItemId === null ? null : urlByItemId.get(signal.workItemId) ?? null;
      return [{
        id: `risk:${signal.id}`, projectId: signal.projectId, severity: signal.severity, project: project.name,
        object: signal.workItemTitle ?? 'Project risk signal', reason: signal.summary,
        impact: signal.workItemId === null ? 'Unresolved project risk' : 'Unresolved linked work item risk',
        freshness: signal.updatedAt, owner: signal.owner, evidence: `Risk signal: ${signal.code}`,
        action: {label: url === null ? 'No external record' : 'Open source', href: url}
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
        id: `outbox:${event.id}`, projectId: event.projectId, severity: 'red', project: project.name,
        object: item?.title ?? 'GitHub project status write', reason: event.failureCode ?? 'GitHub status write failed',
        impact: 'Canonical status is not confirmed in GitHub', freshness: event.updatedAt, owner: null,
        evidence: `Outbox failed after ${event.attemptCount} attempts`,
        action: {label: url === null ? 'No external record' : 'Open source', href: url}
      }];
    }),
    ...unhealthyJobs.flatMap((job): AttentionQueueItem[] => {
      if (job.projectId === null) return [];
      const project = projectById.get(job.projectId);
      if (project === undefined) return [];
      return [{
        id: `job:${job.id}`, projectId: job.projectId, severity: 'red', project: project.name, object: job.name,
        reason: 'Scheduled job is unhealthy', impact: 'Scheduled recovery is not in a healthy state',
        freshness: job.heartbeatAt ?? job.updatedAt, owner: null, evidence: 'Scheduled job status',
        action: {label: 'No external record', href: null}
      }];
    })
  ]);
  const snapshotsByProject = latestByProject(snapshots);
  const operationsByProject = latestByProject(operations);
  const now = Date.now();
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
        unresolvedRiskCount: projectSignals.length
      };
    }),
    attention
  };
});

export type ProjectData = Readonly<{
  project: Project;
  hermesAgentProfileId: string | null;
  snapshot: Readonly<{health: 'green' | 'yellow' | 'red'; capturedAt: Date}> | null;
  synchronizedAt: Date | null;
  workItems: readonly Readonly<{
    id: string; title: string; summary: string | null; status: (typeof workItemStatuses)[number];
    blocked: boolean; owner: string | null; updatedAt: Date; externalUrl: string | null;
    canBuildPacket: boolean;
    handoff: Readonly<{
      label: string;
      state: 'pending' | 'queued' | 'running' | 'waiting_approval' | 'done' | 'failed';
      href: string;
    }> | null;
  }>[];
}>;

export const loadProjectData = (slug: OperatorProjectSlug): Promise<OperatorLoad<ProjectData | null>> => readDatabase(async (db) => {
  const [project] = await scopedProjects(db, slug);
  if (project === undefined) return null;
  const [snapshots, operations, items, bindings, repositoryScopes, hermesProfiles, packetFacts, runFacts, approvalFacts] = await Promise.all([
    db.select({health: dashboardSnapshots.health, capturedAt: dashboardSnapshots.capturedAt})
      .from(dashboardSnapshots).where(eq(dashboardSnapshots.projectId, project.id)).orderBy(desc(dashboardSnapshots.capturedAt)).limit(1),
    db.select({createdAt: trackerSnapshotOperations.createdAt})
      .from(trackerSnapshotOperations).where(eq(trackerSnapshotOperations.projectId, project.id)).orderBy(desc(trackerSnapshotOperations.createdAt)).limit(1),
    db.select({
      id: workItems.id, title: workItems.title, summary: workItems.summary, status: workItems.status,
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
    db.select({id: agentProfiles.id}).from(agentProfiles).where(and(
      eq(agentProfiles.workspaceId, project.workspaceId),
      eq(agentProfiles.runtimeId, 'hermes'),
      eq(agentProfiles.runtimeProfile, 'read_safe'),
      eq(agentProfiles.enabled, true)
    )).limit(2)
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
      .orderBy(desc(approvalRequests.updatedAt), approvalRequests.id)
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
  return {
    project,
    hermesAgentProfileId: process.env.HERMES_RUNNER_ENABLED === 'true' && hermesProfiles.length === 1
      ? hermesProfiles[0]!.id
      : null,
    snapshot: snapshots[0] ?? null,
    synchronizedAt: operations[0]?.createdAt ?? null,
    workItems: items.flatMap((item) => {
      if (!workItemStatuses.includes(item.status)) return [];
      const approval = pendingApprovalByItem.get(item.id);
      const activeRun = activeRunByItem.get(item.id);
      const latestRun = latestRunByItem.get(item.id);
      const completedRun = latestRun?.status === 'done' ? latestRun : undefined;
      const failedRun = latestRun?.status === 'failed' ? latestRun : undefined;
      const packet = unconfirmedPacketByItem.get(item.id);
      const handoff = approval !== undefined
        ? {label: 'Approval pending', state: 'pending' as const, href: `/runs?project=${slug}#approval-${approval.id}`}
        : activeRun !== undefined
          ? {
              label: activeRun.status === 'waiting_approval'
                ? 'Run waiting approval'
                : activeRun.status === 'running' ? 'Run running' : 'Run queued',
              state: activeRun.status === 'waiting_approval'
                ? 'waiting_approval' as const
                : activeRun.status === 'running' ? 'running' as const : 'queued' as const,
              href: `/runs?project=${slug}#run-${activeRun.id}`
            }
          : completedRun !== undefined &&
              (item.status === 'qa' || item.status === 'acceptance' || item.status === 'done')
            ? {label: 'Run completed', state: 'done' as const, href: `/runs?project=${slug}#run-${completedRun.id}`}
          : failedRun !== undefined && (packet === undefined || failedRun.updatedAt >= packet.createdAt)
            ? {label: 'Run failed', state: 'failed' as const, href: `/runs?project=${slug}#run-${failedRun.id}`}
            : packet !== undefined
              ? {label: 'Packet needs confirmation', state: 'queued' as const, href: `/runs?project=${slug}#packet-${packet.id}`}
              : null;
      return [{
        ...item,
        externalUrl: externalUrlByItem.get(item.id) ?? null,
        canBuildPacket: (item.status === 'ready' || item.status === 'in_dev') && packetEligibleItems.has(item.id),
        handoff
      }];
    })
  };
});

export type RunsData = Readonly<{
  runs: readonly Readonly<{
    id: string; project: string; projectSlug: OperatorProjectSlug; workItem: string | null; agent: string | null;
    status: 'queued' | 'running' | 'waiting_approval' | 'done' | 'failed'; runtimeProfile: string;
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
    id: string; project: string; projectSlug: OperatorProjectSlug; actionCategory: string; surface: string;
    environment: string; status: string; policyVersion: number; expiresAt: Date; decidedAt: Date | null;
  }>[];
  packets: readonly Readonly<{
    id: string; project: string; projectSlug: OperatorProjectSlug; workItemTitle: string;
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
      id: agentRuns.id, projectId: taskPackets.projectId, workItem: workItems.title,
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
      id: approvalRequests.id, projectId: approvalRequests.projectId, actionCategory: approvalRequests.actionCategory,
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
          (packet.agentProfileSnapshotId === null && profile.runtimeId !== 'hermes') ||
          profile.id === packet.agentProfileSnapshotId);
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
            : 'Hermes runner is disabled or its frozen profile no longer matches.'
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
  actors: readonly Readonly<{id: string; displayName: string; type: 'human' | 'agent' | 'system'; role: string; disabledAt: Date | null; capabilities: Record<string, boolean>}>[];
  requests: readonly Readonly<{id: string; requester: string; targetSurface: string; requestedScope: readonly string[]; status: string; expiresAt: Date | null; decidedAt: Date | null}>[];
  secretRefs: readonly Readonly<{id: string; provider: string; scope: readonly string[]; lastRotatedAt: Date | null}>[];
  policy: readonly Readonly<{actorType: string; allow: number; ask: number; deny: number}>[];
  hermes: Readonly<{
    id: string;
    runtimeProfile: string;
    allowedTools: readonly string[];
    forbiddenSurfaces: readonly string[];
    instructions: string;
    settings: Readonly<{resultFormat: 'structured_v1'; includeEvidence: boolean}>;
    enabled: boolean;
    version: number;
    configHash: string;
  }> | null;
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

const policySummary = () => actorTypes.map((actorType) => {
  const count = {allow: 0, ask: 0, deny: 0};
  for (const actionCategory of actionCategories) for (const surface of policySurfaces) {
    for (const environment of environments) count[policyMatrix[actorType][actionCategory][surface][environment]] += 1;
  }
  return {actorType, ...count};
});

export {CURRENT_POLICY_VERSION};

export const loadAccessData = (): Promise<OperatorLoad<AccessData>> => readDatabase(async (db) => {
  const configuredProjects = await scopedProjects(db);
  const workspaceIds = [...new Set(configuredProjects.map(({workspaceId}) => workspaceId))];
  const sharingEnabled = process.env.PUBLIC_SHARING_ENABLED === 'true';
  if (workspaceIds.length === 0) {
    return {
      actors: [],
      requests: [],
      secretRefs: [],
      policy: policySummary(),
      hermes: null,
      sharing: {enabled: sharingEnabled, projects: [], grants: []}
    };
  }
  const projectIds = configuredProjects.map(({id}) => id);
  const [persistedActors, requests, persistedSecretRefs, shareItems, grants, hermesProfiles] = await Promise.all([
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
      id: agentProfiles.id,
      runtimeProfile: agentProfiles.runtimeProfile,
      allowedTools: agentProfiles.allowedTools,
      forbiddenSurfaces: agentProfiles.forbiddenSurfaces,
      instructions: agentProfiles.instructions,
      settings: agentProfiles.settings,
      enabled: agentProfiles.enabled,
      version: agentProfiles.version,
      configHash: agentProfiles.configHash
    }).from(agentProfiles).where(and(
      inArray(agentProfiles.workspaceId, workspaceIds),
      eq(agentProfiles.runtimeId, 'hermes'),
      eq(agentProfiles.runtimeProfile, 'read_safe')
    )).limit(2)
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
  return {
    actors: persistedActors,
    requests: requests.map((request) => ({...request, requester: request.requester ?? 'No recorded requester'})),
    secretRefs: persistedSecretRefs,
    policy: policySummary(),
    hermes: hermesProfiles.length === 1 ? {
      ...hermesProfiles[0]!,
      settings: hermesProfiles[0]!.settings as Readonly<{
        resultFormat: 'structured_v1';
        includeEvidence: boolean;
      }>
    } : null,
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
