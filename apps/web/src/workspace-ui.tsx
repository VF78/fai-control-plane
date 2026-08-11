import Link from 'next/link';
import type {CSSProperties, ReactNode} from 'react';
import {
  AlertTriangle, ArrowRight, Bot, ChevronLeft, ChevronRight, CircleDot, ClipboardList, FileCheck2, History,
  FolderKanban, GitPullRequest, LayoutDashboard, Link2, ListChecks,
  ExternalLink, Menu, ServerCog, Settings2, ShieldAlert, ShieldCheck, UsersRound, Workflow
} from 'lucide-react';
import {DeliveryJourneyAction, DeliveryProtocolEditor, GovernedQaControls} from './delivery-controls';
import {RunActionControls, TaskPacketBuildControls, TaskPacketPreview} from './delivery-workspace-controls';
import {ProjectExecutionControls} from './project-execution-controls';
import {ProjectOutcomeAcceptanceControls} from './project-outcome-acceptance-controls';
import {ProjectAcceptanceControls} from './project-acceptance-controls';
import {ReleaseEvidenceControls} from './release-evidence-controls';
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
import {ProjectPlanControls} from './project-plan-controls';
import {RiskDispositionControls} from './risk-disposition-controls';
import {projectDossierReadiness} from '@fai-control-plane/domain';

export type WorkspaceRoute = Readonly<{
  screen: 'dashboard' | 'projects' | 'global_tasks' | 'global_chats' | 'people' | 'setup' | 'overview' | 'tasks' | 'task' | 'protocol' | 'runs' | 'run' | 'chats' | 'access' | 'agents' | 'agent';
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
const riskReasonLabel = (value: string) => ({
  'Worker queue has permanently failed work.': 'В рабочей очереди есть актуальная необработанная ошибка.',
  'Scheduled job is unhealthy': 'Регламентная задача не выполняется штатно',
  'GitHub status write failed': 'Не удалось передать статус задачи в GitHub',
  'Notification delivery failed': 'Не удалось доставить уведомление'
}[value] ?? value);
const riskActionLabel = (value: string | null) => value === null ? 'Следующее действие не зафиксировано' : ({
  inspect_failed_queue_jobs: 'Проверить последнюю ошибку очереди и повторить обработку после устранения причины.',
  inspect_or_recover_scheduled_job: 'Проверить регламентную задачу и восстановить её после устранения причины.',
  inspect_failed_status_writeback: 'Проверить публикацию статуса в GitHub и повторить её безопасно.',
  refresh_tracker_snapshot: 'Обновить снимок трекера после восстановления подключения.',
  review_runtime_registration_recovery: 'Проверить наблюдения runtime и принять решение о восстановлении.',
  review_stale_work_item: 'Проверить задачу без свежих изменений и зафиксировать следующее действие.'
}[value] ?? value.replaceAll('_', ' '));

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
    item.roles.length === 1 && item.roles[0] === 'agent' &&
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
  projects: readonly WorkspaceProjectRef[];
}) {
  const project = selectedProject(route, projects);
  const nav = project === null ? [] : [
    {label: 'Обзор', icon: LayoutDashboard, href: projectUrl(project, 'overview', route.scope), active: route.screen === 'dashboard' || route.screen === 'overview'},
    {label: 'Задачи', icon: ListChecks, href: projectUrl(project, 'tasks', route.scope), active: route.screen === 'global_tasks' || route.screen === 'tasks' || route.screen === 'task'},
    {label: 'Процесс', icon: Workflow, href: projectUrl(project, 'protocol', route.scope), active: route.screen === 'protocol' || route.screen === 'runs' || route.screen === 'run'},
    {label: 'Чаты', icon: UsersRound, href: projectUrl(project, 'chats', route.scope), active: route.screen === 'global_chats' || route.screen === 'chats'}
  ];
  const control = project === null ? [] : [
    {label: 'Агенты и системы', icon: Bot, href: `/agents?project=${project}${scopeQuery(route.scope).replace('?', '&')}`, active: route.screen === 'agents' || route.screen === 'agent'}
  ];
  const settings = project === null ? [] : [
    {label: 'План и подключения', icon: Settings2, href: `/projects/${project}/setup${scopeQuery(route.scope)}`, active: route.screen === 'setup'},
    {label: 'Роли и доступы', icon: ShieldCheck, href: projectUrl(project, 'access', route.scope), active: route.screen === 'people' || route.screen === 'access'}
  ];
  const activeLabel = [...nav, ...control, ...settings].find((item) => item.active)?.label ?? 'Обзор';
  const currentProject = projects.find(({slug}) => slug === project) ?? null;
  const links = (items: typeof nav) => items.map(({label, icon: Icon, href, active}) => <Link aria-label={label} href={href} key={label} aria-current={active ? 'page' : undefined}><span className="fcp-nav-icon"><Icon aria-hidden="true" size={17}/></span><span>{label}</span></Link>);
  const home = project === null ? screenUrl({kind: 'projects'}, route.scope) : projectUrl(project, 'overview', route.scope);
  return <>
    <aside className="fcp-sidebar">
      <Link href={home} className="fcp-brand"><i aria-hidden="true">f</i><b>f(AI) Control</b></Link>
      <nav className="fcp-sidebar-section fcp-project-list-nav" aria-label="Доступные проекты"><span>Проекты</span>{projects.map((item) => { const health = item.health ?? 'unknown'; return <Link aria-current={project === item.slug ? 'page' : undefined} href={projectAreaUrl(route, item.slug)} key={item.slug}><i className={`fcp-project-initial fcp-project-initial--${item.slug}`}>{item.name[0]}</i><div><b>{item.name}</b><small>{item.role ?? 'Доступен'}</small></div><CircleDot aria-label={`Состояние: ${statusLabel(health)}`} className={`fcp-project-health ${statusTone(health)}`} size={13}/></Link>; })}</nav>
      <nav className="fcp-sidebar-section fcp-sidebar-nav" aria-label="Рабочие разделы"><span>Работа</span>{links(nav)}</nav>
      <nav className="fcp-sidebar-section fcp-sidebar-nav" aria-label="Контроль"><span>Контроль</span>{links(control)}</nav>
      <nav className="fcp-sidebar-section fcp-sidebar-nav fcp-sidebar-settings" aria-label="Настройки"><span>Настройки</span>{links(settings)}</nav>
    </aside>
    <header className="fcp-topbar"><Link href={home} className="fcp-mobile-brand">f(AI) Control</Link><strong>{currentProject === null ? activeLabel : `${currentProject.name} · ${activeLabel}`}</strong><span className="fcp-access-count"><ShieldCheck aria-hidden="true" size={15}/>Доступ: {projects.length} проекта</span><span className="fcp-user-avatar" aria-label="Владимир">ВФ</span><details className="fcp-mobile-menu"><summary aria-label="Открыть навигацию"><Menu aria-hidden="true" size={20}/></summary><div className="fcp-mobile-menu-body"><nav aria-label="Доступные проекты"><span>Проекты</span>{projects.map((item) => <Link href={projectAreaUrl(route, item.slug)} key={item.slug} aria-current={project === item.slug ? 'page' : undefined}><FolderKanban aria-hidden="true" size={16}/>{item.name}</Link>)}</nav><nav aria-label="Рабочие разделы"><span>Работа</span>{[...nav, ...control].map(({label, icon: Icon, href, active}) => <Link href={href} key={label} aria-current={active ? 'page' : undefined}><Icon aria-hidden="true" size={16}/>{label}</Link>)}</nav><nav aria-label="Настройки"><span>Настройки</span>{settings.map(({label, icon: Icon, href, active}) => <Link href={href} key={label} aria-current={active ? 'page' : undefined}><Icon aria-hidden="true" size={16}/>{label}</Link>)}</nav></div></details></header>
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
type WorkspaceProjectRef = Readonly<{name: string; slug: OperatorProjectSlug; role?: string; health?: string}>;
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
const nearestProjectDeadline = (project: ProjectData): Date | null => {
  const dates = [project.scopeBaseline?.checkpoint?.targetAt ?? null,
    ...project.workItems.filter((item) => item.status !== 'done').map((item) => item.journey?.deadlineAt ?? null)]
    .filter((value): value is Date => value !== null)
    .sort((left, right) => left.getTime() - right.getTime());
  return dates[0] ?? null;
};
function Dashboard({route, projects, portfolio}: {
  route: WorkspaceUiRoute; projects: readonly ProjectData[]; portfolio: PortfolioData | null;
}) {
  return <><div className="fcp-page-title"><div><h1>Обзор проектов</h1><p>Подтверждённый прогресс каждого доступного проекта — по весу результатов.</p></div><Scope route={route}/></div><section className="fcp-dashboard-progress" aria-label="Прогресс доступных проектов">{projects.length === 0 ? <p className="fcp-empty-line">Нет доступных проектов.</p> : projects.map((project) => {
    const progress = scopeProgress(project);
    const facts = portfolio?.projects.find((item) => item.id === project.project.id) ?? null;
    const topRisk = portfolio?.attention.find((item) =>
      item.projectId === project.project.id && item.riskSignalId !== null) ?? null;
    const deadline = nearestProjectDeadline(project);
    return <Link className="fcp-dashboard-progress-card" href={projectUrl(project.project.slug, 'overview', route.scope)} key={project.project.slug}>
      <header><div><span>{project.project.name}</span><small>Принятый скоп</small></div><Status value={facts?.health ?? 'unknown'}/></header>
      {progress === null || progress.totalWeight === 0 ? <strong>Не настроено</strong> : <>
        <strong>{progress.acceptedWeight} / {progress.totalWeight}</strong>
        <div className="fcp-dashboard-progress-bar" aria-label={progress.states.map((item) => `${item.label}: ${item.weight}`).join(', ')}>{progress.states.map((item) => <span className={`fcp-scope-${item.key}`} key={item.key} style={{width: `${item.weight / progress.totalWeight * 100}%`}}/>)}</div>
        <ul>{progress.states.map((item) => <li key={item.key} className={`fcp-scope-${item.key}`}><span aria-hidden="true"/>{item.label} {item.weight}</li>)}</ul>
      </>}
      <dl className="fcp-dashboard-facts">
        <div><dt>Текущий этап</dt><dd>{project.execution?.selection?.stageName ?? (project.execution?.status === 'completed' ? 'Завершено' : 'Не определён')}</dd></div>
        <div><dt>Ближайший срок</dt><dd>{deadline === null ? 'Не задан' : ruDate(deadline)}</dd></div>
        <div><dt>Риски</dt><dd>{facts === null ? 'Не загружены' : facts.unresolvedRiskCount}</dd></div>
        <div><dt>Главный риск</dt><dd>{topRisk?.reason ?? 'Нет открытых рисков'}</dd></div>
      </dl>
      {topRisk === null ? null : <p className="fcp-dashboard-risk">{topRisk.owner ?? 'Ответственный не назначен'} · {date(topRisk.freshness)}<br/>{topRisk.nextAction}</p>}
    </Link>;
  })}</section></>;
}
const setupLabel = (state: string) => ({
  pending: 'Ожидает настройки', in_progress: 'Настройка выполняется', blocked: 'Нужно вмешательство'
}[state] ?? 'Не настроено');
const setupConfigLabel = (value: string) => ({
  none: 'Не подключать', link_existing: 'Связать существующий', create_managed: 'Создать управляемый',
  manual: 'Ручной', managed_agent: 'Управляемый ИИ-агент'
}[value] ?? 'Не настроено');
function Projects({route, projects, access, csrfToken, operatorActorId}: {
  route: WorkspaceUiRoute; projects: readonly ProjectData[]; access: AccessData | null;
  csrfToken: string | null; operatorActorId: string | null;
}) {
  const operator = access?.actors.find((actor) => actor.id === operatorActorId);
  const canCreate = csrfToken !== null && operator?.type === 'human' && operator.role === 'workspace_admin' &&
    operator.capabilities['write:control_plane:development'] === true;
  const people = access?.actors.filter((actor) => actor.type === 'human' && actor.disabledAt === null) ?? [];
  const members = access?.actors.filter((actor) => (actor.type === 'human' || actor.type === 'agent') && actor.disabledAt === null) ?? [];
  const profiles = access?.agentSystems.flatMap((system) => system.profiles.filter((profile) => profile.enabled).map((profile) => ({
    id: profile.id, actorId: system.actorId, label: `${access.actors.find((actor) => actor.id === system.actorId)?.displayName ?? 'Агент'} · ${profile.runtimeId}/${profile.runtimeProfile}`
  }))) ?? [];
  return <><div className="fcp-page-title"><div><h1>Проекты</h1><p>Каждый проект открывается отдельно; смешанной межпроектной панели нет.</p></div></div>
    <section className="fcp-project-intake-grid" aria-label="Доступные проекты">{projects.length === 0 ? <p className="fcp-empty-line">Нет доступных проектов.</p> : projects.map((item) => {
      const state = item.setup?.state ?? 'not_configured';
      const href = item.setup == null ? projectUrl(item.project.slug, 'overview', route.scope) : `/projects/${item.project.slug}/setup${scopeQuery(route.scope)}`;
      return <Link className="fcp-project-intake-card" href={href} key={item.project.id}><header><div><strong>{item.project.name}</strong><small>{item.project.slug}</small></div><ChevronRight aria-hidden="true" size={18}/></header><Status value={state}/><p>{state === 'blocked' ? 'Откройте детали и устраните зафиксированную причину.' : 'Внешние ресурсы ещё не подтверждены; настройку можно продолжить.'}</p></Link>;
    })}</section>
    <section className="fcp-section"><div className="fcp-section-head"><div><h2>Создать проект</h2><span>Проект, роли и план настройки фиксируются одной командой</span></div></div>{!canCreate ? <p className="fcp-empty-line">Нужна авторизованная сессия администратора рабочей области.</p> : <form action="/api/projects" method="post" className="fcp-project-intake-form">
      <input name="_csrf" type="hidden" value={csrfToken}/><input name="idempotencyKey" type="hidden" value={crypto.randomUUID()}/>
      <label>Название<input name="name" maxLength={120} required/></label><label>Slug<input name="slug" pattern="[a-z][a-z0-9-]{1,47}" maxLength={48} required/></label>
      <label>Product Owner<select name="productOwnerActorId" required><option value="">Выберите человека</option>{people.map((actor) => <option value={actor.id} key={actor.id}>{actor.displayName}</option>)}</select></label><label><input name="productOwnerContributor" type="checkbox" value="true"/>Product Owner также выполняет задачи как Разработчик</label>
      <details className="fcp-project-intake-details"><summary>Участники и роли <span>Необязательно</span></summary><fieldset><legend>До 8 начальных участников</legend>{Array.from({length: 8}, (_, index) => <div className="fcp-project-member-row" key={index}><select aria-label={`Участник ${index + 1}`} name={`memberActorId${index}`}><option value="">Не выбран</option>{members.map((actor) => <option value={actor.id} key={actor.id}>{actor.displayName} · {actor.type === 'agent' ? 'агент' : 'человек'}</option>)}</select><label><input aria-label={`Разработчик ${index + 1}`} name={`memberContributor${index}`} type="checkbox" value="true"/>Разработчик</label><select aria-label={`Дополнительная роль участника ${index + 1}`} name={`memberRole${index}`}><option value="">Без дополнительной роли</option><option value="reviewer">Ревьюер</option><option value="client_viewer">Клиент</option><option value="agent">Агент</option></select></div>)}</fieldset></details>
      <details className="fcp-project-intake-details"><summary>Подключения и исполнение <span>Можно настроить позже</span></summary><div className="fcp-project-intake-options">{[['repositoryBinding', 'Репозиторий'], ['trackerBinding', 'Трекер'], ['internalChat', 'Внутренний чат'], ['clientChat', 'Клиентский чат']].map(([name, label]) => <label key={name}>{label}<select name={name}><option value="none">Не подключать</option><option value="link_existing">Связать существующий</option><option value="create_managed">Создать управляемый</option></select></label>)}<label>Режим исполнения<select name="executionMode"><option value="manual">Ручной</option><option value="managed_agent">Управляемый агент</option></select></label><label>Профиль агента<select name="agentProfileId"><option value="">Без профиля</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.label}</option>)}</select></label></div></details>
      <button className="fcp-primary-button" type="submit">Создать проект</button><small>Провайдеры не вызываются. После создания статус останется «Ожидает настройки» до подтверждённых наблюдений.</small>
    </form>}</section></>;
}

