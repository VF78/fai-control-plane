import {and, desc, eq, inArray, isNull} from 'drizzle-orm';
import {
  createDatabase,
  dashboardSnapshots,
  projects,
  trackerBindings,
  trackerSnapshotOperations,
  workItems
} from '@fai-control-plane/db';

export const dynamic = 'force-dynamic';

const statuses = ['backlog', 'ready', 'in_dev', 'qa', 'acceptance'] as const;
const urgency = ['in_dev', 'qa', 'acceptance', 'ready', 'backlog'];
const statusLabel = (status: string) => status.replace('_', ' ');
const syncLabel = (value: Date | null) => value === null
  ? 'Never synced'
  : `Synced ${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

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
    const [items, bindings, snapshots, operations] = await Promise.all([
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
        .orderBy(desc(trackerSnapshotOperations.createdAt))
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

    return configuredProjects.map((project) => ({
      ...project,
      health: snapshots.find((snapshot) => snapshot.projectId === project.id)?.health ?? 'unknown',
      snapshotCapturedAt: operations.find(
        (operation) => operation.projectId === project.id
      )?.createdAt ?? null,
      items: activeItems.filter((item) => item.projectId === project.id)
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
            <span className={item === 'Project Control Panel' ? 'nav-item active' : 'nav-item'} key={item}>
              {item}
            </span>
          ))}
        </nav>
      </aside>
      <section className="content">
        <header className="page-header">
          <div>
            <p className="eyebrow">Workspace overview</p>
            <h1>Project Control Panel</h1>
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
  const attention = activeItems.filter((item) => item.blocked);
  const grouped = statuses.map((status) => ({
    status,
    items: activeItems.filter((item) => item.status === status)
  })).filter((group) => group.items.length > 0);

  return (
    <div className="control-surface">
      <section className="attention" aria-labelledby="attention-title">
        <header><p className="eyebrow">Attention</p><h2 id="attention-title">{attention.length} blocked</h2></header>
        {attention.length === 0 ? <p>No blocked active work in canonical state.</p> : attention.map((item) => (
          <article className="attention-row" key={item.id}>
            <strong>{item.title}</strong><span>{item.project}</span><span>{statusLabel(item.status)}</span>
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
