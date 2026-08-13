import {
  listApprovalEvidenceViews,
  listProjectSourceViews,
  listProjectTaskViews,
  type ApprovalEvidenceView,
  type ProjectSourceView,
  type ProjectTaskView
} from '@fai-control-plane/db';
import type {ReactNode} from 'react';
import {buildPortfolio, type PortfolioFocus, type PortfolioProject} from '../src/mvp/portfolio-view.ts';
import {getDatabase, requireSession} from '../src/mvp/runtime.ts';

export const dynamic = 'force-dynamic';
type View = 'overview' | 'tasks' | 'sources' | 'approvals';
type Query = Readonly<{view?: string; project?: string; task?: string}>;

const viewLabel: Record<View, string> = {overview: 'Обзор', tasks: 'Задачи', sources: 'Источники', approvals: 'Согласования'};
const viewGlyph: Record<View, string> = {overview: '◫', tasks: '☑', sources: '◇', approvals: '✓'};
const currentView = (value: string | undefined): View => value === 'tasks' || value === 'sources' || value === 'approvals' ? value : 'overview';
const href = (view: View, project?: string, task?: string): string => {
  const query = new URLSearchParams({view});
  if (project !== undefined) query.set('project', project);
  if (task !== undefined) query.set('task', task);
  return `/?${query.toString()}`;
};
const formatDate = (value: string): string => new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Moscow'
}).format(new Date(value.length === 10 ? `${value}T12:00:00.000Z` : value));
const formatInstant = (value: string): string => new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'
}).format(new Date(value));
const progress = (project: PortfolioProject): number => project.total === 0 ? 0 : project.done / project.total * 100;
const healthLabel = (project: PortfolioProject): string => project.health === 'steady' ? 'По плану'
  : project.health === 'attention' ? 'Требует внимания' : 'Нет актуальных данных';
const focusDecision = (focus: PortfolioFocus): string => focus.kind === 'overdue' ? `Определить новый контроль для #${focus.issueId}`
  : focus.kind === 'blocked' ? `Снять блокировку #${focus.issueId}` : `Проверить результат #${focus.issueId}`;
const freshnessLabel = (project: ProjectTaskView): string => project.tracker.errorCode !== null
  ? `Ошибка: ${project.tracker.errorCode}` : project.tracker.observedAt === null ? 'Снимок не получен'
    : `${project.tracker.freshness === 'fresh' ? 'Обновлено' : 'Снимок устарел'} ${formatInstant(project.tracker.observedAt)}`;

function Shell({view, projects, selected, operatorName, children}: Readonly<{
  view: View; projects: readonly ProjectTaskView[]; selected: ProjectTaskView | null; operatorName: string; children: ReactNode;
}>) {
  const navigation = (items: readonly View[]) => items.map((item) => <a aria-current={view === item ? 'page' : undefined}
    href={href(item, selected?.slug)} key={item}><i aria-hidden="true">{viewGlyph[item]}</i><span>{viewLabel[item]}</span></a>);
  return <div className="fcp-workspace fcp-shell-layout">
    <aside className="fcp-sidebar">
      <a className="fcp-brand" href={href('overview')}><i aria-hidden="true">f</i><b>f(AI) Control</b></a>
      <nav className="fcp-sidebar-section fcp-project-list-nav" aria-label="Доступные проекты"><span>Проекты</span>
        {projects.map((project) => <a aria-current={selected?.id === project.id ? 'page' : undefined}
          href={href(view, project.slug)} key={project.id}><i className={`fcp-project-initial project-${project.slug}`}>{project.name[0]}</i>
          <div><b>{project.name}</b><small>{freshnessLabel(project)}</small></div><span className={`fcp-source-dot ${project.tracker.freshness}`} aria-label={project.tracker.freshness}/></a>)}</nav>
      <nav className="fcp-sidebar-section fcp-sidebar-nav" aria-label="Рабочие разделы"><span>Работа</span>{navigation(['overview','tasks'])}</nav>
      <nav className="fcp-sidebar-section fcp-sidebar-nav" aria-label="Контроль"><span>Контроль</span>{navigation(['approvals'])}</nav>
      <nav className="fcp-sidebar-section fcp-sidebar-nav fcp-sidebar-settings" aria-label="Настройки"><span>Настройки</span>{navigation(['sources'])}</nav>
    </aside>
    <header className="fcp-topbar"><a className="fcp-mobile-brand" href={href('overview')}>f(AI) Control</a>
      <strong>{selected === null ? viewLabel[view] : `${selected.name} · ${viewLabel[view]}`}</strong>
      <span className="fcp-access-count">⌾ Доступ: {projects.length} {projects.length === 1 ? 'проект' : 'проекта'}</span>
      <span className="fcp-user-avatar" aria-label={`Оператор: ${operatorName}`}>{operatorName.split(/\s+/).map((part) => part[0]).join('').slice(0,2).toUpperCase()}</span>
      <details className="fcp-mobile-menu"><summary aria-label="Открыть навигацию">☰</summary><div className="fcp-mobile-menu-body">
        <nav aria-label="Доступные проекты"><span>Проекты</span>{projects.map((project) => <a href={href(view, project.slug)} key={project.id}>{project.name}</a>)}</nav>
        <nav aria-label="Разделы"><span>Работа</span>{navigation(['overview','tasks','approvals','sources'])}</nav>
      </div></details>
    </header>
    <main className="fcp-main">{children}</main>
  </div>;
}