function ProjectSetup({route, project, csrfToken, canEditPlan, canApprovePlan}: {route: WorkspaceUiRoute; project: ProjectData; csrfToken: string | null; canEditPlan: boolean; canApprovePlan: boolean}) {
  const setup = project.setup ?? null;
  if (setup === null) return <><ProjectHeader route={route} project={project}/><Blank title="Настройка не заведена">Для этого ранее созданного проекта нет setup-aggregate.</Blank></>;
  const config = setup.configuration;
  return <><ProjectHeader route={route} project={project}/><section className="fcp-section fcp-setup-detail"><div className="fcp-section-head"><div><h2>Настройка проекта</h2><span>Версия {setup.version} · {setupLabel(setup.state)}</span></div><Status value={setup.state}/></div><p>Намерения сохранены. Ресурс считается подключённым только после подтверждённого факта от провайдера.</p>{setup.lastErrorCode === null ? null : <p>Причина остановки: <code>{setup.lastErrorCode}</code>. Повторите соответствующий шаг после устранения причины.</p>}<dl><div><dt>Репозиторий</dt><dd>{setupConfigLabel(config.repositoryBinding)}</dd></div><div><dt>Трекер</dt><dd>{setupConfigLabel(config.trackerBinding)}</dd></div><div><dt>Внутренний чат</dt><dd>{setupConfigLabel(config.internalChat)}</dd></div><div><dt>Клиентский чат</dt><dd>{setupConfigLabel(config.clientChat)}</dd></div><div><dt>Исполнение</dt><dd>{setupConfigLabel(config.executionMode)}</dd></div></dl><Link className="fcp-primary-button" href={projectUrl(project.project.slug, 'overview', route.scope)}>Открыть обзор проекта</Link></section><section className="fcp-section" id="plan"><div className="fcp-section-head"><div><h2>План проекта</h2><span>Источники → черновик → проверка → неизменяемая версия</span></div></div>{project.plan === undefined ? <p className="fcp-empty-line">Планирование недоступно.</p> : <ProjectPlanControls projectId={project.project.id} plan={project.plan} csrfToken={csrfToken} canEdit={canEditPlan} canApprove={canApprovePlan}/>}</section></>;
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
function ScopeBaseline({project, csrfToken, canApproveOutcome}: {
  project: ProjectData; csrfToken: string | null; canApproveOutcome: boolean;
}) {
  const baseline = project.scopeBaseline ?? null;
  if (baseline === null) return <section className="fcp-scope-baseline" id="scope"><div className="fcp-section-head"><div><h2>Принятый скоп</h2><span>Взвешенная база результатов</span></div></div><p className="fcp-empty-line">Скоп ещё не утверждён. Прогресс по количеству задач не показывается.</p></section>;
  const configured = baseline.outcomes.filter((outcome) => outcome.state !== 'not_configured');
  const totalWeight = configured.reduce((total, outcome) => total + outcome.weight, 0);
  const states = [{key: 'accepted', label: 'Принято', state: 'accepted'}, {key: 'review', label: 'Проверка', state: 'review'}, {key: 'in-progress', label: 'В работе', state: 'in_progress'}, {key: 'not-started', label: 'Не начато', state: 'not_started'}] as const;
  const outcomes = states.map((item) => ({...item, value: configured.filter((outcome) => outcome.state === item.state).reduce((total, outcome) => total + outcome.weight, 0)}));
  const acceptedWeight = outcomes[0]?.value ?? 0;
  const executionCanAccept = project.execution.status === 'paused' || project.execution.status === 'blocked';
  return <section className="fcp-scope-baseline" id="scope"><header><div><span>Принятый скоп · версия {baseline.version}</span><strong>{totalWeight === 0 ? 'Не настроено' : `${acceptedWeight} / ${totalWeight}`}</strong><small>вес результатов, а не количество задач · обновлено {ruDate(baseline.updatedAt)}</small></div><Link href="#scope-checkpoint">Контрольная точка <ChevronRight aria-hidden="true" size={16}/></Link></header><div className="fcp-scope-outcomes"><ul aria-label="Состав принятого скопа">{outcomes.map((outcome) => <li key={outcome.key} className={`fcp-scope-${outcome.key}`}><span aria-hidden="true"/><b>{outcome.label} {outcome.value}</b></li>)}</ul>{totalWeight === 0 ? <p className="fcp-empty-line">Не настроено: результатам не назначено подтверждённое состояние.</p> : <div className="fcp-scope-bar" aria-label={outcomes.map((outcome) => `${outcome.label}: ${outcome.value}`).join(', ')}>{outcomes.map((outcome) => <span className={`fcp-scope-${outcome.key}`} key={outcome.key} style={{width: `${outcome.value / totalWeight * 100}%`}}/>)}</div>}<ScopeBurnUp baseline={baseline}/></div><div className="fcp-scope-records">{baseline.outcomes.map((outcome) => <article key={outcome.key}><strong>{outcome.title}</strong><span>{outcome.weight} · {outcome.state === 'not_configured' ? 'Не настроено' : statusLabel(outcome.state)}</span><small>{outcome.evidenceReference === null ? outcome.acceptanceBlockReason ?? 'Подтверждение не зафиксировано' : `${outcome.evidenceReference}${outcome.acceptedBy === null ? '' : ` · ${outcome.acceptedBy}`}`}</small><ProjectOutcomeAcceptanceControls projectId={project.project.id} baselineId={baseline.id} outcomeId={outcome.id} expectedExecutionVersion={project.execution.version} weight={outcome.weight} csrfToken={csrfToken} enabled={canApproveOutcome && executionCanAccept && outcome.state !== 'accepted' && outcome.acceptanceReady}/></article>)}</div><section className="fcp-checkpoint" id="scope-checkpoint"><header><h2>Ближайшая контрольная точка</h2><span>{baseline.checkpoint?.targetAt === null || baseline.checkpoint === null ? 'Срок не задан' : ruDate(baseline.checkpoint.targetAt)}</span></header>{baseline.checkpoint === null ? <p>Контрольная точка ещё не зафиксирована.</p> : <><strong>{baseline.checkpoint.title}</strong><div><Status value={baseline.checkpoint.status}/><span>{baseline.checkpoint.owner === null ? 'Ответственный не назначен' : `Ответственный: ${baseline.checkpoint.owner}`}</span></div></>}</section></section>;
}
type ManagementRouteState = 'done' | 'active' | 'blocked' | 'pending';
type ManagementRouteStep = Readonly<{key: string; label: string; state: ManagementRouteState; detail: string; href: string}>;

function ManagementRoute({project, runs, route}: {project: ProjectData; runs: RunsData | null; route: WorkspaceUiRoute}) {
  const setupHref = `/projects/${project.project.slug}/setup${scopeQuery(route.scope)}#plan`;
  const tasksHref = projectUrl(project.project.slug, 'tasks', route.scope);
  const runsHref = projectUrl(project.project.slug, 'runs', route.scope);
  const protocolHref = projectUrl(project.project.slug, 'protocol', route.scope);
  const overviewHref = projectUrl(project.project.slug, 'overview', route.scope);
  const dossierReady = project.plan !== undefined && projectDossierReadiness(project.plan.artifacts).ready;
  const plan = project.plan;
  const allAssigned = project.workItems.length > 0 && project.workItems.every((item) => item.responsibility !== null);
  const projectRuns = runs?.runs.filter((run) => run.projectSlug === project.project.slug) ?? [];
  const failedRun = projectRuns.some((run) => run.status === 'failed');
  const activeRun = projectRuns.some((run) => ['queued', 'running', 'waiting_approval'].includes(run.status));
  const qaItems = project.workItems.filter((item) => item.journey?.stageKey === 'qa' || item.status === 'qa');
  const blockedQa = qaItems.some((item) => item.blocked);
  const deployments = project.deployments ?? [];
  const observedDeployment = deployments.some((deployment) =>
    deployment.externalEvidence.availability === 'known' &&
    deployment.externalEvidence.value.outcome === 'succeeded');
  const acceptance = project.execution.acceptance ?? null;
  const steps: readonly ManagementRouteStep[] = [
    {key: 'dossier', label: 'Досье', state: dossierReady ? 'done' : 'blocked', href: setupHref,
      detail: dossierReady ? 'Обязательные источники зафиксированы.' : 'Добавьте паспорт, архитектуру решения и требования клиента.'},
    {key: 'plan', label: 'План', state: plan?.materialization !== null && plan?.materialization !== undefined ? 'done' : plan?.approved !== null && plan?.approved !== undefined ? 'active' : 'blocked', href: setupHref,
      detail: plan?.materialization !== null && plan?.materialization !== undefined ? `Материализован · v${plan.materialization.planVersion}.` : plan?.approved !== null && plan?.approved !== undefined ? 'Утверждён; нужна материализация.' : 'Нет материализованного утверждённого плана.'},
    {key: 'assignments', label: 'Назначения', state: allAssigned ? 'done' : project.workItems.length === 0 ? 'blocked' : 'active', href: tasksHref,
      detail: allAssigned ? `Назначения зафиксированы · ${project.workItems.length}.` : project.workItems.length === 0 ? 'Задачи не зафиксированы.' : 'Не у всех задач зафиксирована ответственность.'},
    {key: 'execution', label: 'Исполнение / запуски', state: project.execution.status === 'blocked' || failedRun ? 'blocked' : project.execution.status === 'completed' ? 'done' : activeRun || project.execution.status === 'running' ? 'active' : 'pending', href: runsHref,
      detail: project.execution.status === 'blocked' ? project.execution.blockReason ?? 'Исполнение остановлено до устранения причины.' : failedRun ? 'Есть неуспешный запуск; проверьте причину и устранение.' : activeRun ? 'Запуск или подтверждение в работе.' : project.execution.status === 'running' ? 'Оркестратор включён; запуск ещё может не быть зафиксирован.' : 'Исполнение не запущено.'},
    {key: 'qa', label: 'QA', state: blockedQa ? 'blocked' : qaItems.length > 0 ? 'active' : project.workItems.length > 0 && project.workItems.every((item) => item.status === 'done') ? 'done' : 'pending', href: protocolHref,
      detail: blockedQa ? 'QA-задача заблокирована: устраните замечания.' : qaItems.length > 0 ? `На QA · ${qaItems.length}.` : project.workItems.length > 0 && project.workItems.every((item) => item.status === 'done') ? 'Все зафиксированные задачи завершены.' : 'QA-задача не зафиксирована.'},
    {key: 'deployment', label: 'Развёртывание', state: observedDeployment ? 'done' : deployments.length > 0 ? 'active' : 'pending', href: `${overviewHref}#releases`,
      detail: observedDeployment ? 'Наблюдаемый факт развёртывания зафиксирован.' : deployments.length > 0 ? 'Есть запрос; нужен наблюдаемый факт.' : 'Запрос на развёртывание не зафиксирован.'},
    {key: 'uat', label: 'UAT', state: acceptance?.latestResult?.outcome === 'failed' ? 'blocked' : acceptance?.latestResult?.outcome === 'passed' ? 'done' : acceptance === null ? 'pending' : 'active', href: `${overviewHref}#uat`,
      detail: acceptance?.latestResult?.outcome === 'failed' ? 'UAT не пройден: устраните замечания.' : acceptance?.latestResult?.outcome === 'passed' ? 'Результат UAT зафиксирован.' : acceptance === null ? 'Протокол UAT не подготовлен.' : 'Ожидается результат и подтверждения.'},
    {key: 'completion', label: 'Завершение', state: project.execution.status === 'completed' ? 'done' : acceptance?.completionReady === true ? 'active' : 'pending', href: `${overviewHref}#uat`,
      detail: project.execution.status === 'completed' ? 'Проект завершён канонической командой.' : acceptance?.completionReady === true ? 'Готово к отдельной команде завершения.' : 'Completion gate ещё не выполнен.'}
  ];
  return <section className="fcp-management-route" aria-labelledby="management-route-title"><div className="fcp-section-head"><div><h2 id="management-route-title">Управленческий маршрут</h2><span>Только зафиксированные факты и ближайшее ограничение</span></div></div><ol>{steps.map((step) => <li className={`fcp-management-route-step ${step.state}`} key={step.key}><span aria-hidden="true"/><div><strong>{step.label}</strong><small>{step.detail}</small></div><Link href={step.href}>Открыть</Link></li>)}</ol></section>;
}

function Overview({route, project, runs, portfolio, csrfToken, canManage, hasWriteCapability, canApproveOutcome,
  canClientSignoff}: {route: WorkspaceUiRoute; project: ProjectData; runs: RunsData | null; portfolio: PortfolioData | null;
    csrfToken: string | null; canManage: boolean; hasWriteCapability: boolean; canApproveOutcome: boolean;
    canClientSignoff: boolean}) {
  const active = project.workItems.filter(({status}) => status !== 'backlog' && status !== 'done');
  const attention = project.workItems.filter((task) => taskNeedsAttention(task, project)).slice(0, 3);
  const execution = project.execution;
  const risks = portfolio?.attention.filter((item) => item.projectId === project.project.id && item.riskSignalId !== null).slice(0, 3) ?? [];
  return <>
    <ProjectHeader route={route} project={project}/>
    <ContextTabs label="Разделы обзора" items={[{label: 'Сводка', href: projectUrl(project.project.slug, 'overview', route.scope), active: true}, {label: 'Скоп', href: '#scope', active: false}, {label: 'Риски', href: '#risks', active: false}]}/>
    <ManagementRoute project={project} runs={runs} route={route}/>
    <ProjectExecutionControls projectId={project.project.id} execution={execution} csrfToken={csrfToken} canManage={canManage} hasWriteCapability={hasWriteCapability} runnerQueueAvailable={project.runnerQueueEnabled}/>
    <ScopeBaseline project={project} csrfToken={csrfToken} canApproveOutcome={canApproveOutcome}/>
    <ProjectAcceptanceControls projectId={project.project.id} execution={execution} csrfToken={csrfToken}
      canProductOwner={canApproveOutcome} canClientRepresentative={canClientSignoff}/>
    <ReleaseEvidenceControls projectId={project.project.id} projectVersion={project.project.version}
      materialization={project.plan?.materialization ?? null} workItems={project.workItems}
      deployments={project.deployments ?? []} csrfToken={csrfToken} canManage={canManage && hasWriteCapability}/>
    <section className="fcp-section" id="risks"><div className="fcp-section-head"><div><h2>Риски проекта</h2><span>Только открытые системные риски</span></div></div>
      {risks.length === 0 ? <p className="fcp-empty-line">Открытых рисков нет.</p> : <div className="fcp-list">{risks.map((risk) => <article className="fcp-risk-row" key={risk.id}><Status value={risk.severity}/><div><strong>{riskReasonLabel(risk.reason)}</strong><small>{risk.owner ?? 'Ответственный не назначен'} · {date(risk.freshness)}</small><span>{riskActionLabel(risk.nextAction)}</span>{risk.riskSignalId === null ? null : <RiskDispositionControls csrfToken={csrfToken} disposition={risk.disposition} expectedVersion={risk.dispositionVersion} projectId={risk.projectId} riskSignalId={risk.riskSignalId}/>}</div></article>)}</div>}
    </section>
    <section className="fcp-section" id="attention"><div className="fcp-section-head"><div><h2>Гигиена задач</h2><span>Локальные признаки: блокировка, владелец и следующее действие; это не риск проекта</span></div><Link href={projectUrl(project.project.slug, 'tasks', route.scope)}>Открыть задачи</Link></div>
      {attention.length === 0 ? <p className="fcp-empty-line">Нарушений гигиены задач не обнаружено.</p> : <div className="fcp-list">{attention.map((task) => <TaskRow project={project.project.slug} route={route} task={task} projectData={project} key={task.id}/>)}</div>}
    </section>
    <section className="fcp-section"><div className="fcp-section-head"><h2>Текущая работа</h2><Link href={projectUrl(project.project.slug, 'tasks', route.scope)}>Открыть задачи</Link></div>
      {active.length === 0 ? <p className="fcp-empty-line">Активные задачи не зафиксированы.</p> : <div className="fcp-list">{active.slice(0, 5).map((task) => <TaskRow project={project.project.slug} route={route} task={task} projectData={project} key={task.id}/>)}</div>}
    </section>
    {runs === null ? null : <section className="fcp-section"><div className="fcp-section-head"><h2>Последние запуски</h2><Link href={projectUrl(project.project.slug, 'runs', route.scope)}>Открыть запуски</Link></div>{runs.runs.length === 0 ? <p className="fcp-empty-line">Запуски не зафиксированы.</p> : <div className="fcp-list">{runs.runs.slice(0, 4).map((run) => <RunRow project={project.project.slug} route={route} run={run} key={run.id}/>)}</div>}</section>}
  </>;
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
        membership.roles.includes(responsibility.role))?.actorId;
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
  const mobileVisible = filters.status === 'done' ? visible : [
    ...visible.filter(({task}) => task.status !== 'done'),
    ...visible.filter(({task}) => task.status === 'done').slice(0, 20)
  ];
  return <><ProjectHeader route={route} project={project}/><ContextTabs label="Разделы задач" items={[
    {label: 'Доска', href: taskViewUrl(route, project.project.slug, 'board'), active: filters.view === 'board', count: entries.length},
    {label: 'Мои задачи', href: taskViewUrl(route, project.project.slug, 'mine'), active: filters.view === 'mine', count: mineCount},
    {label: 'Заблокировано', href: taskViewUrl(route, project.project.slug, 'blocked'), active: filters.view === 'blocked', count: blockedCount}
  ]}/><div className="fcp-section-head fcp-page-actions"><span>Только чтение · данные синхронизируются из подключённого трекера</span></div><TaskFilters action={`/projects/${project.project.slug}/tasks`} owners={owners} route={route}/><div className="fcp-board" aria-label={`${project.project.name} task board`}>{statuses.map((status) => {
    const tasks = visible.filter(({task}) => task.status === status);
    const previewed = status === 'done' && filters.status !== 'done' ? tasks.slice(0, 20) : tasks;
    return <section className={`fcp-board-column fcp-board-column--${status}`} key={status}><header><div><h2>{boardColumnLabel[status]}</h2><span>{tasks.length}</span></div><p>{boardDescriptions[status]}</p></header><div>{tasks.length === 0 ? <p className="fcp-board-empty">Нет подходящих задач</p> : <>{previewed.map(({task}) => <TaskBoardCard access={access} project={project} route={route} task={task} key={task.id}/>)}{previewed.length === tasks.length ? null : <Link className="fcp-board-more" href={`/projects/${project.project.slug}/tasks?status=done`}>Показаны последние {previewed.length} из {tasks.length} · открыть все</Link>}</>}</div></section>;
  })}</div><div className="fcp-board-mobile-list" aria-label={`Список задач ${project.project.name}`}>{mobileVisible.length === 0 ? <p className="fcp-board-empty">Нет подходящих задач</p> : mobileVisible.map(({task}) => <TaskRow access={access} project={project.project.slug} projectData={project} route={route} task={task} key={task.id}/>)}</div></>;
}
function DetailFacts({items}: {items: readonly Readonly<{label: string; value: string}>[]}) {
  return <dl className="fcp-details">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}
