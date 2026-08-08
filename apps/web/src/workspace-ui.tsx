import Link from 'next/link';
import type {CSSProperties, ReactNode} from 'react';
import {
  AlertTriangle, ArrowRight, Bot, ChevronLeft, ChevronRight, CircleDot, ClipboardList, FileCheck2, History,
  FolderKanban, GitPullRequest, LayoutDashboard, Link2, ListChecks,
  ExternalLink, Menu, ServerCog, ShieldAlert, ShieldCheck, UsersRound, Workflow
} from 'lucide-react';
import {DeliveryJourneyAction, DeliveryProtocolEditor} from './delivery-controls';
import {RunActionControls, TaskPacketBuildControls, TaskPacketPreview} from './delivery-workspace-controls';
import {type OperatorScreenRef, type OperatorScopeRef} from '@fai/operator-contracts';
import {operatorTokens} from '@fai/operator-tokens';
import {workItemStatuses} from './operator-data';
import type {
  AccessData, HealthData, OperatorLoad, OperatorProjectSlug, PortfolioData,
  ConversationsData, DeliveryLifecycleData, ProjectData, RunsData
} from './operator-data';
import {ProjectShareControls} from './project-share-controls';
import {RuntimeRegistrationControls} from './runtime-registration-controls';
import {AgentRetirementControls} from './agent-retirement-controls';

export type WorkspaceRoute = Readonly<{
  screen: 'dashboard' | 'projects' | 'global_tasks' | 'global_chats' | 'people' | 'overview' | 'tasks' | 'task' | 'protocol' | 'runs' | 'run' | 'chats' | 'access' | 'agents' | 'agent';
  project: OperatorProjectSlug | null;
  globalProject?: 'all' | OperatorProjectSlug;
  taskFilters?: Readonly<{
    view: 'board' | 'mine' | 'blocked';
    status: 'active' | 'all' | 'backlog' | 'ready' | 'in_dev' | 'qa' | 'acceptance' | 'done';
    attention: boolean;
    owner: string | null;
  }>;
  taskId: string | null;
  runId: string | null;
  agentId: string | null;
  accessActorId?: string | null;
  handoffResult?: 'accepted' | 'stale' | 'forbidden' | 'not_found' | 'unavailable' | null;
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
  operatorActorId?: string | null;
}>;

// Keep the internal component annotations small while public route contracts use WorkspaceRoute.
type WorkspaceUiRoute = WorkspaceRoute;

type ProjectTab = 'overview' | 'tasks' | 'protocol' | 'runs' | 'chats' | 'access';

const ready = <T,>(load: OperatorLoad<T> | null): T | null => load?.state === 'ready' ? load.data : null;
const date = (value: Date | null | undefined) => value === null || value === undefined ? 'Не зафиксировано' : new Intl.DateTimeFormat('ru-RU', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}).format(value);
const ruDate = (value: Date | null | undefined) => value === null || value === undefined ? 'Не зафиксировано' : new Intl.DateTimeFormat('ru-RU', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}).format(value);
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
const projectUrl = (slug: OperatorProjectSlug, tab: ProjectTab, scope: OperatorScopeRef) => screenUrl({kind: 'project', projectSlug: slug, section: tab}, scope);
const taskUrl = (slug: OperatorProjectSlug, id: string, scope: OperatorScopeRef) => screenUrl({kind: 'task', projectSlug: slug, taskId: id}, scope);
const runUrl = (slug: OperatorProjectSlug, id: string, scope: OperatorScopeRef) => screenUrl({kind: 'run', projectSlug: slug, runId: id}, scope);
const statusTone = (value: string) => value === 'failed' || value === 'blocked' || value === 'red' || value === 'stale' ? 'danger' : value === 'waiting_approval' || value === 'yellow' ? 'warning' : value === 'done' || value === 'green' || value === 'healthy' || value === 'enabled' ? 'success' : 'neutral';
const statusLabel = (value: string) => ({green: 'В норме', yellow: 'Внимание', red: 'Риск', done: 'Завершено', in_dev: 'В разработке', backlog: 'Бэклог', ready: 'Готово к старту', qa: 'Проверка', acceptance: 'Приёмка', running: 'Выполняется', queued: 'В очереди', waiting_approval: 'Ждёт подтверждения', failed: 'Ошибка', blocked: 'Заблокировано', pending: 'Ожидает', approved: 'Подтверждено', rejected: 'Отклонено', expired: 'Истекло', healthy: 'Работает', stale: 'Нет свежих данных', enabled: 'Включено', disabled: 'Отключено', unknown: 'Неизвестно', not_configured: 'Не настроено', accepted: 'Принято', review: 'Проверка', in_progress: 'В работе', not_started: 'Не начато'}[value] ?? 'Неизвестно');

const fleetHealth = (profiles: AccessData['agentSystems'][number]['profiles']) => {
  const values = profiles.map((profile) => profile.fleet.health);
  if (values.length === 0) return 'unknown';
  if (values.includes('stale')) return 'stale';
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('healthy')) return 'healthy';
  if (values.includes('not_configured')) return 'not_configured';
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
  return <div className="fcp-deferred-action"><button aria-describedby={hintId} disabled type="button">{label}</button><small id={hintId}>Следующий этап — {detail}</small></div>;
}
function Scope({route}: {route: WorkspaceUiRoute}) {
  // Scope remains in each route and link contract, but is not repeated in every page header.
  void route;
  return null;
}
const selectedProject = (
  route: WorkspaceUiRoute,
  projects: readonly Readonly<{slug: OperatorProjectSlug}>[]
): OperatorProjectSlug | null => {
  const requested = route.project ?? (route.globalProject === 'all' ? null : route.globalProject);
  return requested !== null && requested !== undefined && projects.some(({slug}) => slug === requested)
    ? requested
    : projects[0]?.slug ?? null;
};
const projectAreaUrl = (route: WorkspaceUiRoute, project: OperatorProjectSlug): string => {
  if (route.screen === 'global_tasks' || route.screen === 'tasks' || route.screen === 'task') return projectUrl(project, 'tasks', route.scope);
  if (route.screen === 'global_chats' || route.screen === 'chats') return projectUrl(project, 'chats', route.scope);
  if (route.screen === 'protocol') return projectUrl(project, 'protocol', route.scope);
  if (route.screen === 'runs' || route.screen === 'run') return projectUrl(project, 'runs', route.scope);
  if (route.screen === 'people' || route.screen === 'access') return projectUrl(project, 'access', route.scope);
  if (route.screen === 'agents' || route.screen === 'agent') return `/agents?project=${project}${scopeQuery(route.scope).replace('?', '&')}`;
  return projectUrl(project, 'overview', route.scope);
};