function Overview({projects}: Readonly<{projects: readonly ProjectTaskView[]}>) {
  const portfolio = buildPortfolio(projects);
  const attention = portfolio.filter((project) => project.health !== 'steady').length;
  const exceptions = portfolio.flatMap((project) => project.focus.map((focus) => ({project, focus}))).slice(0, 3);
  return <><div className="fcp-page-title"><div><h1>Обзор проектов</h1><p>Текущий статус портфеля по подтверждённым фактам GitHub Project.</p></div>
    <aside className={`fcp-pulse ${attention === 0 ? 'steady' : ''}`}><span>Пульс портфеля</span><strong>{attention === 0 ? 'Исключений нет' : `${attention} ${attention === 1 ? 'проект требует' : 'проекта требуют'} внимания`}</strong></aside></div>
    <section className="fcp-dashboard-progress" aria-label="Статус доступных проектов">{portfolio.map((project) =>
      <article className="fcp-dashboard-progress-card" key={project.id}>
        <header><div><span>{project.name}</span><small>GitHub Project · {project.open} открыто</small></div><b className={`fcp-health ${project.health}`}>{healthLabel(project)}</b></header>
        <p className="fcp-health-reason">{project.healthReason}</p>
        <strong>{project.done} <em>/ {project.total}</em></strong>
        <div className="fcp-dashboard-progress-bar" role="img" aria-label={`${project.done} из ${project.total} завершено`}><span style={{width:`${progress(project)}%`}}/></div>
        <dl className="fcp-dashboard-facts"><div><dt>Текущая фаза</dt><dd>{project.phase}</dd></div><div><dt>Следующий контроль</dt><dd>{project.nextControl === null ? 'Не задан' : formatDate(project.nextControl)}</dd></div>
          <div><dt>Заблокировано</dt><dd>{project.blocked === null ? 'Нет данных' : project.blocked}</dd></div><div><dt>Просрочено</dt><dd>{project.overdue}</dd></div></dl>
        <section className="fcp-focus"><header><h2>В фокусе</h2><a href={project.sourceUrl}>Открыть Project ↗</a></header>
          {project.focus.length === 0 ? <p>Открытых исключений по доступным фактам нет.</p> : project.focus.map((focus) => <a href={focus.url} key={focus.itemId}><span>#{focus.issueId} · {focus.status}</span><strong>{focus.title}</strong><small>{focus.detail}</small></a>)}</section>
        <footer><span>Главное решение</span>{project.decision === null ? <strong>Новых решений нет</strong> : <><strong>{focusDecision(project.decision)}</strong><a href={project.decision.url}>↗</a></>}</footer>
      </article>)}</section>
    <section className="fcp-exceptions"><header><div><span>Исключения портфеля</span><h2>Требует решения</h2></div></header>
      {exceptions.length === 0 ? <p>По доступным provider-фактам исключений нет.</p> : <ol>{exceptions.map(({project,focus}) => <li key={`${project.id}-${focus.itemId}`}><a href={focus.url}><span>{project.name}</span><strong>#{focus.issueId} · {focus.title}</strong><small>{focus.detail}</small><b>↗</b></a></li>)}</ol>}</section>
    <p className="fcp-provenance">Health — прозрачный вывод интерфейса из provider-native Blocked, сроков и freshness; отдельный локальный риск не сохраняется.</p></>;
}

function Tasks({project, requestedTask}: Readonly<{project: ProjectTaskView | null; requestedTask: string | undefined}>) {
  if (project === null) return <Empty title="Нет доступных проектов"/>;
  const selected = project.tasks.find((task) => task.itemId === requestedTask) ?? null;
  return <><PageTitle title="Задачи" detail={`${project.name} · GitHub Project является единственным источником статуса`} state={freshnessLabel(project)}/>
    {project.tracker.errorCode === null ? null : <p className="fcp-error">Показан последний подтверждённый снимок. {project.tracker.errorCode}</p>}
    <div className={`fcp-task-layout ${selected === null ? '' : 'has-selection'}`}><section className="fcp-task-master"><header><h2>Текущая работа</h2><a href={project.tracker.sourceUrl ?? project.repositoryUrl}>GitHub Project ↗</a></header>
      <div className="fcp-task-list">{project.tasks.map((task) => <a aria-current={selected?.itemId === task.itemId ? 'page' : undefined}
        href={href('tasks', project.slug, task.itemId)} key={task.itemId}><span>#{task.issueId} · {task.statusOptionName ?? 'Без статуса'}</span><strong>{task.title}</strong><small>{task.targetDate === null ? 'Срок не задан' : `Контроль ${formatDate(task.targetDate)}`}{task.blocked === true ? ' · Blocked' : ''}</small></a>)}</div></section>
      <article className="fcp-task-detail">{selected === null ? <><span className="fcp-eyebrow">Детали</span><h2>Выберите задачу</h2><p>Факты отображаются из последнего подтверждённого snapshot.</p></> : <><a className="fcp-back" href={href('tasks',project.slug)}>← К списку</a><span className="fcp-eyebrow">GitHub issue #{selected.issueId}</span><h2>{selected.title}</h2>
        <dl><div><dt>Статус</dt><dd>{selected.statusOptionName ?? 'Не задан'}</dd></div><div><dt>Blocked</dt><dd>{selected.blocked === null ? 'Нет данных' : selected.blocked ? 'Yes' : 'No'}</dd></div><div><dt>Срок</dt><dd>{selected.targetDate === null ? 'Не задан' : formatDate(selected.targetDate)}</dd></div><div><dt>Исполнители</dt><dd>{selected.assigneeIds.join(', ') || 'Не назначены'}</dd></div><div><dt>Родитель</dt><dd>{selected.parentIssueId === null ? 'Нет' : `#${selected.parentIssueId}`}</dd></div><div><dt>Зависимости</dt><dd>{selected.dependencyIssueIds.map((id) => `#${id}`).join(', ') || 'Нет'}</dd></div></dl>
        <a className="fcp-primary" href={selected.url}>Открыть задачу в GitHub ↗</a></>}</article></div></>;
}

function Sources({project, sources}: Readonly<{project: ProjectTaskView | null; sources: readonly ProjectSourceView[]}>) {
  if (project === null) return <Empty title="Нет доступных проектов"/>;
  const rows = sources.filter((source) => source.projectId === project.id);
  return <><PageTitle title="Источники" detail={`${project.name} · документы и конфигурация Control Plane`} state={`${rows.length} записей`}/>
    <section className="fcp-list-section"><header><h2>Подтверждённые материалы</h2></header>{rows.length === 0 ? <p className="fcp-empty">Источники ещё не добавлены.</p> : <div className="fcp-record-list">{rows.map((source) => <article key={source.id}><div><span>{source.kind} · {source.mediaType}</span><strong>{source.name}</strong><small>{source.provenance}</small></div><div><span>{formatInstant(source.createdAt)}</span><code>{source.sha256.slice(0,12)}…</code>{source.sourceUrl === null ? null : <a href={source.sourceUrl}>Источник ↗</a>}</div></article>)}</div>}</section></>;
}

function Approvals({project, approvals}: Readonly<{project: ProjectTaskView | null; approvals: readonly ApprovalEvidenceView[]}>) {
  if (project === null) return <Empty title="Нет доступных проектов"/>;
  const rows = approvals.filter((approval) => approval.projectId === project.id);
  return <><PageTitle title="Согласования" detail={`${project.name} · неизменяемые решения по точной внешней версии`} state={`${rows.length} решений`}/>
    <section className="fcp-list-section"><header><h2>Журнал решений</h2></header>{rows.length === 0 ? <p className="fcp-empty">Согласований пока нет.</p> : <div className="fcp-record-list">{rows.map((approval) => <article key={approval.id}><div><span>{approval.kind}</span><strong>{approval.targetReference}</strong><small>{approval.targetVersion}</small></div><div><b className={`fcp-decision ${approval.decision}`}>{approval.decision}</b><span>{formatInstant(approval.decidedAt)}</span><a href={approval.targetUrl}>Цель ↗</a></div></article>)}</div>}</section></>;
}

function PageTitle({title, detail, state}: Readonly<{title:string;detail:string;state:string}>) { return <div className="fcp-page-title"><div><h1>{title}</h1><p>{detail}</p></div><span className="fcp-page-state">{state}</span></div>; }
function Empty({title}: Readonly<{title:string}>) { return <section className="fcp-empty-card"><h1>{title}</h1><p>После подключения данные появятся здесь.</p></section>; }

export default async function Home({searchParams}: Readonly<{searchParams: Promise<Query>}>) {
  let session: Awaited<ReturnType<typeof requireSession>> | null = null;
  try { session = await requireSession(); } catch { session = null; }
  if (session === null) return <main className="fcp-login"><section><span className="fcp-eyebrow">f(AI) Control</span><h1>Вход оператора</h1><p>Авторизация выполняется через GitHub.</p><a className="fcp-primary" href="/api/auth/github/login">Войти через GitHub</a></section></main>;
  const query = await searchParams; const view = currentView(query.view); const database = getDatabase();
  const [projects,sources,approvals] = await Promise.all([
    listProjectTaskViews(database,session.actorId), listProjectSourceViews(database,session.actorId),
    listApprovalEvidenceViews(database,session.actorId)
  ]);
  const selected = projects.find((project) => project.slug === query.project) ?? projects[0] ?? null;
  return <Shell view={view} projects={projects} selected={selected} operatorName={session.displayName}>{view === 'tasks' ? <Tasks project={selected} requestedTask={query.task}/>
    : view === 'sources' ? <Sources project={selected} sources={sources}/>
      : view === 'approvals' ? <Approvals project={selected} approvals={approvals}/>
        : <Overview projects={projects}/>}</Shell>;
}
