import {listApprovalEvidenceViews, listProjectOperatorEvidenceViews, listProjectSourceViews, listProjectTaskViews} from '@fai-control-plane/db';
import {Dashboard, Process, Shell, Tasks} from '../src/mvp/phase-a-ui.tsx';
import {ApprovalControl} from '../src/mvp/operator-controls.tsx';
import {PhaseB, TaskApprovalEvidence, type PhaseBView} from '../src/mvp/phase-b-ui.tsx';
import {integrationConfig} from '../src/mvp/integration-config.ts';
import {getDatabase, requireSession} from '../src/mvp/runtime.ts';

export const dynamic = 'force-dynamic';
type Area = 'dashboard'|'tasks'|'process'|PhaseBView;
type Query = Readonly<{view?: string; project?: string; task?: string; filter?: string}>;
const current = (view?: string): Area => ['dashboard','tasks','process','conversations','people','systems','settings'].includes(view ?? '') ? view as Area : 'dashboard';

export default async function Home({searchParams}: Readonly<{searchParams: Promise<Query>}>) {
  let session: Awaited<ReturnType<typeof requireSession>>|null = null;
  try { session = await requireSession(); } catch { session = null; }
  if (session === null) return <main className="fcp-login"><section><span className="fcp-eyebrow">f(AI) Control</span><h1>Вход оператора</h1><p>Авторизация выполняется через GitHub.</p><a className="fcp-primary" href="/api/auth/github/login">Войти через GitHub</a></section></main>;

  const query = await searchParams;
  const view = current(query.view);
  const database = getDatabase();
  const [projects, sources, approvals, operatorEvidence] = await Promise.all([
    listProjectTaskViews(database, session.actorId),
    listProjectSourceViews(database, session.actorId),
    listApprovalEvidenceViews(database, session.actorId),
    listProjectOperatorEvidenceViews(database, session.actorId)
  ]);
  const selected = projects.find((project) => project.slug === query.project) ?? projects[0] ?? null;
  const evidence = selected === null ? null : operatorEvidence.find((item) => item.projectId === selected.id) ?? null;
  const config = integrationConfig();
  const content = view === 'tasks'
    ? <Tasks project={selected} task={query.task} filter={query.filter} approvalControl={(taskId) => selected === null ? null : <><ApprovalControl projectId={selected.id} taskId={taskId}/><TaskApprovalEvidence projectId={selected.id} taskId={taskId} approvals={approvals}/></>}/>
    : view === 'process' ? <Process project={selected}/>
      : view === 'dashboard' ? <Dashboard projects={projects}/>
        : <PhaseB view={view} project={selected} evidence={evidence} sources={sources} approvals={approvals} actorId={session.actorId} config={config}/>;

  return <Shell view={view} projects={projects} selected={selected} operatorName={session.displayName}>{content}</Shell>;
}
