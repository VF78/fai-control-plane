import {listApprovalEvidenceViews, listProjectOperatorEvidenceViews, listProjectSourceViews, listProjectTaskViews, projectAgentDeliveryConfigured, readHermesRoutingPolicy} from '@fai-control-plane/db';
import {defaultHermesRoutingPolicy} from '@fai-control-plane/domain';
import {Dashboard, Process, Shell, Tasks} from '../src/mvp/phase-a-ui.tsx';
import {executorFact} from '../src/mvp/phase-a-view.ts';
import {ApprovalControl, TaskExecutorControl} from '../src/mvp/operator-controls.tsx';
import {PhaseB, TaskApprovalEvidence, type PhaseBView} from '../src/mvp/phase-b-ui.tsx';
import {hermesExecutorCatalog} from '../src/mvp/hermes-executor-readiness.ts';
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
  const agentDeliveryConfigured = selected === null ? false
    : await projectAgentDeliveryConfigured(database, session.actorId, selected.id);
  const hermesRouting = selected === null ? null
    : await readHermesRoutingPolicy(database, session.actorId, selected.id);
  const canManageRouting = evidence?.people.some((person) => person.actorId === session.actorId && person.active && person.role === 'project_owner') ?? false;
  const executorCatalog = hermesExecutorCatalog();
  const routing = {policy: hermesRouting?.policy ?? defaultHermesRoutingPolicy, version: hermesRouting?.version ?? null,
    provenance: hermesRouting?.provenance ?? null, createdAt: hermesRouting?.createdAt ?? null, executorCatalog};
  const config = integrationConfig(process.env, agentDeliveryConfigured);
  const content = view === 'tasks'
    ? <Tasks project={selected} task={query.task} filter={query.filter} hermesOwnerOptionId={process.env.HERMES_TRACKER_OWNER_OPTION_ID} executorControl={(task) => selected === null ? null : <TaskExecutorControl projectId={selected.id} currentExecutor={executorFact(task, process.env.HERMES_TRACKER_OWNER_OPTION_ID)} confirmedRun={evidence?.agentSubmissions.recent.find((run) => run.targetReference === task.itemId) ?? null} task={{itemId: task.itemId, status: task.statusOptionName, blocked: task.blocked}}/>} approvalControl={(taskId) => selected === null ? null : <><ApprovalControl projectId={selected.id} taskId={taskId}/><TaskApprovalEvidence projectId={selected.id} taskId={taskId} approvals={approvals}/></>}/>
    : view === 'process' ? <Process project={selected} filter={query.filter} routing={routing} canManageRouting={canManageRouting}/>
      : view === 'dashboard' ? <Dashboard projects={projects}/>
        : <PhaseB view={view} project={selected} evidence={evidence} sources={sources} approvals={approvals} actorId={session.actorId} config={config}/>;

  return <Shell view={view} projects={projects} selected={selected} operatorName={session.displayName}>{content}</Shell>;
}
