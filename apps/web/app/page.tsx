import {listProjectTaskViews} from '@fai-control-plane/db';
import {getDatabase, requireSession} from '../src/mvp/runtime.ts';

export const dynamic = 'force-dynamic';
const formatInstant = (value: string): string => new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow'
}).format(new Date(value));

export default async function Home({searchParams}: Readonly<{
  searchParams: Promise<Readonly<{task?: string}>>;
}>) {
  let projects: Awaited<ReturnType<typeof listProjectTaskViews>> | null = null;
  try {
    const session = await requireSession();
    projects = await listProjectTaskViews(getDatabase(), session.actorId);
  } catch {
    projects = null;
  }
  if (projects === null) return <main><header><p>f(AI) Studio</p><h1>Control Plane</h1></header><section>
      <h2>Вход оператора</h2><p>Авторизация выполняется через GitHub.</p>
      <a className="button" href="/api/auth/github/login">Войти</a>
    </section></main>;
  const requestedTask = (await searchParams).task;
  const selected = projects.flatMap((project) => project.tasks.map((task) => ({project, task})))
    .find(({task}) => task.itemId === requestedTask) ?? null;
  return <main><header><p>f(AI) Studio</p><h1>Control Plane</h1></header>
    {projects.length === 0 ? <section><h2>Проекты</h2><p>Проекты ещё не подключены.</p></section> :
      projects.map((project) => <section className="project" key={project.id}>
        <div className="project-heading"><div><p className="eyebrow">GitHub Project</p><h2>{project.name}</h2></div>
          <div className={`freshness ${project.tracker.freshness}`}>
            <strong>{project.tracker.freshness}</strong>
            {project.tracker.observedAt === null ? <span>Снимок ещё не получен</span> :
              <time dateTime={project.tracker.observedAt}>{formatInstant(project.tracker.observedAt)}</time>}
          </div></div>
        {project.tracker.errorCode === null ? null : <p className="error" role="status">
          Ошибка источника: <code>{project.tracker.errorCode}</code>. Показан последний подтверждённый снимок.
        </p>}
        <p className="source"><a href={project.tracker.sourceUrl ?? project.repositoryUrl}>Открыть источник в GitHub</a></p>
        {project.tasks.length === 0 ? <p>В подтверждённом снимке задач пока нет.</p> : <div className="task-layout">
          <nav aria-label={`Задачи проекта ${project.name}`}><ul className="task-list">{project.tasks.map((task) =>
            <li key={task.itemId}><a className={selected?.task.itemId === task.itemId ? 'selected' : ''}
              href={`/?task=${encodeURIComponent(task.itemId)}`}><span>{task.title}</span>
                <small>{task.statusOptionName ?? 'Без статуса'} · #{task.issueId}</small></a></li>)}</ul></nav>
          <article className="task-detail">{selected?.project.id !== project.id ?
            <><p className="eyebrow">Детали</p><h3>Выберите задачу</h3><p>Факты читаются непосредственно из GitHub Project.</p></> :
            <><p className="eyebrow">GitHub issue #{selected.task.issueId}</p><h3>{selected.task.title}</h3>
              <dl><div><dt>Статус</dt><dd>{selected.task.statusOptionName ?? 'Не задан'}</dd></div>
                <div><dt>Срок</dt><dd>{selected.task.targetDate ?? 'Не задан'}</dd></div>
                <div><dt>Исполнители</dt><dd>{selected.task.assigneeIds.join(', ') || 'Не назначены'}</dd></div>
                <div><dt>Родитель</dt><dd>{selected.task.parentIssueId === null ? 'Нет' : `#${selected.task.parentIssueId}`}</dd></div>
                <div><dt>Подзадачи</dt><dd>{selected.task.subIssueIds.map((id) => `#${id}`).join(', ') || 'Нет'}</dd></div>
                <div><dt>Зависимости</dt><dd>{selected.task.dependencyIssueIds.map((id) => `#${id}`).join(', ') || 'Нет'}</dd></div></dl>
              <a className="button" href={selected.task.url}>Открыть задачу в GitHub</a></>}
          </article></div>}
      </section>)}
  </main>;
}
