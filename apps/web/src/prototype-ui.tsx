import Link from 'next/link';
import type {CSSProperties, ReactNode} from 'react';
import {
  Activity, AlertTriangle, Bot, ChevronRight, CircleDot, Clock3, FileCheck2,
  FolderKanban, GitPullRequest, LayoutDashboard, ListChecks, MoreHorizontal, Search,
  ShieldCheck, UsersRound
} from 'lucide-react';
import {DeliveryJourneyAction, DeliveryProtocolEditor} from './delivery-controls';
import {type OperatorScreenRef, type OperatorScopeRef} from '@fai/operator-contracts';
import {operatorTokens} from '@fai/operator-tokens';
import type {
  AccessData, HealthData, OperatorLoad, OperatorProjectSlug, PortfolioData,
  ProjectData, RunsData
} from './operator-data';

export type PrototypeRoute = Readonly<{
  screen: 'dashboard' | 'projects' | 'global_tasks' | 'global_chats' | 'overview' | 'tasks' | 'task' | 'protocol' | 'runs' | 'run' | 'chats' | 'access' | 'agents' | 'agent';
  project: OperatorProjectSlug | null;
  globalProject?: 'all' | OperatorProjectSlug;
  taskId: string | null;
  runId: string | null;
  agentId: string | null;
  scope: OperatorScopeRef;
}>;

export type PrototypeData = Readonly<{
  portfolio: OperatorLoad<PortfolioData>;
  project: OperatorLoad<ProjectData | null> | null;
  runs: OperatorLoad<RunsData> | null;
  access: OperatorLoad<AccessData>;
  health: OperatorLoad<HealthData> | null;
  projectIndex: readonly ProjectData[];
  csrfToken?: string | null;
}>;

const projectTabs = ['overview', 'tasks', 'protocol', 'runs', 'chats', 'access'] as const;
const labels: Record<(typeof projectTabs)[number], string> = {
  overview: 'Overview', tasks: 'Tasks', protocol: 'Protocol', runs: 'Runs', chats: 'Chats', access: 'Access'
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
  const path = screen.kind === 'dashboard' ? '/prototype/dashboard'
    : screen.kind === 'projects' ? '/prototype/projects'
    : screen.kind === 'tasks' ? `/prototype/tasks?project=${screen.project}`
    : screen.kind === 'chats' ? `/prototype/chats?project=${screen.project}`
    : screen.kind === 'project' ? `/prototype/projects/${screen.projectSlug}/${screen.section}`
    : screen.kind === 'task' ? `/prototype/projects/${screen.projectSlug}/tasks/${screen.taskId}`
    : screen.kind === 'run' ? `/prototype/projects/${screen.projectSlug}/runs/${screen.runId}`
    : screen.kind === 'agents' ? '/prototype/agents' : `/prototype/agents/${screen.agentId}`;
  const query = scopeQuery(scope);
  return query === '' ? path : `${path}${path.includes('?') ? '&' : '?'}${query.slice(1)}`;
};
const projectUrl = (slug: OperatorProjectSlug, tab: (typeof projectTabs)[number], scope: OperatorScopeRef) => screenUrl({kind: 'project', projectSlug: slug, section: tab}, scope);
const taskUrl = (slug: OperatorProjectSlug, id: string, scope: OperatorScopeRef) => screenUrl({kind: 'task', projectSlug: slug, taskId: id}, scope);
const runUrl = (slug: OperatorProjectSlug, id: string, scope: OperatorScopeRef) => screenUrl({kind: 'run', projectSlug: slug, runId: id}, scope);
const statusTone = (value: string) => value === 'failed' || value === 'blocked' || value === 'red' ? 'danger' : value === 'waiting_approval' || value === 'yellow' ? 'warning' : value === 'done' || value === 'green' ? 'success' : 'neutral';
const statusLabel = (value: string) => ({green: 'On track', yellow: 'Watch', red: 'At risk', done: 'Completed', in_dev: 'In development', backlog: 'Backlog', ready: 'Ready', qa: 'Quality assurance', acceptance: 'Acceptance', running: 'Running', queued: 'Queued', waiting_approval: 'Waiting for approval', failed: 'Failed', blocked: 'Blocked', pending: 'Pending', unknown: 'Unknown'}[value] ?? 'Unknown');

