import {listProjectOperatorEvidenceViews, listProjectSourceViews, listProjectTaskViews,
  projectAgentDeliveryConfigured, readProjectAgentProfile, readProjectAgentSubmissionView,
  readAgentRoutingPolicy, readProjectContextStatus, readProjectExecutionMode, readProjectMembershipRole, readProjectProcessPolicy,
  readProjectTrackerCapabilities, type ProjectOperatorEvidenceSection} from '@fai-control-plane/db';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import type {ReactNode} from 'react';
import {Dashboard, Process, Shell, Tasks} from '../src/mvp/phase-a-ui.tsx';
import {executorFact} from '../src/mvp/phase-a-view.ts';
import {TaskExecutorControl} from '../src/mvp/operator-controls.tsx';
import {PhaseB, type PhaseBView} from '../src/mvp/phase-b-ui.tsx';
import {integrationConfig} from '../src/mvp/integration-config.ts';
import {hermesExecutorCatalog} from '../src/mvp/hermes-executor-readiness.ts';
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
  const projects = await listProjectTaskViews(database, session.actorId);
  const selected = view === 'tasks'
    ? projects.find((project) => project.slug === query.project) ?? projects[0] ?? null
    : null;
  let content: ReactNode;
  if (view === 'dashboard') {
    content = <Dashboard projects={projects}/>;
  } else if (view === 'tasks') {
    const [trackerCapabilities, run] = selected === null ? [null, null] as const : await Promise.all([
      readProjectTrackerCapabilities(database, session.actorId, selected.id),
      query.task === undefined ? Promise.resolve(null)
        : readProjectAgentSubmissionView(database, session.actorId, selected.id, query.task)
    ]);
    content = <Tasks projects={projects} project={selected} task={query.task} filter={query.filter}
      hermesOwnerOptionId={trackerCapabilities?.agentOwnerOptionId}
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
    const needsEvidence = view === 'conversations' || view === 'people';
    const evidenceSections = new Set<ProjectOperatorEvidenceSection>(view === 'conversations'
      ? ['people'] : view === 'people' ? ['people'] : []);
    const [operatorEvidence, sources, projectDetails] = await Promise.all([
      needsEvidence ? listProjectOperatorEvidenceViews(database, session.actorId, evidenceSections) : Promise.resolve([]),
      view === 'settings' ? listProjectSourceViews(database, session.actorId) : Promise.resolve([]),
      Promise.all(projects.map(async (project) => {
        const [agentProfile, agentDeliveryConfigured] = await Promise.all([
          view === 'settings' ? readProjectAgentProfile(database, session.actorId, project.id) : Promise.resolve(null),
          view === 'systems' ? projectAgentDeliveryConfigured(database, session.actorId, project.id) : Promise.resolve(false)
        ]);
        return {project, agentProfile, config: integrationConfig(process.env, agentDeliveryConfigured)};
      }))
    ]);
    const phaseBProjects = projectDetails.map((item) => ({...item, sources,
      evidence: operatorEvidence.find((evidence) => evidence.projectId === item.project.id) ?? null}));
    content = <PhaseB view={view} projects={phaseBProjects} actorId={session.actorId}/>;
  }

  return <Shell view={view} projects={projects} operatorName={session.displayName}>{content}</Shell>;
}
