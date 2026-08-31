import {listProjectOperatorEvidenceViews, listProjectSourceViews, listProjectTaskViews,listWorkspaceHumanActors,
  listProjectHermesRuntimeBindings, readProjectAgentProfile, readProjectAgentSubmissionView,
  readProjectHermesRuntimeSetup,
  readAgentRoutingPolicy, readProjectContextStatus, readProjectExecutionMode, readProjectMembershipRole, readProjectProcessPolicy,
  readProjectTrackerCapabilities,readProjectTrackerPreparation,readProjectWizardProgress,type ProjectOperatorEvidenceSection} from '@fai-control-plane/db';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import type {ReactNode} from 'react';
import {Dashboard, Process, Shell, Tasks} from '../src/mvp/phase-a-ui.tsx';
import {executorFact} from '../src/mvp/phase-a-view.ts';
import {TaskExecutorControl} from '../src/mvp/operator-controls.tsx';
import {PhaseB, type PhaseBView} from '../src/mvp/phase-b-ui.tsx';
import {integrationConfig} from '../src/mvp/integration-config.ts';
import {hermesExecutorCatalog} from '../src/mvp/hermes-executor-readiness.ts';
import {getDatabase, requireSession} from '../src/mvp/runtime.ts';
import {ErrorState,PageHeader} from '../src/ui/foundation.tsx';

export const dynamic = 'force-dynamic';
type Area = 'dashboard'|'tasks'|'process'|PhaseBView;
type Query = Readonly<{view?: string; project?: string; task?: string; filter?: string; setup?: string}>;
const current = (view?: string): Area => ['dashboard','tasks','process','conversations','people','systems','settings'].includes(view ?? '') ? view as Area : 'dashboard';

export default async function Home({searchParams}: Readonly<{searchParams: Promise<Query>}>) {
  let session: Awaited<ReturnType<typeof requireSession>>|null = null;
  try { session = await requireSession(); } catch { session = null; }
  if (session === null) return <main className="fcp-login"><section><span className="fcp-eyebrow">f(AI) Control</span><h1>Вход оператора</h1><p>Авторизация выполняется через GitHub.</p><a className="fcp-primary" href="/api/auth/github/login">Войти через GitHub</a></section></main>;

  const query = await searchParams;
  const view = current(query.view);
  const database = getDatabase();
  let projects: Awaited<ReturnType<typeof listProjectTaskViews>>;
  try { projects = await listProjectTaskViews(database, session.actorId); }
  catch { return <Shell view={view} projects={[]} operatorName={session.displayName}><PageHeader title={view==='dashboard'?'Обзор':view==='tasks'?'Задачи':view==='process'?'Процесс':view==='settings'?'Проекты':'Рабочее пространство'}/><ErrorState detail="Данные пока не подтверждены. Сохранённые настройки не изменены; обновите страницу и повторите." action={<a className="fcp-secondary" href={`/?view=${view}`}>Повторить</a>}/></Shell>; }
  const invalidProject = view === 'tasks' && query.project !== undefined && !projects.some((project) => project.slug === query.project);
  const selected = view === 'tasks'
    ? invalidProject ? null : projects.find((project) => project.slug === query.project) ?? projects[0] ?? null
    : null;
  let content: ReactNode;
  if (view === 'dashboard') {
    content = <Dashboard projects={projects}/>;
  } else if (view === 'tasks') {
    const [trackerCapabilities, run, role] = selected === null ? [null, null, null] as const : await Promise.all([
      readProjectTrackerCapabilities(database, session.actorId, selected.id),
      query.task === undefined ? Promise.resolve(null)
        : readProjectAgentSubmissionView(database, session.actorId, selected.id, query.task),
      readProjectMembershipRole(database, session.actorId, selected.id)
    ]);
    content = <Tasks projects={projects} project={selected} task={query.task} filter={query.filter}
      hermesOwnerOptionId={trackerCapabilities?.agentOwnerOptionId}
      invalidProject={invalidProject} canManage={role==='project_owner'||role==='operator'}
      executorControl={(task) => selected === null ? null : <TaskExecutorControl
        key={`${run?.deliveryReference ?? task.itemId}:${run?.status ?? 'none'}`}
        projectId={selected.id}
        currentExecutor={executorFact(task, trackerCapabilities?.agentOwnerOptionId)}
        confirmedRun={run}
        task={{itemId: task.itemId, status: task.statusOptionName, blocked: task.blocked}}/>}/>;
  } else if (view === 'process') {
    const executorCatalog = hermesExecutorCatalog();
    const processProjects = await Promise.all(projects.map(async (project) => {
      const [role, processPolicy, executionMode, agentRouting, context] = await Promise.all([
        readProjectMembershipRole(database, session.actorId, project.id),
        readProjectProcessPolicy(database, session.actorId, project.id),
        readProjectExecutionMode(database, session.actorId, project.id),
        readAgentRoutingPolicy(database, session.actorId, project.id),
        readProjectContextStatus(database, session.actorId, project.id)
      ]);
      return {project, processPolicy, executionMode, context,
        routing:{policy:agentRouting?.policy??defaultAgentRoutingPolicy,executorCatalog},
        canManageRouting:role==='project_owner',canManageContext:role==='project_owner'||role==='operator'};
    }));
    content = <Process projects={processProjects}/>;
  } else {
    const needsEvidence = view === 'conversations' || view === 'people' || view === 'settings';
    const evidenceSections = new Set<ProjectOperatorEvidenceSection>(view === 'conversations'
      ? ['people'] : view === 'people' || view === 'settings' ? ['people'] : []);
    const [operatorEvidence, sources, runtimes, workspacePeople] = await Promise.all([
      needsEvidence ? listProjectOperatorEvidenceViews(database, session.actorId, evidenceSections) : Promise.resolve([]),
      view === 'settings' ? listProjectSourceViews(database, session.actorId) : Promise.resolve([]),
      listProjectHermesRuntimeBindings(database, session.workspaceId),
      view === 'people' || view === 'settings' ? listWorkspaceHumanActors(database,session.workspaceId) : Promise.resolve([])
    ]);
    const runtimeByProject = new Map(runtimes.map((runtime) => [runtime.projectId, runtime]));
    const projectDetails = await Promise.all(projects.map(async (project) => {
      const [agentProfile,runtimeSetup,trackerCapabilities,trackerPreparation,wizardProgress]=view==='settings'||view==='systems'?await Promise.all([
        readProjectAgentProfile(database,session.actorId,project.id),
        readProjectHermesRuntimeSetup(database,session.actorId,project.id),
        view==='settings'?readProjectTrackerCapabilities(database,session.actorId,project.id):Promise.resolve(null),
        view==='settings'?readProjectTrackerPreparation(database,session.actorId,project.id):Promise.resolve(null),
        view==='settings'?readProjectWizardProgress(database,session.actorId,project.id):Promise.resolve(null)
      ]):[null,null,null,null,null];
      return {project,agentProfile,runtimeSetup,trackerCapabilities,trackerPreparation,wizardProgress,
        config: integrationConfig(process.env, runtimeByProject.get(project.id) ?? null)};
    }));
    const phaseBProjects = projectDetails.map((item) => ({...item, sources,
      evidence: operatorEvidence.find((evidence) => evidence.projectId === item.project.id) ?? null}));
    content = <PhaseB view={view} projects={phaseBProjects} actorId={session.actorId} setup={query.setup}
      workspacePeople={workspacePeople}/>;
  }

  return <Shell view={view} projects={projects} operatorName={session.displayName}>{content}</Shell>;
}
