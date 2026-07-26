import {and, desc, eq, inArray, isNull} from 'drizzle-orm';
import {
  actors,
  auditEvents,
  createDatabase,
  dashboardSnapshots,
  outboxEvents,
  projects,
  riskSignals,
  scheduledJobs,
  trackerBindings,
  trackerSnapshotOperations,
  workItems
} from '@fai-control-plane/db';
import {rankAttentionQueue, type AttentionQueueItem} from '../src/attention-queue';

export const dynamic = 'force-dynamic';

const statuses = ['backlog', 'ready', 'in_dev', 'qa', 'acceptance'] as const;
const urgency = ['in_dev', 'qa', 'acceptance', 'ready', 'backlog'];
const statusLabel = (status: string) => status.replace('_', ' ');
const syncLabel = (value: Date | null) => value === null
  ? 'Never synced'
  : `Synced ${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const freshnessLabel = (value: Date) => `Updated ${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const severityLabel = (value: AttentionQueueItem['severity']) => ({
  red: 'Critical',
  yellow: 'Warning',
  green: 'Info'
})[value];

type WorkItemRow = {
  id: string;
  projectId: string;
  title: string;
  status: string;
  blocked: boolean;
  externalUrl: string | null;
};

const externalUrl = (metadata: Record<string, unknown>): string | null => {
  const value = metadata.htmlUrl;
  return typeof value === 'string' && value.startsWith('https://') ? value : null;
};

const issueState = (metadata: Record<string, unknown>): 'open' | 'closed' | null =>
  metadata.state === 'open' || metadata.state === 'closed' ? metadata.state : null;

const hasProjectStatus = (metadata: Record<string, unknown>): boolean =>
  typeof metadata.projectStatus === 'object' && metadata.projectStatus !== null;

const outboxWorkItemId = (payload: Record<string, unknown>): string | null =>
  typeof payload.workItemId === 'string' ? payload.workItemId : null;

async function loadProjects() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;

  const {db, pool} = createDatabase(databaseUrl);
  try {
    const configuredProjects = await db.select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug
    }).from(projects).where(inArray(projects.slug, ['msa', 'ascon']))
      .orderBy(projects.slug);
    if (configuredProjects.length === 0) return [];

    const projectIds = configuredProjects.map(({id}) => id);
    const [items, bindings, snapshots, operations, signals, failedOutbox, unhealthyJobs] = await Promise.all([
      db.select({
        id: workItems.id,
        projectId: workItems.projectId,
        title: workItems.title,
        status: workItems.status,
        blocked: workItems.blocked
      }).from(workItems).where(and(
        inArray(workItems.projectId, projectIds),
        isNull(workItems.deletedAt),
        inArray(workItems.status, [...statuses])
      )).orderBy(desc(workItems.updatedAt)),
      db.select({
        entityId: trackerBindings.entityId,
        metadata: trackerBindings.metadata
      }).from(trackerBindings).where(and(
        inArray(trackerBindings.projectId, projectIds),
        eq(trackerBindings.entityType, 'work_item')
      )),
      db.select({
        projectId: dashboardSnapshots.projectId,
        health: dashboardSnapshots.health,
        capturedAt: dashboardSnapshots.capturedAt
      }).from(dashboardSnapshots).where(inArray(dashboardSnapshots.projectId, projectIds))
        .orderBy(desc(dashboardSnapshots.capturedAt)),
      db.select({
        projectId: trackerSnapshotOperations.projectId,
        createdAt: trackerSnapshotOperations.createdAt
      }).from(trackerSnapshotOperations)
        .where(inArray(trackerSnapshotOperations.projectId, projectIds))
        .orderBy(desc(trackerSnapshotOperations.createdAt)),
      db.select({
        id: riskSignals.id,
        projectId: riskSignals.projectId,
        workItemId: riskSignals.workItemId,
        code: riskSignals.code,
        severity: riskSignals.severity,
        summary: riskSignals.summary,
        updatedAt: riskSignals.updatedAt,
        workItemTitle: workItems.title,
        owner: actors.displayName
      }).from(riskSignals)
        .leftJoin(workItems, and(
          eq(riskSignals.workItemId, workItems.id),
          eq(riskSignals.projectId, workItems.projectId)
        ))
        .leftJoin(actors, eq(workItems.ownerActorId, actors.id))
        .where(and(inArray(riskSignals.projectId, projectIds), isNull(riskSignals.resolvedAt)))
        .orderBy(desc(riskSignals.updatedAt), riskSignals.id),
      db.select({
        id: outboxEvents.id,
        projectId: outboxEvents.projectId,
        payload: outboxEvents.payload,
        attemptCount: outboxEvents.attemptCount,
        failureCode: outboxEvents.failureCode,
        updatedAt: outboxEvents.updatedAt
      }).from(outboxEvents).where(and(
        inArray(outboxEvents.projectId, projectIds),
        eq(outboxEvents.destination, 'github'),
        eq(outboxEvents.eventType, 'github.project_status.write.v1'),
        eq(outboxEvents.status, 'failed')
      )).orderBy(desc(outboxEvents.updatedAt), outboxEvents.id),
      db.select({
        id: scheduledJobs.id,
        projectId: scheduledJobs.projectId,
        name: scheduledJobs.name,
        updatedAt: scheduledJobs.updatedAt,
        heartbeatAt: scheduledJobs.heartbeatAt
      }).from(scheduledJobs).where(and(
        inArray(scheduledJobs.projectId, projectIds),
        eq(scheduledJobs.status, 'unhealthy')
      )).orderBy(desc(scheduledJobs.updatedAt), scheduledJobs.id)
    ]);
    const issueBindings = new Map(bindings.map((binding) => [
      binding.entityId,
      {
        externalUrl: externalUrl(binding.metadata),
        state: issueState(binding.metadata),
        hasProjectStatus: hasProjectStatus(binding.metadata)
      }
    ]));
    const activeItems: WorkItemRow[] = items.flatMap((item) => {
      const binding = issueBindings.get(item.id);
      return binding?.state === 'closed' && !binding.hasProjectStatus ? [] : [{
        ...item,
        externalUrl: binding?.externalUrl ?? null
      }];
    });
    const itemById = new Map(activeItems.map((item) => [item.id, item]));
    const auditWorkItemIds = [...new Set([
      ...signals.flatMap((signal) => signal.workItemId === null ? [] : [signal.workItemId]),
      ...failedOutbox.flatMap((event) => {
        const workItemId = outboxWorkItemId(event.payload);
        return workItemId === null ? [] : [workItemId];
      })
    ])];
    const audits = auditWorkItemIds.length === 0 ? [] : await db.select({
      targetId: auditEvents.targetId,
      action: auditEvents.action,
      outcome: auditEvents.outcome,
      reasonCode: auditEvents.reasonCode,
      occurredAt: auditEvents.occurredAt
    }).from(auditEvents).where(and(
      inArray(auditEvents.targetId, auditWorkItemIds),
      inArray(auditEvents.projectId, projectIds),
      eq(auditEvents.targetType, 'work_item')
    )).orderBy(desc(auditEvents.occurredAt), auditEvents.id);
    const auditByWorkItem = new Map<string, typeof audits[number]>();
    for (const audit of audits) {
      if (audit.targetId !== null && !auditByWorkItem.has(audit.targetId)) {
        auditByWorkItem.set(audit.targetId, audit);
      }
    }
    const projectById = new Map(configuredProjects.map((project) => [project.id, project]));
    const auditEvidence = (workItemId: string | null, fallback: string): string => {
      if (workItemId === null) return fallback;
      const audit = auditByWorkItem.get(workItemId);
      if (audit === undefined) return fallback;
      const outcome = audit.outcome === null ? '' : ` ${audit.outcome}`;
      const reason = audit.reasonCode === null ? '' : ` (${audit.reasonCode})`;
      return `Audit: ${audit.action}${outcome}${reason}`;
    };
    const attention = rankAttentionQueue([
      ...signals.flatMap((signal): AttentionQueueItem[] => {
        const project = projectById.get(signal.projectId);
        if (project === undefined) return [];
        const item = signal.workItemId === null ? undefined : itemById.get(signal.workItemId);
        return [{
          id: `risk:${signal.id}`,
          projectId: signal.projectId,
          severity: signal.severity,
          project: project.name,
          object: signal.workItemTitle ?? 'Project risk signal',
          reason: signal.summary,
          impact: signal.workItemId === null ? 'Unresolved project risk' : 'Unresolved risk on linked work item',
          freshness: signal.updatedAt,
          owner: signal.owner,
          evidence: auditEvidence(signal.workItemId, `RiskSignal: ${signal.code}`),
          action: item?.externalUrl === null || item === undefined
            ? {label: 'Review signal', href: null}
            : {label: 'Open issue', href: item.externalUrl}
        }];
      }),
      ...failedOutbox.flatMap((event): AttentionQueueItem[] => {
        if (event.projectId === null) return [];
        const project = projectById.get(event.projectId);
        if (project === undefined) return [];
        const workItemId = outboxWorkItemId(event.payload);
        const item = workItemId === null ? undefined : itemById.get(workItemId);
        return [{
          id: `outbox:${event.id}`,
          projectId: event.projectId,
          severity: 'red',
          project: project.name,
          object: item?.title ?? 'GitHub project status write',
          reason: event.failureCode ?? 'GitHub status write failed',
          impact: 'Canonical status is not confirmed in GitHub',
          freshness: event.updatedAt,
          owner: null,
          evidence: auditEvidence(workItemId, `Outbox: failed after ${event.attemptCount} attempts`),
          action: item?.externalUrl === null || item === undefined
            ? {label: 'Inspect write', href: null}
            : {label: 'Open issue', href: item.externalUrl}
        }];
      }),
      ...unhealthyJobs.flatMap((job): AttentionQueueItem[] => {
        if (job.projectId === null) return [];
        const project = projectById.get(job.projectId);
        if (project === undefined) return [];
        return [{
          id: `job:${job.id}`,
          projectId: job.projectId,
          severity: 'red',
          project: project.name,
          object: job.name,
          reason: 'Scheduled job is unhealthy',
          impact: 'Scheduled recovery is not in a healthy state',
          freshness: job.heartbeatAt ?? job.updatedAt,
          owner: null,
          evidence: 'ScheduledJob: unhealthy',
          action: {label: 'Inspect job', href: null}
        }];
      })
    ]);

    return configuredProjects.map((project) => ({
      ...project,
      health: snapshots.find((snapshot) => snapshot.projectId === project.id)?.health ?? 'unknown',
      snapshotCapturedAt: operations.find(
        (operation) => operation.projectId === project.id
      )?.createdAt ?? null,
      items: activeItems.filter((item) => item.projectId === project.id),
      attention: attention.filter((item) => item.projectId === project.id)
    }));
  } finally {
    await pool.end();
  }
}