function DeliveryLifecycleRail({lifecycleLoad, task}: {lifecycleLoad: OperatorLoad<DeliveryLifecycleData | null> | null; task: ProjectData['workItems'][number]}) {
  const lifecycle = lifecycleLoad?.state === 'ready' ? lifecycleLoad.data : null;
  const loadState = lifecycleLoad === null || lifecycleLoad.state === 'unconfigured'
    ? 'Не настроено'
    : lifecycleLoad.state === 'unavailable'
      ? 'Недоступно'
      : lifecycle === null ? 'Не зафиксировано' : null;
  const missing = loadState ?? 'Не зафиксировано';
  const missingDetail = loadState === 'Недоступно' ? 'Чтение PostgreSQL недоступно'
    : loadState === 'Не настроено' ? 'Источник PostgreSQL не настроен'
      : 'Сохранённый факт не зафиксирован';
  const packet = lifecycle?.packet;
  const approval = lifecycle?.approval;
  const run = lifecycle?.run;
  const receiptEvidence = lifecycle === null ? missing : lifecycle.receipt === null
    ? lifecycle.artifactCount === 0 && lifecycle.journeyEvidenceCount === 0 ? 'Не зафиксировано' : `${lifecycle.artifactCount} артефактов · ${lifecycle.journeyEvidenceCount} подтверждений`
    : `${statusLabel(lifecycle.receipt.terminal)} · ${lifecycle.artifactCount} артефактов · ${lifecycle.journeyEvidenceCount} подтверждений`;
  const writeBack = lifecycle?.writeBack;
  const auditDetail = lifecycle?.audit === null || lifecycle?.audit === undefined ? null : `Аудит ${lifecycle.audit.action} · ${lifecycle.audit.outcome}`;
  const steps = [
    {label: 'Задача', icon: CircleDot, value: statusLabel(task.blocked ? 'blocked' : task.status), detail: `Обновлено ${date(task.updatedAt)}`},
    {label: 'Неизменяемый пакет', icon: ClipboardList, value: packet === null || packet === undefined ? missing : 'Зафиксирован', detail: packet === null || packet === undefined ? missingDetail : `Hash ${packet.contentHash.slice(0, 12)} · ${date(packet.createdAt)}`},
    {label: 'Правило и подтверждение', icon: ShieldCheck, value: approval === null || approval === undefined ? missing : statusLabel(approval.status), detail: approval === null || approval === undefined ? missingDetail : `Правило v${approval.policyVersion} · ${approval.environment}`},
    {label: 'Исполнение', icon: Bot, value: run === null || run === undefined ? missing : statusLabel(run.status), detail: run === null || run === undefined ? missingDetail : `Зафиксировано ${date(run.completedAt ?? run.startedAt ?? run.createdAt)}`},
    {label: 'Отчёт и подтверждения', icon: FileCheck2, value: receiptEvidence, detail: lifecycle?.receipt === null || lifecycle?.receipt === undefined ? missingDetail : `Отчёт ${date(lifecycle.receipt.completedAt)}`},
    {label: 'Передача и следующий шаг', icon: Link2, value: writeBack === null || writeBack === undefined ? missing : `${writeBack.destination} · ${writeBack.status}`, detail: [writeBack === null || writeBack === undefined ? (loadState === null ? (task.handoff?.label ?? 'Следующее действие неизвестно') : missingDetail) : `${writeBack.eventType} · ${date(writeBack.updatedAt)}`, auditDetail].filter((entry): entry is string => entry !== null).join(' · ')}
  ];
  return <ol className="fcp-delivery-lifecycle" aria-label="Delivery lifecycle">
    {steps.map(({label, icon: Icon, value, detail}) => <li key={label} aria-label={`${label}: ${value}. ${detail}`}><Icon aria-hidden="true" size={16}/><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></li>)}
  </ol>;
}
function TaskDetail({route, project, runs, lifecycleLoad, csrfToken, operatorActorId,
  canRecordTerminalEvidence}: {route: WorkspaceUiRoute; project: ProjectData; runs: RunsData | null;
  lifecycleLoad: OperatorLoad<DeliveryLifecycleData | null> | null; csrfToken: string | null;
  operatorActorId: string | null; canRecordTerminalEvidence: boolean}) {
  const selectedTask = project.workItems.find((item) => item.id === route.taskId) ?? null;
  if (selectedTask === null) return <><ProjectHeader route={route} project={project} title="Задача"/><Blank title="Задача не найдена">Задача недоступна в выбранном проекте.</Blank></>;
  const task = {...selectedTask,
    sourcePlanVersionId: selectedTask.sourcePlanVersionId ?? null,
    sourcePlanVersion: selectedTask.sourcePlanVersion ?? null,
    sourceTaskKey: selectedTask.sourceTaskKey ?? null,
    responsibility: selectedTask.responsibility ?? null,
    acceptanceEvidence: selectedTask.acceptanceEvidence ?? null};
  const packet = runs?.packets.find((item) => item.workItemId === task.id) ?? null;
  const run = runs?.runs.find((item) => item.workItemId === task.id) ?? null;
  const approval = runs?.approvals.find((item) => item.workItemId === task.id || item.agentRunId === run?.id) ?? null;
  const rawJourney = task.journey ?? null;
  const journey = rawJourney === null ? null : {...rawJourney,
    canRecordTerminalEvidence: canRecordTerminalEvidence &&
      rawJourney.stage?.actor?.id === operatorActorId};
  const stage = journey?.stage ?? null;
  const recordedEvidence = (journey?.evidence ?? []).map((entry) => ({
    ...entry,
    reference: `${entry.stageKey.replaceAll('_', ' ')} · ${entry.reference}`
  }));
  const nextRequiredEvidence = (journey?.requiredEvidence ?? []).filter((requirement) =>
    !recordedEvidence.some((entry) => entry.stageKey === journey?.stageKey && entry.requirement === requirement));
  const plannedTask = task.sourceTaskKey == null ? null : project.plan?.approved?.definition.tasks
    .find((candidate) => candidate.key === task.sourceTaskKey) ?? null;
  const sourceLabels = plannedTask?.acceptanceEvidence.map(({evidence}) => evidence.kind === 'assumption'
    ? `Допущение: ${evidence.statement}`
    : project.plan?.artifacts.find((artifact) => artifact.id === evidence.artifactId)?.name ?? `Источник ${evidence.artifactId.slice(0, 8)}`) ?? [];
  const responsibilityLabel = task.responsibility === null ? 'Не зафиксирована (legacy task)'
    : task.responsibility.kind === 'human' ? task.owner ?? 'Назначенный человек недоступен'
      : task.responsibility.kind === 'project_role' ? ({project_owner: 'Product Owner', workspace_owner: 'Workspace owner', contributor: 'Исполнитель', reviewer: 'Рецензент', client_viewer: 'Клиентский наблюдатель'}[task.responsibility.role] ?? task.responsibility.role)
        : 'Назначен enabled agent profile';
  const responsibilityAction = task.responsibility === null ? 'Назначьте ответственность явным re-plan.'
    : task.responsibility.kind === 'human' ? `${responsibilityLabel}: выполнить задачу и сохранить evidence.`
      : task.responsibility.kind === 'project_role' ? `${responsibilityLabel}: принять задачу в работу и сохранить evidence.`
        : 'Agent profile назначен; governed TaskPacket/queue остаётся отдельным действием.';
  const executionAction = task.blocked ? 'Устранить зафиксированную блокировку.'
    : run !== null && (run.status !== 'done' || run.canAcceptReceipt || run.receipt === null)
      ? 'Открыть запуск и проверить сохранённый отчёт.'
      : packet !== null ? 'Проверить правило, подтвердить hash пакета и поставить запуск в очередь.'
        : task.canBuildPacket ? 'Собрать пакет из текущей канонической версии задачи.'
          : task.responsibility !== null ? responsibilityAction
          : nextRequiredEvidence.length > 0 ? `Зафиксировать обязательные подтверждения: ${nextRequiredEvidence.join(', ')}.`
            : stage?.nextStage !== null && stage !== null ? `Перейти к этапу «${stage.nextStage}».` : 'Следующее действие по протоколу недоступно.';
  return <><ProjectHeader route={route} project={project} title={task.title}/><div className="fcp-detail-layout"><main className="fcp-detail-main"><div className="fcp-detail-status"><Status value={task.blocked ? 'blocked' : task.status}/></div>{task.summary === null ? <p className="fcp-empty-line">Описание задачи не зафиксировано.</p> : <p className="fcp-task-summary">{task.summary}</p>}<section className="fcp-section"><div className="fcp-section-head"><h2>Связь с планом</h2><span>{task.sourcePlanVersion === null ? 'Задача вне материализованного плана' : `Утверждённый план v${task.sourcePlanVersion}`}</span></div><DetailFacts items={[{label: 'Ключ задачи', value: task.sourceTaskKey ?? 'Не зафиксирован'}, {label: 'Ответственность', value: responsibilityLabel}, {label: 'Источники', value: sourceLabels.length === 0 ? 'Не зафиксированы' : sourceLabels.join(' · ')}, {label: 'Критерии приёмки', value: task.acceptanceEvidence === null ? 'Не зафиксированы' : 'Зафиксированы в утверждённом плане'}]}/></section><section className="fcp-section"><div className="fcp-section-head"><h2>Цикл исполнения</h2><span>Только факты PostgreSQL</span></div><DeliveryLifecycleRail lifecycleLoad={lifecycleLoad} task={task}/></section><section className="fcp-section"><div className="fcp-section-head"><h2>Протокол работы</h2><span>{journey === null ? 'Не настроено' : `Версия ${journey.protocolVersion}`}</span></div>{journey === null ? <p className="fcp-empty-line">Эта задача не связана с протоколом работы.</p> : <div className="fcp-lifecycle-rail"><span aria-hidden="true"/><div><strong>{stage?.name ?? journey.stageKey}</strong><small>Статус: {statusLabel(stage?.taskStatus ?? task.status)} · {stage?.executionMode ?? 'Режим неизвестен'}</small></div><div><strong>Срок</strong><small>{journey.deadlineAt === null ? 'Не задан' : date(journey.deadlineAt)}</small></div><div><strong>Ответственный</strong><small>{stage?.actor === null || stage?.actor === undefined ? `${stage?.responsibility ?? 'Не определён'} · не сопоставлен` : `${stage.actor.displayName} · ${stage.actor.type === 'agent' ? 'ИИ-агент' : 'человек'}`}</small></div><div><strong>Следующее действие</strong><small>{executionAction}</small></div></div>}<GovernedQaControls workItemId={task.id} taskVersion={task.version ?? 0} journey={journey} csrfToken={csrfToken}/>{journey?.stageKey === 'qa' ? null : <DeliveryJourneyAction workItemId={task.id} taskVersion={task.version ?? 0} journey={journey} activeProtocolId={project.protocol?.active === true ? project.protocol.id : null} csrfToken={csrfToken}/>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Исполнение</h2><ListChecks aria-hidden="true" size={17}/></div>{packet === null ? <TaskPacketBuildControls task={task} profiles={project.agentProfiles} csrfToken={csrfToken}/> : <TaskPacketPreview packet={packet} csrfToken={csrfToken} operatorActorId={operatorActorId}/>} {packet === null && !task.canBuildPacket && run === null ? <p className="fcp-empty-line">Пакет задачи и запуск ещё не зафиксированы.</p> : null}{run === null ? null : <div className="fcp-command"><div><strong>{task.handoff?.label ?? 'Запуск зафиксирован'}</strong><p>Факты исполнения сохранены в управляемой записи запуска.</p></div><Link className="fcp-primary" href={runUrl(project.project.slug, run.id, route.scope)}>Открыть запуск</Link></div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Правило и подтверждение</h2><ShieldCheck aria-hidden="true" size={17}/></div><p className="fcp-empty-line">{approval === null ? 'Отдельный запрос подтверждения не зафиксирован.' : `${statusLabel(approval.status)} · ${approval.environment}`}</p></section><section className="fcp-section"><div className="fcp-section-head"><h2>Подтверждения результата</h2><FileCheck2 aria-hidden="true" size={17}/></div>{journey === null ? <p className="fcp-empty-line">Требования протокола не настроены.</p> : <div className="fcp-evidence-list">{recordedEvidence.length === 0 ? <p className="fcp-empty-line">Подтверждения текущего этапа не зафиксированы.</p> : recordedEvidence.map((entry) => <p key={`${entry.requirement}:${entry.reference}`}><strong>{entry.requirement}</strong><span>{entry.reference}</span></p>)}{nextRequiredEvidence.length === 0 ? null : <p className="fcp-evidence-next"><strong>Ещё требуется</strong><span>{nextRequiredEvidence.join(', ')}</span></p>}</div>}</section></main><aside className="fcp-meta"><h2>Сводка</h2><DetailFacts items={[{label: 'План', value: task.sourcePlanVersion === null ? 'Не связан' : `v${task.sourcePlanVersion}`}, {label: 'Ответственность', value: responsibilityLabel}, {label: 'Протокол', value: journey === null ? 'Не настроен' : `v${journey.protocolVersion}`}, {label: 'Этап', value: stage?.name ?? 'Не настроен'}, {label: 'Ответственный человек', value: task.responsibility?.kind === 'human' ? responsibilityLabel : stage?.actor?.type === 'human' ? stage.actor.displayName : task.owner ?? 'Не определён'}, {label: 'Ответственный агент', value: task.responsibility?.kind === 'agent_profile' ? responsibilityLabel : stage?.actor?.type === 'agent' ? stage.actor.displayName : 'Не применяется'}, {label: 'Подтверждение', value: approval === null ? 'Не зафиксировано' : statusLabel(approval.status)}, {label: 'Срок', value: journey?.deadlineAt === null || journey === null ? 'Не задан' : date(journey.deadlineAt)}, {label: 'Источник трекера', value: task.externalUrl === null ? 'Не подтверждён' : 'Подтверждён провайдером'}, {label: 'Обновлено', value: date(task.updatedAt)}]}/>{task.externalUrl === null ? null : <a href={task.externalUrl} target="_blank" rel="noreferrer">Открыть у провайдера</a>}</aside></div></>;
}
const protocolModeLabel = (mode: NonNullable<ProjectData['protocol']>['definition']['stages'][number]['executionMode']) =>
  mode === 'autonomous' ? 'Автономно' : mode === 'human_approval' ? 'С подтверждением' : 'Вручную';
const protocolStageLabel = (key: string, fallback: string) => ({
  intake: 'Постановка', development: 'Разработка', qa: 'QA', staging: 'Тестовый контур', acceptance: 'Приёмка'
}[key] ?? fallback);
const protocolEvidenceLabel = (value: string) => ({
  'Implementation change': 'Изменения реализации',
  'Relevant checks': 'Результаты проверок',
  'QA report': 'Отчёт QA',
  'Staging deployment': 'Развёртывание в тестовом контуре',
  'Product Owner acceptance': 'Приёмка Product Owner'
}[value] ?? value);
function Protocol({route, project, access, csrfToken}: {route: WorkspaceUiRoute; project: ProjectData; access: AccessData | null; csrfToken: string | null}) {
  const protocol = project.protocol ?? (project.protocolRevision?.state === 'published' ? project.protocolRevision : null);
  const editorProtocol = project.protocolRevision ?? protocol;
  return <><ProjectHeader route={route} project={project}/><ContextTabs label="Разделы процесса" items={[
    {label: 'Этапы', href: projectUrl(project.project.slug, 'protocol', route.scope), active: true, count: protocol?.definition.stages.filter((stage) => stage.enabled).length ?? 0},
    {label: 'Запуски', href: projectUrl(project.project.slug, 'runs', route.scope), active: false},
    {label: 'Правила', href: '#protocol-rules', active: false}
  ]}/><section className="fcp-section"><div className="fcp-section-head"><div><h2>Как проект проходит разработку</h2><span>Текущая опубликованная последовательность</span></div><span>{protocol === null ? 'Не настроено' : `v${protocol.version} · ${protocol.active ? 'активен' : 'неактивен'}`}</span></div>{protocol === null ? <Blank title="Процесс не настроен">Нет сохранённого протокола разработки для этого проекта.</Blank> : <ol className="fcp-protocol-flow" aria-label={`Протокол работы ${project.project.name}`}>{protocol.definition.stages.filter((stage) => stage.enabled).map((stage, index, stages) => {
    const responsibility = protocolStageResponsibility(project, access, stage);
    const next = stage.allowedNextStageKey === null ? null : protocol.definition.stages.find((candidate) => candidate.key === stage.allowedNextStageKey);
    return <li key={stage.key}><header><span>{String(index + 1).padStart(2, '0')}</span><Status value={stage.taskStatus}/></header><h3>{protocolStageLabel(stage.key, stage.name)}</h3><dl><div><dt>Ответственный</dt><dd>{responsibility === null ? 'Ответственный не назначен' : `По протоколу · ${responsibility.name}`}</dd></div><div><dt>Режим</dt><dd>{protocolModeLabel(stage.executionMode)}</dd></div><div><dt>Подтверждение</dt><dd>{stage.executionMode === 'human_approval' ? 'Требуется' : 'Не требуется'}</dd></div><div><dt>Подтверждающие материалы</dt><dd>{stage.requiredEvidence.map(protocolEvidenceLabel).join(', ')}</dd></div></dl><footer>{stage.allowedNextStageKey === null ? <><FileCheck2 aria-hidden="true" size={15}/><span>Завершение процесса</span></> : <><ArrowRight aria-hidden="true" size={15}/><span>Далее: {next == null ? stage.allowedNextStageKey : protocolStageLabel(next.key, next.name)}</span></>}</footer>{index === stages.length - 1 ? null : <span className="fcp-protocol-connector" aria-hidden="true"/>}</li>;
  })}</ol>}</section><section className="fcp-section" id="protocol-rules"><div className="fcp-section-head"><div><h2>Правила и версии</h2><span>{project.protocolRevision === null || project.protocolRevision === undefined ? 'Активная версия неизменяема; изменения начинаются в новом черновике' : project.protocolRevision.state === 'draft' ? `Черновик v${project.protocolRevision.version} готов к редактированию` : `Версия v${project.protocolRevision.version} опубликована и готова к активации`}</span></div></div><details className="fcp-protocol-management"><summary>Открыть управление протоколом</summary><DeliveryProtocolEditor projectId={project.project.id} protocol={editorProtocol} csrfToken={csrfToken}/></details></section></>;
}
function RunRow({project, route, run}: {project: OperatorProjectSlug; route: WorkspaceUiRoute; run: RunsData['runs'][number]}) {
  return <Link className="fcp-row fcp-run-row" href={runUrl(project, run.id, route.scope)}><Status value={run.status}/><div><strong>{run.workItem ?? 'Задача не найдена'}</strong><small>{run.agent ?? 'Агент не определён'} · {run.runtimeProfile}</small></div><span>{run.receipt?.terminal ?? 'Отчёт не зафиксирован'}</span><time>{date(run.completedAt ?? run.startedAt)}</time><ChevronRight aria-hidden="true" size={16}/></Link>;
}
function Runs({route, project, runs}: {route: WorkspaceUiRoute; project: ProjectData; runs: RunsData | null}) {
  return <><ProjectHeader route={route} project={project}/>{runs === null ? <Blank title="Запуски недоступны">Не удалось загрузить канонические записи запусков.</Blank> : <div className="fcp-list">{runs.runs.length === 0 ? <p className="fcp-empty-line">Запуски не зафиксированы.</p> : runs.runs.map((run) => <RunRow project={project.project.slug} route={route} run={run} key={run.id}/>)}</div>}</>;
}
function RunDetail({route, project, runs, csrfToken, operatorActorId}: {route: WorkspaceUiRoute; project: ProjectData; runs: RunsData | null; csrfToken: string | null; operatorActorId: string | null}) {
  const run = runs?.runs.find((item) => item.id === route.runId) ?? null;
  if (run === null) return <><ProjectHeader route={route} project={project} title="Запуск"/><Blank title="Запуск не найден">В выбранном проекте нет такой записи запуска.</Blank></>;
  const approval = runs?.approvals.find((item) => item.agentRunId === run.id) ?? null;
  const events = [{label: 'Запуск начат', value: run.startedAt}, {label: 'Решение по правилу', value: approval?.decidedAt ?? null}, {label: 'Исполнение завершено', value: run.completedAt}, {label: 'Отчёт сохранён', value: run.receipt?.completedAt ?? null}];
  const nextAction = run.status === 'queued' ? 'Ожидать безопасного получения задания исполнителем или отменить запуск до начала.'
    : run.status === 'running' ? 'Ожидать итоговый отчёт и свежий сигнал работоспособности исполнителя.'
      : run.canAcceptReceipt ? `Product Owner проверяет точную связь запуска, отчёт и обязательные подтверждения перед этапом «${run.acceptanceTargetStage ?? 'следующий'}». Автопереход запрещён.`
        : run.status === 'failed' ? 'Проверить подтверждения ошибки и решить, нужен ли новый неизменяемый пакет задачи. Автоповтор: 0.'
          : run.receipt !== null ? 'Продолжить по протоколу из карточки задачи.' : 'Действия заблокированы до сохранённого отчёта.';
  return <><ProjectHeader route={route} project={project} title={run.workItem ?? 'Отчёт запуска'}/><div className="fcp-detail-layout"><main className="fcp-detail-main"><div className="fcp-detail-status"><Status value={run.status}/><span className="fcp-muted">{run.agent ?? 'Агент не определён'}</span></div>{route.handoffResult === undefined || route.handoffResult === null ? null : <p className={`fcp-command-notice ${route.handoffResult === 'accepted' ? 'success' : 'error'}`}>{route.handoffResult === 'accepted' ? 'Результат принят Product Owner; задача переведена на разрешённый следующий этап, исполнение проекта приостановлено.' : `Результат не принят: ${route.handoffResult.replaceAll('_', ' ')}.`}</p>}<section className="fcp-section"><div className="fcp-section-head"><h2>Хронология запуска</h2><FileCheck2 aria-hidden="true" size={17}/></div><ol className="fcp-timeline">{events.map((event) => <li key={event.label}><span aria-hidden="true" className={event.value === null ? 'missing' : ''}/><div><strong>{event.label}</strong><small>{date(event.value)}</small></div></li>)}</ol></section><section className="fcp-section"><div className="fcp-section-head"><h2>Проверки и подтверждения</h2><GitPullRequest aria-hidden="true" size={17}/></div><p className="fcp-empty-line">{run.artifacts.length === 0 ? 'Артефакты не зафиксированы.' : `Зафиксировано артефактов: ${run.artifacts.length}.`}</p></section><section className="fcp-section"><div className="fcp-section-head"><h2>Следующее действие</h2><ChevronRight aria-hidden="true" size={17}/></div><p className="fcp-empty-line">{nextAction}</p><RunActionControls run={run} csrfToken={csrfToken} operatorActorId={operatorActorId}/>{run.workItemId === null ? null : <Link className="fcp-primary" href={taskUrl(project.project.slug, run.workItemId, route.scope)}>Вернуться к задаче</Link>}</section></main><aside className="fcp-meta"><h2>Сводка отчёта</h2><DetailFacts items={[{label: 'Задача', value: run.workItem ?? 'Не определена'}, {label: 'Агент', value: run.agent ?? 'Не определён'}, {label: 'Подтверждение', value: approval === null ? 'Не зафиксировано' : statusLabel(approval.status)}, {label: 'Среда', value: approval?.environment ?? 'Не определена'}, {label: 'Результат', value: statusLabel(run.receipt?.terminal ?? run.status)}, {label: 'Зафиксировано', value: date(run.completedAt ?? run.startedAt)}]}/><details><summary>Технические сведения</summary><p>Профиль исполнения: {run.runtimeProfile}</p></details></aside></div></>;
}
const chatAccessLabel = (level: 'none' | 'read' | 'write' | 'admin' | null) =>
  level === null ? 'Не наблюдался' : ({none: 'Нет', read: 'Чтение', write: 'Запись', admin: 'Администратор'}[level]);
const chatConfirmationLabel = (state: ConversationsData['projects'][number]['channels'][number]['access'][number]['confirmation']) => ({
  confirmed: 'Подтверждено', mismatch: 'Есть расхождение', unobserved: 'Ожидает наблюдения', not_requested: 'Не задано'
}[state]);
function ChatChannelConfiguration({projectId, channel, csrfToken}: {
  projectId: string;
  channel: ConversationsData['projects'][number]['channels'][number];
  csrfToken: string;
}) {
  const configurationId = channel.configuration?.id ?? crypto.randomUUID();
  const expectedVersion = channel.configuration?.version ?? 0;
  const nextAction = channel.configuration?.desiredState === 'active' ? 'deactivate' : 'activate';
  return <details className="fcp-system-details"><summary>Настройка канала</summary><form action="/api/conversations/channel" className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="projectId" type="hidden" value={projectId}/><input name="channelId" type="hidden" value={configurationId}/><input name="conversationClass" type="hidden" value={channel.conversationClass}/><input name="expectedVersion" type="hidden" value={expectedVersion}/><input name="action" type="hidden" value={nextAction}/><button className="fcp-primary-button" type="submit">{nextAction === 'activate' ? 'Подключить Telegram' : 'Отключить наблюдение'}</button><small>Control Plane хранит только намерение и подтверждённые наблюдения. Идентификатор Telegram задаётся в защищённой конфигурации окружения.</small></form><form action="/api/conversations/channel" className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="projectId" type="hidden" value={projectId}/><input name="channelId" type="hidden" value={configurationId}/><input name="conversationClass" type="hidden" value={channel.conversationClass}/><input name="expectedVersion" type="hidden" value={expectedVersion}/><input name="action" type="hidden" value="not_used"/><button type="submit">Чат не используется</button></form></details>;
}
function ConversationAccess({projectId, channel, csrfToken, canManage}: {
  projectId: string;
  channel: ConversationsData['projects'][number]['channels'][number];
  csrfToken: string | null;
  canManage: boolean;
}) {
  const configuration = channel.configuration ?? null;
  if (configuration === null || configuration.desiredState === 'not_used') return null;
  return <aside><h3>Доступ</h3>{channel.access.length === 0 ? <p>Участники проекта не зафиксированы.</p> : <ul>{channel.access.map((access) => <li key={access.actorId}><strong>{access.displayName}</strong><span>{rolesLabel(access.roles)} · желаемый: {chatAccessLabel(access.desiredLevel)} · факт: {chatAccessLabel(access.observedLevel)} · {chatConfirmationLabel(access.confirmation)}</span>{canManage && csrfToken !== null ? <form action="/api/conversations/access" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="projectId" type="hidden" value={projectId}/><input name="channelId" type="hidden" value={configuration.id}/><input name="conversationClass" type="hidden" value={channel.conversationClass}/><input name="actorId" type="hidden" value={access.actorId}/><input name="grantId" type="hidden" value={access.grantId ?? crypto.randomUUID()}/><input name="expectedVersion" type="hidden" value={access.grantVersion ?? 0}/><label><span className="fcp-sr-only">Желаемый доступ для {access.displayName}</span><select defaultValue={access.desiredLevel ?? 'none'} name="desiredLevel"><option value="none">Нет доступа</option><option value="read">Чтение</option><option value="write">Запись</option><option value="admin">Администратор</option></select></label><button type="submit">Сохранить</button></form> : null}</li>)}</ul>}<p>Изменение участника выполняется в Telegram. Control Plane подтвердит результат только после нового наблюдения.</p><a href="https://web.telegram.org/" target="_blank" rel="noreferrer">Открыть Telegram <ExternalLink aria-hidden="true" size={12}/></a></aside>;
}
function ConversationChannel({projectId, channel, csrfToken, canManage}: {
  projectId: string;
  channel: ConversationsData['projects'][number]['channels'][number];
  csrfToken: string | null;
  canManage: boolean;
}) {
  const label = channel.conversationClass === 'internal' ? 'Внутренний чат' : 'Чат с клиентом';
  const stateLabel = channel.state === 'not_configured' ? 'Не настроено'
    : channel.state === 'not_used' ? 'Не используется'
      : channel.state === 'inactive' ? 'Наблюдение отключено'
        : channel.state === 'waiting_observation' ? 'Ожидает подтверждения Telegram'
          : channel.state === 'empty' ? 'Сообщений пока нет'
            : channel.state === 'degraded' ? 'Синхронизация нарушена' : 'Синхронизировано';
  const configured = channel.configuration != null && channel.configuration.desiredState !== 'not_used';
  return <section className="fcp-conversation"><header><div><h2>{label}</h2><span>{stateLabel} · обновлено {date(channel.freshnessAt)}</span></div><Status value={channel.state === 'degraded' ? 'failed' : channel.state === 'ready' ? 'healthy' : 'unknown'}/></header>{channel.failure === null ? null : <p className="fcp-conversation-failure">Ошибка синхронизации: {channel.failure.code} · {date(channel.failure.at)} · событий: {channel.failure.count}</p>}{!configured ? <div className="fcp-conversation-empty"><p className="fcp-empty-line">{channel.state === 'not_used' ? 'Для этого проекта такой чат явно не нужен.' : 'Канал ещё не настроен.'}</p>{canManage && csrfToken !== null ? <ChatChannelConfiguration projectId={projectId} channel={channel} csrfToken={csrfToken}/> : null}</div> : <><div className="fcp-conversation-body"><ConversationAccess projectId={projectId} channel={channel} csrfToken={csrfToken} canManage={canManage}/><ol className="fcp-message-list">{channel.messages.length === 0 ? <li className="fcp-empty-line">После подключения новых сообщений не зафиксировано.</li> : channel.messages.map((message) => <li key={message.id}><header><strong>{message.author}</strong><time>{date(message.sentAt)}</time></header>{message.text === null ? null : <p>{message.text}</p>}<footer>{message.reply ? <span>Ответ</span> : null}{message.threaded ? <span>Ветка</span> : null}{message.attachmentSummary === null ? null : <span>Вложения: {message.attachmentSummary}</span>}</footer></li>)}</ol></div><details className="fcp-system-details"><summary>Наблюдаемые участники Telegram</summary>{channel.participants.length === 0 ? <p>Наблюдения участников ещё не зафиксированы.</p> : <ul>{channel.participants.map((participant) => <li key={participant.id}><strong>{participant.displayName}</strong><span>{participant.resolution === 'resolved' ? 'Личность подтверждена' : 'Не сопоставлен'} · факт: {chatAccessLabel(participant.observedLevel)} · {date(participant.observedAt)}</span></li>)}</ul>}</details>{canManage && csrfToken !== null ? <ChatChannelConfiguration projectId={projectId} channel={channel} csrfToken={csrfToken}/> : null}</>}</section>;
}
function Conversations({projects, csrfToken, canManage}: {projects: readonly ConversationsData['projects'][number][]; csrfToken: string | null; canManage: boolean}) {
  return <div className="fcp-conversation-projects">{projects.map((project) => <section key={project.id}><h2 className="fcp-conversation-project-name">{project.name}</h2>{project.channels.every(({state}) => state === 'not_used') ? <Blank title="Чаты не используются">Для этого проекта отсутствие чатов зафиксировано как осознанное решение.</Blank> : <div className="fcp-conversation-grid">{project.channels.map((channel) => <ConversationChannel projectId={project.id} channel={channel} csrfToken={csrfToken} canManage={canManage} key={channel.conversationClass}/>)}</div>}</section>)}</div>;
}
function Chats({route, project, conversations, csrfToken, canManage}: {route: WorkspaceUiRoute; project: ProjectData; conversations: ConversationsData | null; csrfToken: string | null; canManage: boolean}) {
  const scoped = conversations?.projects.find((item) => item.id === project.project.id);
  return <><ProjectHeader route={route} project={project}/><div className="fcp-section-head fcp-page-actions"><span>Сообщения только для чтения · желаемый доступ отдельно от факта Telegram</span></div>{scoped === undefined ? <Blank title="Чаты недоступны">Не удалось загрузить подтверждённые данные каналов.</Blank> : <Conversations projects={[scoped]} csrfToken={csrfToken} canManage={canManage}/>}</>;
}
const roleLabel = (role: string) => ({project_owner: 'Владелец продукта', contributor: 'Разработчик', agent: 'ИИ-агент', workspace_admin: 'Администратор'}[role] ?? role.replaceAll('_', ' '));
const rolesLabel = (roles: readonly string[]) => roles.map(roleLabel).join(' · ');
const resourceLabel = (resource: string) => ({repository: 'Репозиторий', tracker: 'Проект / трекер', internal_chat: 'Внутренний чат', client_chat: 'Чат с клиентом'}[resource] ?? resource.replaceAll('_', ' '));
const grantConfirmationState = (grant: AccessData['resourceGrants'][number]) => {
  if (grant.observationState === 'unsupported') return 'Не поддерживается';
  if (grant.observationState === 'unobserved') return 'Не подтверждено провайдером';
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
  return <article><div><strong>{resourceLabel(grant.resourceType)}</strong><small>Требуемый уровень: {grant.desiredLevel} · версия {grant.version}</small></div><dl><div><dt>Роль в проекте</dt><dd>{membership.active ? rolesLabel(membership.roles) : 'Участие неактивно'}</dd></div><div><dt>Факт провайдера</dt><dd>{grant.observedLevel === null ? 'Не зафиксирован' : `${grant.observedLevel} · ${grant.observedProvider ?? 'провайдер неизвестен'}`}</dd></div><div><dt>Подтверждение</dt><dd>{confirmation}</dd></div><div><dt>Изменение</dt><dd>{grant.providerAccessUrl == null ? 'Не настроено' : <a href={grant.providerAccessUrl} target="_blank" rel="noreferrer" aria-label={`Управлять доступом ${resourceLabel(grant.resourceType)} в ${provider}`}>Открыть у провайдера <ExternalLink aria-hidden="true" size={13}/></a>}</dd></div></dl>{grant.remediation === null ? null : <p className="fcp-empty-line">{grant.remediation}</p>}{membership.canManage && csrfToken !== null ? <form action={`/api/access/grants/${grant.id}`} className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="expectedVersion" type="hidden" value={grant.version}/><label>Желаемый доступ<select defaultValue={grant.desiredLevel} name="desiredLevel"><option value="none">Нет</option><option value="read">Чтение</option><option value="write">Запись</option><option value="admin">Администратор</option></select></label><button className="fcp-primary-button" type="submit">Сохранить намерение</button><small>После сохранения Control Plane покажет расхождение до применения у провайдера.</small></form> : null}<small className="fcp-access-observed">{grant.observedAt === null ? 'Проверка ещё не зафиксирована' : `Проверено ${date(grant.observedAt)}`}</small></article>;
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
    const grant = access.resourceGrants.find((item) => item.projectId === project.project.id && item.actorId === actor.id && item.resourceType === resource.key);
    if (grant === undefined) return {label: 'Не настроено', tone: 'missing'};
    const confirmed = grant.observedLevel !== null && grant.observedAt !== null && grant.observedLevel === grant.desiredLevel;
    return {label: confirmed ? 'Подтверждено' : 'Только роль', tone: confirmed ? 'confirmed' : 'role'};
  };
  return <section className="fcp-access-matrix-section"><div className="fcp-section-head"><div><h2>Карта доступов проекта</h2><span>Роль показывает намерение, «Подтверждено» — факт от подключённого провайдера</span></div></div><div className="fcp-access-matrix-scroll"><table className="fcp-access-matrix"><thead><tr><th>Участник</th>{accessResources.map((resource) => <th key={resource.key}>{resource.label}</th>)}</tr></thead><tbody>{actors.map((actor) => { const membership = memberships.find((item) => item.actorId === actor.id)!; return <tr key={actor.id}><th><strong>{actor.displayName}</strong><small>{rolesLabel(membership.roles)}</small></th>{accessResources.map((resource) => { const state = cell(actor, membership, resource); return <td key={resource.key}><span className={`fcp-access-cell ${state.tone}`}>{state.label}</span></td>; })}</tr>; })}</tbody></table></div><div className="fcp-access-legend"><span><i className="confirmed"/>Подтверждено провайдером</span><span><i className="role"/>Роль задана, факт не подтверждён</span><span><i className="missing"/>Не настроено</span></div></section>;
}
function EnvironmentAccess({project, access, csrfToken}: {project: ProjectData; access: AccessData; csrfToken: string | null}) {
  const environments = (access.environments ?? []).filter((item) => item.projectId === project.project.id);
  const eligibleMembers = access.memberships.filter((item) => item.projectId === project.project.id && item.active)
    .filter((item) => item.roles.includes('contributor') || item.roles.length === 1 && item.roles[0] === 'agent');
  const canManage = access.memberships.some((item) => item.projectId === project.project.id && item.canManage);
  const adminRefs = (access.secretRefs ?? []).filter((ref) => ref.scope.includes('environment_access:admin'));
  const principalRefs = (access.secretRefs ?? []).filter((ref) => ref.scope.includes('ssh:principal'));
  const reconcilers = access.environmentReconcilers ?? [];
  const label = (kind: 'development' | 'production') => kind === 'development' ? 'Среда разработки' : 'Продакшен';
  const card = (kind: 'development' | 'production') => {
    const environment = environments.find((item) => item.kind === kind) ?? null;
    const members = kind === 'production' ? eligibleMembers.filter((member) =>
      access.actors.find((actor) => actor.id === member.actorId)?.type === 'human') : eligibleMembers;
    const grants = environment === null ? [] : access.resourceGrants.filter((item) =>
      item.projectId === project.project.id && item.resourceType === 'environment' && item.resourceId === environment.id &&
      access.memberships.some((member) => member.actorId === item.actorId) &&
      // A grant resource is the canonical environment id; the projection intentionally exposes no provider locator.
      item.resourceType === 'environment');
    const requests = environment === null ? [] : access.requests.filter((item) =>
      item.projectId === project.project.id && item.resourceId === environment.id);
    return <article className="fcp-environment-card" key={kind}>
      <header><div><ServerCog aria-hidden="true" size={18}/><div><strong>{label(kind)}</strong><small>{environment === null ? 'Не настроена' : environment.purpose}</small></div></div><Status value={environment === null || !environment.enabled ? 'unknown' : environment.adapterConfigured ? 'ready' : 'blocked'}/></header>
      {environment === null ? <p className="fcp-empty-line">Каноническая среда проекта не настроена.</p> : <dl><div><dt>Подключение</dt><dd>{environment.endpoint}:{environment.port}</dd></div><div><dt>Провайдер</dt><dd>{environment.provider}</dd></div><div><dt>Reconciler</dt><dd>{environment.adapterConfigured ? environment.reconcilerName : `${environment.reconcilerName} · adapter недоступен`}</dd></div><div><dt>Версия</dt><dd>{environment.version}</dd></div></dl>}
      {!canManage || csrfToken === null ? null : <details><summary>{environment === null ? 'Настроить среду' : 'Изменить настройки'}</summary>{adminRefs.length === 0 || reconcilers.length === 0 ? <p className="fcp-empty-line">Нужны host-owned reference environment_access:admin и активный system reconciler.</p> : <form action="/api/access/environments" className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="action" type="hidden" value="configure"/><input name="environmentId" type="hidden" value={environment?.id ?? ''}/><input name="projectId" type="hidden" value={project.project.id}/><input name="kind" type="hidden" value={kind}/><input name="expectedVersion" type="hidden" value={environment?.version ?? ''}/><label>Назначение<input defaultValue={environment?.purpose ?? label(kind)} maxLength={240} name="purpose" required/></label><label>Endpoint<input defaultValue={environment?.endpoint ?? ''} maxLength={255} name="endpoint" required/></label><label>SSH порт<input defaultValue={environment?.port ?? 22} max={65535} min={1} name="port" type="number" required/></label><label>Провайдер<input defaultValue={environment?.provider ?? 'ssh'} maxLength={64} name="provider" required/></label><label>Adapter key<input defaultValue={environment?.adapterKey ?? 'ssh'} maxLength={64} name="adapterKey" required/></label><label>Host-owned credential<select name="adapterCredentialRefId" required><option value="">Выберите reference</option>{adminRefs.map((ref) => <option key={ref.id} value={ref.id}>{ref.provider} · environment access admin</option>)}</select></label><label>Доверенный reconciler<select defaultValue={environment?.reconcilerActorId ?? ''} name="reconcilerActorId" required><option value="">Выберите system actor</option>{reconcilers.map((actor) => <option key={actor.id} value={actor.id}>{actor.displayName}</option>)}</select></label><label>Состояние<select defaultValue={String(environment?.enabled ?? false)} name="enabled"><option value="false">Отключена</option><option value="true">Включена</option></select></label><button className="fcp-primary-button" type="submit">Сохранить среду</button><small>Приватные ключи, capabilities и SSH config не передаются через форму.</small></form>}</details>}
      {environment === null ? null : <section><h3>SSH-доступ</h3>{members.length === 0 ? <p className="fcp-empty-line">{kind === 'production' ? 'Нет активных Developers. Обычные ИИ-агенты не получают production SSH.' : 'Нет активных Developers или ИИ-агентов.'}</p> : members.map((member) => {
        const actor = access.actors.find((item) => item.id === member.actorId);
        const grant = grants.find((item) => item.actorId === member.actorId && item.resourceType === 'environment');
        const actorRequests = requests.filter((item) => item.subjectActorId === member.actorId);
        const approved = actorRequests.find((item) => item.status === 'granted' && item.expiresAt !== null && item.expiresAt.getTime() > Date.now()) ?? null;
        const expired = grant?.expiresAt !== null && grant?.expiresAt !== undefined && grant.expiresAt.getTime() <= Date.now();
        return <div className="fcp-environment-principal" key={member.actorId}><div><strong>{actor?.displayName ?? 'Участник'}</strong><small>{actor?.type === 'agent' ? 'ИИ-агент' : 'Developer'} · desired {grant?.desiredLevel ?? 'none'} · observed {grant?.observedLevel ?? 'не подтверждён'}{expired ? ' · срок истёк, требуется revoke/observe' : grant?.expiresAt === null || grant?.expiresAt === undefined ? '' : ` · до ${date(grant.expiresAt)}`}</small></div>{!canManage || csrfToken === null || principalRefs.length === 0 ? null : kind === 'production' && approved === null ? <form action="/api/access/environments" className="fcp-inline-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="action" type="hidden" value="request"/><input name="projectId" type="hidden" value={project.project.id}/><input name="subjectActorId" type="hidden" value={member.actorId}/><input name="environmentId" type="hidden" value={environment.id}/><select aria-label="Публичный SSH reference" name="credentialRefId" required><option value="">SSH reference</option>{principalRefs.map((ref) => <option key={ref.id} value={ref.id}>{ref.provider} · principal</option>)}</select><input aria-label="Срок доступа" name="expiresAt" type="datetime-local" required/><button type="submit">Запросить</button></form> : <form action="/api/access/environments" className="fcp-inline-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="action" type="hidden" value="grant"/><input name="grantId" type="hidden" value={grant?.id ?? ''}/><input name="projectId" type="hidden" value={project.project.id}/><input name="subjectActorId" type="hidden" value={member.actorId}/><input name="environmentId" type="hidden" value={environment.id}/><input name="approvalRequestId" type="hidden" value={kind === 'production' ? approved?.id ?? '' : ''}/><input name="expectedVersion" type="hidden" value={grant?.version ?? ''}/><select aria-label="Публичный SSH reference" name="credentialRefId" required><option value="">SSH reference</option>{principalRefs.map((ref) => <option key={ref.id} value={ref.id}>{ref.provider} · principal</option>)}</select><input aria-label="Срок доступа" defaultValue={approved?.expiresAt === null || approved?.expiresAt === undefined ? undefined : approved.expiresAt.toISOString().slice(0, 16)} name="expiresAt" type="datetime-local" required/><input name="desiredLevel" type="hidden" value="write"/><button type="submit">Зафиксировать доступ</button></form>}{grant === undefined || grant.desiredLevel === 'none' || !canManage || csrfToken === null ? null : <form action="/api/access/environments" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="action" type="hidden" value="grant"/><input name="grantId" type="hidden" value={grant.id}/><input name="projectId" type="hidden" value={project.project.id}/><input name="subjectActorId" type="hidden" value={member.actorId}/><input name="environmentId" type="hidden" value={environment.id}/><input name="credentialRefId" type="hidden" value=""/><input name="approvalRequestId" type="hidden" value=""/><input name="expiresAt" type="hidden" value=""/><input name="desiredLevel" type="hidden" value="none"/><input name="expectedVersion" type="hidden" value={grant.version}/><button className="fcp-quiet-button" type="submit">Отозвать</button></form>}</div>;
      })}{kind !== 'production' ? null : requests.filter((item) => item.status === 'pending').map((request) => <div className="fcp-environment-request" key={request.id}><span>Запрос · {access.actors.find((actor) => actor.id === request.subjectActorId)?.displayName ?? 'участник'} · до {date(request.expiresAt)}</span>{!canManage || csrfToken === null ? null : <form action="/api/access/environments" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="action" type="hidden" value="decide"/><input name="requestId" type="hidden" value={request.id}/><input name="expectedVersion" type="hidden" value={request.version}/><button name="status" value="granted">Одобрить</button><button name="status" value="rejected">Отклонить</button></form>}</div>)}</section>}
    </article>;
  };
  return <section className="fcp-environments"><div className="fcp-section-head"><div><h2>Среды и SSH-доступ</h2><span>Desired, approval и observed — отдельные факты</span></div></div><div>{card('development')}{card('production')}</div></section>;
}
function Access({route, project, access, csrfToken}: {route: WorkspaceUiRoute; project: ProjectData; access: AccessData | null; csrfToken: string | null}) {
  if (access === null) return <><ProjectHeader route={route} project={project}/><Blank title="Доступы недоступны">Не удалось загрузить подтверждённые данные ролей и доступов.</Blank></>;
  const memberships = access.memberships.filter((item) => item.projectId === project.project.id);
  const actors = memberships.flatMap((item) => access.actors.find((actor) => actor.id === item.actorId) ?? []);
  const activeMemberships = memberships.filter((item) => item.active);
  const activeActorIds = new Set(activeMemberships.map((item) => item.actorId));
  const activeActors = actors.filter((actor) => activeActorIds.has(actor.id));
  const inactiveActors = actors.filter((actor) => !activeActorIds.has(actor.id));
  const selected = actors.find((actor) => actor.id === route.accessActorId) ?? activeActors[0] ?? inactiveActors[0] ?? null;
  const membership = selected === null ? null : memberships.find((item) => item.actorId === selected.id) ?? null;
  const identities = selected === null ? [] : access.externalIdentities.filter((item) => item.actorId === selected.id);
  const grants = selected === null ? [] : access.resourceGrants.filter((item) => item.projectId === project.project.id && item.actorId === selected.id);
  const profiles = selected === null ? [] : access.agentSystems.find((item) => item.actorId === selected.id)?.profiles ?? [];
  const actorUrl = (actorId: string) => `/projects/${project.project.slug}/access/${actorId}${scopeQuery(route.scope)}`;
  const actorRow = (actor: AccessData['actors'][number]) => { const row = memberships.find((item) => item.actorId === actor.id)!; return <Link className="fcp-access-person" href={actorUrl(actor.id)} key={actor.id} aria-current={selected?.id === actor.id ? 'page' : undefined}><UsersRound aria-hidden="true" size={17}/><div><strong>{actor.displayName}</strong><small>{row.active ? rolesLabel(row.roles) : `${rolesLabel(row.roles)} · роль отключена`} · {actor.type === 'agent' ? 'ИИ-агент' : 'человек'}</small></div><Status value={accessState(access, row, actor)}/><ChevronRight aria-hidden="true" size={16}/></Link>; };
  return <><ProjectHeader route={route} project={project}/><EnvironmentAccess access={access} csrfToken={csrfToken} project={project}/><AccessMatrix access={access} actors={activeActors} memberships={activeMemberships} project={project}/><div className={`fcp-access-layout${route.accessActorId === undefined || route.accessActorId === null ? '' : ' has-selection'}`}>
    <aside className="fcp-access-master"><div className="fcp-section-head"><div><h2>Участники</h2><span>Откройте строку для объяснения доступа</span></div></div>{activeActors.length === 0 ? <p className="fcp-empty-line">Активные участники проекта не зафиксированы.</p> : <div className="fcp-list">{activeActors.map(actorRow)}</div>}{inactiveActors.length === 0 ? null : <details className="fcp-system-details"><summary>Отключённые роли · {inactiveActors.length}</summary><div className="fcp-list">{inactiveActors.map(actorRow)}</div></details>}</aside>
    <main className="fcp-access-detail"><Link className="fcp-access-back" href={projectUrl(project.project.slug, 'access', route.scope)}><ChevronLeft aria-hidden="true" size={16}/>Участники</Link>{selected === null || membership === null ? <Blank title="Выберите участника">Нажмите на участника слева, чтобы увидеть происхождение его доступа.</Blank> : <>
      <div className="fcp-page-title fcp-access-title"><div><h1>{selected.displayName}</h1><p>Объяснение из роли, явных разрешений и наблюдений подключённого провайдера.</p></div><Status value={accessState(access, membership, selected)}/></div>
      <section className="fcp-section"><div className="fcp-section-head"><h2>Почему участник видит проект</h2><ShieldCheck aria-hidden="true" size={17}/></div><Summary items={[{label: 'Роль', value: membership.active ? rolesLabel(membership.roles) : 'Неактивна'}, {label: 'Участник', value: selected.disabledAt === null ? 'Включён' : 'Отключён'}, {label: 'Внешняя личность', value: identities.length === 0 ? 'Не зафиксирована' : `активных: ${identities.filter((item) => item.active).length}`}, {label: 'Явные разрешения', value: grants.length}]}/></section>
      <section className="fcp-section"><div className="fcp-section-head"><h2>Роль в проекте</h2><span>Роль Control Plane · версия {membership.version}</span></div>{membership.canManage && csrfToken !== null ? <form action={`/api/access/memberships/${membership.id}`} className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="expectedVersion" type="hidden" value={membership.version}/><fieldset><legend>Роли проекта</legend>{selected.type === 'agent' ? <label><input defaultChecked name="roleAgent" type="checkbox" value="true"/>ИИ-агент</label> : <><label><input defaultChecked={membership.roles.includes('contributor')} name="roleContributor" type="checkbox" value="true"/>Разработчик</label><label><input defaultChecked={membership.roles.includes('project_owner')} name="roleProjectOwner" type="checkbox" value="true"/>Product Owner</label><label><input defaultChecked={membership.roles.includes('reviewer')} name="roleReviewer" type="checkbox" value="true"/>Ревьюер</label><label><input defaultChecked={membership.roles.includes('client_viewer')} name="roleClientViewer" type="checkbox" value="true"/>Представитель клиента</label><label><input defaultChecked={membership.roles.includes('workspace_owner')} name="roleWorkspaceOwner" type="checkbox" value="true"/>Владелец рабочей области</label></>}</fieldset><label>Состояние<select defaultValue={String(membership.active)} name="active"><option value="true">Активна</option><option value="false">Отключена</option></select></label><button className="fcp-primary-button" type="submit">Сохранить роль</button></form> : <p className="fcp-empty-line">Для изменения роли нужны права владельца проекта и авторизованная сессия.</p>}</section>
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
  if (health === null) return <Blank title="Системные данные недоступны">Не удалось загрузить сохранённые эксплуатационные факты.</Blank>;
  const unhealthy = health.jobs.filter((job) => job.status === 'unhealthy').length;
  return <><Summary items={[{label: 'Регламентные задачи', value: health.jobs.length}, {label: 'Нештатные задачи', value: unhealthy, tone: unhealthy > 0 ? 'danger' : ''}, {label: 'Наблюдения интеграций', value: health.integrations.length}, {label: 'Открытые риски', value: health.risks.length, tone: health.risks.length > 0 ? 'danger' : ''}, {label: 'Записи аудита', value: health.audit.length}]}/><div className="fcp-systems-grid"><SystemFacts icon={Workflow} title="Регламентные задачи" empty="Сохранённые регламентные задачи отсутствуют." items={health.jobs}>{(job) => <><strong>{job.project} · {job.name}</strong><span>{statusLabel(job.status)} · heartbeat {date(job.heartbeatAt)} · успешно {date(job.lastSuccessAt)} · следующий запуск {date(job.nextRunAt)}</span></>}</SystemFacts><SystemFacts icon={ServerCog} title="Наблюдения интеграций" empty="Операции обновления трекера не зафиксированы." items={health.integrations}>{(item) => <><strong>{item.project} · {item.provider}</strong><span>{item.mode} · наблюдение {date(item.createdAt)}</span></>}</SystemFacts><SystemFacts icon={ShieldAlert} title="Открытые риски" empty="Открытые системные риски отсутствуют." items={health.risks}>{(item) => <><strong>{item.project} · {statusLabel(item.severity)}</strong><span>{riskReasonLabel(item.summary)} · обновлено {date(item.updatedAt)}</span></>}</SystemFacts><SystemFacts icon={History} title="Восстановление и аудит" empty="Канонические записи аудита отсутствуют." items={health.audit}>{(item) => <><strong>{item.project} · {item.action}</strong><span>{item.actor ?? 'Автор не зафиксирован'} · {item.outcome ?? 'Результат не зафиксирован'} · {date(item.occurredAt)}</span></>}</SystemFacts></div><details className="fcp-system-details"><summary>Все сохранённые системные факты</summary><div>{health.jobs.map((item) => <p key={item.id}>{item.project} · {item.name} · {statusLabel(item.status)} · heartbeat {date(item.heartbeatAt)} · успешно {date(item.lastSuccessAt)} · следующий запуск {date(item.nextRunAt)}</p>)}{health.integrations.map((item) => <p key={item.id}>{item.project} · {item.provider} · {item.mode} · {date(item.createdAt)}</p>)}{health.risks.map((item) => <p key={item.id}>{item.project} · {statusLabel(item.severity)} · {riskReasonLabel(item.summary)} · {date(item.updatedAt)}</p>)}{health.costLedger.length === 0 ? <p>Факты стоимости запусков агентов отсутствуют.</p> : health.costLedger.map((item) => <p key={`${item.runType}:${item.currency}:${item.state}`}>{item.runType} · {item.state} · запусков: {item.count} · {item.currency ?? 'валюта не зафиксирована'}</p>)}{health.audit.map((item) => <p key={item.id}>{item.project} · {item.action} · {item.targetType} · {item.targetId ?? 'цель не зафиксирована'} · {item.policyDecision ?? 'решение не зафиксировано'} · {item.reasonCode ?? 'причина не зафиксирована'}</p>)}</div></details></>;
}
function SystemFacts<T>({icon: Icon, title, empty, items, children}: {icon: typeof Bot; title: string; empty: string; items: readonly T[]; children: (item: T) => ReactNode}) { return <section className="fcp-system-card"><header><Icon aria-hidden="true" size={18}/><h2>{title}</h2><span>{items.length}</span></header>{items.length === 0 ? <p>{empty}</p> : <div>{items.slice(0, 3).map((item, index) => <article key={index}>{children(item)}</article>)}</div>}</section>; }
function Agents({route, access, health, projects, csrfToken}: {route: WorkspaceUiRoute; access: AccessData | null; health: HealthData | null; projects: readonly WorkspaceProjectRef[]; csrfToken: string | null}) {
  if (selectedGlobalProject(route) === null) return <ProjectChooser route={route} projects={projects} title="Агенты и системы" detail="Системы и runtime-факты доступны отдельно внутри проекта." area="agents"/>;
  const selectedProjectSlug = selectedGlobalProject(route);
  const selectedProject = projects.find((project) => project.slug === selectedProjectSlug) ?? null;
  const managedAgentIds = new Set(access?.memberships.flatMap((membership) =>
    membership.active &&
    membership.roles.length === 1 && membership.roles[0] === 'agent' &&
    (route.globalProject === undefined || route.globalProject === 'all' || membership.projectSlug === route.globalProject)
      ? [membership.actorId] : []) ?? []);
  const agents = access?.actors.filter((actor) => actor.type === 'agent' && managedAgentIds.has(actor.id)) ?? [];
  const systems = new Map<string, AccessData['agentSystems'][number]>(access?.agentSystems.map((item) => [item.actorId, item] as const) ?? []);
  const projectId = access?.memberships.find((membership) =>
    membership.projectSlug === selectedProjectSlug && membership.canManage)?.projectId ?? null;
  return <><div className="fcp-page-title"><div><h1>Агенты и системы</h1><p>Работоспособность, текущая работа и последние результаты — без технического шума.</p></div><Scope route={route}/></div><section className="fcp-agent-command"><div className="fcp-section-head"><div><h2>Управляемые агенты</h2><span>{selectedProject?.name ?? 'Проект'} · факты из наблюдений runtime и подтверждённых receipts</span></div></div>{agents.length === 0 ? <Blank title="Управляемого агента нет">{selectedProjectSlug === 'ascon' ? 'Для ASCON это зафиксированное решение проекта: Владимир работает напрямую через Codex.' : 'В проекте нет активного участника с ролью ИИ-агента.'}</Blank> : agents.map((agent) => {
    const profiles = systems.get(agent.id)?.profiles ?? [];
    const healthState = agent.disabledAt === null ? fleetHealth(profiles) : 'disabled';
    const currentWork = profiles.find((profile) => profile.fleet.currentWork !== null)?.fleet.currentWork ?? null;
    const freshnessAt = profiles.map((profile) => profile.fleet.freshnessAt).filter((value): value is Date => value !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const lastReceipt = profiles.find((profile) => profile.fleet.lastReceipt !== null)?.fleet.lastReceipt ?? null;
    const components = profiles.flatMap((profile) => profile.registrations.flatMap((registration) => Object.entries(registration.availability.components).map(([name, fact]) => ({name, fact}))));
    return <article className="fcp-agent-hero" key={agent.id}><header><span className="fcp-agent-icon"><Bot aria-hidden="true" size={24}/></span><div><h2>{agent.displayName}</h2><p>{profiles.length === 0 ? 'Профиль не зафиксирован' : profiles.map((profile) => `${profile.runtimeId} · ${profile.runtimeProfile}`).join(' · ')}</p></div><Status value={healthState}/></header><div className="fcp-agent-vitals"><div><span>Последний heartbeat</span><strong>{date(freshnessAt)}</strong></div><div><span>Текущая работа</span><strong>{currentWork === null ? 'Активной задачи нет' : currentWork.title}</strong><small>{currentWork?.project ?? 'Проект не зафиксирован'}</small></div><div><span>Последний результат</span><strong>{lastReceipt === null ? 'Не зафиксирован' : statusLabel(lastReceipt.terminal)}</strong><small>{lastReceipt === null ? 'Receipt отсутствует' : `${lastReceipt.project} · ${date(lastReceipt.completedAt)}`}</small></div></div><div className="fcp-agent-components">{components.length === 0 ? <span className="fcp-component-chip unknown"><CircleDot aria-hidden="true" size={12}/>Компоненты не наблюдаются</span> : components.map(({name, fact}, index) => <span className={`fcp-component-chip ${statusTone(fact.state)}`} key={`${name}:${index}`}><CircleDot aria-hidden="true" size={12}/>{name} · {statusLabel(fact.state)}</span>)}</div><footer><Link className="fcp-primary" href={screenUrl({kind: 'agent', agentId: agent.id}, route.scope)}>Открыть управление <ChevronRight aria-hidden="true" size={15}/></Link></footer></article>;
  })}</section><details className="fcp-system-console"><summary><Bot aria-hidden="true" size={17}/><span><strong>Управление · добавить агента</strong><small>Канонический профиль и одна проектная привязка runtime</small></span><ChevronRight aria-hidden="true" size={16}/></summary><div>{csrfToken === null || projectId === null ? <p className="fcp-empty-line">Для добавления нужны права владельца проекта и авторизованная сессия.</p> : <form action="/api/access/onboarding" className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="idempotencyKey" type="hidden" value={crypto.randomUUID()}/><input name="projectId" type="hidden" value={projectId}/><input name="actorType" type="hidden" value="agent"/><label>Имя агента<input maxLength={120} name="displayName" required/></label><label>Runtime<input maxLength={64} name="runtimeId" placeholder="codex" required/></label><label>Портативный профиль<input maxLength={64} name="runtimeProfile" placeholder="read_safe" required/></label><label>Ключ регистрации<input maxLength={256} name="runtimeKey" required/></label><button className="fcp-primary-button" type="submit">Добавить агента</button><small>Секреты и настройки провайдера не принимаются; внешних изменений команда не выполняет.</small></form>}</div></details><details className="fcp-system-console"><summary><ServerCog aria-hidden="true" size={17}/><span><strong>Системные факты и диагностика</strong><small>Jobs, интеграции, риски и аудит</small></span><ChevronRight aria-hidden="true" size={16}/></summary><div><SystemsSummary health={health}/></div></details></>;
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
  const rawProfiles = access?.agentSystems.find((item) => item.actorId === agent.id)?.profiles ?? [];
  const profiles = rawProfiles.map((profile) => ({
    ...profile,
    registrations: profile.registrations.map((registration) => ({
      ...registration,
      ttlSeconds: registration.ttlSeconds ?? {service: null, scheduler: null, delivery: null},
      recoveryPolicy: registration.recoveryPolicy ?? null,
      recoveryCandidate: registration.recoveryCandidate === null || registration.recoveryCandidate === undefined
        ? null
        : {
            ...registration.recoveryCandidate,
            staleComponents: [
              ...registration.recoveryCandidate.staleComponents,
              ...registration.recoveryCandidate.missingComponents.map((component) => `${component} (наблюдение отсутствует)`)
            ]
          }
    }))
  }));
  const health = agent.disabledAt === null ? fleetHealth(profiles) : 'disabled';
  return <><div className="fcp-page-title"><div><Crumbs route={route} project={null} title={agent.displayName}/><h1>{agent.displayName}</h1><p>Работоспособность, текущая работа и результаты из подтверждённых наблюдений.</p></div><div className="fcp-agent-title-actions"><Status value={health}/>{agent.disabledAt === null ? <AgentRetirementControls agentId={agent.id} agentName={agent.displayName} canRetire={access.canRetireAgents} csrfToken={csrfToken}/> : null}</div></div><div className="fcp-detail-layout"><main className="fcp-detail-main"><section className="fcp-section"><div className="fcp-section-head"><h2>Работоспособность</h2><ServerCog aria-hidden="true" size={17}/></div>{profiles.length === 0 ? <p className="fcp-empty-line">Профиль агента или привязка к проекту не зафиксированы.</p> : <div className="fcp-fleet-profiles">{profiles.map((profile) => <article key={profile.id}><header><div><strong>{profile.runtimeId} · {profile.runtimeProfile}</strong><small>{profile.enabled ? 'Профиль включён' : 'Профиль отключён'} · привязок к проектам: {profile.registrations.length}</small></div><Status value={profile.fleet.health}/></header>{profile.registrations.length === 0 ? <p className="fcp-empty-line">Проектная привязка не зафиксирована.</p> : <div className="fcp-registration-list">{profile.registrations.map((registration) => <div key={registration.id}><div><strong>{registration.project}</strong><small>{registration.provider}/{registration.runtimeKey} · версия привязки {registration.version}</small>{Object.entries(registration.availability.components).map(([component, fact]) => <small key={component}>{component} · {statusLabel(fact.state)} · TTL {registration.ttlSeconds[component as keyof typeof registration.ttlSeconds] ?? 'не настроен'} сек. · {date(fact.observedAt)}</small>)}<details><summary>Политика и следующий шаг</summary><small>{registration.recoveryPolicy === null ? 'Политика восстановления не задана.' : `${registration.recoveryPolicy.enabled ? 'Включена' : 'Выключена'} · порог ${registration.recoveryPolicy.staleThresholdSeconds} сек. · максимум попыток ${registration.recoveryPolicy.maximumAttempts}`}</small><small>{registration.recoveryCandidate === null ? 'Кандидат на восстановление отсутствует.' : `Нужна проверка: ${registration.recoveryCandidate.staleComponents.join(', ')}. Следующий шаг — менеджер проверяет факты и использует ручное управление.`}</small></details></div><Status value={registration.availability.health}/><RuntimeRegistrationControls agentId={agent.id} agentProfileId={profile.id} canManage={agent.disabledAt === null && registration.canManage} csrfToken={csrfToken} enabled={registration.enabled} expectedVersion={registration.version} projectId={registration.projectId} projectName={registration.project} recoveryPolicy={registration.recoveryPolicy} registrationId={registration.id} replacementTargets={access === null ? [] : replacementTargets(access, agent.id, profile.id, registration.projectId)} staleRun={profile.fleet.health === 'stale' && profile.fleet.currentWork?.projectSlug === registration.projectSlug ? {id: profile.fleet.currentWork.id, version: profile.fleet.currentWork.version} : null}/></div>)}</div>}<dl><div><dt>Последний heartbeat</dt><dd>{date(profile.fleet.freshnessAt)}</dd></div><div><dt>Текущая работа</dt><dd>{profile.fleet.currentWork === null ? 'Не зафиксировано' : `${profile.fleet.currentWork.project} · ${profile.fleet.currentWork.title} · ${statusLabel(profile.fleet.currentWork.status)}`}</dd></div><div><dt>Последний результат</dt><dd>{profile.fleet.lastReceipt === null ? 'Не зафиксировано' : `${profile.fleet.lastReceipt.terminal} · ${profile.fleet.lastReceipt.project} · ${date(profile.fleet.lastReceipt.completedAt)}`}</dd></div></dl></article>)}</div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Действующие инструкции</h2><Bot aria-hidden="true" size={17}/></div>{profiles.length === 0 || profiles.every((profile) => profile.instruction === null) ? <p className="fcp-empty-line">Версии действующих инструкций для этого агента не зафиксированы.</p> : profiles.map((profile) => profile.instruction === null ? null : <article className="fcp-agent-profile" key={`${profile.id}:instruction`}><strong>{profile.runtimeId} · {profile.runtimeProfile}</strong><p>{profile.instruction.provenance} · hash действующей версии {profile.instruction.hash}</p>{profile.instruction.history === undefined ? null : <InstructionHistory title="Дополнение инструкции профиля" scope="agent_profile" targetId={profile.id} csrfToken={csrfToken} current={profile.instruction.history.override} previous={profile.instruction.history.previousOverride}/>}</article>)}</section>{agent.disabledAt === null ? profiles.map((profile) => <AgentProfileSettings csrfToken={csrfToken} key={`${profile.id}:settings`} profile={profile}/>) : null}</main><aside className="fcp-meta"><h2>Сводка</h2><DetailFacts items={[{label: 'Тип', value: agent.type}, {label: 'Роль', value: agent.role}, {label: 'Состояние участника', value: agent.disabledAt === null ? 'Включён' : 'Отключён'}, {label: 'Работоспособность', value: statusLabel(health)}, {label: 'Профили', value: String(profiles.length)}]}/></aside></div></>;
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
  const manageableProjects = [...new Map(access.memberships.filter((membership) => membership.canManage)
    .map((membership) => [membership.projectId, membership] as const)).values()];
  return <><div className="fcp-page-title"><div><h1>Люди и доступы</h1><p>Текущие роли, требуемые права и подтверждение подключённых провайдеров.</p></div><Scope route={route}/></div><section className="fcp-section"><div className="fcp-section-head"><h2>Участники проектов</h2><span>Роль не подтверждает внешний доступ</span></div>{membershipRows.length === 0 ? <p className="fcp-empty-line">Активные участники проектов не зафиксированы.</p> : <div className="fcp-list">{membershipRows.map(({membership, actor}) => { const confirmed = providerAccessConfirmed(access, membership); return <Link className="fcp-row fcp-people-row" href={`/projects/${membership.projectSlug}/access/${actor.id}${scopeQuery(route.scope)}`} key={`${membership.projectId}:${actor.id}`}><UsersRound aria-hidden="true" size={18}/><div><strong>{actor.displayName}</strong><small>{membership.project} · {rolesLabel(membership.roles)}{membership.roles.length === 1 && membership.roles[0] === 'agent' ? '' : ` · ${actor.type === 'human' ? 'человек' : 'система'}`}</small></div><Status value={accessState(access, membership, actor)}/><span>{actor.disabledAt !== null ? 'Участник отключён' : confirmed ? 'Доступ подтверждён провайдером' : 'Роль зафиксирована'}</span><ChevronRight aria-hidden="true" size={16}/></Link>; })}</div>}</section><section className="fcp-section"><div className="fcp-section-head"><h2>Состояние доступов</h2><span>Фактические права остаются специфичными для провайдера</span></div><Summary items={[{label: 'Люди и агенты', value: access.actors.length}, {label: 'Активные роли', value: access.memberships.filter((membership) => membership.active).length}, {label: 'Внешние учётные записи', value: access.externalIdentities.filter((identity) => identity.active).length}, {label: 'Подтверждённые права', value: access.resourceGrants.filter((grant) => grant.observedLevel !== null && grant.observedAt !== null).length}]}/></section><section className="fcp-section"><div className="fcp-section-head"><div><h2>Управление · расширенные настройки</h2><span>Добавление участника и утверждённые версии инструкций</span></div></div><details className="fcp-system-details"><summary>Добавить человека</summary>{csrfToken === null || manageableProjects.length === 0 ? <p>Для добавления нужны права владельца проекта и авторизованная сессия.</p> : <form action="/api/access/onboarding" className="fcp-profile-form" method="post"><input name="_csrf" type="hidden" value={csrfToken}/><input name="idempotencyKey" type="hidden" value={crypto.randomUUID()}/><input name="actorType" type="hidden" value="human"/><label>Проект<select name="projectId" required>{manageableProjects.map((project) => <option key={project.projectId} value={project.projectId}>{project.project}</option>)}</select></label><label>Имя<input maxLength={120} name="displayName" required/></label><label>Роль в рабочей области<select name="actorRole"><option value="developer">Разработчик</option><option value="delivery_lead">Руководитель delivery</option></select></label><fieldset><legend>Роли в проекте</legend><label><input name="roleContributor" type="checkbox" value="true"/>Разработчик</label><label><input name="roleProjectOwner" type="checkbox" value="true"/>Product Owner</label><label><input name="roleReviewer" type="checkbox" value="true"/>Ревьюер</label><label><input name="roleClientViewer" type="checkbox" value="true"/>Представитель клиента</label></fieldset><button className="fcp-primary-button" type="submit">Добавить человека</button><small>Создаётся участник и одна проектная роль. Внешняя учётная запись не создаётся.</small></form>}</details>{instructionBaselines.length === 0 ? <p className="fcp-empty-line">Базовая инструкция рабочей области не зафиксирована.</p> : instructionBaselines.map((baseline) => <InstructionHistory key={baseline.workspaceId} title="Базовая инструкция рабочей области" scope="workspace" targetId="" csrfToken={csrfToken} current={baseline.current} previous={baseline.previous}/>)}</section></>;
}
function ProjectScreen({route, data}: {route: WorkspaceRoute; data: WorkspaceData}) {
  const project = ready(data.project);
  const runs = ready(data.runs);
  const access = ready(data.access);
  if (project === null) return <Blank title="Проект не наблюдается">Проект отсутствует в доступной модели данных PostgreSQL.</Blank>;
  const executionMembership = access?.memberships.find((item) =>
    item.projectId === project.project.id && item.actorId === data.operatorActorId && item.active);
  const executionOperator = access?.actors.find((item) =>
    item.id === data.operatorActorId && item.type === 'human' && item.disabledAt === null);
  const canManageExecution = executionMembership?.roles.includes('project_owner') === true ||
    executionMembership?.roles.includes('workspace_owner') === true || executionOperator?.role === 'workspace_admin' ||
    executionOperator?.role === 'delivery_lead';
  const hasExecutionWriteCapability =
    executionOperator?.capabilities['write:control_plane:development'] === true;
  switch (route.screen) {
    case 'setup': {
      const membership = access?.memberships.find((item) => item.projectId === project.project.id && item.actorId === data.operatorActorId && item.active);
      const operator = access?.actors.find((item) => item.id === data.operatorActorId && item.type === 'human' && item.disabledAt === null);
      const canApprovePlan = membership?.roles.includes('project_owner') === true;
      const canEditPlan = canApprovePlan || membership?.roles.includes('workspace_owner') === true || operator?.role === 'workspace_admin' || operator?.role === 'delivery_lead';
      return <ProjectSetup route={route} project={project} csrfToken={data.csrfToken ?? null} canEditPlan={canEditPlan} canApprovePlan={canApprovePlan}/>;
    }
    case 'overview': return <Overview route={route} project={project} runs={runs} portfolio={ready(data.portfolio)} csrfToken={data.csrfToken ?? null} canManage={canManageExecution ?? false} hasWriteCapability={hasExecutionWriteCapability} canApproveOutcome={executionMembership?.roles.includes('project_owner') === true && hasExecutionWriteCapability} canClientSignoff={executionMembership?.roles.includes('client_viewer') === true && hasExecutionWriteCapability}/>;
    case 'tasks': return <Tasks route={route} project={project} access={access} operatorActorId={data.operatorActorId ?? null}/>;
    case 'task': return <TaskDetail route={route} project={project} runs={runs} lifecycleLoad={data.lifecycle ?? null} csrfToken={data.csrfToken ?? null} operatorActorId={data.operatorActorId ?? null} canRecordTerminalEvidence={executionMembership?.roles.includes('project_owner') === true && hasExecutionWriteCapability}/>;
    case 'protocol': return <Protocol route={route} project={project} access={access} csrfToken={data.csrfToken ?? null}/>;
    case 'runs': return <Runs route={route} project={project} runs={runs}/>;
    case 'run': return <RunDetail route={route} project={project} runs={runs} csrfToken={data.csrfToken ?? null} operatorActorId={data.operatorActorId ?? null}/>;
    case 'chats': return <Chats route={route} project={project} conversations={ready(data.conversations ?? null)} csrfToken={data.csrfToken ?? null} canManage={canManageExecution === true && hasExecutionWriteCapability}/>;
    case 'access': return <><Access route={route} project={project} access={access} csrfToken={data.csrfToken ?? null}/><AccessOperations project={project} access={access} csrfToken={data.csrfToken ?? null}/></>;
    default: return null;
  }
}
export function WorkspaceShell({route, data}: {route: WorkspaceRoute; data: WorkspaceData}) {
  const access = ready(data.access);
  const health = ready(data.health);
  const conversations = ready(data.conversations ?? null);
  const observedProjects = [
    ...(ready(data.portfolio)?.projects.map(({name, slug, health}) => ({name, slug, health})) ?? []),
    ...(data.project?.state === 'ready' && data.project.data !== null ? [{name: data.project.data.project.name, slug: data.project.data.project.slug, health: data.project.data.snapshot?.health ?? 'unknown'}] : []),
    ...(data.projectIndex ?? []).map(({project, snapshot}) => ({name: project.name, slug: project.slug, health: snapshot?.health ?? 'unknown'})),
    ...(access?.memberships.filter((membership) => membership.active).map(({project: name, projectSlug: slug}) => ({name, slug})) ?? [])
  ].filter((project, index, projects) => projects.findIndex(({slug}) => slug === project.slug) === index);
  const operatorScoped = data.operatorActorId !== null && data.operatorActorId !== undefined;
  const authorizedSlugs = !operatorScoped
    ? new Set(observedProjects.map(({slug}) => slug))
    : new Set(access?.memberships.flatMap((membership) => membership.actorId === data.operatorActorId && membership.active ? [membership.projectSlug] : []) ?? []);
  const visibleProjects = observedProjects.filter(({slug}) => authorizedSlugs.has(slug)).map((project) => {
    const membership = access?.memberships.find((item) => item.actorId === data.operatorActorId && item.projectSlug === project.slug && item.active);
    return {...project, ...(membership === undefined ? {} : {role: rolesLabel(membership.roles)})};
  });
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
    : route.screen === 'dashboard' ? <Dashboard route={route} projects={(data.projectIndex ?? []).filter((item) => authorizedSlugs.has(item.project.slug))} portfolio={ready(data.portfolio)}/>
      : route.screen === 'projects' ? <Projects route={route} projects={(data.projectIndex ?? []).filter((item) => authorizedSlugs.has(item.project.slug))} access={scopedAccess} csrfToken={data.csrfToken ?? null} operatorActorId={data.operatorActorId ?? null}/>
        : route.screen === 'global_tasks' ? <GlobalTasks route={route} projects={projectSelection(route, visibleProjects)}/>
          : route.screen === 'global_chats' ? <GlobalChats route={route} projects={projectSelection(route, visibleProjects)}/>
            : route.screen === 'people' ? <People route={route} access={scopedAccess} csrfToken={data.csrfToken ?? null}/>
              : route.screen === 'agents' ? <Agents route={route} access={scopedAccess} health={scopedHealth} projects={visibleProjects} csrfToken={data.csrfToken ?? null}/>
                : route.screen === 'agent' ? <AgentDetail route={route} access={scopedAccess} csrfToken={data.csrfToken ?? null}/>
                  : <ProjectScreen route={route} data={scopedData}/>;
  return <div className="fcp-workspace" style={tokenStyle}><div className="fcp-shell-layout"><WorkspaceShellHeader route={route} projects={visibleProjects}/><main className="fcp-main">{content}</main></div></div>;
}
