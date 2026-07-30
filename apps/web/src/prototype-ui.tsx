import Link from 'next/link';
import type {CSSProperties, ReactNode} from 'react';
import {
  AlertTriangle, Bot, ChevronLeft, ChevronRight, CircleDot, ClipboardList, FileCheck2, History,
  FolderKanban, GitPullRequest, LayoutDashboard, Link2, ListChecks,
  ExternalLink, ServerCog, ShieldAlert, ShieldCheck, UsersRound, Workflow
} from 'lucide-react';
import {DeliveryJourneyAction, DeliveryProtocolEditor} from './delivery-controls';
import {type OperatorScreenRef, type OperatorScopeRef} from '@fai/operator-contracts';
import {operatorTokens} from '@fai/operator-tokens';
import type {
  AccessData, HealthData, OperatorLoad, OperatorProjectSlug, PortfolioData,
  ConversationsData, DeliveryLifecycleData, ProjectData, RunsData
} from './operator-data';
import {RiskDispositionControls} from './risk-disposition-controls';
import {ProjectShareControls} from './project-share-controls';
import {RuntimeRegistrationControls} from './runtime-registration-controls';
import {AgentRetirementControls} from './agent-retirement-controls';

export type WorkspaceRoute = Readonly<{
  screen: 'dashboard' | 'projects' | 'global_tasks' | 'global_chats' | 'people' | 'overview' | 'tasks' | 'task' | 'protocol' | 'runs' | 'run' | 'chats' | 'access' | 'agents' | 'agent';
  project: OperatorProjectSlug | null;
  globalProject?: 'all' | OperatorProjectSlug;
  taskId: string | null;
  runId: string | null;
  agentId: string | null;
  accessActorId?: string | null;
  scope: OperatorScopeRef;
}>;

export type WorkspaceData = Readonly<{
  portfolio: OperatorLoad<PortfolioData>;
  project: OperatorLoad<ProjectData | null> | null;
  runs: OperatorLoad<RunsData> | null;
  access: OperatorLoad<AccessData>;
  health: OperatorLoad<HealthData> | null;
  projectIndex: readonly ProjectData[];
  lifecycle?: OperatorLoad<DeliveryLifecycleData | null> | null;
  conversations?: OperatorLoad<ConversationsData> | null;
  csrfToken?: string | null;
}>;

// Keep the internal component annotations small while public route contracts use WorkspaceRoute.
type PrototypeRoute = WorkspaceRoute;

const projectTabs = ['overview', 'tasks', 'protocol', 'runs', 'chats', 'access'] as const;
const labels: Record<(typeof projectTabs)[number], string> = {
  overview: 'Overview', tasks: 'Tasks', protocol: 'Protocol', runs: 'Runs', chats: 'Conversations', access: 'Access'
};

const ready = <T,>(load: OperatorLoad<T> | null): T | null => load?.state === 'ready' ? load.data : null;
const date = (value: Date | null | undefined) => value === null || value === undefined ? 'Not observed' : new Intl.DateTimeFormat('en', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}).format(value);
const compactDate = (value: Date | null | undefined) => value === null || value === undefined ? 'Not observed' : new Intl.DateTimeFormat('en', {month: 'short', day: 'numeric'}).format(value);
const scopeQuery = (scope: OperatorScopeRef) => {
  const query = new URLSearchParams();
  if (scope.environment !== null) query.set('environment', scope.environment);
  if (scope.from !== null) query.set('from', scope.from);
  if (scope.to !== null) query.set('to', scope.to);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
};
const screenUrl = (screen: OperatorScreenRef, scope: OperatorScopeRef): string => {
  const path = screen.kind === 'dashboard' ? '/dashboard'
    : screen.kind === 'projects' ? '/projects'
    : screen.kind === 'tasks' ? `/tasks?project=${screen.project}`
    : screen.kind === 'chats' ? `/chats?project=${screen.project}`
    : screen.kind === 'project' ? `/projects/${screen.projectSlug}/${screen.section}`
    : screen.kind === 'task' ? `/projects/${screen.projectSlug}/tasks/${screen.taskId}`
    : screen.kind === 'run' ? `/projects/${screen.projectSlug}/runs/${screen.runId}`
    : screen.kind === 'agents' ? '/agents' : `/agents/${screen.agentId}`;
  const query = scopeQuery(scope);
  return query === '' ? path : `${path}${path.includes('?') ? '&' : '?'}${query.slice(1)}`;
};
const projectUrl = (slug: OperatorProjectSlug, tab: (typeof projectTabs)[number], scope: OperatorScopeRef) => screenUrl({kind: 'project', projectSlug: slug, section: tab}, scope);
const taskUrl = (slug: OperatorProjectSlug, id: string, scope: OperatorScopeRef) => screenUrl({kind: 'task', projectSlug: slug, taskId: id}, scope);
const runUrl = (slug: OperatorProjectSlug, id: string, scope: OperatorScopeRef) => screenUrl({kind: 'run', projectSlug: slug, runId: id}, scope);
const peopleUrl = (scope: OperatorScopeRef) => `/people${scopeQuery(scope)}`;
const statusTone = (value: string) => value === 'failed' || value === 'blocked' || value === 'red' || value === 'stale' ? 'danger' : value === 'waiting_approval' || value === 'yellow' ? 'warning' : value === 'done' || value === 'green' || value === 'healthy' || value === 'enabled' ? 'success' : 'neutral';
const statusLabel = (value: string) => ({green: 'On track', yellow: 'Watch', red: 'At risk', done: 'Completed', in_dev: 'In development', backlog: 'Backlog', ready: 'Ready', qa: 'Quality assurance', acceptance: 'Acceptance', running: 'Running', queued: 'Queued', waiting_approval: 'Waiting for approval', failed: 'Failed', blocked: 'Blocked', pending: 'Pending', approved: 'Approved', rejected: 'Rejected', expired: 'Expired', healthy: 'Healthy', stale: 'Stale', enabled: 'Enabled', disabled: 'Disabled', unknown: 'Unknown'}[value] ?? 'Unknown');

const fleetHealth = (profiles: AccessData['agentSystems'][number]['profiles']) => {
  const values = profiles.map((profile) => profile.fleet.health);
  if (values.length === 0) return 'unknown';
  if (values.includes('stale')) return 'stale';
  if (values.includes('healthy')) return 'healthy';
  if (values.includes('unknown')) return 'unknown';
  return 'disabled';
};
const replacementTargets = (
  access: AccessData,
  sourceActorId: string,
  sourceProfileId: string,
  projectId: string
) => access.agentSystems.flatMap((system) => {
  const actor = access.actors.find((item) => item.id === system.actorId);
  const membership = access.memberships?.find((item) =>
    item.projectId === projectId &&
    item.actorId === system.actorId &&
    item.role === 'agent' &&
    item.active);
  if (
    system.actorId === sourceActorId ||
    actor === undefined ||
    actor.disabledAt !== null ||
    membership === undefined
  ) return [];
  return system.profiles.flatMap((profile) =>
    profile.id === sourceProfileId || !profile.enabled
      ? []
      : profile.registrations.flatMap((registration) =>
          registration.projectId !== projectId ||
          registration.enabled ||
          !registration.canManage
            ? []
            : [{
                id: registration.id,
                version: registration.version,
                label: `${actor.displayName} · ${profile.runtimeId}/${profile.runtimeProfile}`
              }]));
});