export default async function ProjectControlPanel() {
  const projectData = await loadProjects();
  const navigation = [
    'Portfolio',
    'Project Control Panel',
    'Runs & Approvals',
    'Access & Policies',
    'Health & Audit'
  ];

  return (
    <main className="shell">
      <aside className="sidebar">
        <p className="product-name">f(AI) Studio</p>
        <nav aria-label="Control plane">
          {navigation.map((item) => (
            <span className={item === 'Portfolio' ? 'nav-item active' : 'nav-item'} key={item}>
              {item}
            </span>
          ))}
        </nav>
      </aside>
      <section className="content">
        <header className="page-header">
          <div>
            <p className="eyebrow">Workspace overview</p>
            <h1>Portfolio</h1>
          </div>
          <p className="source">PostgreSQL canonical state</p>
        </header>
        {projectData === null ? (
          <section className="empty-state">
            <h2>Database is not configured</h2>
            <p>Set <code>DATABASE_URL</code> to load the operational workspace.</p>
          </section>
        ) : projectData.length === 0 ? (
          <section className="empty-state">
            <h2>No configured projects</h2>
            <p>Run the control-plane seed, then bootstrap tracker snapshots to populate active work.</p>
          </section>
        ) : (
          <ControlSurface projects={projectData} />
        )}
      </section>
    </main>
  );
}