function Status({value}: {value: string}) {
  return <span className={`fcp-status ${statusTone(value)}`}><CircleDot aria-hidden="true" size={14}/>{statusLabel(value)}</span>;
}
function Blank({title, children}: {title: string; children: ReactNode}) {
  return <section className="fcp-blank"><AlertTriangle aria-hidden="true" size={18}/><div><h2>{title}</h2><p>{children}</p></div></section>;
}
function Scope({route}: {route: PrototypeRoute}) {
  const scope = route.scope;
  const selectedProject = route.globalProject ?? (route.project === null ? 'all' : null);
  return <div className="fcp-scope" aria-label="Current scope">{selectedProject === null ? null : <span>Project: {selectedProject === 'all' ? 'All projects' : selectedProject.toUpperCase()}</span>}<span>Environment: {scope.environment ?? 'Not configured'}</span><span>Time: {scope.from ?? scope.to ? 'Custom range' : 'All time'}</span></div>;
}
function Header({route}: {route: PrototypeRoute}) {
  const nav = [{label: 'Dashboard', icon: LayoutDashboard, target: {kind: 'dashboard'} as const}, {label: 'Projects', icon: FolderKanban, target: {kind: 'projects'} as const}, {label: 'Tasks', icon: ListChecks, target: {kind: 'tasks', project: 'all'} as const}, {label: 'Chats', icon: UsersRound, target: {kind: 'chats', project: 'all'} as const}, {label: 'Agents', icon: Bot, target: {kind: 'agents'} as const}];
  const current = route.project !== null ? 'Projects' : route.screen === 'global_tasks' ? 'Tasks' : route.screen === 'global_chats' ? 'Chats' : route.screen === 'agent' ? 'Agents' : route.screen[0]!.toUpperCase() + route.screen.slice(1);
  return <header className="fcp-global"><Link href={screenUrl({kind: 'dashboard'}, route.scope)} className="fcp-brand">f(AI)<span>Control</span></Link><nav className="fcp-global-nav" aria-label="Global navigation">{nav.map(({label, icon: Icon, target}) => <Link aria-label={label} href={screenUrl(target, route.scope)} key={label} aria-current={current === label ? 'page' : undefined}><Icon aria-hidden="true" size={16}/><span>{label}</span></Link>)}</nav></header>;
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
function AttentionRow({signal, route, projects}: {signal: PortfolioData['attention'][number]; route: PrototypeRoute; projects: PortfolioData['projects']}) {
  const project = projects.find((item) => item.id === signal.projectId);
  const href = project === undefined ? null : signal.workItemId === null
    ? projectUrl(project.slug, 'overview', route.scope)
    : taskUrl(project.slug, signal.workItemId, route.scope);
  const stage = signal.stage === null ? 'Unknown' : signal.stage.replaceAll('_', ' ');
  const provenance = signal.signalClass === null ? 'Unavailable' : signal.signalClass === 'fact' ? 'Fact' : 'Inference';
  const target = signal.workItemId === null ? 'Open project' : 'Open task';
  return <article className="fcp-attention" key={signal.id}><header><Status value={signal.severity}/><div><strong>{signal.object}</strong><small>{signal.project} · {signal.reason}</small></div>{href === null ? <span className="fcp-muted">Target unavailable</span> : <Link className="fcp-attention-open" href={href} aria-label={`${target}: ${signal.object}`}>{target}<ChevronRight aria-hidden="true" size={16}/></Link>}</header><dl className="fcp-attention-facts"><div><dt>Delivery stage</dt><dd>{stage}</dd></div><div><dt>Owner</dt><dd>{signal.owner ?? 'Unknown'}</dd></div><div><dt>Observed</dt><dd>{date(signal.freshness)}</dd></div><div><dt>Class</dt><dd>{provenance}</dd></div></dl><div className="fcp-attention-next"><span>Next action</span><strong>{signal.nextAction ?? 'Unavailable'}</strong></div><details className="fcp-attention-details"><summary><FileCheck2 aria-hidden="true" size={15}/>Evidence &amp; impact</summary><div><p><strong>Impact</strong><span>{signal.impact ?? 'Unavailable'}</span></p><p><strong>Evidence</strong><span>{signal.evidenceReferences.length === 0 ? 'Unavailable' : signal.evidenceReferences.map((reference) => `${reference.type}: ${reference.id}`).join(' · ')}</span></p>{signal.sourceUrl === null ? null : <a href={signal.sourceUrl} target="_blank" rel="noreferrer">Open provider source</a>}</div></details></article>;
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
function Dashboard({route, data}: {route: PrototypeRoute; data: PrototypeData}) {
  const portfolio = ready(data.portfolio);
  const allRuns = ready(data.runs);
  if (portfolio === null) return <Blank title="Control plane data is unavailable">Connect the configured PostgreSQL source to view portfolio facts.</Blank>;
  const failed = allRuns?.runs.filter((run) => run.status === 'failed').length;
  const active = allRuns?.runs.filter((run) => run.status === 'running').length;
  return <><div className="fcp-page-title"><div><h1>Dashboard</h1><p>Delivery attention across configured projects.</p></div><Scope route={route}/></div><Summary items={[
    {label: 'Projects', value: portfolio.projects.length}, {label: 'Attention', value: portfolio.attention.length, tone: portfolio.attention.length > 0 ? 'danger' : ''},
    ...(active === undefined ? [] : [{label: 'Active runs', value: active}]), ...(failed === undefined ? [] : [{label: 'Failed runs', value: failed, tone: failed > 0 ? 'danger' : ''}])
  ]}/><section className="fcp-section"><div className="fcp-section-head"><h2>Portfolio</h2><span>Observed facts</span></div><div className="fcp-portfolio-grid">{portfolio.projects.map((project) => <PortfolioMetrics project={project} route={route} key={project.id}/>)}</div></section><section className="fcp-section"><div className="fcp-section-head"><h2>Attention</h2><span>Persisted signals only</span></div>{portfolio.attention.length === 0 ? <p className="fcp-empty-line">No recorded alerts.</p> : <div className="fcp-list">{portfolio.attention.map((signal) => <AttentionRow signal={signal} route={route} projects={portfolio.projects} key={signal.id}/>)}</div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Projects</h2><Link href={screenUrl({kind: 'projects'}, route.scope)}>View all</Link></div><div className="fcp-list">{portfolio.projects.map((project) => <Link className="fcp-row fcp-project-row" href={projectUrl(project.slug, 'overview', route.scope)} key={project.id}><FolderKanban aria-hidden="true" size={18}/><div><strong>{project.name}</strong><small>{project.unresolvedRiskCount === 0 ? 'No recorded risks' : `${project.unresolvedRiskCount} recorded risks`}</small></div><Status value={project.health}/><span>{project.synchronizedAt === null ? 'Source not observed' : `Observed ${date(project.synchronizedAt)}`}</span><ChevronRight aria-hidden="true" size={16}/></Link>)}</div></section></>;
}
function Projects({route, data}: {route: PrototypeRoute; data: PrototypeData}) {
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
  return <><ProjectHeader route={route} project={project}/><div className="fcp-list">{project.workItems.length === 0 ? <p className="fcp-empty-line">No tasks observed.</p> : project.workItems.map((task) => <TaskRow project={project.project.slug} route={route} task={task} key={task.id}/>)}</div></>;
}
function DetailFacts({items}: {items: readonly Readonly<{label: string; value: string}>[]}) {
  return <dl className="fcp-details">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}
function TaskDetail({route, project, runs, csrfToken}: {route: PrototypeRoute; project: ProjectData; runs: RunsData | null; csrfToken: string | null}) {
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
  return <><ProjectHeader route={route} project={project} title={task.title}/><div className="fcp-detail-layout"><main className="fcp-detail-main"><div className="fcp-detail-status"><Status value={task.blocked ? 'blocked' : task.status}/></div>{task.summary === null ? <p className="fcp-empty-line">Task summary not observed.</p> : <p className="fcp-task-summary">{task.summary}</p>}<section className="fcp-section"><div className="fcp-section-head"><h2>Delivery lifecycle</h2><span>{journey === null ? 'Not configured' : `Protocol v${journey.protocolVersion}`}</span></div>{journey === null ? <p className="fcp-empty-line">Not configured. This legacy task is not bound to a delivery protocol.</p> : <div className="fcp-lifecycle-rail"><span aria-hidden="true"/><div><strong>{stage?.name ?? journey.stageKey}</strong><small>Task status: {statusLabel(stage?.taskStatus ?? task.status)} · {stage?.executionMode ?? 'Unknown mode'}</small></div><div><strong>Deadline</strong><small>{journey.deadlineAt === null ? 'Not set' : date(journey.deadlineAt)}</small></div><div><strong>Responsibility</strong><small>{stage?.actor === null || stage?.actor === undefined ? `${stage?.responsibility ?? 'Unknown'} · unresolved` : `${stage.actor.displayName} · ${stage.actor.type}`}</small></div><div><strong>Next allowed action</strong><small>{task.blocked ? 'Blocked: task is blocked' : stage?.nextStage === null || stage === null ? 'Blocked: journey complete or protocol context missing' : `Advance to ${stage.nextStage}`}</small></div></div>}<DeliveryJourneyAction workItemId={task.id} taskVersion={task.version ?? 0} journey={journey} activeProtocolId={project.protocol?.active === true ? project.protocol.id : null} csrfToken={csrfToken}/></section><section className="fcp-section"><div className="fcp-section-head"><h2>Run or packet handoff</h2><ListChecks aria-hidden="true" size={17}/></div><div className="fcp-command"><div><strong>{task.handoff?.label ?? 'Not observed'}</strong><p>{task.handoff === null ? 'No task packet or run handoff is recorded.' : `Observed ${task.handoff.kind} handoff.`}</p></div>{run === null ? null : <Link className="fcp-primary" href={runUrl(project.project.slug, run.id, route.scope)}>Open run receipt</Link>}</div></section><section className="fcp-section"><div className="fcp-section-head"><h2>Policy & approval</h2><ShieldCheck aria-hidden="true" size={17}/></div><p className="fcp-empty-line">{approval === null ? 'Not observed. Delivery does not create a #6 run or approval.' : `${statusLabel(approval.status)} · ${approval.environment}`}</p></section><section className="fcp-section"><div className="fcp-section-head"><h2>Evidence</h2><FileCheck2 aria-hidden="true" size={17}/></div>{journey === null ? <p className="fcp-empty-line">No protocol evidence requirements are configured.</p> : <div className="fcp-evidence-list">{recordedEvidence.length === 0 ? <p className="fcp-empty-line">No evidence references recorded for this stage.</p> : recordedEvidence.map((entry) => <p key={`${entry.requirement}:${entry.reference}`}><strong>{entry.requirement}</strong><span>{entry.reference}</span></p>)}{nextRequiredEvidence.length === 0 ? null : <p className="fcp-evidence-next"><strong>Next required</strong><span>{nextRequiredEvidence.join(', ')}</span></p>}</div>}</section></main><aside className="fcp-meta"><h2>Details</h2><DetailFacts items={[{label: 'Protocol', value: journey === null ? 'Not configured' : `v${journey.protocolVersion}`}, {label: 'Stage', value: stage?.name ?? 'Not configured'}, {label: 'Responsible human', value: stage?.actor?.type === 'human' ? stage.actor.displayName : task.owner ?? 'Unknown'}, {label: 'Responsible agent', value: stage?.actor?.type === 'agent' ? stage.actor.displayName : 'Unknown'}, {label: 'Approval', value: approval === null ? 'Not observed' : statusLabel(approval.status)}, {label: 'Deadline', value: journey?.deadlineAt === null || journey === null ? 'Not set' : date(journey.deadlineAt)}, {label: 'Source', value: task.externalUrl === null ? 'Not observed' : 'Provider observation'}, {label: 'Updated', value: date(task.updatedAt)}]}/>{task.externalUrl === null ? null : <a href={task.externalUrl} target="_blank" rel="noreferrer">Open provider source</a>}</aside></div></>;
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
function Chats({route, project}: {route: PrototypeRoute; project: ProjectData}) { return <><ProjectHeader route={route} project={project}/><Blank title="Chats not configured">No canonical conversation or thread records are available for this project.</Blank></>; }
function Access({route, project, access}: {route: PrototypeRoute; project: ProjectData; access: AccessData | null}) { return <><ProjectHeader route={route} project={project}/>{access === null ? <Blank title="Access is unavailable">The canonical access read model could not be loaded.</Blank> : <section className="fcp-settings"><div className="fcp-settings-head"><div><h2>Effective project access</h2><p>Not configured. Global actor records do not establish project grants.</p></div><Status value="unknown"/></div><p className="fcp-empty-line">No canonical project grant record is available for this workspace.</p></section>}</>;
}
function Agents({route, access}: {route: PrototypeRoute; access: AccessData | null}) { const agents = access?.actors.filter((actor) => actor.type === 'agent') ?? []; return <><div className="fcp-page-title"><div><h1>Agents</h1><p>Shared human-supervised fleet.</p></div><Scope route={route}/></div><div className="fcp-list">{agents.length === 0 ? <Blank title="Agents not observed">No agent records are available from PostgreSQL.</Blank> : agents.map((agent) => <Link className="fcp-row fcp-agent-row" href={screenUrl({kind: 'agent', agentId: agent.id}, route.scope)} key={agent.id}><Bot aria-hidden="true" size={18}/><div><strong>{agent.displayName}</strong><small>{agent.role}</small></div><span>Linked observation not observed</span><Status value={agent.disabledAt === null ? 'ready' : 'blocked'}/><ChevronRight aria-hidden="true" size={16}/></Link>)}</div></>;
}
function AgentDetail({route, access}: {route: PrototypeRoute; access: AccessData | null}) { const agent = access?.actors.find((item) => item.id === route.agentId && item.type === 'agent') ?? null; if (agent === null) return <Blank title="Agent not observed">This agent is not available in the canonical access read model.</Blank>; return <><div className="fcp-page-title"><div><Crumbs route={route} project={null} title={agent.displayName}/><h1>{agent.displayName}</h1><p>{agent.role}</p></div><Status value={agent.disabledAt === null ? 'ready' : 'blocked'}/></div><div className="fcp-detail-layout"><main className="fcp-detail-main"><section className="fcp-section"><div className="fcp-section-head"><h2>Fleet observation</h2><Activity aria-hidden="true" size={17}/></div><p className="fcp-empty-line">No canonically linked observation recorded.</p></section><section className="fcp-section"><div className="fcp-section-head"><h2>Instructions</h2><Bot aria-hidden="true" size={17}/></div><p className="fcp-empty-line">Versioned effective instructions are not observed for this agent.</p></section></main><aside className="fcp-meta"><h2>Details</h2><DetailFacts items={[{label: 'Type', value: agent.type}, {label: 'Role', value: agent.role}, {label: 'State', value: agent.disabledAt === null ? 'Enabled' : 'Disabled'}, {label: 'Projects', value: 'Unknown'}]}/></aside></div></>;
}
function GlobalTasks({route, projects}: {route: PrototypeRoute; projects: readonly ProjectData[]}) {
  const visibleProjects = route.globalProject === undefined || route.globalProject === 'all' ? projects : projects.filter((project) => project.project.slug === route.globalProject);
  const rows = visibleProjects.flatMap((project) => project.workItems.map((task) => <TaskRow key={task.id} project={project.project.slug} route={route} task={task}/>));
  return <><div className="fcp-page-title"><div><h1>Tasks</h1><p>Canonical work items across configured projects.</p></div><Scope route={route}/></div><div className="fcp-list">{rows.length === 0 ? <p className="fcp-empty-line">No tasks observed for this project filter.</p> : rows}</div></>;
}
function GlobalChats({route}: {route: PrototypeRoute}) { return <><div className="fcp-page-title"><div><h1>Chats</h1><p>All configured projects.</p></div><Scope route={route}/></div><Blank title="Chats not configured">No canonical conversation or thread records are available.</Blank></>; }
function ProjectScreen({route, data}: {route: PrototypeRoute; data: PrototypeData}) {
  const project = ready(data.project);
  const runs = ready(data.runs);
  const access = ready(data.access);
  if (project === null) return <Blank title="Project not observed">This project is not available in the PostgreSQL read model.</Blank>;
  switch (route.screen) {
    case 'overview': return <Overview route={route} project={project} runs={runs}/>;
    case 'tasks': return <Tasks route={route} project={project}/>;
    case 'task': return <TaskDetail route={route} project={project} runs={runs} csrfToken={data.csrfToken ?? null}/>;
    case 'protocol': return <Protocol route={route} project={project} csrfToken={data.csrfToken ?? null}/>;
    case 'runs': return <Runs route={route} project={project} runs={runs}/>;
    case 'run': return <RunDetail route={route} project={project} runs={runs}/>;
    case 'chats': return <Chats route={route} project={project}/>;
    case 'access': return <Access route={route} project={project} access={access}/>;
    default: return null;
  }
}
export function PrototypeShell({route, data}: {route: PrototypeRoute; data: PrototypeData}) {
  const access = ready(data.access);
  const tokenStyle = {'--fcp-bg': operatorTokens.color.canvas, '--fcp-canvas': operatorTokens.color.surface, '--fcp-ink': operatorTokens.color.ink, '--fcp-muted': operatorTokens.color.muted, '--fcp-rule': operatorTokens.color.border, '--fcp-blue': operatorTokens.color.focus, '--fcp-red': operatorTokens.color.danger, '--fcp-amber': operatorTokens.color.warning, '--fcp-green': operatorTokens.color.success, '--fcp-target': `${operatorTokens.target.minimum}px`} as CSSProperties;
  return <div className="fcp-prototype" style={tokenStyle}><Header route={route}/><div className="fcp-main">{route.screen === 'dashboard' ? <Dashboard route={route} data={data}/> : route.screen === 'projects' ? <Projects route={route} data={data}/> : route.screen === 'global_tasks' ? <GlobalTasks route={route} projects={data.projectIndex}/> : route.screen === 'global_chats' ? <GlobalChats route={route}/> : route.screen === 'agents' ? <Agents route={route} access={access}/> : route.screen === 'agent' ? <AgentDetail route={route} access={access}/> : <ProjectScreen route={route} data={data}/>}</div></div>;
}