function Status({value}: {value: string}) {
  return <span className={`fcp-status ${statusTone(value)}`}><CircleDot aria-hidden="true" size={14}/>{statusLabel(value)}</span>;
}
function Blank({title, children}: {title: string; children: ReactNode}) {
  return <section className="fcp-blank"><AlertTriangle aria-hidden="true" size={18}/><div><h2>{title}</h2><p>{children}</p></div></section>;
}
function DeferredAction({label, detail}: {label: string; detail: string}) {
  const hintId = `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-deferred`;
  return <div className="fcp-deferred-action"><button aria-describedby={hintId} disabled type="button">{label}</button><small id={hintId}>Deferred — {detail}</small></div>;
}
function Scope({route}: {route: PrototypeRoute}) {
  const scope = route.scope;
  const selectedProject = route.globalProject ?? (route.project === null ? 'all' : null);
  return <div className="fcp-scope" aria-label="Current scope">{selectedProject === null ? null : <span>Project: {selectedProject === 'all' ? 'All projects' : selectedProject.toUpperCase()}</span>}<span>Environment: {scope.environment ?? 'Not configured'}</span><span>Time: {scope.from ?? scope.to ? 'Custom range' : 'All time'}</span></div>;
}
function Header({route}: {route: PrototypeRoute}) {
  const nav = [
    {label: 'Portfolio', icon: LayoutDashboard, href: screenUrl({kind: 'dashboard'}, route.scope), active: route.screen === 'dashboard'},
    {label: 'Delivery', icon: FolderKanban, href: screenUrl({kind: 'projects'}, route.scope), active: route.project !== null || route.screen === 'projects' || route.screen === 'global_tasks'},
    {label: 'Conversations', icon: UsersRound, href: screenUrl({kind: 'chats', project: 'all'}, route.scope), active: route.screen === 'global_chats' || route.screen === 'chats'},
    {label: 'People & Access', icon: ShieldCheck, href: peopleUrl(route.scope), active: route.screen === 'people' || route.screen === 'access'},
    {label: 'Agents & Systems', icon: Bot, href: screenUrl({kind: 'agents'}, route.scope), active: route.screen === 'agents' || route.screen === 'agent'}
  ];
  return <header className="fcp-global"><Link href={screenUrl({kind: 'dashboard'}, route.scope)} className="fcp-brand">f(AI)<span>Control</span></Link><nav className="fcp-global-nav" aria-label="Primary workspace areas">{nav.map(({label, icon: Icon, href, active}) => <Link aria-label={label} href={href} key={label} aria-current={active ? 'page' : undefined}><Icon aria-hidden="true" size={16}/><span>{label}</span></Link>)}</nav></header>;
}
function Crumbs({route, project, title}: {route: PrototypeRoute; project: ProjectData | null; title?: string}) {
  return <div className="fcp-crumbs"><span>Workspace</span><ChevronRight aria-hidden="true" size={14}/><Link href={screenUrl({kind: 'projects'}, route.scope)}>Projects</Link>{project === null ? null : <><ChevronRight aria-hidden="true" size={14}/><Link href={projectUrl(project.project.slug, 'overview', route.scope)}>{project.project.name}</Link></>}{title === undefined ? null : <><ChevronRight aria-hidden="true" size={14}/><strong>{title}</strong></>}</div>;
}
function ProjectTabs({route, project}: {route: PrototypeRoute; project: ProjectData}) {
  const active = route.screen === 'task' ? 'tasks' : route.screen === 'run' ? 'runs' : route.screen as (typeof projectTabs)[number];
  return <nav className="fcp-tabs" aria-label={`${project.project.name} sections`}>{projectTabs.map((tab) => <Link href={projectUrl(project.project.slug, tab, route.scope)} key={tab} aria-current={active === tab ? 'page' : undefined}>{labels[tab]}{tab === 'tasks' ? <span>{project.workItems.length}</span> : null}</Link>)}</nav>;
}
function ProjectHeader({route, project, title}: {route: PrototypeRoute; project: ProjectData; title?: string}) {
  return <><Crumbs route={route} project={project} {...(title === undefined ? {} : {title})}/><div className="fcp-project-title"><div><h1>{title ?? project.project.name}</h1><span>Control plane fact {project.synchronizedAt === null ? 'not observed' : `observed ${date(project.synchronizedAt)}`}</span></div>{title === undefined ? <Status value={project.snapshot?.health ?? 'unknown'}/> : null}</div><ProjectTabs route={route} project={project}/></>;
}
function Summary({items}: {items: readonly Readonly<{label: string; value: string | number; tone?: string}>[]}) {
  return <dl className="fcp-summary">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd className={item.tone ?? ''}>{item.value}</dd></div>)}</dl>;
}
function AttentionRow({csrfToken, signal, route, projects}: {csrfToken: string | null; signal: PortfolioData['attention'][number]; route: PrototypeRoute; projects: PortfolioData['projects']}) {
  const project = projects.find((item) => item.id === signal.projectId);
  const href = project === undefined ? null : signal.workItemId === null
    ? projectUrl(project.slug, 'overview', route.scope)
    : taskUrl(project.slug, signal.workItemId, route.scope);
  const stage = signal.stage === null ? 'Unknown' : signal.stage.replaceAll('_', ' ');
  const provenance = signal.signalClass === null ? 'Unavailable' : signal.signalClass === 'fact' ? 'Fact' : 'Inference';
  const target = signal.workItemId === null ? 'Open project' : 'Open task';
  const nextAction = signal.nextAction === null ? 'Unavailable' : signal.nextAction.replaceAll('_', ' ');
  return <article className="fcp-attention" key={signal.id}><header><Status value={signal.severity}/><div><strong>{signal.object}</strong><small>{signal.project} · {signal.reason}</small></div>{href === null ? <span className="fcp-muted">Target unavailable</span> : <Link className="fcp-attention-open" href={href} aria-label={`${target}: ${signal.object}`}>{target}<ChevronRight aria-hidden="true" size={16}/></Link>}</header><dl className="fcp-attention-facts"><div><dt>Delivery stage</dt><dd>{stage}</dd></div><div><dt>Owner</dt><dd>{signal.owner ?? 'Unknown'}</dd></div><div><dt>Observed</dt><dd>{date(signal.freshness)}</dd></div><div><dt>Class</dt><dd>{provenance}</dd></div></dl><div className="fcp-attention-next"><span>Next action</span><strong>{nextAction}</strong></div>{signal.riskSignalId == null ? null : <RiskDispositionControls csrfToken={csrfToken} disposition={signal.disposition == null ? null : {...signal.disposition, expiresAt: signal.disposition.expiresAt.toISOString()}} expectedVersion={signal.dispositionVersion ?? 0} projectId={signal.projectId} riskSignalId={signal.riskSignalId}/>}<details className="fcp-attention-details"><summary><FileCheck2 aria-hidden="true" size={15}/>Evidence &amp; impact</summary><div><p><strong>Impact</strong><span>{signal.impact ?? 'Unavailable'}</span></p><p><strong>Evidence</strong><span>{signal.evidenceReferences.length === 0 ? 'Unavailable' : signal.evidenceReferences.map((reference) => `${reference.type}: ${reference.id}`).join(' · ')}</span></p>{signal.sourceUrl === null ? null : <a href={signal.sourceUrl} target="_blank" rel="noreferrer">Open provider source</a>}</div></details></article>;
}
function age(value: Date | null, asOf = new Date()): string {
  if (value === null) return 'Not observed';
  const hours = Math.max(0, Math.floor((asOf.getTime() - value.getTime()) / 3_600_000));
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
function PortfolioMetrics({project, route}: {project: PortfolioData['projects'][number]; route: PrototypeRoute}) {
  const metrics = project.metrics;
  const outlook = metrics.milestoneOutlook.state === 'unknown'
    ? 'Unknown — no dated fact'
    : metrics.milestoneOutlook.overdue > 0
      ? `${metrics.milestoneOutlook.overdue} overdue · ${metrics.milestoneOutlook.due} upcoming`
      : `${metrics.milestoneOutlook.due} upcoming`;
  const throughput = metrics.throughputTrend.state === 'ready'
    ? `${metrics.throughputTrend.recent} vs ${metrics.throughputTrend.previous} completed`
    : 'Not enough history';
  const cycle = metrics.cycleTime.state === 'ready'
    ? `${metrics.cycleTime.averageHours! < 24 ? `${metrics.cycleTime.averageHours}h` : `${Math.round(metrics.cycleTime.averageHours! / 24)}d`} average`
    : 'Not enough history';
  return <article className="fcp-portfolio-metrics"><header><div><FolderKanban aria-hidden="true" size={17}/><Link href={projectUrl(project.slug, 'overview', route.scope)}>{project.name}</Link></div><Status value={project.health}/></header><div className="fcp-metric-core"><div><span>Active WIP</span><strong>{metrics.activeWip}</strong></div><div className={metrics.blockedWork > 0 ? 'danger' : ''}><span>Blocked</span><strong>{metrics.blockedWork}</strong></div><div className={metrics.staleActiveWork > 0 ? 'warning' : ''}><span>Stale active</span><strong>{metrics.staleActiveWork}</strong></div><div><span>Pending approval</span><strong>{metrics.pendingApprovals.count}</strong><small>{metrics.pendingApprovals.count === 0 ? 'None pending' : `Oldest ${age(metrics.pendingApprovals.oldestAt)}`}</small></div></div><ol className="fcp-portfolio-stages" aria-label={`${project.name} work items by delivery stage`}>{Object.entries(metrics.stages).map(([stage, count]) => <li key={stage}><span>{stage === 'in_dev' ? 'In dev' : stage === 'qa' ? 'QA' : stage === 'done' ? 'Done' : statusLabel(stage)}</span><strong>{count}</strong></li>)}</ol><dl className="fcp-portfolio-facts"><div><dt>Integration</dt><dd>{metrics.integrationFreshness === null ? 'Not observed' : `Observed ${compactDate(metrics.integrationFreshness)}`}</dd></div><div><dt>Deadline outlook</dt><dd>{outlook}</dd></div><div><dt>Throughput</dt><dd>{throughput}</dd></div><div><dt>Cycle time</dt><dd>{cycle}</dd></div></dl></article>;
}
function Dashboard({route, data}: {route: WorkspaceRoute; data: WorkspaceData}) {
  const portfolio = ready(data.portfolio);
  const allRuns = ready(data.runs);
  if (portfolio === null) return <Blank title="Control plane data is unavailable">Connect the configured PostgreSQL source to view portfolio facts.</Blank>;
  const failed = allRuns?.runs.filter((run) => run.status === 'failed').length;
  const active = allRuns?.runs.filter((run) => run.status === 'running').length;
  return <><div className="fcp-page-title"><div><h1>Dashboard</h1><p>Delivery attention across configured projects.</p></div><Scope route={route}/></div><Summary items={[
    {label: 'Projects', value: portfolio.projects.length}, {label: 'Attention', value: portfolio.attention.length, tone: portfolio.attention.length > 0 ? 'danger' : ''},
    ...(active === undefined ? [] : [{label: 'Active runs', value: active}]), ...(failed === undefined ? [] : [{label: 'Failed runs', value: failed, tone: failed > 0 ? 'danger' : ''}])
  ]}/><section className="fcp-section"><div className="fcp-section-head"><h2>Portfolio</h2><span>Observed facts</span></div><div className="fcp-portfolio-grid">{portfolio.projects.map((project) => <PortfolioMetrics project={project} route={route} key={project.id}/>)}</div></section><section className="fcp-section"><div className="fcp-section-head"><h2>Attention</h2><span>Persisted signals only</span></div>{portfolio.attention.length === 0 ? <p className="fcp-empty-line">No recorded alerts.</p> : <div className="fcp-list">{portfolio.attention.map((signal) => <AttentionRow csrfToken={data.csrfToken ?? null} signal={signal} route={route} projects={portfolio.projects} key={signal.id}/>)}</div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Projects</h2><Link href={screenUrl({kind: 'projects'}, route.scope)}>View all</Link></div><div className="fcp-list fcp-project-list">{portfolio.projects.map((project) => <Link className="fcp-row fcp-project-row" href={projectUrl(project.slug, 'overview', route.scope)} key={project.id}><FolderKanban aria-hidden="true" size={18}/><div><strong>{project.name}</strong><small>{project.unresolvedRiskCount === 0 ? 'No recorded risks' : `${project.unresolvedRiskCount} recorded risks`}</small></div><Status value={project.health}/><span>{project.synchronizedAt === null ? 'Source not observed' : `Observed ${date(project.synchronizedAt)}`}</span><ChevronRight aria-hidden="true" size={16}/></Link>)}</div></section></>;
}
function Projects({route, data}: {route: WorkspaceRoute; data: WorkspaceData}) {
  const portfolio = ready(data.portfolio);
  if (portfolio === null) return <Blank title="Projects are unavailable">The PostgreSQL portfolio read model is not available.</Blank>;
  return <><div className="fcp-page-title"><div><Crumbs route={route} project={null}/><h1>Projects</h1><p>Configured delivery workspaces.</p></div><Scope route={route}/></div><div className="fcp-list fcp-project-list">{portfolio.projects.map((project) => <Link className="fcp-row fcp-project-row" href={projectUrl(project.slug, 'overview', route.scope)} key={project.id}><FolderKanban aria-hidden="true" size={18}/><div><strong>{project.name}</strong><small>{project.unresolvedRiskCount === 0 ? 'No recorded attention' : `${project.unresolvedRiskCount} attention signals`}</small></div><Status value={project.health}/><span>{project.synchronizedAt === null ? 'Not observed' : `Observed ${date(project.synchronizedAt)}`}</span><ChevronRight aria-hidden="true" size={16}/></Link>)}</div></>;
}
function StageStrip({items, current}: {items: readonly string[]; current: string | null}) {
  return <ol className="fcp-stages" aria-label="Task lifecycle">{items.map((item) => <li className={item === current ? 'current' : ''} key={item}><span aria-hidden="true"/>{statusLabel(item)}</li>)}</ol>;
}
function Overview({route, project, runs}: {route: PrototypeRoute; project: ProjectData; runs: RunsData | null}) {
  const counts = project.workItems.reduce<Record<string, number>>((result, item) => ({...result, [item.status]: (result[item.status] ?? 0) + 1}), {});
  const current = project.workItems.find((item) => item.status !== 'done')?.status ?? null;
  return <><ProjectHeader route={route} project={project}/><Summary items={Object.entries(counts).slice(0, 4).map(([label, value]) => ({label: statusLabel(label), value}))}/><section className="fcp-section"><div className="fcp-section-head"><h2>Task lifecycle</h2><span>{current === null ? 'No active task' : `Current task: ${statusLabel(current)}`}</span></div><StageStrip items={['backlog', 'ready', 'in_dev', 'qa', 'acceptance', 'done']} current={current}/></section><section className="fcp-section"><div className="fcp-section-head"><h2>Current work</h2><Link href={projectUrl(project.project.slug, 'tasks', route.scope)}>View tasks</Link></div>{project.workItems.length === 0 ? <p className="fcp-empty-line">No tasks observed.</p> : <div className="fcp-list">{project.workItems.slice(0, 5).map((task) => <TaskRow project={project.project.slug} route={route} task={task} key={task.id}/>)}</div>}</section>{runs === null ? null : <section className="fcp-section"><div className="fcp-section-head"><h2>Recent runs</h2><Link href={projectUrl(project.project.slug, 'runs', route.scope)}>View runs</Link></div>{runs.runs.length === 0 ? <p className="fcp-empty-line">No runs observed.</p> : <div className="fcp-list">{runs.runs.slice(0, 4).map((run) => <RunRow project={project.project.slug} route={route} run={run} key={run.id}/>)}</div>}</section>}</>;
}
function TaskRow({project, route, task}: {project: OperatorProjectSlug; route: PrototypeRoute; task: ProjectData['workItems'][number]}) {
  return <Link className="fcp-row fcp-task-row" href={taskUrl(project, task.id, route.scope)}><Status value={task.blocked ? 'blocked' : task.status}/><div><strong>{task.title}</strong><small>{task.owner ?? 'Responsible person unknown'}</small></div><span>{task.handoff?.label ?? 'Next action unknown'}</span><time>{date(task.updatedAt)}</time><ChevronRight aria-hidden="true" size={16}/></Link>;
}
function Tasks({route, project}: {route: PrototypeRoute; project: ProjectData}) {
  return <><ProjectHeader route={route} project={project}/><div className="fcp-section-head fcp-page-actions"><span>Provider-synchronized work items</span><DeferredAction label="New task" detail="task creation is not configured in this workspace."/></div><div className="fcp-list">{project.workItems.length === 0 ? <p className="fcp-empty-line">No tasks observed.</p> : project.workItems.map((task) => <TaskRow project={project.project.slug} route={route} task={task} key={task.id}/>)}</div></>;
}
function DetailFacts({items}: {items: readonly Readonly<{label: string; value: string}>[]}) {
  return <dl className="fcp-details">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}
function DeliveryLifecycleRail({lifecycleLoad, task}: {lifecycleLoad: OperatorLoad<DeliveryLifecycleData | null> | null; task: ProjectData['workItems'][number]}) {
  const lifecycle = lifecycleLoad?.state === 'ready' ? lifecycleLoad.data : null;
  const loadState = lifecycleLoad === null || lifecycleLoad.state === 'unconfigured'
    ? 'Not configured'
    : lifecycleLoad.state === 'unavailable'
      ? 'Unavailable'
      : lifecycle === null ? 'Not observed' : null;
  const missing = loadState ?? 'Not observed';
  const missingDetail = loadState === 'Unavailable' ? 'PostgreSQL read unavailable'
    : loadState === 'Not configured' ? 'PostgreSQL source not configured'
      : 'No record observed';
  const packet = lifecycle?.packet;
  const approval = lifecycle?.approval;
  const run = lifecycle?.run;
  const receiptEvidence = lifecycle === null ? missing : lifecycle.receipt === null
    ? lifecycle.artifactCount === 0 && lifecycle.journeyEvidenceCount === 0 ? 'Not observed' : `${lifecycle.artifactCount} artifacts · ${lifecycle.journeyEvidenceCount} evidence`
    : `${statusLabel(lifecycle.receipt.terminal)} · ${lifecycle.artifactCount} artifacts · ${lifecycle.journeyEvidenceCount} evidence`;
  const writeBack = lifecycle?.writeBack;
  const auditDetail = lifecycle?.audit === null || lifecycle?.audit === undefined ? null : `Audit ${lifecycle.audit.action} · ${lifecycle.audit.outcome}`;
  const steps = [
    {label: 'Event / task', icon: CircleDot, value: statusLabel(task.blocked ? 'blocked' : task.status), detail: `Observed ${date(task.updatedAt)}`},
    {label: 'Immutable packet', icon: ClipboardList, value: packet === null || packet === undefined ? missing : 'Recorded', detail: packet === null || packet === undefined ? missingDetail : `Hash ${packet.contentHash.slice(0, 12)} · ${date(packet.createdAt)}`},
    {label: 'Policy / approval', icon: ShieldCheck, value: approval === null || approval === undefined ? missing : statusLabel(approval.status), detail: approval === null || approval === undefined ? missingDetail : `Policy v${approval.policyVersion} · ${approval.environment}`},
    {label: 'Execution / run', icon: Bot, value: run === null || run === undefined ? missing : statusLabel(run.status), detail: run === null || run === undefined ? missingDetail : `Observed ${date(run.completedAt ?? run.startedAt ?? run.createdAt)}`},
    {label: 'Receipt / evidence', icon: FileCheck2, value: receiptEvidence, detail: lifecycle?.receipt === null || lifecycle?.receipt === undefined ? missingDetail : `Receipt ${date(lifecycle.receipt.completedAt)}`},
    {label: 'Write-back / next', icon: Link2, value: writeBack === null || writeBack === undefined ? missing : `${writeBack.destination} · ${writeBack.status}`, detail: [writeBack === null || writeBack === undefined ? (loadState === null ? (task.handoff?.label ?? 'Next action unknown') : missingDetail) : `${writeBack.eventType} · ${date(writeBack.updatedAt)}`, auditDetail].filter((entry): entry is string => entry !== null).join(' · ')}
  ];
  return <ol className="fcp-delivery-lifecycle" aria-label="Delivery lifecycle">
    {steps.map(({label, icon: Icon, value, detail}) => <li key={label} aria-label={`${label}: ${value}. ${detail}`}><Icon aria-hidden="true" size={16}/><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></li>)}
  </ol>;
}
function TaskDetail({route, project, runs, lifecycleLoad, csrfToken}: {route: PrototypeRoute; project: ProjectData; runs: RunsData | null; lifecycleLoad: OperatorLoad<DeliveryLifecycleData | null> | null; csrfToken: string | null}) {
  const task = project.workItems.find((item) => item.id === route.taskId) ?? null;
  if (task === null) return <><ProjectHeader route={route} project={project} title="Task"/><Blank title="Task not observed">This task is not available in the selected project.</Blank></>;
  const run = task.handoff?.kind === 'run' ? runs?.runs.find((item) => item.id === task.handoff?.targetId) ?? null : null;
  const approval = runs?.approvals.find((item) => item.workItemId === task.id || item.agentRunId === run?.id) ?? null;
  const journey = task.journey ?? null;
  const stage = journey?.stage ?? null;
  const recordedEvidence = (journey?.evidence ?? []).map((entry) => ({
    ...entry,
    reference: `${entry.stageKey.replaceAll('_', ' ')} · ${entry.reference}`
  }));
  const nextRequiredEvidence = (journey?.requiredEvidence ?? []).filter((requirement) =>
    !recordedEvidence.some((entry) => entry.stageKey === journey?.stageKey && entry.requirement === requirement));
  return <><ProjectHeader route={route} project={project} title={task.title}/><div className="fcp-detail-layout"><main className="fcp-detail-main"><div className="fcp-detail-status"><Status value={task.blocked ? 'blocked' : task.status}/></div>{task.summary === null ? <p className="fcp-empty-line">Task summary not observed.</p> : <p className="fcp-task-summary">{task.summary}</p>}<section className="fcp-section"><div className="fcp-section-head"><h2>Delivery lifecycle</h2><span>PostgreSQL facts only</span></div><DeliveryLifecycleRail lifecycleLoad={lifecycleLoad} task={task}/></section><section className="fcp-section"><div className="fcp-section-head"><h2>Delivery protocol</h2><span>{journey === null ? 'Not configured' : `Protocol v${journey.protocolVersion}`}</span></div>{journey === null ? <p className="fcp-empty-line">Not configured. This legacy task is not bound to a delivery protocol.</p> : <div className="fcp-lifecycle-rail"><span aria-hidden="true"/><div><strong>{stage?.name ?? journey.stageKey}</strong><small>Task status: {statusLabel(stage?.taskStatus ?? task.status)} · {stage?.executionMode ?? 'Unknown mode'}</small></div><div><strong>Deadline</strong><small>{journey.deadlineAt === null ? 'Not set' : date(journey.deadlineAt)}</small></div><div><strong>Responsibility</strong><small>{stage?.actor === null || stage?.actor === undefined ? `${stage?.responsibility ?? 'Unknown'} · unresolved` : `${stage.actor.displayName} · ${stage.actor.type}`}</small></div><div><strong>Next allowed action</strong><small>{task.blocked ? 'Blocked: task is blocked' : stage?.nextStage === null || stage === null ? 'Blocked: journey complete or protocol context missing' : `Advance to ${stage.nextStage}`}</small></div></div>}<DeliveryJourneyAction workItemId={task.id} taskVersion={task.version ?? 0} journey={journey} activeProtocolId={project.protocol?.active === true ? project.protocol.id : null} csrfToken={csrfToken}/></section><section className="fcp-section"><div className="fcp-section-head"><h2>Run or packet handoff</h2><ListChecks aria-hidden="true" size={17}/></div><div className="fcp-command"><div><strong>{task.handoff?.label ?? 'Not observed'}</strong><p>{task.handoff === null ? 'No task packet or run handoff is recorded.' : `Observed ${task.handoff.kind} handoff.`}</p></div>{run === null ? null : <Link className="fcp-primary" href={runUrl(project.project.slug, run.id, route.scope)}>Open run receipt</Link>}</div></section><section className="fcp-section"><div className="fcp-section-head"><h2>Policy & approval</h2><ShieldCheck aria-hidden="true" size={17}/></div><p className="fcp-empty-line">{approval === null ? 'Not observed. Delivery does not create a #6 run or approval.' : `${statusLabel(approval.status)} · ${approval.environment}`}</p></section><section className="fcp-section"><div className="fcp-section-head"><h2>Evidence</h2><FileCheck2 aria-hidden="true" size={17}/></div>{journey === null ? <p className="fcp-empty-line">No protocol evidence requirements are configured.</p> : <div className="fcp-evidence-list">{recordedEvidence.length === 0 ? <p className="fcp-empty-line">No evidence references recorded for this stage.</p> : recordedEvidence.map((entry) => <p key={`${entry.requirement}:${entry.reference}`}><strong>{entry.requirement}</strong><span>{entry.reference}</span></p>)}{nextRequiredEvidence.length === 0 ? null : <p className="fcp-evidence-next"><strong>Next required</strong><span>{nextRequiredEvidence.join(', ')}</span></p>}</div>}</section></main><aside className="fcp-meta"><h2>Details</h2><DetailFacts items={[{label: 'Protocol', value: journey === null ? 'Not configured' : `v${journey.protocolVersion}`}, {label: 'Stage', value: stage?.name ?? 'Not configured'}, {label: 'Responsible human', value: stage?.actor?.type === 'human' ? stage.actor.displayName : task.owner ?? 'Unknown'}, {label: 'Responsible agent', value: stage?.actor?.type === 'agent' ? stage.actor.displayName : 'Unknown'}, {label: 'Approval', value: approval === null ? 'Not observed' : statusLabel(approval.status)}, {label: 'Deadline', value: journey?.deadlineAt === null || journey === null ? 'Not set' : date(journey.deadlineAt)}, {label: 'Source', value: task.externalUrl === null ? 'Not observed' : 'Provider observation'}, {label: 'Updated', value: date(task.updatedAt)}]}/>{task.externalUrl === null ? null : <a href={task.externalUrl} target="_blank" rel="noreferrer">Open provider source</a>}</aside></div></>;
}
function Protocol({route, project, csrfToken}: {route: PrototypeRoute; project: ProjectData; csrfToken: string | null}) {
  return <><ProjectHeader route={route} project={project}/><section className="fcp-section"><div className="fcp-section-head"><h2>Delivery protocol</h2><span>Active workflow</span></div><DeliveryProtocolEditor projectId={project.project.id} protocol={project.protocol ?? null} csrfToken={csrfToken}/></section></>;
}
function RunRow({project, route, run}: {project: OperatorProjectSlug; route: PrototypeRoute; run: RunsData['runs'][number]}) {
  return <Link className="fcp-row fcp-run-row" href={runUrl(project, run.id, route.scope)}><Status value={run.status}/><div><strong>{run.workItem ?? 'Task not observed'}</strong><small>{run.agent ?? 'Agent unknown'} · {run.runtimeProfile}</small></div><span>{run.receipt?.terminal ?? 'Receipt not observed'}</span><time>{date(run.completedAt ?? run.startedAt)}</time><ChevronRight aria-hidden="true" size={16}/></Link>;
}
function Runs({route, project, runs}: {route: PrototypeRoute; project: ProjectData; runs: RunsData | null}) {
  return <><ProjectHeader route={route} project={project}/>{runs === null ? <Blank title="Runs are unavailable">The canonical run read model could not be loaded.</Blank> : <div className="fcp-list">{runs.runs.length === 0 ? <p className="fcp-empty-line">No runs observed.</p> : runs.runs.map((run) => <RunRow project={project.project.slug} route={route} run={run} key={run.id}/>)}</div>}</>;
}
function RunDetail({route, project, runs}: {route: PrototypeRoute; project: ProjectData; runs: RunsData | null}) {
  const run = runs?.runs.find((item) => item.id === route.runId) ?? null;
  if (run === null) return <><ProjectHeader route={route} project={project} title="Run"/><Blank title="Run not observed">This run is not available in the selected project.</Blank></>;
  const approval = runs?.approvals.find((item) => item.agentRunId === run.id) ?? null;
  const events = [{label: 'Run observed', value: run.startedAt}, {label: 'Policy decision', value: approval?.decidedAt ?? null}, {label: 'Run outcome', value: run.completedAt}, {label: 'Receipt observed', value: run.receipt?.completedAt ?? null}];
  return <><ProjectHeader route={route} project={project} title={run.workItem ?? 'Run receipt'}/><div className="fcp-detail-layout"><main className="fcp-detail-main"><div className="fcp-detail-status"><Status value={run.status}/><span className="fcp-muted">{run.agent ?? 'Agent unknown'}</span></div><section className="fcp-section"><div className="fcp-section-head"><h2>Run receipt</h2><FileCheck2 aria-hidden="true" size={17}/></div><ol className="fcp-timeline">{events.map((event) => <li key={event.label}><span aria-hidden="true" className={event.value === null ? 'missing' : ''}/><div><strong>{event.label}</strong><small>{date(event.value)}</small></div></li>)}</ol></section><section className="fcp-section"><div className="fcp-section-head"><h2>Checks & evidence</h2><GitPullRequest aria-hidden="true" size={17}/></div><p className="fcp-empty-line">{run.artifacts.length === 0 ? 'No artifacts observed.' : `${run.artifacts.length} evidence artifact${run.artifacts.length === 1 ? '' : 's'} recorded.`}</p></section><section className="fcp-section"><div className="fcp-section-head"><h2>Next action</h2><ChevronRight aria-hidden="true" size={17}/></div><p className="fcp-empty-line">{run.canAcceptReceipt ? 'Receipt acceptance is available in the governed record.' : 'Next action is unknown.'}</p></section></main><aside className="fcp-meta"><h2>Receipt details</h2><DetailFacts items={[{label: 'Task', value: run.workItem ?? 'Unknown'}, {label: 'Agent', value: run.agent ?? 'Unknown'}, {label: 'Approval', value: approval === null ? 'Not observed' : statusLabel(approval.status)}, {label: 'Environment', value: approval?.environment ?? 'Unknown'}, {label: 'Outcome', value: statusLabel(run.receipt?.terminal ?? run.status)}, {label: 'Observed', value: date(run.completedAt ?? run.startedAt)}]}/><details><summary>Technical details</summary><p>Runtime profile: {run.runtimeProfile}</p></details></aside></div></>;
}
function ConversationChannel({channel}: {channel: ConversationsData['projects'][number]['channels'][number]}) {
  const label = channel.conversationClass === 'internal' ? 'Internal' : 'Client';
  const stateLabel = channel.state === 'not_configured' ? 'Not configured'
    : channel.state === 'empty' ? 'No messages observed'
      : channel.state === 'degraded' ? 'Degraded' : 'Observed';
  return <section className="fcp-conversation"><header><div><h2>{label}</h2><span>{stateLabel} · freshness {date(channel.freshnessAt)}</span></div><Status value={channel.state === 'degraded' ? 'failed' : channel.state === 'ready' ? 'healthy' : 'unknown'}/></header>{channel.failure === null ? null : <p className="fcp-conversation-failure">Ingestion degraded: {channel.failure.code} · {date(channel.failure.at)} · {channel.failure.count} recorded failure{channel.failure.count === 1 ? '' : 's'}</p>}{channel.state === 'not_configured' ? <p className="fcp-empty-line">Not configured. No verified chat binding exists for this project and class.</p> : <div className="fcp-conversation-body"><aside><h3>Participants</h3>{channel.participants.length === 0 ? <p>No participants observed.</p> : <ul>{channel.participants.map((participant) => <li key={participant.id}><strong>{participant.displayName}</strong><span>{participant.resolution === 'resolved' ? 'Resolved identity' : 'Unresolved'} · {participant.controlPlaneAccess}</span></li>)}</ul>}</aside><ol className="fcp-message-list">{channel.messages.length === 0 ? <li className="fcp-empty-line">No messages observed after binding activation.</li> : channel.messages.map((message) => <li key={message.id}><header><strong>{message.author}</strong><time>{date(message.sentAt)}</time></header>{message.text === null ? null : <p>{message.text}</p>}<footer>{message.reply ? <span>Reply</span> : null}{message.threaded ? <span>Thread</span> : null}{message.attachmentSummary === null ? null : <span>Attachments: {message.attachmentSummary}</span>}</footer></li>)}</ol></div>}</section>;
}
function Conversations({projects}: {projects: readonly ConversationsData['projects'][number][]}) {
  return <div className="fcp-conversation-projects">{projects.map((project) => <section key={project.id}><h2 className="fcp-conversation-project-name">{project.name}</h2><div className="fcp-conversation-grid">{project.channels.map((channel) => <ConversationChannel channel={channel} key={channel.conversationClass}/>)}</div></section>)}</div>;
}
function Chats({route, project, conversations}: {route: PrototypeRoute; project: ProjectData; conversations: ConversationsData | null}) {
  const scoped = conversations?.projects.find((item) => item.id === project.project.id);
  return <><ProjectHeader route={route} project={project}/><div className="fcp-section-head fcp-page-actions"><span>Verified read-only bindings</span><DeferredAction label="Manage chat membership" detail="chat administration is not configured."/></div>{scoped === undefined ? <Blank title="Conversations unavailable">The canonical conversation read model could not be loaded.</Blank> : <Conversations projects={[scoped]}/>}</>;
}
const roleLabel = (role: string) => role.replaceAll('_', ' ');
const resourceLabel = (resource: string) => resource.replaceAll('_', ' ');
const grantConfirmationState = (grant: AccessData['resourceGrants'][number]) => {
  const observed = [grant.observedProvider, grant.observedLevel, grant.observedAt];
  if (observed.every((value) => value !== null)) {
    return grant.observedLevel === grant.desiredLevel ? 'Confirmed' : 'Pending confirmation';
  }
  if (observed.every((value) => value === null)) return 'Pending confirmation';
  return 'Unknown';
};
function ResourceGrant({grant, membership}: {
  grant: AccessData['resourceGrants'][number];
  membership: AccessData['memberships'][number];
}) {
  const confirmation = grantConfirmationState(grant);
  const provider = grant.observedProvider ?? 'provider';
  return <article><div><strong>{resourceLabel(grant.resourceType)}</strong><small>Canonical desired: {grant.desiredLevel} · grant v{grant.version}</small></div><dl><div><dt>Membership baseline</dt><dd>{membership.active ? roleLabel(membership.role) : 'Inactive membership'}</dd></div><div><dt>Provider observation</dt><dd>{grant.observedLevel === null ? 'Not observed' : `${grant.observedLevel} · ${grant.observedProvider ?? 'Unknown provider'}`}</dd></div><div><dt>Confirmation</dt><dd>{confirmation}</dd></div><div><dt>External change</dt><dd>{grant.providerAccessUrl == null ? 'Not configured' : <a href={grant.providerAccessUrl} target="_blank" rel="noreferrer" aria-label={`Manage ${resourceLabel(grant.resourceType)} access in ${provider} (opens in a new tab)`}>Manage in provider <ExternalLink aria-hidden="true" size={13}/></a>}</dd></div></dl><small className="fcp-access-observed">Observed {date(grant.observedAt)}</small></article>;
}
function Access({route, project, access}: {route: PrototypeRoute; project: ProjectData; access: AccessData | null}) {
  if (access === null) return <><ProjectHeader route={route} project={project}/><Blank title="Access is unavailable">The canonical access read model could not be loaded.</Blank></>;
  const memberships = access.memberships.filter((item) => item.projectId === project.project.id);
  const actors = memberships.flatMap((item) => access.actors.find((actor) => actor.id === item.actorId) ?? []);
  const selected = actors.find((actor) => actor.id === route.accessActorId) ?? actors[0] ?? null;
  const membership = selected === null ? null : memberships.find((item) => item.actorId === selected.id) ?? null;
  const identities = selected === null ? [] : access.externalIdentities.filter((item) => item.actorId === selected.id);
  const grants = selected === null ? [] : access.resourceGrants.filter((item) => item.projectId === project.project.id && item.actorId === selected.id);
  const profiles = selected === null ? [] : access.agentSystems.find((item) => item.actorId === selected.id)?.profiles ?? [];
  const actorUrl = (actorId: string) => `/projects/${project.project.slug}/access/${actorId}${scopeQuery(route.scope)}`;
  return <><ProjectHeader route={route} project={project}/><div className={`fcp-access-layout${route.accessActorId === undefined || route.accessActorId === null ? '' : ' has-selection'}`}>
    <aside className="fcp-access-master"><div className="fcp-section-head"><div><h2>People &amp; agents</h2><span>Project memberships</span></div></div>{actors.length === 0 ? <p className="fcp-empty-line">No project memberships observed.</p> : <div className="fcp-list">{actors.map((actor) => { const row = memberships.find((item) => item.actorId === actor.id)!; return <Link className="fcp-access-person" href={actorUrl(actor.id)} key={actor.id} aria-current={selected?.id === actor.id ? 'page' : undefined}><UsersRound aria-hidden="true" size={17}/><div><strong>{actor.displayName}</strong><small>{roleLabel(row.role)} · {actor.type}</small></div><Status value={row.active && actor.disabledAt === null ? 'ready' : 'blocked'}/><ChevronRight aria-hidden="true" size={16}/></Link>; })}</div>}</aside>
    <main className="fcp-access-detail"><Link className="fcp-access-back" href={projectUrl(project.project.slug, 'access', route.scope)}><ChevronLeft aria-hidden="true" size={16}/>People &amp; agents</Link>{selected === null || membership === null ? <Blank title="Access not configured">No persisted membership connects a person or agent to this project.</Blank> : <>
      <div className="fcp-page-title fcp-access-title"><div><h1>{selected.displayName}</h1><p>Access explanation from persisted membership, grant, and provider-observation records.</p></div><Status value={membership.active && selected.disabledAt === null ? 'ready' : 'blocked'}/></div>
      <section className="fcp-section"><div className="fcp-section-head"><h2>Why this actor can access the project</h2><ShieldCheck aria-hidden="true" size={17}/></div><Summary items={[{label: 'Membership', value: membership.active ? roleLabel(membership.role) : 'Inactive'}, {label: 'Actor', value: selected.disabledAt === null ? 'Enabled' : 'Disabled'}, {label: 'External identity', value: identities.length === 0 ? 'Not observed' : `${identities.filter((item) => item.active).length} active`}, {label: 'Explicit grants', value: grants.length}]}/></section>
      <section className="fcp-section"><div className="fcp-section-head"><h2>Resource grants</h2><span>Desired vs provider-confirmed access</span></div>{grants.length === 0 ? <p className="fcp-empty-line">No explicit resource grants observed. Membership is recorded, but connected resource access is Not configured.</p> : <div className="fcp-access-grants">{grants.map((grant) => <ResourceGrant grant={grant} key={grant.id} membership={membership}/>)}</div>}</section>
      <section className="fcp-section"><div className="fcp-section-head"><h2>External identities</h2><span>Provider binding metadata only</span></div>{identities.length === 0 ? <p className="fcp-empty-line">Not observed. No provider identity binding is recorded.</p> : <div className="fcp-identity-list">{identities.map((identity) => <span key={identity.provider}>{identity.provider} · {identity.active ? 'Active binding' : 'Inactive binding'}</span>)}</div>}</section>
      {selected.type !== 'agent' ? null : <section className="fcp-section"><div className="fcp-section-head"><h2>Agent registrations</h2><Bot aria-hidden="true" size={17}/></div>{profiles.length === 0 ? <p className="fcp-empty-line">Not observed. This agent has no persisted runtime profile.</p> : <div className="fcp-access-grants">{profiles.map((profile) => <article key={profile.id}><div><strong>{profile.runtimeId} · {profile.runtimeProfile}</strong><small>{profile.enabled ? 'Enabled profile' : 'Disabled profile'} · {profile.registrations.length} recorded project registration{profile.registrations.length === 1 ? '' : 's'}</small></div><dl><div><dt>Current work</dt><dd>{profile.latestRun === null ? 'Not observed' : profile.latestRun.status}</dd></div><div><dt>Last receipt</dt><dd>{profile.latestRun?.receipt === null || profile.latestRun?.receipt === undefined ? 'Not observed' : profile.latestRun.receipt.terminal}</dd></div><div><dt>Runtime liveness</dt><dd>Unknown (not observed)</dd></div></dl></article>)}</div>}</section>}
    </>}</main>
  </div></>;
}
function AccessOperations({project, access, csrfToken}: {project: ProjectData; access: AccessData | null; csrfToken: string | null}) {
  if (access === null) return null;
  const shareProject = access.sharing.projects.find((item) => item.slug === project.project.slug);
  const projectShares = access.sharing.grants.filter((grant) => grant.projectSlug === project.project.slug);
  return <section className="fcp-access-operations" aria-label="Governed access operations">
    <details className="fcp-access-operation">
      <summary><Link2 aria-hidden="true" size={18}/><span><strong>Client sharing</strong><small>Scoped, expiring task-list links</small></span><b>{projectShares.filter((grant) => grant.active).length}</b><ChevronRight aria-hidden="true" size={16}/></summary>
      <div>{shareProject === undefined ? <p className="fcp-empty-line">Sharing is Not configured for this project.</p> : <ProjectShareControls csrfToken={csrfToken} enabled={access.sharing.enabled} grants={projectShares} projects={[shareProject]} project={shareProject}/>}</div>
    </details>
    <details className="fcp-access-operation">
      <summary><ClipboardList aria-hidden="true" size={18}/><span><strong>Access requests</strong><small>Workspace records; project binding is not recorded</small></span><b>{access.requests.length}</b><ChevronRight aria-hidden="true" size={16}/></summary>
      <div>{access.requests.length === 0 ? <p className="fcp-empty-line">No persisted access requests are recorded.</p> : <div className="fcp-access-request-list">{access.requests.map((request) => <article key={request.id}><div><strong>{request.requester}</strong><small>{resourceLabel(request.targetSurface)} · {request.requestedScope.length === 0 ? 'Scope not observed' : request.requestedScope.join(', ')}</small></div><Status value={request.status}/><time>{request.expiresAt === null ? 'No expiry recorded' : `Expires ${date(request.expiresAt)}`}</time></article>)}</div>}</div>
    </details>
  </section>;
}
function SystemsSummary({health}: {health: HealthData | null}) {
  if (health === null) return <Blank title="Systems data is unavailable">Persisted operational facts could not be loaded.</Blank>;
  const unhealthy = health.jobs.filter((job) => job.status === 'unhealthy').length;
  return <><Summary items={[{label: 'Scheduled jobs', value: health.jobs.length}, {label: 'Unhealthy jobs', value: unhealthy, tone: unhealthy > 0 ? 'danger' : ''}, {label: 'Integration observations', value: health.integrations.length}, {label: 'Unresolved risks', value: health.risks.length, tone: health.risks.length > 0 ? 'danger' : ''}, {label: 'Audit facts', value: health.audit.length}]}/><div className="fcp-systems-grid"><SystemFacts icon={Workflow} title="Scheduled jobs" empty="No persisted scheduled jobs are recorded." items={health.jobs}>{(job) => <><strong>{job.project} · {job.name}</strong><span>{job.status} · heartbeat {date(job.heartbeatAt)} · last success {date(job.lastSuccessAt)} · next {date(job.nextRunAt)}</span></>}</SystemFacts><SystemFacts icon={ServerCog} title="Integration observations" empty="No persisted tracker snapshot operations are recorded." items={health.integrations}>{(item) => <><strong>{item.project} · {item.provider}</strong><span>{item.mode} · observed {date(item.createdAt)}</span></>}</SystemFacts><SystemFacts icon={ShieldAlert} title="Unresolved risks" empty="No unresolved risk signals are recorded." items={health.risks}>{(item) => <><strong>{item.project} · {item.severity}</strong><span>{item.summary} · updated {date(item.updatedAt)}</span></>}</SystemFacts><SystemFacts icon={History} title="Recovery & audit" empty="No canonical audit events are recorded." items={health.audit}>{(item) => <><strong>{item.project} · {item.action}</strong><span>{item.actor ?? 'No recorded actor'} · {item.outcome ?? 'No recorded outcome'} · {date(item.occurredAt)}</span></>}</SystemFacts></div><details className="fcp-system-details"><summary>All persisted systems facts</summary><div>{health.jobs.map((item) => <p key={item.id}>{item.project} · {item.name} · {item.status} · heartbeat {date(item.heartbeatAt)} · last success {date(item.lastSuccessAt)} · next {date(item.nextRunAt)}</p>)}{health.integrations.map((item) => <p key={item.id}>{item.project} · {item.provider} · {item.mode} · {date(item.createdAt)}</p>)}{health.risks.map((item) => <p key={item.id}>{item.project} · {item.severity} · {item.summary} · {date(item.updatedAt)}</p>)}{health.costLedger.length === 0 ? <p>No AgentRuns cost facts are recorded.</p> : health.costLedger.map((item) => <p key={`${item.runType}:${item.currency}:${item.state}`}>{item.runType} · {item.state} · {item.count} runs · {item.currency ?? 'No currency'}</p>)}{health.audit.map((item) => <p key={item.id}>{item.project} · {item.action} · {item.targetType} · {item.targetId ?? 'No recorded target ID'} · {item.policyDecision ?? 'No recorded policy decision'} · {item.reasonCode ?? 'No recorded reason code'}</p>)}</div></details></>;
}
function SystemFacts<T>({icon: Icon, title, empty, items, children}: {icon: typeof Bot; title: string; empty: string; items: readonly T[]; children: (item: T) => ReactNode}) { return <section className="fcp-system-card"><header><Icon aria-hidden="true" size={18}/><h2>{title}</h2><span>{items.length}</span></header>{items.length === 0 ? <p>{empty}</p> : <div>{items.slice(0, 3).map((item, index) => <article key={index}>{children(item)}</article>)}</div>}</section>; }
function Agents({route, access, health}: {route: PrototypeRoute; access: AccessData | null; health: HealthData | null}) {
  const agents = access?.actors.filter((actor) => actor.type === 'agent') ?? [];
  const systems = new Map<string, AccessData['agentSystems'][number]>(access?.agentSystems.map((item) => [item.actorId, item] as const) ?? []);
  return <><div className="fcp-page-title"><div><h1>Agents &amp; Systems</h1><p>Fleet facts from registrations, active run leases, and immutable receipts.</p></div><Scope route={route}/></div><div className="fcp-page-actions"><DeferredAction label="Add agent" detail="agent onboarding is not configured."/></div><SystemsSummary health={health}/><section className="fcp-section"><div className="fcp-section-head"><h2>Fleet</h2><span>Healthy requires an active observed lease</span></div><div className="fcp-list">{agents.length === 0 ? <Blank title="Agents not observed">No agent records are available from PostgreSQL.</Blank> : agents.map((agent) => {
    const profiles = systems.get(agent.id)?.profiles ?? [];
    const currentWork = profiles.find((profile) => profile.fleet.currentWork !== null)?.fleet.currentWork ?? null;
    return <Link className="fcp-row fcp-agent-row" href={screenUrl({kind: 'agent', agentId: agent.id}, route.scope)} key={agent.id}><Bot aria-hidden="true" size={18}/><div><strong>{agent.displayName}</strong><small>{profiles.length === 0 ? 'Profile not observed' : profiles.map((profile) => `${profile.runtimeId} · ${profile.runtimeProfile}`).join(' · ')}</small></div><span>{currentWork === null ? 'No active work observed' : `${currentWork.project} · ${currentWork.title}`}</span><Status value={agent.disabledAt === null ? fleetHealth(profiles) : 'disabled'}/><ChevronRight aria-hidden="true" size={16}/></Link>;
  })}</div></section></>;
}
function AgentProfileSettings({profile, csrfToken}: {
  profile: AccessData['agentSystems'][number]['profiles'][number];
  csrfToken: string | null;
}) {
  return <section className="fcp-section fcp-settings">
    <div className="fcp-section-head"><h2>{profile.runtimeId} profile</h2><span>Governed mutation</span></div>
    {csrfToken === null
      ? <p className="fcp-empty-line">An authenticated operator session is required.</p>
      : <form action={`/api/agent-profiles/${profile.id}`} className="fcp-profile-form" method="post">
          <input name="_csrf" type="hidden" value={csrfToken}/>
          <input name="expectedVersion" type="hidden" value={profile.version}/>
          <label>Instructions<textarea defaultValue={profile.instructions} maxLength={2000} name="instructions" required rows={5}/></label>
          <label>Evidence<select defaultValue={String(profile.settings.includeEvidence)} name="includeEvidence"><option value="true">Required</option><option value="false">Optional</option></select></label>
          <label>Status<select defaultValue={String(profile.enabled)} name="enabled"><option value="true">Enabled</option><option value="false">Disabled</option></select></label>
          <button className="fcp-primary-button" type="submit">Update profile</button>
        </form>}
  </section>;
}
function AgentDetail({route, access, csrfToken}: {route: PrototypeRoute; access: AccessData | null; csrfToken: string | null}) {
  const agent = access?.actors.find((item) => item.id === route.agentId && item.type === 'agent') ?? null;
  if (agent === null) return <Blank title="Agent not observed">This agent is not available in the canonical access read model.</Blank>;
  if (access === null) return <Blank title="Agent not observed">This agent is not available in the canonical access read model.</Blank>;
  const profiles = access?.agentSystems.find((item) => item.actorId === agent.id)?.profiles ?? [];
  const health = agent.disabledAt === null ? fleetHealth(profiles) : 'disabled';
  return <><div className="fcp-page-title"><div><Crumbs route={route} project={null} title={agent.displayName}/><h1>{agent.displayName}</h1><p>Fleet projection from persisted execution facts.</p></div><div className="fcp-agent-title-actions"><Status value={health}/>{agent.disabledAt === null ? <AgentRetirementControls agentId={agent.id} agentName={agent.displayName} canRetire={access.canRetireAgents} csrfToken={csrfToken}/> : null}</div></div><div className="fcp-detail-layout"><main className="fcp-detail-main"><section className="fcp-section"><div className="fcp-section-head"><h2>Runtime fleet</h2><ServerCog aria-hidden="true" size={17}/></div>{profiles.length === 0 ? <p className="fcp-empty-line">No persisted agent profile or project registration is observed.</p> : <div className="fcp-fleet-profiles">{profiles.map((profile) => <article key={profile.id}><header><div><strong>{profile.runtimeId} · {profile.runtimeProfile}</strong><small>{profile.enabled ? 'Profile enabled' : 'Profile disabled'} · {profile.registrations.length} project registration{profile.registrations.length === 1 ? '' : 's'}</small></div><Status value={profile.fleet.health}/></header>{profile.registrations.length === 0 ? <p className="fcp-empty-line">Project scope not observed.</p> : <div className="fcp-registration-list">{profile.registrations.map((registration) => <div key={registration.id}><div><strong>{registration.project}</strong><small>{registration.provider}/{registration.runtimeKey} · registration v{registration.version}</small></div><Status value={registration.enabled ? 'enabled' : 'disabled'}/><RuntimeRegistrationControls agentId={agent.id} agentProfileId={profile.id} canManage={agent.disabledAt === null && registration.canManage} csrfToken={csrfToken} enabled={registration.enabled} expectedVersion={registration.version} projectId={registration.projectId} projectName={registration.project} registrationId={registration.id} replacementTargets={access === null ? [] : replacementTargets(access, agent.id, profile.id, registration.projectId)} staleRun={profile.fleet.health === 'stale' && profile.fleet.currentWork?.projectSlug === registration.projectSlug ? {id: profile.fleet.currentWork.id, version: profile.fleet.currentWork.version} : null}/></div>)}</div>}<dl><div><dt>Freshness</dt><dd>{date(profile.fleet.freshnessAt)}</dd></div><div><dt>Current work</dt><dd>{profile.fleet.currentWork === null ? 'Not observed' : `${profile.fleet.currentWork.project} · ${profile.fleet.currentWork.title} · ${statusLabel(profile.fleet.currentWork.status)}`}</dd></div><div><dt>Last receipt</dt><dd>{profile.fleet.lastReceipt === null ? 'Not observed' : `${profile.fleet.lastReceipt.terminal} · ${profile.fleet.lastReceipt.project} · ${date(profile.fleet.lastReceipt.completedAt)}`}</dd></div></dl></article>)}</div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Effective instructions</h2><Bot aria-hidden="true" size={17}/></div>{profiles.length === 0 || profiles.every((profile) => profile.instruction === null) ? <p className="fcp-empty-line">Versioned effective instructions are not observed for this agent.</p> : profiles.map((profile) => profile.instruction === null ? null : <article className="fcp-agent-profile" key={`${profile.id}:instruction`}><strong>{profile.runtimeId} · {profile.runtimeProfile}</strong><p>{profile.instruction.provenance} · effective hash {profile.instruction.hash}</p></article>)}</section>{agent.disabledAt === null ? profiles.map((profile) => <AgentProfileSettings csrfToken={csrfToken} key={`${profile.id}:settings`} profile={profile}/>) : null}</main><aside className="fcp-meta"><h2>Details</h2><DetailFacts items={[{label: 'Type', value: agent.type}, {label: 'Role', value: agent.role}, {label: 'Actor state', value: agent.disabledAt === null ? 'Enabled' : 'Disabled'}, {label: 'Fleet health', value: statusLabel(health)}, {label: 'Profiles', value: String(profiles.length)}]}/></aside></div></>;
}
function GlobalTasks({route, projects}: {route: PrototypeRoute; projects: readonly ProjectData[]}) {
  const visibleProjects = route.globalProject === undefined || route.globalProject === 'all' ? projects : projects.filter((project) => project.project.slug === route.globalProject);
  const rows = visibleProjects.flatMap((project) => project.workItems.map((task) => <TaskRow key={task.id} project={project.project.slug} route={route} task={task}/>));
  return <><div className="fcp-page-title"><div><h1>Delivery tasks</h1><p>Canonical work items across configured projects.</p></div><Scope route={route}/></div><div className="fcp-page-actions"><DeferredAction label="New task" detail="task creation is not configured in this workspace."/></div><div className="fcp-list">{rows.length === 0 ? <p className="fcp-empty-line">No tasks observed for this project filter.</p> : rows}</div></>;
}
function GlobalChats({route, conversations}: {route: PrototypeRoute; conversations: ConversationsData | null}) { return <><div className="fcp-page-title"><div><h1>Conversations</h1><p>Read-only internal and client timelines from verified bindings.</p></div><Scope route={route}/></div><div className="fcp-page-actions"><DeferredAction label="Manage chat membership" detail="chat administration is not configured."/></div>{conversations === null ? <Blank title="Conversations unavailable">The canonical conversation read model could not be loaded.</Blank> : conversations.projects.length === 0 ? <Blank title="No projects observed">No configured projects are available for this filter.</Blank> : <Conversations projects={conversations.projects}/>}</>; }
function People({route, access}: {route: PrototypeRoute; access: AccessData | null}) {
  if (access === null) return <><div className="fcp-page-title"><div><h1>People &amp; Access</h1><p>Persisted memberships, identities, and effective access.</p></div><Scope route={route}/></div><Blank title="People and access are unavailable">The canonical access read model could not be loaded.</Blank></>;
  const membershipRows = access.memberships.flatMap((membership) => {
    const actor = access.actors.find((candidate) => candidate.id === membership.actorId);
    if (actor === undefined) return [];
    return [{membership, actor}];
  });
  return <><div className="fcp-page-title"><div><h1>People &amp; Access</h1><p>Confirmed project memberships and provider-access evidence.</p></div><Scope route={route}/></div><section className="fcp-section"><div className="fcp-section-head"><h2>Project memberships</h2><span>Read-only canonical records</span></div>{membershipRows.length === 0 ? <p className="fcp-empty-line">No persisted project memberships are recorded.</p> : <div className="fcp-list">{membershipRows.map(({membership, actor}) => <Link className="fcp-row fcp-people-row" href={`/projects/${membership.projectSlug}/access/${actor.id}${scopeQuery(route.scope)}`} key={`${membership.projectId}:${actor.id}`}><UsersRound aria-hidden="true" size={18}/><div><strong>{actor.displayName}</strong><small>{membership.project} · {roleLabel(membership.role)} · {actor.type}</small></div><Status value={membership.active && actor.disabledAt === null ? 'ready' : 'blocked'}/><span>{actor.disabledAt === null ? 'Actor enabled' : 'Actor disabled'}</span><ChevronRight aria-hidden="true" size={16}/></Link>)}</div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Access posture</h2><span>Provider grants remain project-specific</span></div><Summary items={[{label: 'People & agents', value: access.actors.length}, {label: 'Active memberships', value: access.memberships.filter((membership) => membership.active).length}, {label: 'External identities', value: access.externalIdentities.filter((identity) => identity.active).length}, {label: 'Explicit grants', value: access.resourceGrants.length}]}/></section></>;
}
function ProjectScreen({route, data}: {route: WorkspaceRoute; data: WorkspaceData}) {
  const project = ready(data.project);
  const runs = ready(data.runs);
  const access = ready(data.access);
  if (project === null) return <Blank title="Project not observed">This project is not available in the PostgreSQL read model.</Blank>;
  switch (route.screen) {
    case 'overview': return <Overview route={route} project={project} runs={runs}/>;
    case 'tasks': return <Tasks route={route} project={project}/>;
    case 'task': return <TaskDetail route={route} project={project} runs={runs} lifecycleLoad={data.lifecycle ?? null} csrfToken={data.csrfToken ?? null}/>;
    case 'protocol': return <Protocol route={route} project={project} csrfToken={data.csrfToken ?? null}/>;
    case 'runs': return <Runs route={route} project={project} runs={runs}/>;
    case 'run': return <RunDetail route={route} project={project} runs={runs}/>;
    case 'chats': return <Chats route={route} project={project} conversations={ready(data.conversations ?? null)}/>;
    case 'access': return <><Access route={route} project={project} access={access}/><AccessOperations project={project} access={access} csrfToken={data.csrfToken ?? null}/></>;
    default: return null;
  }
}
export function WorkspaceShell({route, data}: {route: WorkspaceRoute; data: WorkspaceData}) {
  const access = ready(data.access);
  const health = ready(data.health);
  const conversations = ready(data.conversations ?? null);
  const tokenStyle = {'--fcp-bg': operatorTokens.color.canvas, '--fcp-canvas': operatorTokens.color.surface, '--fcp-ink': operatorTokens.color.ink, '--fcp-muted': operatorTokens.color.muted, '--fcp-rule': operatorTokens.color.border, '--fcp-blue': operatorTokens.color.focus, '--fcp-red': operatorTokens.color.danger, '--fcp-amber': operatorTokens.color.warning, '--fcp-green': operatorTokens.color.success, '--fcp-target': `${operatorTokens.target.minimum}px`} as CSSProperties;
  return <div className="fcp-workspace" style={tokenStyle}><Header route={route}/><div className="fcp-main">{route.screen === 'dashboard' ? <Dashboard route={route} data={data}/> : route.screen === 'projects' ? <Projects route={route} data={data}/> : route.screen === 'global_tasks' ? <GlobalTasks route={route} projects={data.projectIndex}/> : route.screen === 'global_chats' ? <GlobalChats route={route} conversations={conversations}/> : route.screen === 'people' ? <People route={route} access={access}/> : route.screen === 'agents' ? <Agents route={route} access={access} health={health}/> : route.screen === 'agent' ? <AgentDetail route={route} access={access} csrfToken={data.csrfToken ?? null}/> : <ProjectScreen route={route} data={data}/>}</div></div>;
}