function ControlSurface({projects: projectData}: {
  projects: NonNullable<Awaited<ReturnType<typeof loadProjects>>>;
}) {
  const activeItems = projectData.flatMap((project) => project.items.map((item) => ({
    ...item,
    project: project.name
  }))).sort((left, right) => {
    if (left.blocked !== right.blocked) return left.blocked ? -1 : 1;
    return urgency.indexOf(left.status) - urgency.indexOf(right.status);
  });
  const attention = rankAttentionQueue(projectData.flatMap((project) => project.attention));
  const grouped = statuses.map((status) => ({
    status,
    items: activeItems.filter((item) => item.status === status)
  })).filter((group) => group.items.length > 0);

  return (
    <div className="control-surface">
      <section className="attention" aria-labelledby="attention-title">
        <header><p className="eyebrow">Attention queue</p><h2 id="attention-title">{attention.length} exceptions</h2></header>
        {attention.length === 0 ? <p>No unresolved exceptions in selected canonical scope.</p> : attention.map((item) => (
          <article className="attention-row" key={item.id}>
            <span className={`severity ${item.severity}`}>{severityLabel(item.severity)}</span>
            <div className="attention-subject"><strong>{item.object}</strong><span>{item.project}</span></div>
            <div className="attention-detail"><strong>{item.reason}</strong><span>{item.evidence}</span></div>
            <div className="attention-detail"><span>{item.impact}</span><time dateTime={item.freshness.toISOString()}>{freshnessLabel(item.freshness)}</time></div>
            <span>{item.owner ?? 'Unassigned'}</span>
            {item.action.href === null ? <span className="attention-action">{item.action.label}</span> : (
              <a className="attention-action" href={item.action.href} rel="noreferrer" target="_blank">{item.action.label}</a>
            )}
          </article>
        ))}
      </section>

      <section className="signals" aria-labelledby="signals-title">
        <header><p className="eyebrow">Project signals</p><h2 id="signals-title">Configured scope</h2></header>
        <div className="signal-table">
          {projectData.map((project) => (
            <div className="signal-row" key={project.id}>
              <strong>{project.name}</strong>
              <span className={`health ${project.health}`}>Health: {project.health}</span>
              <span>{syncLabel(project.snapshotCapturedAt)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="ledger" aria-labelledby="ledger-title">
        <header><p className="eyebrow">Active work</p><h2 id="ledger-title">{activeItems.length} open</h2></header>
        {grouped.length === 0 ? <p className="no-work">No active work items in canonical state.</p> : grouped.map((group) => (
          <section className="status-group" key={group.status}>
            <h3>{statusLabel(group.status)} <span>{group.items.length}</span></h3>
            <div className="work-list">
              {group.items.map((item) => (
                <article className="work-row" key={item.id}>
                  <div><strong>{item.title}</strong><span className="project-tag">{item.project}</span></div>
                  <span className="status">{statusLabel(item.status)}</span>
                  <span className={item.blocked ? 'blocked yes' : 'blocked'}>{item.blocked ? 'Blocked' : 'Clear'}</span>
                  {item.externalUrl === null ? <span className="no-link">No link</span> : (
                    <a href={item.externalUrl} rel="noreferrer" target="_blank">Open</a>
                  )}
                </article>
              ))}
            </div>
          </section>
        ))}
      </section>
    </div>
  );
}
