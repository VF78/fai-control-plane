import {listProjects} from '@fai-control-plane/db';
import {getDatabase, requireSession} from '../src/mvp/runtime.ts';

export const dynamic = 'force-dynamic';
export default async function Home() {
  let projects: Awaited<ReturnType<typeof listProjects>> | null = null;
  try {
    const session = await requireSession();
    projects = await listProjects(getDatabase(), session.actorId);
  } catch {
    projects = null;
  }
  if (projects === null) return <main><header><p>f(AI) Studio</p><h1>Control Plane</h1></header><section>
      <h2>Вход оператора</h2><p>Авторизация выполняется через GitHub.</p>
      <a className="button" href="/api/auth/github/login">Войти</a>
    </section></main>;
  return <main><header><p>f(AI) Studio</p><h1>Control Plane</h1></header><section>
    <h2>Проекты</h2>{projects.length === 0 ? <p>Проекты ещё не подключены.</p> : <ul>{projects.map((project) =>
      <li key={project.id}><a href={project.repositoryUrl}>{project.name}</a><small>{project.slug}</small></li>)}</ul>}
  </section></main>;
}