function WorkspaceShellHeader({route, projects}: {
  route: WorkspaceUiRoute;
  projects: readonly Readonly<{name: string; slug: OperatorProjectSlug}>[];
}) {
  const project = selectedProject(route, projects);
  const nav = project === null ? [] : [
    {label: 'Обзор', icon: LayoutDashboard, href: projectUrl(project, 'overview', route.scope), active: route.screen === 'dashboard' || route.screen === 'overview'},
    {label: 'Задачи', icon: ListChecks, href: projectUrl(project, 'tasks', route.scope), active: route.screen === 'global_tasks' || route.screen === 'tasks' || route.screen === 'task'},
    {label: 'Процесс', icon: Workflow, href: projectUrl(project, 'protocol', route.scope), active: route.screen === 'protocol' || route.screen === 'runs' || route.screen === 'run'},
    {label: 'Чаты', icon: UsersRound, href: projectUrl(project, 'chats', route.scope), active: route.screen === 'global_chats' || route.screen === 'chats'}
  ];
  const control = project === null ? [] : [
    {label: 'Команда и доступы', icon: ShieldCheck, href: projectUrl(project, 'access', route.scope), active: route.screen === 'people' || route.screen === 'access'},
    {label: 'Агенты и системы', icon: Bot, href: `/agents?project=${project}${scopeQuery(route.scope).replace('?', '&')}`, active: route.screen === 'agents' || route.screen === 'agent'}
  ];
  const activeLabel = [...nav, ...control].find((item) => item.active)?.label ?? 'Обзор';
  const currentProject = projects.find(({slug}) => slug === project) ?? null;
  const links = (items: typeof nav) => items.map(({label, icon: Icon, href, active}) => <Link aria-label={label} href={href} key={label} aria-current={active ? 'page' : undefined}><span className="fcp-nav-icon"><Icon aria-hidden="true" size={17}/></span><span>{label}</span></Link>);
  const home = project === null ? screenUrl({kind: 'projects'}, route.scope) : projectUrl(project, 'overview', route.scope);
  return <>
    <aside className="fcp-sidebar">
      <Link href={home} className="fcp-brand"><i aria-hidden="true">f</i><b>f(AI) Control</b></Link>
      <nav className="fcp-sidebar-section fcp-project-list-nav" aria-label="Доступные проекты"><span>Проекты</span>{projects.map((item) => <Link aria-current={project === item.slug ? 'page' : undefined} href={projectAreaUrl(route, item.slug)} key={item.slug}><i className={`fcp-project-initial fcp-project-initial--${item.slug}`}>{item.name[0]}</i><div><b>{item.name}</b><small>{item.slug === 'msa' ? 'Product Owner' : 'PO + Developer'}</small></div><CircleDot aria-label="Данные требуют проверки" size={13}/></Link>)}</nav>
      <nav className="fcp-sidebar-section fcp-sidebar-nav" aria-label="Рабочие разделы"><span>Работа</span>{links(nav)}</nav>
      <nav className="fcp-sidebar-section fcp-sidebar-nav" aria-label="Контроль"><span>Контроль</span>{links(control)}</nav>
      <div className="fcp-sidebar-settings"><span>Настройки</span><small>Изменение проекта и интеграций — следующий этап</small></div>
    </aside>
    <header className="fcp-topbar"><Link href={home} className="fcp-mobile-brand">f(AI) Control</Link><strong>{currentProject === null ? activeLabel : `${currentProject.name} · ${activeLabel}`}</strong><span className="fcp-access-count"><ShieldCheck aria-hidden="true" size={15}/>Доступ: {projects.length} проекта</span><span className="fcp-user-avatar" aria-label="Владимир">ВФ</span><details className="fcp-mobile-menu"><summary aria-label="Открыть навигацию"><Menu aria-hidden="true" size={20}/></summary><div className="fcp-mobile-menu-body"><nav aria-label="Доступные проекты"><span>Проекты</span>{projects.map((item) => <Link href={projectAreaUrl(route, item.slug)} key={item.slug} aria-current={project === item.slug ? 'page' : undefined}><FolderKanban aria-hidden="true" size={16}/>{item.name}</Link>)}</nav><nav aria-label="Рабочие разделы"><span>Работа</span>{[...nav, ...control].map(({label, icon: Icon, href, active}) => <Link href={href} key={label} aria-current={active ? 'page' : undefined}><Icon aria-hidden="true" size={16}/>{label}</Link>)}</nav></div></details></header>
  </>;
}
function Crumbs({route, project, title}: {route: WorkspaceUiRoute; project: ProjectData | null; title?: string}) {
  if (project === null) return null;
  return <div className="fcp-crumbs"><Link href={screenUrl({kind: 'projects'}, route.scope)}>Проекты</Link><ChevronRight aria-hidden="true" size={14}/><Link href={projectUrl(project.project.slug, 'overview', route.scope)}>{project.project.name}</Link>{title === undefined ? null : <><ChevronRight aria-hidden="true" size={14}/><strong>{title}</strong></>}</div>;
}
function ProjectHeader({route, project, title}: {route: WorkspaceUiRoute; project: ProjectData; title?: string}) {
  return <><Crumbs route={route} project={project} {...(title === undefined ? {} : {title})}/><div className="fcp-project-title"><div><h1>{title ?? project.project.name}</h1><span>{project.synchronizedAt === null ? 'Свежесть данных не зафиксирована' : `Обновлено: ${ruDate(project.synchronizedAt)}`}</span></div>{title === undefined ? <Status value={project.snapshot?.health ?? 'unknown'}/> : null}</div></>;
}
function ContextTabs({label, items}: {label: string; items: readonly Readonly<{label: string; href: string; active: boolean; count?: number}>[]}) {
  return <nav className="fcp-tabs fcp-context-tabs" aria-label={label}>{items.map((item) => <Link href={item.href} key={item.label} aria-current={item.active ? 'page' : undefined}>{item.label}{item.count === undefined ? null : <span>{item.count}</span>}</Link>)}</nav>;
}
function Summary({items}: {items: readonly Readonly<{label: string; value: string | number; tone?: string}>[]}) {
  return <dl className="fcp-summary">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd className={item.tone ?? ''}>{item.value}</dd></div>)}</dl>;
}
type WorkspaceProjectRef = Readonly<{name: string; slug: OperatorProjectSlug}>;
type ScopeProgress = Readonly<{
  totalWeight: number;
  acceptedWeight: number;
  states: readonly Readonly<{key: 'accepted' | 'review' | 'in-progress' | 'not-started'; label: string; weight: number}>[];
}>;
const selectedGlobalProject = (route: WorkspaceUiRoute) => route.globalProject === undefined || route.globalProject === 'all' ? null : route.globalProject;
const projectSelection = (route: WorkspaceUiRoute, projects: readonly WorkspaceProjectRef[]) => {
  const selected = selectedGlobalProject(route);
  return selected === null ? projects : projects.filter((project) => project.slug === selected);
};
function ProjectChooser({route, projects, title, detail, area}: {route: WorkspaceUiRoute; projects: readonly WorkspaceProjectRef[]; title: string; detail: string; area: 'overview' | 'tasks' | 'chats' | 'agents'}) {
  const choices = projectSelection(route, projects);
  const href = (project: WorkspaceProjectRef) => area === 'agents'
    ? `/agents?project=${project.slug}${scopeQuery(route.scope).replace('?', '&')}`
    : projectUrl(project.slug, area, route.scope);
  return <><div className="fcp-page-title"><div><h1>{title}</h1><p>{detail}</p></div><Scope route={route}/></div><section className="fcp-section"><div className="fcp-section-head"><h2>Доступные проекты</h2></div>{choices.length === 0 ? <p className="fcp-empty-line">Нет доступных проектов.</p> : <div className="fcp-list fcp-project-list">{choices.map((project) => <Link className="fcp-row fcp-project-row" href={href(project)} key={project.slug}><FolderKanban aria-hidden="true" size={18}/><div><strong>{project.name}</strong><small>Открыть рабочую область проекта</small></div><ChevronRight aria-hidden="true" size={16}/></Link>)}</div>}</section></>;
}
const scopeProgress = (project: ProjectData): ScopeProgress | null => {
  const baseline = project.scopeBaseline;
  if (baseline === null || baseline === undefined) return null;
  const configured = baseline.outcomes.filter((outcome) => outcome.state !== 'not_configured');
  const states = [
    {key: 'accepted' as const, label: 'Принято', state: 'accepted'},
    {key: 'review' as const, label: 'На проверке', state: 'review'},
    {key: 'in-progress' as const, label: 'В работе', state: 'in_progress'},
    {key: 'not-started' as const, label: 'Не начато', state: 'not_started'}
  ].map((item) => ({
    key: item.key,
    label: item.label,
    weight: configured.filter((outcome) => outcome.state === item.state).reduce((total, outcome) => total + outcome.weight, 0)
  }));
  return {
    totalWeight: configured.reduce((total, outcome) => total + outcome.weight, 0),
    acceptedWeight: states[0]!.weight,
    states
  };
};
function Dashboard({route, projects}: {route: WorkspaceUiRoute; projects: readonly ProjectData[]}) {
  return <><div className="fcp-page-title"><div><h1>Обзор проектов</h1><p>Подтверждённый прогресс каждого доступного проекта — по весу результатов.</p></div><Scope route={route}/></div><section className="fcp-dashboard-progress" aria-label="Прогресс доступных проектов">{projects.length === 0 ? <p className="fcp-empty-line">Нет доступных проектов.</p> : projects.map((project) => {
    const progress = scopeProgress(project);
    return <Link className="fcp-dashboard-progress-card" href={projectUrl(project.project.slug, 'overview', route.scope)} key={project.project.slug}><header><div><span>{project.project.name}</span><small>Принятый скоп</small></div><ChevronRight aria-hidden="true" size={18}/></header>{progress === null || progress.totalWeight === 0 ? <strong>Не настроено</strong> : <><strong>{progress.acceptedWeight} / {progress.totalWeight}</strong><div className="fcp-dashboard-progress-bar" aria-label={progress.states.map((item) => `${item.label}: ${item.weight}`).join(', ')}>{progress.states.map((item) => <span className={`fcp-scope-${item.key}`} key={item.key} style={{width: `${item.weight / progress.totalWeight * 100}%`}}/>)}</div><ul>{progress.states.map((item) => <li key={item.key} className={`fcp-scope-${item.key}`}><span aria-hidden="true"/>{item.label} {item.weight}</li>)}</ul></>}</Link>;
  })}</section></>;
}
function Projects({route, projects}: {route: WorkspaceUiRoute; projects: readonly WorkspaceProjectRef[]}) {
  return <ProjectChooser route={route} projects={projects} title="Проекты" detail="Выберите доступный проект, чтобы открыть его рабочую область." area="overview"/>;
}
function ScopeBurnUp({baseline}: {baseline: NonNullable<ProjectData['scopeBaseline']>}) {
  if (baseline.observations.length < 2) return <p className="fcp-burnup-empty">История принятого скопа ещё не зафиксирована — график появится после двух подтверждённых наблюдений.</p>;
  const totalWeight = baseline.outcomes.filter((outcome) => outcome.state !== 'not_configured').reduce((total, outcome) => total + outcome.weight, 0);
  const acceptedWeight = baseline.outcomes.filter((outcome) => outcome.state === 'accepted').reduce((total, outcome) => total + outcome.weight, 0);
  const points = baseline.observations.map((item, index, all) => {
    const x = 18 + (index * 464 / Math.max(1, all.length - 1));
    const y = 118 - Math.min(item.totalWeight, item.acceptedWeight) / item.totalWeight * 92;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return <figure className="fcp-burnup"><figcaption>Принятый скоп по подтверждённым наблюдениям</figcaption><svg viewBox="0 0 500 140" role="img" aria-label={`График принятого скопа: ${acceptedWeight} из ${totalWeight}`}><line className="fcp-burnup-total" x1="18" x2="482" y1="26" y2="26"/><text x="18" y="18">Текущий скоп {totalWeight}</text><polyline className="fcp-burnup-line" points={points}/><text x="482" y="132" textAnchor="end">Принято {acceptedWeight}</text></svg></figure>;
}
function ScopeBaseline({project}: {project: ProjectData}) {
  const baseline = project.scopeBaseline ?? null;
  if (baseline === null) return <section className="fcp-scope-baseline" id="scope"><div className="fcp-section-head"><div><h2>Принятый скоп</h2><span>Взвешенная база результатов</span></div></div><p className="fcp-empty-line">Скоп ещё не утверждён. Прогресс по количеству задач не показывается.</p></section>;
  const configured = baseline.outcomes.filter((outcome) => outcome.state !== 'not_configured');
  const totalWeight = configured.reduce((total, outcome) => total + outcome.weight, 0);
  const states = [{key: 'accepted', label: 'Принято', state: 'accepted'}, {key: 'review', label: 'Проверка', state: 'review'}, {key: 'in-progress', label: 'В работе', state: 'in_progress'}, {key: 'not-started', label: 'Не начато', state: 'not_started'}] as const;
  const outcomes = states.map((item) => ({...item, value: configured.filter((outcome) => outcome.state === item.state).reduce((total, outcome) => total + outcome.weight, 0)}));
  const acceptedWeight = outcomes[0]?.value ?? 0;
  return <section className="fcp-scope-baseline" id="scope"><header><div><span>Принятый скоп · версия {baseline.version}</span><strong>{totalWeight === 0 ? 'Не настроено' : `${acceptedWeight} / ${totalWeight}`}</strong><small>вес результатов, а не количество задач · обновлено {ruDate(baseline.updatedAt)}</small></div><Link href="#scope-checkpoint">Контрольная точка <ChevronRight aria-hidden="true" size={16}/></Link></header><div className="fcp-scope-outcomes"><ul aria-label="Состав принятого скопа">{outcomes.map((outcome) => <li key={outcome.key} className={`fcp-scope-${outcome.key}`}><span aria-hidden="true"/><b>{outcome.label} {outcome.value}</b></li>)}</ul>{totalWeight === 0 ? <p className="fcp-empty-line">Не настроено: результатам не назначено подтверждённое состояние.</p> : <div className="fcp-scope-bar" aria-label={outcomes.map((outcome) => `${outcome.label}: ${outcome.value}`).join(', ')}>{outcomes.map((outcome) => <span className={`fcp-scope-${outcome.key}`} key={outcome.key} style={{width: `${outcome.value / totalWeight * 100}%`}}/>)}</div>}<ScopeBurnUp baseline={baseline}/></div><div className="fcp-scope-records">{baseline.outcomes.map((outcome) => <article key={outcome.key}><strong>{outcome.title}</strong><span>{outcome.weight} · {outcome.state === 'not_configured' ? 'Не настроено' : statusLabel(outcome.state)}</span><small>{outcome.evidenceReference === null ? 'Подтверждение не зафиксировано' : `${outcome.evidenceReference}${outcome.acceptedBy === null ? '' : ` · ${outcome.acceptedBy}`}`}</small></article>)}</div><section className="fcp-checkpoint" id="scope-checkpoint"><header><h2>Ближайшая контрольная точка</h2><span>{baseline.checkpoint?.targetAt === null || baseline.checkpoint === null ? 'Срок не задан' : ruDate(baseline.checkpoint.targetAt)}</span></header>{baseline.checkpoint === null ? <p>Контрольная точка ещё не зафиксирована.</p> : <><strong>{baseline.checkpoint.title}</strong><div><Status value={baseline.checkpoint.status}/><span>{baseline.checkpoint.owner === null ? 'Ответственный не назначен' : `Ответственный: ${baseline.checkpoint.owner}`}</span></div></>}</section></section>;
}
function Overview({route, project, runs}: {route: WorkspaceUiRoute; project: ProjectData; runs: RunsData | null}) {
  const active = project.workItems.filter(({status}) => status !== 'backlog' && status !== 'done');
  const attention = project.workItems.filter((task) => taskNeedsAttention(task, project)).slice(0, 3);
  return <><ProjectHeader route={route} project={project}/><ContextTabs label="Разделы обзора" items={[{label: 'Сводка', href: projectUrl(project.project.slug, 'overview', route.scope), active: true}, {label: 'Скоп', href: '#scope', active: false}, {label: 'Риски', href: '#attention', active: false}]}/><ScopeBaseline project={project}/><section className="fcp-section" id="attention"><div className="fcp-section-head"><div><h2>Требует внимания</h2><span>Не более трёх подтверждённых рабочих сигналов</span></div><Link href={projectUrl(project.project.slug, 'tasks', route.scope)}>Открыть задачи</Link></div>{attention.length === 0 ? <p className="fcp-empty-line">Сигналов, требующих внимания, не зафиксировано.</p> : <div className="fcp-list">{attention.map((task) => <TaskRow project={project.project.slug} route={route} task={task} projectData={project} key={task.id}/>)}</div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Текущая работа</h2><Link href={projectUrl(project.project.slug, 'tasks', route.scope)}>Открыть задачи</Link></div>{active.length === 0 ? <p className="fcp-empty-line">Активные задачи не зафиксированы.</p> : <div className="fcp-list">{active.slice(0, 5).map((task) => <TaskRow project={project.project.slug} route={route} task={task} projectData={project} key={task.id}/>)}</div>}</section>{runs === null ? null : <section className="fcp-section"><div className="fcp-section-head"><h2>Последние запуски</h2><Link href={projectUrl(project.project.slug, 'runs', route.scope)}>Открыть запуски</Link></div>{runs.runs.length === 0 ? <p className="fcp-empty-line">Запуски не зафиксированы.</p> : <div className="fcp-list">{runs.runs.slice(0, 4).map((run) => <RunRow project={project.project.slug} route={route} run={run} key={run.id}/>)}</div>}</section>}</>;
}
type TaskResponsibility = Readonly<{name: string; source: 'journey' | 'assignment' | 'protocol'}>;
const protocolStageResponsibility = (
  project: ProjectData,
  access: AccessData | null,
  stage: NonNullable<ProjectData['protocol']>['definition']['stages'][number]
): TaskResponsibility | null => {
  if (access === null) return null;
  const responsibility = stage.responsibility;
  const actorId = responsibility.kind === 'actor'
    ? responsibility.actorId
    : access.memberships.find((membership) =>
        membership.projectId === project.project.id &&
        membership.active &&
        membership.role === responsibility.role)?.actorId;
  const actor = actorId === undefined ? undefined : access.actors.find((candidate) => candidate.id === actorId && candidate.disabledAt === null);
  return actor === undefined ? null : {name: actor.displayName, source: 'protocol'};
};
const taskResponsibility = (
  task: ProjectData['workItems'][number],
  project?: ProjectData,
  access?: AccessData | null
): TaskResponsibility | null => {
  const journeyActor = task.journey?.stage?.actor;
  if (journeyActor !== null && journeyActor !== undefined) return {name: journeyActor.displayName, source: 'journey'};
  if (task.owner !== null) return {name: task.owner, source: 'assignment'};
  const protocolStage = project?.protocol?.active === true
    ? project.protocol.definition.stages.find((stage) => stage.enabled && stage.taskStatus === task.status)
    : undefined;
  return project === undefined || protocolStage === undefined ? null : protocolStageResponsibility(project, access ?? null, protocolStage);
};
const effectiveTaskOwner = (task: ProjectData['workItems'][number], project?: ProjectData, access?: AccessData | null) =>
  taskResponsibility(task, project, access)?.name ?? null;
const taskNextAction = (task: ProjectData['workItems'][number], project?: ProjectData): string | null => {
  if (task.blocked) return 'Снять блокировку';
  if (task.handoff !== null) return task.handoff.label;
  const nextStage = task.journey?.stage?.nextStage;
  if (nextStage !== undefined && nextStage !== null) return `Перевести: ${nextStage}`;
  const stage = project?.protocol?.active === true
    ? project.protocol.definition.stages.find((candidate) => candidate.enabled && candidate.taskStatus === task.status)
    : undefined;
  if (stage?.allowedNextStageKey !== null && stage?.allowedNextStageKey !== undefined) {
    const next = project?.protocol?.definition.stages.find((candidate) => candidate.key === stage.allowedNextStageKey);
    return `Перевести: ${next?.name ?? stage.allowedNextStageKey}`;
  }
  return task.status === 'done' ? 'Завершено' : stage === undefined ? null : 'Завершить текущий этап';
};
const taskNeedsAttention = (task: ProjectData['workItems'][number], project?: ProjectData, access?: AccessData | null) =>
  task.blocked || effectiveTaskOwner(task, project, access) === null || taskNextAction(task, project) === null;
function TaskRow({project, route, task, projectData, access}: {project: OperatorProjectSlug; route: WorkspaceUiRoute; task: ProjectData['workItems'][number]; projectData?: ProjectData; access?: AccessData | null}) {
  const responsibility = taskResponsibility(task, projectData, access);
  return <Link className="fcp-row fcp-task-row" href={taskUrl(project, task.id, route.scope)}><Status value={task.blocked ? 'blocked' : task.status}/><div><strong>{task.title}</strong><small>{responsibility === null ? 'Ответственный не назначен' : `${responsibility.source === 'protocol' ? 'По протоколу · ' : ''}${responsibility.name}`}</small></div><span>{taskNextAction(task, projectData) ?? 'Следующее действие не настроено'}</span><time>{date(task.updatedAt)}</time><ChevronRight aria-hidden="true" size={16}/></Link>;
}
const selectedTaskFilters = (route: WorkspaceUiRoute) => route.taskFilters ?? {view: 'board' as const, status: 'all' as const, attention: false, owner: null};
function TaskFilters({route, owners, action}: {
  route: WorkspaceUiRoute;
  owners: readonly string[];
  action: string;
}) {
  const filters = selectedTaskFilters(route);
  const resetQuery = new URLSearchParams();
  if (filters.view !== 'board') resetQuery.set('view', filters.view);
  if (route.scope.environment !== null) resetQuery.set('environment', route.scope.environment);
  if (route.scope.from !== null) resetQuery.set('from', route.scope.from);
  if (route.scope.to !== null) resetQuery.set('to', route.scope.to);
  const reset = `${action}${resetQuery.size === 0 ? '' : `?${resetQuery.toString()}`}`;
  return <form action={action} className="fcp-task-filters" method="get">
    {filters.view === 'board' ? null : <input name="view" type="hidden" value={filters.view}/>}
    <label><span>Статус</span><select defaultValue={filters.status} name="status"><option value="active">В работе</option><option value="backlog">Бэклог</option><option value="ready">Готово к старту</option><option value="in_dev">Разработка</option><option value="qa">Проверка</option><option value="acceptance">Приёмка</option><option value="done">Завершено</option><option value="all">Все статусы</option></select></label>
    <label><span>Внимание</span><select defaultValue={filters.attention ? 'only' : 'all'} name="attention"><option value="all">Все</option><option value="only">Требует внимания</option></select></label>
    <label><span>Ответственный</span><select defaultValue={filters.owner ?? ''} name="owner"><option value="">Все</option>{owners.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
    {route.scope.environment === null ? null : <input name="environment" type="hidden" value={route.scope.environment}/>}
    {route.scope.from === null ? null : <input name="from" type="hidden" value={route.scope.from}/>}
    {route.scope.to === null ? null : <input name="to" type="hidden" value={route.scope.to}/>}
    <button type="submit">Применить</button><Link href={reset}>Сбросить</Link>
  </form>;
}
const taskViewUrl = (route: WorkspaceUiRoute, project: OperatorProjectSlug, view: 'board' | 'mine' | 'blocked') => {
  const query = new URLSearchParams();
  if (view !== 'board') query.set('view', view);
  if (route.scope.environment !== null) query.set('environment', route.scope.environment);
  if (route.scope.from !== null) query.set('from', route.scope.from);
  if (route.scope.to !== null) query.set('to', route.scope.to);
  return `/projects/${project}/tasks${query.size === 0 ? '' : `?${query.toString()}`}`;
};
const boardDescriptions: Record<ProjectData['workItems'][number]['status'], string> = {
  backlog: 'Не взято в работу', ready: 'Готово к старту', in_dev: 'Разработка', qa: 'Проверка', acceptance: 'Решение владельца', done: 'Принятый результат'
};
const boardColumnLabel: Record<ProjectData['workItems'][number]['status'], string> = {
  backlog: 'Бэклог', ready: 'Готово', in_dev: 'Разработка', qa: 'Проверка', acceptance: 'Приёмка', done: 'Завершено'
};
const providerTaskLabel = (task: ProjectData['workItems'][number]) => {
  if (task.externalUrl === null) return 'Задача';
  const match = task.externalUrl.match(/\/issues\/(\d+)(?:$|[?#])/);
  return match?.[1] === undefined ? 'Связанная задача' : `GitHub #${match[1]}`;
};
function TaskBoardCard({route, project, task, access}: {route: WorkspaceUiRoute; project: ProjectData; task: ProjectData['workItems'][number]; access: AccessData | null}) {
  const responsibility = taskResponsibility(task, project, access);
  const nextAction = taskNextAction(task, project);
  const needsAttention = taskNeedsAttention(task, project, access);
  return <Link className="fcp-board-card" href={taskUrl(project.project.slug, task.id, route.scope)}><header><span>{providerTaskLabel(task)}</span>{needsAttention ? <span className="fcp-board-attention"><AlertTriangle aria-hidden="true" size={13}/>Требует внимания</span> : null}</header><strong>{task.title}</strong><div><span>{responsibility === null ? 'Ответственный не назначен' : `${responsibility.source === 'protocol' ? 'По протоколу · ' : ''}${responsibility.name}`}</span><small>{nextAction ?? 'Следующее действие не настроено'}</small></div><time>{date(task.updatedAt)}</time></Link>;
}
function Tasks({route, project, access, operatorActorId}: {route: WorkspaceUiRoute; project: ProjectData; access: AccessData | null; operatorActorId: string | null}) {
  const entries = project.workItems.map((task) => ({project: project.project.slug, projectName: project.project.name, task}));
  const operator = access?.actors.find((actor) => actor.id === operatorActorId)?.displayName ?? null;
  const filters = selectedTaskFilters(route);
  const visible = entries.filter(({task}) => {
    const responsibility = effectiveTaskOwner(task, project, access);
    const viewMatches = filters.view === 'board' || (filters.view === 'mine' && operator !== null && responsibility === operator) || (filters.view === 'blocked' && task.blocked);
    const statusMatches = filters.status === 'all' || filters.status === 'active'
      ? filters.status === 'all' || ['ready', 'in_dev', 'qa', 'acceptance'].includes(task.status)
      : task.status === filters.status;
    return viewMatches && statusMatches && (!filters.attention || taskNeedsAttention(task, project, access)) && (filters.owner === null || responsibility === filters.owner);
  });
  const owners = [...new Set(entries.flatMap(({task}) => effectiveTaskOwner(task, project, access) ?? []))].sort();
  const mineCount = operator === null ? 0 : entries.filter(({task}) => effectiveTaskOwner(task, project, access) === operator).length;
  const blockedCount = entries.filter(({task}) => task.blocked).length;
  const statuses = filters.status === 'all' || filters.status === 'active'
    ? workItemStatuses.filter((status) => filters.status === 'all' || ['ready', 'in_dev', 'qa', 'acceptance'].includes(status))
    : [filters.status];
  return <><ProjectHeader route={route} project={project}/><ContextTabs label="Разделы задач" items={[
    {label: 'Доска', href: taskViewUrl(route, project.project.slug, 'board'), active: filters.view === 'board', count: entries.length},
    {label: 'Мои задачи', href: taskViewUrl(route, project.project.slug, 'mine'), active: filters.view === 'mine', count: mineCount},
    {label: 'Заблокировано', href: taskViewUrl(route, project.project.slug, 'blocked'), active: filters.view === 'blocked', count: blockedCount}
  ]}/><div className="fcp-section-head fcp-page-actions"><span>Только чтение · данные синхронизируются из подключённого трекера</span></div><TaskFilters action={`/projects/${project.project.slug}/tasks`} owners={owners} route={route}/><div className="fcp-board" aria-label={`${project.project.name} task board`}>{statuses.map((status) => {
    const tasks = visible.filter(({task}) => task.status === status);
    return <section className={`fcp-board-column fcp-board-column--${status}`} key={status}><header><div><h2>{boardColumnLabel[status]}</h2><span>{tasks.length}</span></div><p>{boardDescriptions[status]}</p></header><div>{tasks.length === 0 ? <p className="fcp-board-empty">Нет подходящих задач</p> : tasks.map(({task}) => <TaskBoardCard access={access} project={project} route={route} task={task} key={task.id}/>)}</div></section>;
  })}</div><div className="fcp-board-mobile-list" aria-label={`Список задач ${project.project.name}`}>{visible.length === 0 ? <p className="fcp-board-empty">Нет подходящих задач</p> : visible.map(({task}) => <TaskRow access={access} project={project.project.slug} projectData={project} route={route} task={task} key={task.id}/>)}</div></>;
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
function TaskDetail({route, project, runs, lifecycleLoad, csrfToken, operatorActorId}: {route: WorkspaceUiRoute; project: ProjectData; runs: RunsData | null; lifecycleLoad: OperatorLoad<DeliveryLifecycleData | null> | null; csrfToken: string | null; operatorActorId: string | null}) {
  const task = project.workItems.find((item) => item.id === route.taskId) ?? null;
  if (task === null) return <><ProjectHeader route={route} project={project} title="Task"/><Blank title="Task not observed">This task is not available in the selected project.</Blank></>;
  const packet = runs?.packets.find((item) => item.workItemId === task.id) ?? null;
  const run = runs?.runs.find((item) => item.workItemId === task.id) ?? null;
  const approval = runs?.approvals.find((item) => item.workItemId === task.id || item.agentRunId === run?.id) ?? null;
  const journey = task.journey ?? null;
  const stage = journey?.stage ?? null;
  const recordedEvidence = (journey?.evidence ?? []).map((entry) => ({
    ...entry,
    reference: `${entry.stageKey.replaceAll('_', ' ')} · ${entry.reference}`
  }));
  const nextRequiredEvidence = (journey?.requiredEvidence ?? []).filter((requirement) =>
    !recordedEvidence.some((entry) => entry.stageKey === journey?.stageKey && entry.requirement === requirement));
  const executionAction = task.blocked ? 'Resolve the recorded blocker before continuing.'
    : run !== null && (run.status !== 'done' || run.canAcceptReceipt || run.receipt === null)
      ? 'Open the run record and review its persisted receipt.'
      : packet !== null ? 'Simulate policy, confirm the immutable packet hash, and queue the run.'
        : task.canBuildPacket ? 'Build Task Packet from the current canonical task version.'
          : nextRequiredEvidence.length > 0 ? `Record required evidence: ${nextRequiredEvidence.join(', ')}.`
            : stage?.nextStage !== null && stage !== null ? `Advance to ${stage.nextStage}.` : 'No further protocol action is available.';
  return <><ProjectHeader route={route} project={project} title={task.title}/><div className="fcp-detail-layout"><main className="fcp-detail-main"><div className="fcp-detail-status"><Status value={task.blocked ? 'blocked' : task.status}/></div>{task.summary === null ? <p className="fcp-empty-line">Task summary not observed.</p> : <p className="fcp-task-summary">{task.summary}</p>}<section className="fcp-section"><div className="fcp-section-head"><h2>Delivery lifecycle</h2><span>PostgreSQL facts only</span></div><DeliveryLifecycleRail lifecycleLoad={lifecycleLoad} task={task}/></section><section className="fcp-section"><div className="fcp-section-head"><h2>Delivery protocol</h2><span>{journey === null ? 'Not configured' : `Protocol v${journey.protocolVersion}`}</span></div>{journey === null ? <p className="fcp-empty-line">Not configured. This legacy task is not bound to a delivery protocol.</p> : <div className="fcp-lifecycle-rail"><span aria-hidden="true"/><div><strong>{stage?.name ?? journey.stageKey}</strong><small>Task status: {statusLabel(stage?.taskStatus ?? task.status)} · {stage?.executionMode ?? 'Unknown mode'}</small></div><div><strong>Deadline</strong><small>{journey.deadlineAt === null ? 'Not set' : date(journey.deadlineAt)}</small></div><div><strong>Responsibility</strong><small>{stage?.actor === null || stage?.actor === undefined ? `${stage?.responsibility ?? 'Unknown'} · unresolved` : `${stage.actor.displayName} · ${stage.actor.type}`}</small></div><div><strong>Next allowed action</strong><small>{executionAction}</small></div></div>}<DeliveryJourneyAction workItemId={task.id} taskVersion={task.version ?? 0} journey={journey} activeProtocolId={project.protocol?.active === true ? project.protocol.id : null} csrfToken={csrfToken}/></section><section className="fcp-section"><div className="fcp-section-head"><h2>Execution</h2><ListChecks aria-hidden="true" size={17}/></div>{packet === null ? <TaskPacketBuildControls task={task} profiles={project.agentProfiles} csrfToken={csrfToken}/> : <TaskPacketPreview packet={packet} csrfToken={csrfToken} operatorActorId={operatorActorId}/>} {packet === null && !task.canBuildPacket && run === null ? <p className="fcp-empty-line">No task packet or run handoff is recorded.</p> : null}{run === null ? null : <div className="fcp-command"><div><strong>{task.handoff?.label ?? 'Run observed'}</strong><p>Execution facts are persisted in the governed run record.</p></div><Link className="fcp-primary" href={runUrl(project.project.slug, run.id, route.scope)}>Open run record</Link></div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Policy & approval</h2><ShieldCheck aria-hidden="true" size={17}/></div><p className="fcp-empty-line">{approval === null ? 'Not observed. Delivery does not create a #6 run or approval.' : `${statusLabel(approval.status)} · ${approval.environment}`}</p></section><section className="fcp-section"><div className="fcp-section-head"><h2>Evidence</h2><FileCheck2 aria-hidden="true" size={17}/></div>{journey === null ? <p className="fcp-empty-line">No protocol evidence requirements are configured.</p> : <div className="fcp-evidence-list">{recordedEvidence.length === 0 ? <p className="fcp-empty-line">No evidence references recorded for this stage.</p> : recordedEvidence.map((entry) => <p key={`${entry.requirement}:${entry.reference}`}><strong>{entry.requirement}</strong><span>{entry.reference}</span></p>)}{nextRequiredEvidence.length === 0 ? null : <p className="fcp-evidence-next"><strong>Next required</strong><span>{nextRequiredEvidence.join(', ')}</span></p>}</div>}</section></main><aside className="fcp-meta"><h2>Details</h2><DetailFacts items={[{label: 'Protocol', value: journey === null ? 'Not configured' : `v${journey.protocolVersion}`}, {label: 'Stage', value: stage?.name ?? 'Not configured'}, {label: 'Responsible human', value: stage?.actor?.type === 'human' ? stage.actor.displayName : task.owner ?? 'Unknown'}, {label: 'Responsible agent', value: stage?.actor?.type === 'agent' ? stage.actor.displayName : 'Unknown'}, {label: 'Approval', value: approval === null ? 'Not observed' : statusLabel(approval.status)}, {label: 'Deadline', value: journey?.deadlineAt === null || journey === null ? 'Not set' : date(journey.deadlineAt)}, {label: 'Source', value: task.externalUrl === null ? 'Not observed' : 'Provider observation'}, {label: 'Updated', value: date(task.updatedAt)}]}/>{task.externalUrl === null ? null : <a href={task.externalUrl} target="_blank" rel="noreferrer">Open provider source</a>}</aside></div></>;
}
const protocolModeLabel = (mode: NonNullable<ProjectData['protocol']>['definition']['stages'][number]['executionMode']) =>
  mode === 'autonomous' ? 'Автономно' : mode === 'human_approval' ? 'С подтверждением' : 'Вручную';
function Protocol({route, project, access, csrfToken}: {route: WorkspaceUiRoute; project: ProjectData; access: AccessData | null; csrfToken: string | null}) {
  const protocol = project.protocol ?? null;
  return <><ProjectHeader route={route} project={project}/><ContextTabs label="Разделы процесса" items={[
    {label: 'Этапы', href: projectUrl(project.project.slug, 'protocol', route.scope), active: true, count: protocol?.definition.stages.filter((stage) => stage.enabled).length ?? 0},
    {label: 'Запуски', href: projectUrl(project.project.slug, 'runs', route.scope), active: false},
    {label: 'Правила', href: '#protocol-rules', active: false}
  ]}/><section className="fcp-section"><div className="fcp-section-head"><div><h2>Как проект проходит разработку</h2><span>Текущая опубликованная последовательность</span></div><span>{protocol === null ? 'Не настроено' : `v${protocol.version} · ${protocol.active ? 'активен' : 'неактивен'}`}</span></div>{protocol === null ? <Blank title="Процесс не настроен">Нет сохранённого протокола разработки для этого проекта.</Blank> : <ol className="fcp-protocol-flow" aria-label={`${project.project.name} delivery protocol`}>{protocol.definition.stages.filter((stage) => stage.enabled).map((stage, index, stages) => {
    const responsibility = protocolStageResponsibility(project, access, stage);
    const next = stage.allowedNextStageKey === null ? null : protocol.definition.stages.find((candidate) => candidate.key === stage.allowedNextStageKey);
    return <li key={stage.key}><header><span>{String(index + 1).padStart(2, '0')}</span><Status value={stage.taskStatus}/></header><h3>{stage.name}</h3><dl><div><dt>Ответственный</dt><dd>{responsibility === null ? 'Ответственный не назначен' : `По протоколу · ${responsibility.name}`}</dd></div><div><dt>Режим</dt><dd>{protocolModeLabel(stage.executionMode)}</dd></div><div><dt>Подтверждение</dt><dd>{stage.executionMode === 'human_approval' ? 'Требуется' : 'Не требуется'}</dd></div><div><dt>Подтверждающие материалы</dt><dd>{stage.requiredEvidence.join(', ')}</dd></div></dl><footer>{stage.allowedNextStageKey === null ? <><FileCheck2 aria-hidden="true" size={15}/><span>Завершение процесса</span></> : <><ArrowRight aria-hidden="true" size={15}/><span>Далее: {next?.name ?? stage.allowedNextStageKey}</span></>}</footer>{index === stages.length - 1 ? null : <span className="fcp-protocol-connector" aria-hidden="true"/>}</li>;
  })}</ol>}</section><section className="fcp-section" id="protocol-rules"><div className="fcp-section-head"><div><h2>Правила и версии</h2><span>Управляемые изменения через canonical commands</span></div></div><details className="fcp-protocol-management"><summary>Открыть управление протоколом</summary><DeliveryProtocolEditor projectId={project.project.id} protocol={protocol} csrfToken={csrfToken}/></details></section></>;
}
function RunRow({project, route, run}: {project: OperatorProjectSlug; route: WorkspaceUiRoute; run: RunsData['runs'][number]}) {
  return <Link className="fcp-row fcp-run-row" href={runUrl(project, run.id, route.scope)}><Status value={run.status}/><div><strong>{run.workItem ?? 'Task not observed'}</strong><small>{run.agent ?? 'Agent unknown'} · {run.runtimeProfile}</small></div><span>{run.receipt?.terminal ?? 'Receipt not observed'}</span><time>{date(run.completedAt ?? run.startedAt)}</time><ChevronRight aria-hidden="true" size={16}/></Link>;
}
function Runs({route, project, runs}: {route: WorkspaceUiRoute; project: ProjectData; runs: RunsData | null}) {
  return <><ProjectHeader route={route} project={project}/>{runs === null ? <Blank title="Runs are unavailable">The canonical run read model could not be loaded.</Blank> : <div className="fcp-list">{runs.runs.length === 0 ? <p className="fcp-empty-line">No runs observed.</p> : runs.runs.map((run) => <RunRow project={project.project.slug} route={route} run={run} key={run.id}/>)}</div>}</>;
}
function RunDetail({route, project, runs, csrfToken}: {route: WorkspaceUiRoute; project: ProjectData; runs: RunsData | null; csrfToken: string | null}) {
  const run = runs?.runs.find((item) => item.id === route.runId) ?? null;
  if (run === null) return <><ProjectHeader route={route} project={project} title="Run"/><Blank title="Run not observed">This run is not available in the selected project.</Blank></>;
  const approval = runs?.approvals.find((item) => item.agentRunId === run.id) ?? null;
  const events = [{label: 'Run observed', value: run.startedAt}, {label: 'Policy decision', value: approval?.decidedAt ?? null}, {label: 'Run outcome', value: run.completedAt}, {label: 'Receipt observed', value: run.receipt?.completedAt ?? null}];
  const nextAction = run.status === 'queued' ? 'Wait for a governed claim or cancel this queued run.'
    : run.status === 'running' ? 'Wait for the runner to persist a terminal receipt.'
      : run.canAcceptReceipt ? 'Accept the persisted receipt to move the task to QA.'
        : run.status === 'failed' ? 'Return to the task, review failure evidence, and build a new immutable packet.'
          : run.receipt !== null ? 'Continue the delivery protocol from the task record.' : 'No action is allowed until a persisted receipt is observed.';
  return <><ProjectHeader route={route} project={project} title={run.workItem ?? 'Run receipt'}/><div className="fcp-detail-layout"><main className="fcp-detail-main"><div className="fcp-detail-status"><Status value={run.status}/><span className="fcp-muted">{run.agent ?? 'Agent unknown'}</span></div>{route.handoffResult === undefined || route.handoffResult === null ? null : <p className={`fcp-command-notice ${route.handoffResult === 'accepted' ? 'success' : 'error'}`}>{route.handoffResult === 'accepted' ? 'Receipt accepted. The task moved to QA.' : `Receipt was not accepted: ${route.handoffResult.replaceAll('_', ' ')}.`}</p>}<section className="fcp-section"><div className="fcp-section-head"><h2>Run receipt</h2><FileCheck2 aria-hidden="true" size={17}/></div><ol className="fcp-timeline">{events.map((event) => <li key={event.label}><span aria-hidden="true" className={event.value === null ? 'missing' : ''}/><div><strong>{event.label}</strong><small>{date(event.value)}</small></div></li>)}</ol></section><section className="fcp-section"><div className="fcp-section-head"><h2>Checks & evidence</h2><GitPullRequest aria-hidden="true" size={17}/></div><p className="fcp-empty-line">{run.artifacts.length === 0 ? 'No artifacts observed.' : `${run.artifacts.length} evidence artifact${run.artifacts.length === 1 ? '' : 's'} recorded.`}</p></section><section className="fcp-section"><div className="fcp-section-head"><h2>Next action</h2><ChevronRight aria-hidden="true" size={17}/></div><p className="fcp-empty-line">{nextAction}</p><RunActionControls run={run} csrfToken={csrfToken}/>{run.workItemId === null ? null : <Link className="fcp-primary" href={taskUrl(project.project.slug, run.workItemId, route.scope)}>Return to task record</Link>}</section></main><aside className="fcp-meta"><h2>Receipt details</h2><DetailFacts items={[{label: 'Task', value: run.workItem ?? 'Unknown'}, {label: 'Agent', value: run.agent ?? 'Unknown'}, {label: 'Approval', value: approval === null ? 'Not observed' : statusLabel(approval.status)}, {label: 'Environment', value: approval?.environment ?? 'Unknown'}, {label: 'Outcome', value: statusLabel(run.receipt?.terminal ?? run.status)}, {label: 'Observed', value: date(run.completedAt ?? run.startedAt)}]}/><details><summary>Technical details</summary><p>Runtime profile: {run.runtimeProfile}</p></details></aside></div></>;
}
function ConversationChannel({channel}: {channel: ConversationsData['projects'][number]['channels'][number]}) {
  const label = channel.conversationClass === 'internal' ? 'Внутренний чат' : 'Чат с клиентом';
  const stateLabel = channel.state === 'not_configured' ? 'Не настроено'
    : channel.state === 'empty' ? 'Сообщений пока нет'
      : channel.state === 'degraded' ? 'Синхронизация нарушена' : 'Синхронизировано';
  return <section className="fcp-conversation"><header><div><h2>{label}</h2><span>{stateLabel} · обновлено {date(channel.freshnessAt)}</span></div><Status value={channel.state === 'degraded' ? 'failed' : channel.state === 'ready' ? 'healthy' : 'unknown'}/></header>{channel.failure === null ? null : <p className="fcp-conversation-failure">Ошибка синхронизации: {channel.failure.code} · {date(channel.failure.at)} · событий: {channel.failure.count}</p>}{channel.state === 'not_configured' ? <p className="fcp-empty-line">Для проекта нет подтверждённой привязки этого типа чата.</p> : <div className="fcp-conversation-body"><aside><h3>Участники</h3>{channel.participants.length === 0 ? <p>Участники не зафиксированы.</p> : <ul>{channel.participants.map((participant) => <li key={participant.id}><strong>{participant.displayName}</strong><span>{participant.resolution === 'resolved' ? 'Личность подтверждена' : 'Не сопоставлен'} · {participant.controlPlaneAccess}</span></li>)}</ul>}</aside><ol className="fcp-message-list">{channel.messages.length === 0 ? <li className="fcp-empty-line">После подключения новых сообщений не зафиксировано.</li> : channel.messages.map((message) => <li key={message.id}><header><strong>{message.author}</strong><time>{date(message.sentAt)}</time></header>{message.text === null ? null : <p>{message.text}</p>}<footer>{message.reply ? <span>Ответ</span> : null}{message.threaded ? <span>Ветка</span> : null}{message.attachmentSummary === null ? null : <span>Вложения: {message.attachmentSummary}</span>}</footer></li>)}</ol></div>}</section>;
}
function Conversations({projects}: {projects: readonly ConversationsData['projects'][number][]}) {
  return <div className="fcp-conversation-projects">{projects.map((project) => <section key={project.id}><h2 className="fcp-conversation-project-name">{project.name}</h2><div className="fcp-conversation-grid">{project.channels.map((channel) => <ConversationChannel channel={channel} key={channel.conversationClass}/>)}</div></section>)}</div>;
}
function Chats({route, project, conversations}: {route: WorkspaceUiRoute; project: ProjectData; conversations: ConversationsData | null}) {
  const scoped = conversations?.projects.find((item) => item.id === project.project.id);
  return <><ProjectHeader route={route} project={project}/><div className="fcp-section-head fcp-page-actions"><span>Просмотр подтверждённых каналов · только чтение</span><DeferredAction label="Настроить участников" detail="управление чатами будет доступно на следующем этапе."/></div>{scoped === undefined ? <Blank title="Чаты недоступны">Не удалось загрузить подтверждённые данные каналов.</Blank> : <Conversations projects={[scoped]}/>}</>;
}
const roleLabel = (role: string) => ({project_owner: 'Владелец продукта', contributor: 'Разработчик', agent: 'ИИ-агент', workspace_admin: 'Администратор'}[role] ?? role.replaceAll('_', ' '));
const resourceLabel = (resource: string) => ({repository: 'Репозиторий', tracker: 'Проект / трекер', internal_chat: 'Внутренний чат', client_chat: 'Чат с клиентом'}[resource] ?? resource.replaceAll('_', ' '));
const grantConfirmationState = (grant: AccessData['resourceGrants'][number]) => {
  const observed = [grant.observedProvider, grant.observedLevel, grant.observedAt];
  if (observed.every((value) => value !== null)) {
    return grant.observedLevel === grant.desiredLevel ? 'Подтверждено' : 'Требует сверки';
  }
  if (observed.every((value) => value === null)) return 'Не подтверждено провайдером';
  return 'Неполные данные';
};
function ResourceGrant({grant, membership, csrfToken}: {
  grant: AccessData['resourceGrants'][number];
  membership: AccessData['memberships'][number];
  csrfToken: string | null;
}) {
  const confirmation = grantConfirmationState(grant);
  const provider = grant.observedProvider ?? 'provider';
  return <article><div><strong>{resourceLabel(grant.resourceType)}</strong><small>Требуемый уровень: {grant.desiredLevel} · версия {grant.version}</small></div><dl><div><dt>Роль в проекте</dt><dd>{membership.active ? roleLabel(membership.role) : 'Участие неактивно'}</dd></div><div><dt>Факт провайдера</dt><dd>{grant.observedLevel === null ? 'Не зафиксирован' : `${grant.observedLevel} · ${grant.observedProvider ?? 'провайдер неизвестен'}`}</dd></div><div><dt>Подтверждение</dt><dd>{confirmation}</dd></div><div><dt>Изменение</dt><dd>{grant.providerAccessUrl == null ? 'Не настроено' : <a href={grant.providerAccessUrl} target="_blank" rel="noreferrer" aria-label={`Управлять доступом ${resourceLabel(grant.resourceType)} в ${provider}`}>Открыть у провайдера <ExternalLink aria-hidden="true" size={13}/></a>}</dd></div></dl>{membership.canManage && csrfToken !== null ? <form action={`/api/access/grants/${grant.id}`} className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="expectedVersion" type="hidden" value={grant.version}/><label>Желаемый доступ<select defaultValue={grant.desiredLevel} name="desiredLevel"><option value="none">Нет</option><option value="read">Чтение</option><option value="write">Запись</option><option value="admin">Администратор</option></select></label><button className="fcp-primary-button" type="submit">Сохранить намерение</button><small>После сохранения Control Plane покажет расхождение до применения у провайдера.</small></form> : null}<small className="fcp-access-observed">Проверено {date(grant.observedAt)}</small></article>;
}
const providerAccessConfirmed = (
  access: AccessData,
  membership: AccessData['memberships'][number]
) => access.resourceGrants.some((grant) =>
  grant.projectId === membership.projectId
  && grant.actorId === membership.actorId
  && grant.observedLevel !== null
  && grant.observedAt !== null);
const accessState = (
  access: AccessData,
  membership: AccessData['memberships'][number],
  actor: AccessData['actors'][number]
) => !membership.active || actor.disabledAt !== null
  ? 'blocked'
  : providerAccessConfirmed(access, membership) ? 'ready' : 'unknown';
const accessResources = [
  {key: 'repository', label: 'Репозиторий'},
  {key: 'tracker', label: 'Проект / трекер'},
  {key: 'internal_chat', label: 'Внутренний чат'},
  {key: 'client_chat', label: 'Чат с клиентом'},
  {key: 'control_plane', label: 'Control Panel'},
  {key: 'runtime', label: 'Runtime'}
] as const;
function AccessMatrix({project, access, memberships, actors}: {project: ProjectData; access: AccessData; memberships: readonly AccessData['memberships'][number][]; actors: readonly AccessData['actors'][number][]}) {
  const cell = (actor: AccessData['actors'][number], membership: AccessData['memberships'][number], resource: typeof accessResources[number]) => {
    if (!membership.active) return {label: 'Роль отключена', tone: 'missing'};
    if (resource.key === 'control_plane') return {label: membership.active ? 'Только роль' : 'Не настроено', tone: membership.active ? 'role' : 'missing'};
    if (resource.key === 'runtime') {
      if (actor.type !== 'agent') return {label: 'Не применяется', tone: 'na'};
      const activeRuntime = access.agentSystems.find((item) => item.actorId === actor.id)?.profiles.some((profile) => profile.enabled && profile.registrations.some((registration) => registration.projectId === project.project.id && registration.enabled)) ?? false;
      return {label: activeRuntime ? 'Подтверждено' : 'Не настроено', tone: activeRuntime ? 'confirmed' : 'missing'};
    }
    if (project.project.slug === 'ascon' && (resource.key === 'internal_chat' || resource.key === 'client_chat')) return {label: 'Не применяется', tone: 'na'};
    const grant = access.resourceGrants.find((item) => item.projectId === project.project.id && item.actorId === actor.id && item.resourceType === resource.key);
    if (grant === undefined) return {label: 'Не настроено', tone: 'missing'};
    const confirmed = grant.observedLevel !== null && grant.observedAt !== null && grant.observedLevel === grant.desiredLevel;
    return {label: confirmed ? 'Подтверждено' : 'Только роль', tone: confirmed ? 'confirmed' : 'role'};
  };
  return <section className="fcp-access-matrix-section"><div className="fcp-section-head"><div><h2>Карта доступов проекта</h2><span>Роль показывает намерение, «Подтверждено» — факт от подключённого провайдера</span></div></div><div className="fcp-access-matrix-scroll"><table className="fcp-access-matrix"><thead><tr><th>Участник</th>{accessResources.map((resource) => <th key={resource.key}>{resource.label}</th>)}</tr></thead><tbody>{actors.map((actor) => { const membership = memberships.find((item) => item.actorId === actor.id)!; return <tr key={actor.id}><th><strong>{actor.displayName}</strong><small>{roleLabel(membership.role)}</small></th>{accessResources.map((resource) => { const state = cell(actor, membership, resource); return <td key={resource.key}><span className={`fcp-access-cell ${state.tone}`}>{state.label}</span></td>; })}</tr>; })}</tbody></table></div><div className="fcp-access-legend"><span><i className="confirmed"/>Подтверждено провайдером</span><span><i className="role"/>Роль задана, факт не подтверждён</span><span><i className="missing"/>Не настроено</span></div></section>;
}
function Access({route, project, access, csrfToken}: {route: WorkspaceUiRoute; project: ProjectData; access: AccessData | null; csrfToken: string | null}) {
  if (access === null) return <><ProjectHeader route={route} project={project}/><Blank title="Доступы недоступны">Не удалось загрузить подтверждённые данные ролей и доступов.</Blank></>;
  const memberships = access.memberships.filter((item) => item.projectId === project.project.id);
  const actors = memberships.flatMap((item) => access.actors.find((actor) => actor.id === item.actorId) ?? []);
  const selected = actors.find((actor) => actor.id === route.accessActorId) ?? actors[0] ?? null;
  const membership = selected === null ? null : memberships.find((item) => item.actorId === selected.id) ?? null;
  const identities = selected === null ? [] : access.externalIdentities.filter((item) => item.actorId === selected.id);
  const grants = selected === null ? [] : access.resourceGrants.filter((item) => item.projectId === project.project.id && item.actorId === selected.id);
  const profiles = selected === null ? [] : access.agentSystems.find((item) => item.actorId === selected.id)?.profiles ?? [];
  const actorUrl = (actorId: string) => `/projects/${project.project.slug}/access/${actorId}${scopeQuery(route.scope)}`;
  return <><ProjectHeader route={route} project={project}/><AccessMatrix access={access} actors={actors} memberships={memberships} project={project}/><div className={`fcp-access-layout${route.accessActorId === undefined || route.accessActorId === null ? '' : ' has-selection'}`}>
    <aside className="fcp-access-master"><div className="fcp-section-head"><div><h2>Участники</h2><span>Откройте строку для объяснения доступа</span></div></div>{actors.length === 0 ? <p className="fcp-empty-line">Участники проекта не зафиксированы.</p> : <div className="fcp-list">{actors.map((actor) => { const row = memberships.find((item) => item.actorId === actor.id)!; return <Link className="fcp-access-person" href={actorUrl(actor.id)} key={actor.id} aria-current={selected?.id === actor.id ? 'page' : undefined}><UsersRound aria-hidden="true" size={17}/><div><strong>{actor.displayName}</strong><small>{row.active ? roleLabel(row.role) : `${roleLabel(row.role)} · роль отключена`} · {actor.type === 'agent' ? 'ИИ-агент' : 'человек'}</small></div><Status value={accessState(access, row, actor)}/><ChevronRight aria-hidden="true" size={16}/></Link>; })}</div>}</aside>
    <main className="fcp-access-detail"><Link className="fcp-access-back" href={projectUrl(project.project.slug, 'access', route.scope)}><ChevronLeft aria-hidden="true" size={16}/>Участники</Link>{selected === null || membership === null ? <Blank title="Выберите участника">Нажмите на участника слева, чтобы увидеть происхождение его доступа.</Blank> : <>
      <div className="fcp-page-title fcp-access-title"><div><h1>{selected.displayName}</h1><p>Объяснение из роли, явных разрешений и наблюдений подключённого провайдера.</p></div><Status value={accessState(access, membership, selected)}/></div>
      <section className="fcp-section"><div className="fcp-section-head"><h2>Почему участник видит проект</h2><ShieldCheck aria-hidden="true" size={17}/></div><Summary items={[{label: 'Роль', value: membership.active ? roleLabel(membership.role) : 'Неактивна'}, {label: 'Участник', value: selected.disabledAt === null ? 'Включён' : 'Отключён'}, {label: 'Внешняя личность', value: identities.length === 0 ? 'Не зафиксирована' : `активных: ${identities.filter((item) => item.active).length}`}, {label: 'Явные разрешения', value: grants.length}]}/></section>
      <section className="fcp-section"><div className="fcp-section-head"><h2>Роль в проекте</h2><span>Роль Control Plane · версия {membership.version}</span></div>{membership.canManage && csrfToken !== null ? <form action={`/api/access/memberships/${membership.id}`} className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="expectedVersion" type="hidden" value={membership.version}/><label>Роль<select defaultValue={membership.role} name="role"><option value="workspace_owner">Владелец рабочей области</option><option value="project_owner">Владелец проекта</option><option value="contributor">Разработчик</option><option value="reviewer">Ревьюер</option><option value="client_viewer">Представитель клиента</option><option value="agent">ИИ-агент</option></select></label><label>Состояние<select defaultValue={String(membership.active)} name="active"><option value="true">Активна</option><option value="false">Отключена</option></select></label><button className="fcp-primary-button" type="submit">Сохранить роль</button></form> : <p className="fcp-empty-line">Для изменения роли нужны права владельца проекта и авторизованная сессия.</p>}</section>
      <section className="fcp-section"><div className="fcp-section-head"><h2>Доступ к ресурсам</h2><span>Требуемый и подтверждённый уровень</span></div>{grants.length === 0 ? <p className="fcp-empty-line">Явные разрешения не зафиксированы. Роль есть, доступ провайдера не настроен.</p> : <div className="fcp-access-grants">{grants.map((grant) => <ResourceGrant csrfToken={csrfToken} grant={grant} key={grant.id} membership={membership}/>)}</div>}</section>
      <section className="fcp-section"><div className="fcp-section-head"><h2>Внешние учётные записи</h2><span>Только подтверждённые привязки</span></div>{identities.length === 0 ? <p className="fcp-empty-line">Привязка к учётной записи провайдера не зафиксирована.</p> : <div className="fcp-identity-list">{identities.map((identity) => <span key={identity.provider}>{identity.provider} · {identity.active ? 'активна' : 'неактивна'}</span>)}</div>}</section>
      {selected.type !== 'agent' ? null : <section className="fcp-section"><div className="fcp-section-head"><h2>Привязки агента</h2><Bot aria-hidden="true" size={17}/></div>{profiles.length === 0 ? <p className="fcp-empty-line">Профиль runtime для агента не зафиксирован.</p> : <div className="fcp-access-grants">{profiles.map((profile) => <article key={profile.id}><div><strong>{profile.runtimeId} · {profile.runtimeProfile}</strong><small>{profile.enabled ? 'Профиль включён' : 'Профиль отключён'} · {profile.registrations.length} привязок к проектам</small></div><dl><div><dt>Текущая работа</dt><dd>{profile.latestRun === null ? 'Не зафиксировано' : profile.latestRun.status}</dd></div><div><dt>Последний результат</dt><dd>{profile.latestRun?.receipt === null || profile.latestRun?.receipt === undefined ? 'Не зафиксировано' : profile.latestRun.receipt.terminal}</dd></div><div><dt>Работоспособность runtime</dt><dd>Нет наблюдений</dd></div></dl></article>)}</div>}</section>}
    </>}</main>
  </div></>;
}
function AccessOperations({project, access, csrfToken}: {project: ProjectData; access: AccessData | null; csrfToken: string | null}) {
  if (access === null) return null;
  const shareProject = access.sharing.projects.find((item) => item.slug === project.project.slug);
  const projectShares = access.sharing.grants.filter((grant) => grant.projectSlug === project.project.slug);
  return <section className="fcp-access-operations" aria-label="Governed access operations">
    <details className="fcp-access-operation">
      <summary><Link2 aria-hidden="true" size={18}/><span><strong>Доступ клиента</strong><small>Ограниченные по сроку ссылки на задачи</small></span><b>{projectShares.filter((grant) => grant.active).length}</b><ChevronRight aria-hidden="true" size={16}/></summary>
      <div>{shareProject === undefined ? <p className="fcp-empty-line">Публичный доступ для проекта не настроен.</p> : <ProjectShareControls csrfToken={csrfToken} enabled={access.sharing.enabled} grants={projectShares} projects={[shareProject]} project={shareProject}/>}</div>
    </details>
    <details className="fcp-access-operation">
      <summary><ClipboardList aria-hidden="true" size={18}/><span><strong>Запросы доступа</strong><small>Управляемые заявки рабочей области</small></span><b>{access.requests.length}</b><ChevronRight aria-hidden="true" size={16}/></summary>
      <div>{access.requests.length === 0 ? <p className="fcp-empty-line">Запросы доступа не зафиксированы.</p> : <div className="fcp-access-request-list">{access.requests.map((request) => <article key={request.id}><div><strong>{request.requester}</strong><small>{resourceLabel(request.targetSurface)} · {request.requestedScope.length === 0 ? 'Область не зафиксирована' : request.requestedScope.join(', ')}</small></div><Status value={request.status}/><time>{request.expiresAt === null ? 'Срок не задан' : `Истекает ${date(request.expiresAt)}`}</time></article>)}</div>}</div>
    </details>
  </section>;
}
function SystemsSummary({health}: {health: HealthData | null}) {
  if (health === null) return <Blank title="Systems data is unavailable">Persisted operational facts could not be loaded.</Blank>;
  const unhealthy = health.jobs.filter((job) => job.status === 'unhealthy').length;
  return <><Summary items={[{label: 'Scheduled jobs', value: health.jobs.length}, {label: 'Unhealthy jobs', value: unhealthy, tone: unhealthy > 0 ? 'danger' : ''}, {label: 'Integration observations', value: health.integrations.length}, {label: 'Unresolved risks', value: health.risks.length, tone: health.risks.length > 0 ? 'danger' : ''}, {label: 'Audit facts', value: health.audit.length}]}/><div className="fcp-systems-grid"><SystemFacts icon={Workflow} title="Scheduled jobs" empty="No persisted scheduled jobs are recorded." items={health.jobs}>{(job) => <><strong>{job.project} · {job.name}</strong><span>{job.status} · heartbeat {date(job.heartbeatAt)} · last success {date(job.lastSuccessAt)} · next {date(job.nextRunAt)}</span></>}</SystemFacts><SystemFacts icon={ServerCog} title="Integration observations" empty="No persisted tracker snapshot operations are recorded." items={health.integrations}>{(item) => <><strong>{item.project} · {item.provider}</strong><span>{item.mode} · observed {date(item.createdAt)}</span></>}</SystemFacts><SystemFacts icon={ShieldAlert} title="Unresolved risks" empty="No unresolved risk signals are recorded." items={health.risks}>{(item) => <><strong>{item.project} · {item.severity}</strong><span>{item.summary} · updated {date(item.updatedAt)}</span></>}</SystemFacts><SystemFacts icon={History} title="Recovery & audit" empty="No canonical audit events are recorded." items={health.audit}>{(item) => <><strong>{item.project} · {item.action}</strong><span>{item.actor ?? 'No recorded actor'} · {item.outcome ?? 'No recorded outcome'} · {date(item.occurredAt)}</span></>}</SystemFacts></div><details className="fcp-system-details"><summary>All persisted systems facts</summary><div>{health.jobs.map((item) => <p key={item.id}>{item.project} · {item.name} · {item.status} · heartbeat {date(item.heartbeatAt)} · last success {date(item.lastSuccessAt)} · next {date(item.nextRunAt)}</p>)}{health.integrations.map((item) => <p key={item.id}>{item.project} · {item.provider} · {item.mode} · {date(item.createdAt)}</p>)}{health.risks.map((item) => <p key={item.id}>{item.project} · {item.severity} · {item.summary} · {date(item.updatedAt)}</p>)}{health.costLedger.length === 0 ? <p>No AgentRuns cost facts are recorded.</p> : health.costLedger.map((item) => <p key={`${item.runType}:${item.currency}:${item.state}`}>{item.runType} · {item.state} · {item.count} runs · {item.currency ?? 'No currency'}</p>)}{health.audit.map((item) => <p key={item.id}>{item.project} · {item.action} · {item.targetType} · {item.targetId ?? 'No recorded target ID'} · {item.policyDecision ?? 'No recorded policy decision'} · {item.reasonCode ?? 'No recorded reason code'}</p>)}</div></details></>;
}
function SystemFacts<T>({icon: Icon, title, empty, items, children}: {icon: typeof Bot; title: string; empty: string; items: readonly T[]; children: (item: T) => ReactNode}) { return <section className="fcp-system-card"><header><Icon aria-hidden="true" size={18}/><h2>{title}</h2><span>{items.length}</span></header>{items.length === 0 ? <p>{empty}</p> : <div>{items.slice(0, 3).map((item, index) => <article key={index}>{children(item)}</article>)}</div>}</section>; }
function Agents({route, access, health, projects}: {route: WorkspaceUiRoute; access: AccessData | null; health: HealthData | null; projects: readonly WorkspaceProjectRef[]}) {
  if (selectedGlobalProject(route) === null) return <ProjectChooser route={route} projects={projects} title="Агенты и системы" detail="Системы и runtime-факты доступны отдельно внутри проекта." area="agents"/>;
  const selectedProjectSlug = selectedGlobalProject(route);
  const selectedProject = projects.find((project) => project.slug === selectedProjectSlug) ?? null;
  const managedAgentIds = new Set(access?.memberships.flatMap((membership) =>
    membership.active &&
    membership.role === 'agent' &&
    (route.globalProject === undefined || route.globalProject === 'all' || membership.projectSlug === route.globalProject)
      ? [membership.actorId] : []) ?? []);
  const agents = access?.actors.filter((actor) => actor.type === 'agent' && managedAgentIds.has(actor.id)) ?? [];
  const systems = new Map<string, AccessData['agentSystems'][number]>(access?.agentSystems.map((item) => [item.actorId, item] as const) ?? []);
  return <><div className="fcp-page-title"><div><h1>Агенты и системы</h1><p>Работоспособность, текущая работа и последние результаты — без технического шума.</p></div><Scope route={route}/></div><div className="fcp-page-actions"><DeferredAction label="Добавить агента" detail="подключение новых агентов запланировано на следующий этап."/></div><section className="fcp-agent-command"><div className="fcp-section-head"><div><h2>Управляемые агенты</h2><span>{selectedProject?.name ?? 'Проект'} · факты из наблюдений runtime и подтверждённых receipts</span></div></div>{agents.length === 0 ? <Blank title="Управляемого агента нет">{selectedProjectSlug === 'ascon' ? 'Для ASCON это зафиксированное решение проекта: Владимир работает напрямую через Codex.' : 'В проекте нет активного участника с ролью ИИ-агента.'}</Blank> : agents.map((agent) => {
    const profiles = systems.get(agent.id)?.profiles ?? [];
    const healthState = agent.disabledAt === null ? fleetHealth(profiles) : 'disabled';
    const currentWork = profiles.find((profile) => profile.fleet.currentWork !== null)?.fleet.currentWork ?? null;
    const freshnessAt = profiles.map((profile) => profile.fleet.freshnessAt).filter((value): value is Date => value !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const lastReceipt = profiles.find((profile) => profile.fleet.lastReceipt !== null)?.fleet.lastReceipt ?? null;
    const components = profiles.flatMap((profile) => profile.registrations.flatMap((registration) => Object.entries(registration.availability.components).map(([name, fact]) => ({name, fact}))));
    return <article className="fcp-agent-hero" key={agent.id}><header><span className="fcp-agent-icon"><Bot aria-hidden="true" size={24}/></span><div><h2>{agent.displayName}</h2><p>{profiles.length === 0 ? 'Профиль не зафиксирован' : profiles.map((profile) => `${profile.runtimeId} · ${profile.runtimeProfile}`).join(' · ')}</p></div><Status value={healthState}/></header><div className="fcp-agent-vitals"><div><span>Последний heartbeat</span><strong>{date(freshnessAt)}</strong></div><div><span>Текущая работа</span><strong>{currentWork === null ? 'Активной задачи нет' : currentWork.title}</strong><small>{currentWork?.project ?? 'Проект не зафиксирован'}</small></div><div><span>Последний результат</span><strong>{lastReceipt === null ? 'Не зафиксирован' : statusLabel(lastReceipt.terminal)}</strong><small>{lastReceipt === null ? 'Receipt отсутствует' : `${lastReceipt.project} · ${date(lastReceipt.completedAt)}`}</small></div></div><div className="fcp-agent-components">{components.length === 0 ? <span className="fcp-component-chip unknown"><CircleDot aria-hidden="true" size={12}/>Компоненты не наблюдаются</span> : components.map(({name, fact}, index) => <span className={`fcp-component-chip ${statusTone(fact.state)}`} key={`${name}:${index}`}><CircleDot aria-hidden="true" size={12}/>{name} · {statusLabel(fact.state)}</span>)}</div><footer><Link className="fcp-primary" href={screenUrl({kind: 'agent', agentId: agent.id}, route.scope)}>Открыть управление <ChevronRight aria-hidden="true" size={15}/></Link></footer></article>;
  })}</section><details className="fcp-system-console"><summary><ServerCog aria-hidden="true" size={17}/><span><strong>Системные факты и диагностика</strong><small>Jobs, интеграции, риски и аудит</small></span><ChevronRight aria-hidden="true" size={16}/></summary><div><SystemsSummary health={health}/></div></details></>;
}
function AgentProfileSettings({profile, csrfToken}: {
  profile: AccessData['agentSystems'][number]['profiles'][number];
  csrfToken: string | null;
}) {
  return <section className="fcp-section fcp-settings">
    <div className="fcp-section-head"><h2>Настройки {profile.runtimeId}</h2><span>Изменение с контролем версии</span></div>
    {csrfToken === null
      ? <p className="fcp-empty-line">Для изменения нужна авторизованная сессия оператора.</p>
      : <form action={`/api/agent-profiles/${profile.id}`} className="fcp-profile-form" method="post">
          <input name="_csrf" type="hidden" value={csrfToken}/>
          <input name="expectedVersion" type="hidden" value={profile.version}/>
          <label>Инструкции<textarea defaultValue={profile.instructions} maxLength={2000} name="instructions" required rows={5}/></label>
          <label>Подтверждающие материалы<select defaultValue={String(profile.settings.includeEvidence)} name="includeEvidence"><option value="true">Обязательны</option><option value="false">Необязательны</option></select></label>
          <label>Состояние<select defaultValue={String(profile.enabled)} name="enabled"><option value="true">Включён</option><option value="false">Отключён</option></select></label>
          <button className="fcp-primary-button" type="submit">Сохранить настройки</button>
        </form>}
  </section>;
}
type InstructionRevisionView = Readonly<{
  id: string;
  version: number;
  instructions: string;
  createdAt: Date;
  rollbackOfVersionId: string | null;
}>;
function InstructionHistory({title, current, previous, scope, targetId, csrfToken}: {
  title: string;
  current: InstructionRevisionView | null;
  previous: InstructionRevisionView | null;
  scope: 'workspace' | 'agent_profile';
  targetId: string;
  csrfToken: string | null;
}) {
  return <details className="fcp-system-details fcp-instruction-history">
    <summary>{title}</summary>
    <div>{current === null ? <p>Версия не зафиксирована. Профильный override нельзя публиковать без базовой инструкции рабочей области.</p> : <>
      <p><strong>Версия {current.version}</strong> · утверждена и записана в аудит · {date(current.createdAt)}</p>
      <p>{current.rollbackOfVersionId === null ? 'Текущая версия опубликована напрямую.' : 'Текущая версия создана откатом к ранее утверждённому содержанию.'}</p>
      <details><summary>Текущее содержимое</summary><pre>{current.instructions}</pre></details>
      {previous === null ? <p>Предыдущая версия отсутствует: сравнение и откат пока недоступны.</p> : <details><summary>Разница с версией {previous.version}</summary><p>Предыдущая версия: {date(previous.createdAt)}.</p><pre>{previous.instructions}</pre><p>Эта версия может стать источником канонического отката после подтверждения менеджером.</p></details>}
    </>}</div>
    <p className="fcp-empty-line">{scope === 'workspace' ? 'Базовая инструкция применяется ко всем профилям; дополнение профиля накладывается поверх неё.' : 'Дополнение применяется только к этому профилю поверх базовой инструкции.'}</p>
    {csrfToken === null ? <p className="fcp-empty-line">Для публикации нужна авторизованная сессия оператора.</p> : <div className="fcp-instruction-controls"><form action="/api/instructions/versions" className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="action" type="hidden" value="publish"/><input name="scope" type="hidden" value={scope}/><input name="targetId" type="hidden" value={targetId}/><input name="expectedVersion" type="hidden" value={current?.version ?? 0}/><input name="rollbackOfVersionId" type="hidden" value=""/><label>Новая утверждённая версия<textarea defaultValue={current?.instructions ?? ''} maxLength={65536} name="instructions" required rows={6}/></label><button className="fcp-primary-button" type="submit">Опубликовать версию</button><small>Содержимое проверяется на секреты и записывается вместе с автором и записью аудита.</small></form>{current === null || previous === null ? null : <form action="/api/instructions/versions" className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="action" type="hidden" value="rollback"/><input name="scope" type="hidden" value={scope}/><input name="targetId" type="hidden" value={targetId}/><input name="expectedVersion" type="hidden" value={current.version}/><input name="instructions" type="hidden" value=""/><input name="rollbackOfVersionId" type="hidden" value={previous.id}/><button className="fcp-secondary" type="submit">Откатить к версии {previous.version}</button></form>}</div>}
  </details>;
}
function AgentDetail({route, access, csrfToken}: {route: WorkspaceUiRoute; access: AccessData | null; csrfToken: string | null}) {
  const agent = access?.actors.find((item) => item.id === route.agentId && item.type === 'agent') ?? null;
  if (agent === null) return <Blank title="Агент не найден">Агент отсутствует в подтверждённой модели доступов.</Blank>;
  if (access === null) return <Blank title="Агент недоступен">Не удалось загрузить подтверждённые данные агента.</Blank>;
  const profiles = access?.agentSystems.find((item) => item.actorId === agent.id)?.profiles ?? [];
  const health = agent.disabledAt === null ? fleetHealth(profiles) : 'disabled';
  return <><div className="fcp-page-title"><div><Crumbs route={route} project={null} title={agent.displayName}/><h1>{agent.displayName}</h1><p>Работоспособность, текущая работа и результаты из подтверждённых наблюдений.</p></div><div className="fcp-agent-title-actions"><Status value={health}/>{agent.disabledAt === null ? <AgentRetirementControls agentId={agent.id} agentName={agent.displayName} canRetire={access.canRetireAgents} csrfToken={csrfToken}/> : null}</div></div><div className="fcp-detail-layout"><main className="fcp-detail-main"><section className="fcp-section"><div className="fcp-section-head"><h2>Работоспособность</h2><ServerCog aria-hidden="true" size={17}/></div>{profiles.length === 0 ? <p className="fcp-empty-line">Профиль агента или привязка к проекту не зафиксированы.</p> : <div className="fcp-fleet-profiles">{profiles.map((profile) => <article key={profile.id}><header><div><strong>{profile.runtimeId} · {profile.runtimeProfile}</strong><small>{profile.enabled ? 'Профиль включён' : 'Профиль отключён'} · привязок к проектам: {profile.registrations.length}</small></div><Status value={profile.fleet.health}/></header>{profile.registrations.length === 0 ? <p className="fcp-empty-line">Проектная привязка не зафиксирована.</p> : <div className="fcp-registration-list">{profile.registrations.map((registration) => <div key={registration.id}><div><strong>{registration.project}</strong><small>{registration.provider}/{registration.runtimeKey} · версия привязки {registration.version}</small>{Object.entries(registration.availability.components).map(([component, fact]) => <small key={component}>{component} · {statusLabel(fact.state)} · {date(fact.observedAt)}</small>)}</div><Status value={registration.availability.health}/><RuntimeRegistrationControls agentId={agent.id} agentProfileId={profile.id} canManage={agent.disabledAt === null && registration.canManage} csrfToken={csrfToken} enabled={registration.enabled} expectedVersion={registration.version} projectId={registration.projectId} projectName={registration.project} registrationId={registration.id} replacementTargets={access === null ? [] : replacementTargets(access, agent.id, profile.id, registration.projectId)} staleRun={profile.fleet.health === 'stale' && profile.fleet.currentWork?.projectSlug === registration.projectSlug ? {id: profile.fleet.currentWork.id, version: profile.fleet.currentWork.version} : null}/></div>)}</div>}<dl><div><dt>Последний heartbeat</dt><dd>{date(profile.fleet.freshnessAt)}</dd></div><div><dt>Текущая работа</dt><dd>{profile.fleet.currentWork === null ? 'Не зафиксировано' : `${profile.fleet.currentWork.project} · ${profile.fleet.currentWork.title} · ${statusLabel(profile.fleet.currentWork.status)}`}</dd></div><div><dt>Последний результат</dt><dd>{profile.fleet.lastReceipt === null ? 'Не зафиксировано' : `${profile.fleet.lastReceipt.terminal} · ${profile.fleet.lastReceipt.project} · ${date(profile.fleet.lastReceipt.completedAt)}`}</dd></div></dl></article>)}</div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Действующие инструкции</h2><Bot aria-hidden="true" size={17}/></div>{profiles.length === 0 || profiles.every((profile) => profile.instruction === null) ? <p className="fcp-empty-line">Версии действующих инструкций для этого агента не зафиксированы.</p> : profiles.map((profile) => profile.instruction === null ? null : <article className="fcp-agent-profile" key={`${profile.id}:instruction`}><strong>{profile.runtimeId} · {profile.runtimeProfile}</strong><p>{profile.instruction.provenance} · hash действующей версии {profile.instruction.hash}</p>{profile.instruction.history === undefined ? null : <InstructionHistory title="Дополнение инструкции профиля" scope="agent_profile" targetId={profile.id} csrfToken={csrfToken} current={profile.instruction.history.override} previous={profile.instruction.history.previousOverride}/>}</article>)}</section>{agent.disabledAt === null ? profiles.map((profile) => <AgentProfileSettings csrfToken={csrfToken} key={`${profile.id}:settings`} profile={profile}/>) : null}</main><aside className="fcp-meta"><h2>Сводка</h2><DetailFacts items={[{label: 'Тип', value: agent.type}, {label: 'Роль', value: agent.role}, {label: 'Состояние участника', value: agent.disabledAt === null ? 'Включён' : 'Отключён'}, {label: 'Работоспособность', value: statusLabel(health)}, {label: 'Профили', value: String(profiles.length)}]}/></aside></div></>;
}
function GlobalTasks({route, projects}: {route: WorkspaceUiRoute; projects: readonly WorkspaceProjectRef[]}) {
  return <ProjectChooser route={route} projects={projects} title="Задачи проекта" detail="Доски задач доступны внутри проекта — общая смешанная очередь не поддерживается." area="tasks"/>;
}
function GlobalChats({route, projects}: {route: WorkspaceUiRoute; projects: readonly WorkspaceProjectRef[]}) {
  return <ProjectChooser route={route} projects={projects} title="Чаты проекта" detail="Таймлайны доступны отдельно внутри проекта." area="chats"/>;
}
function People({route, access, csrfToken}: {route: WorkspaceUiRoute; access: AccessData | null; csrfToken: string | null}) {
  if (access === null) return <><div className="fcp-page-title"><div><h1>Люди и доступы</h1><p>Роли, внешние учётные записи и действующие права.</p></div><Scope route={route}/></div><Blank title="Доступы недоступны">Не удалось загрузить подтверждённые данные ролей и доступов.</Blank></>;
  const membershipRows = access.memberships.filter(({active}) => active).flatMap((membership) => {
    const actor = access.actors.find((candidate) => candidate.id === membership.actorId);
    if (actor === undefined) return [];
    return [{membership, actor}];
  });
  const instructionBaselines = access.instructionBaselines ?? [];
  return <><div className="fcp-page-title"><div><h1>Люди и доступы</h1><p>Текущие роли, требуемые права и подтверждение подключённых провайдеров.</p></div><Scope route={route}/></div><section className="fcp-section"><div className="fcp-section-head"><h2>Участники проектов</h2><span>Роль не подтверждает внешний доступ</span></div>{membershipRows.length === 0 ? <p className="fcp-empty-line">Активные участники проектов не зафиксированы.</p> : <div className="fcp-list">{membershipRows.map(({membership, actor}) => { const confirmed = providerAccessConfirmed(access, membership); return <Link className="fcp-row fcp-people-row" href={`/projects/${membership.projectSlug}/access/${actor.id}${scopeQuery(route.scope)}`} key={`${membership.projectId}:${actor.id}`}><UsersRound aria-hidden="true" size={18}/><div><strong>{actor.displayName}</strong><small>{membership.project} · {roleLabel(membership.role)}{membership.role === 'agent' ? '' : ` · ${actor.type === 'human' ? 'человек' : 'система'}`}</small></div><Status value={accessState(access, membership, actor)}/><span>{actor.disabledAt !== null ? 'Участник отключён' : confirmed ? 'Доступ подтверждён провайдером' : 'Роль зафиксирована'}</span><ChevronRight aria-hidden="true" size={16}/></Link>; })}</div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Состояние доступов</h2><span>Фактические права остаются специфичными для провайдера</span></div><Summary items={[{label: 'Люди и агенты', value: access.actors.length}, {label: 'Активные роли', value: access.memberships.filter((membership) => membership.active).length}, {label: 'Внешние учётные записи', value: access.externalIdentities.filter((identity) => identity.active).length}, {label: 'Подтверждённые права', value: access.resourceGrants.filter((grant) => grant.observedLevel !== null && grant.observedAt !== null).length}]}/></section><section className="fcp-section"><div className="fcp-section-head"><div><h2>Управление · расширенные настройки</h2><span>Утверждённые версии инструкций без секретов</span></div></div>{instructionBaselines.length === 0 ? <p className="fcp-empty-line">Базовая инструкция рабочей области не зафиксирована.</p> : instructionBaselines.map((baseline) => <InstructionHistory key={baseline.workspaceId} title="Базовая инструкция рабочей области" scope="workspace" targetId="" csrfToken={csrfToken} current={baseline.current} previous={baseline.previous}/>)}</section></>;
}
function ProjectScreen({route, data}: {route: WorkspaceRoute; data: WorkspaceData}) {
  const project = ready(data.project);
  const runs = ready(data.runs);
  const access = ready(data.access);
  if (project === null) return <Blank title="Project not observed">This project is not available in the PostgreSQL read model.</Blank>;
  switch (route.screen) {
    case 'overview': return <Overview route={route} project={project} runs={runs}/>;
    case 'tasks': return <Tasks route={route} project={project} access={access} operatorActorId={data.operatorActorId ?? null}/>;
    case 'task': return <TaskDetail route={route} project={project} runs={runs} lifecycleLoad={data.lifecycle ?? null} csrfToken={data.csrfToken ?? null} operatorActorId={data.operatorActorId ?? null}/>;
    case 'protocol': return <Protocol route={route} project={project} access={access} csrfToken={data.csrfToken ?? null}/>;
    case 'runs': return <Runs route={route} project={project} runs={runs}/>;
    case 'run': return <RunDetail route={route} project={project} runs={runs} csrfToken={data.csrfToken ?? null}/>;
    case 'chats': return <Chats route={route} project={project} conversations={ready(data.conversations ?? null)}/>;
    case 'access': return <><Access route={route} project={project} access={access} csrfToken={data.csrfToken ?? null}/><AccessOperations project={project} access={access} csrfToken={data.csrfToken ?? null}/></>;
    default: return null;
  }
}
export function WorkspaceShell({route, data}: {route: WorkspaceRoute; data: WorkspaceData}) {
  const access = ready(data.access);
  const health = ready(data.health);
  const conversations = ready(data.conversations ?? null);
  const observedProjects = [
    ...(ready(data.portfolio)?.projects.map(({name, slug}) => ({name, slug})) ?? []),
    ...(data.project?.state === 'ready' && data.project.data !== null ? [{name: data.project.data.project.name, slug: data.project.data.project.slug}] : []),
    ...(data.projectIndex ?? []).map(({project}) => ({name: project.name, slug: project.slug})),
    ...(access?.memberships.filter((membership) => membership.active).map(({project: name, projectSlug: slug}) => ({name, slug})) ?? [])
  ].filter((project, index, projects) => projects.findIndex(({slug}) => slug === project.slug) === index);
  const operatorScoped = data.operatorActorId !== null && data.operatorActorId !== undefined;
  const authorizedSlugs = !operatorScoped
    ? new Set(observedProjects.map(({slug}) => slug))
    : new Set(access?.memberships.flatMap((membership) => membership.actorId === data.operatorActorId && membership.active ? [membership.projectSlug] : []) ?? []);
  const visibleProjects = observedProjects.filter(({slug}) => authorizedSlugs.has(slug));
  const requestedProject = route.project ?? selectedGlobalProject(route);
  const routeAllowed = requestedProject === null || !operatorScoped || authorizedSlugs.has(requestedProject);
  const selectedProject = selectedGlobalProject(route);
  const withinProjectScope = (slug: OperatorProjectSlug) => selectedProject === null
    ? !operatorScoped || authorizedSlugs.has(slug)
    : slug === selectedProject;
  const scopedHealth = health === null ? null : {
    ...health,
    jobs: health.jobs.filter((item) => withinProjectScope(item.projectSlug)),
    integrations: health.integrations.filter((item) => withinProjectScope(item.projectSlug)),
    risks: health.risks.filter((item) => withinProjectScope(item.projectSlug)),
    audit: health.audit.filter((item) => withinProjectScope(item.projectSlug)),
    costLedger: operatorScoped ? [] : health.costLedger
  };
  const scopedConversations = conversations === null ? null : {...conversations, projects: conversations.projects.filter((item) => withinProjectScope(item.slug))};
  const scopedAccess = access === null ? null : (() => {
    const memberships = access.memberships.filter((membership) => withinProjectScope(membership.projectSlug));
    const actorIds = operatorScoped || selectedProject !== null
      ? new Set(memberships.map((membership) => membership.actorId))
      : new Set(access.actors.map((actor) => actor.id));
    const sharing = access.sharing ?? {enabled: false, projects: [], grants: []};
    return {
      ...access,
      actors: access.actors.filter((actor) => actorIds.has(actor.id)),
      memberships,
      externalIdentities: (access.externalIdentities ?? []).filter((identity) => actorIds.has(identity.actorId)),
      resourceGrants: (access.resourceGrants ?? []).filter((grant) => withinProjectScope(grant.projectSlug) && actorIds.has(grant.actorId)),
      agentSystems: (access.agentSystems ?? [])
        .filter((system) => actorIds.has(system.actorId))
        .map((system) => ({
          ...system,
          profiles: system.profiles.map((profile) => ({
            ...profile,
            registrations: profile.registrations.filter((registration) => withinProjectScope(registration.projectSlug)),
            fleet: {
              ...profile.fleet,
              currentWork: profile.fleet.currentWork !== null && withinProjectScope(profile.fleet.currentWork.projectSlug) ? profile.fleet.currentWork : null,
              lastReceipt: profile.fleet.lastReceipt !== null && withinProjectScope(profile.fleet.lastReceipt.projectSlug) ? profile.fleet.lastReceipt : null
            }
          }))
        })),
      requests: operatorScoped ? [] : access.requests ?? [],
      secretRefs: operatorScoped ? [] : access.secretRefs ?? [],
      sharing: {...sharing, projects: sharing.projects.filter((project) => withinProjectScope(project.slug)), grants: sharing.grants.filter((grant) => withinProjectScope(grant.projectSlug))}
    };
  })();
  const tokenStyle = {'--fcp-bg': operatorTokens.color.canvas, '--fcp-canvas': operatorTokens.color.surface, '--fcp-ink': operatorTokens.color.ink, '--fcp-muted': operatorTokens.color.muted, '--fcp-rule': operatorTokens.color.border, '--fcp-blue': operatorTokens.color.focus, '--fcp-red': operatorTokens.color.danger, '--fcp-amber': operatorTokens.color.warning, '--fcp-green': operatorTokens.color.success, '--fcp-target': `${operatorTokens.target.minimum}px`} as CSSProperties;
  const scopedData = {
    ...data,
    ...(scopedAccess === null ? {} : {access: {state: 'ready' as const, data: scopedAccess}}),
    ...(scopedHealth === null ? {} : {health: {state: 'ready' as const, data: scopedHealth}}),
    ...(scopedConversations === null ? {} : {conversations: {state: 'ready' as const, data: scopedConversations}})
  };
  const content = !routeAllowed ? <Blank title="Проект недоступен">У текущего пользователя нет активного участия в этом проекте.</Blank>
    : route.screen === 'dashboard' ? <Dashboard route={route} projects={(data.projectIndex ?? []).filter((item) => authorizedSlugs.has(item.project.slug))}/>
      : route.screen === 'projects' ? <Projects route={route} projects={visibleProjects}/>
        : route.screen === 'global_tasks' ? <GlobalTasks route={route} projects={projectSelection(route, visibleProjects)}/>
          : route.screen === 'global_chats' ? <GlobalChats route={route} projects={projectSelection(route, visibleProjects)}/>
            : route.screen === 'people' ? <People route={route} access={scopedAccess} csrfToken={data.csrfToken ?? null}/>
              : route.screen === 'agents' ? <Agents route={route} access={scopedAccess} health={scopedHealth} projects={visibleProjects}/>
                : route.screen === 'agent' ? <AgentDetail route={route} access={scopedAccess} csrfToken={data.csrfToken ?? null}/>
                  : <ProjectScreen route={route} data={scopedData}/>;
  return <div className="fcp-workspace" style={tokenStyle}><div className="fcp-shell-layout"><WorkspaceShellHeader route={route} projects={visibleProjects}/><main className="fcp-main">{content}</main></div></div>;
}
