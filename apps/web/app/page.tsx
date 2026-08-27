import {listProjectOperatorEvidenceViews, listProjectSourceViews, listProjectTaskViews,
  projectAgentDeliveryConfigured, readAgentRoutingPolicy, readProjectAgentProfile, readProjectAgentSubmissionView,
  readProjectContextStatus, readProjectExecutionMode, readProjectMembershipRole, readProjectProcessPolicy,
  readProjectTrackerCapabilities, type ProjectOperatorEvidenceSection} from '@fai-control-plane/db';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import type {ReactNode} from 'react';
import {Dashboard, Process, Shell, Tasks} from '../src/mvp/phase-a-ui.tsx';
import {executorFact} from '../src/mvp/phase-a-view.ts';
import {TaskExecutorControl} from '../src/mvp/operator-controls.tsx';
import {PhaseB, type PhaseBView} from '../src/mvp/phase-b-ui.tsx';
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
  const projects = await listProjectTaskViews(database, session.actorId);
  const selected = query.project === undefined ? null : projects.find((project) => project.slug === query.project) ?? null;
  let content: ReactNode;
  if (view === 'dashboard') {
    content = <Dashboard projects={selected === null ? projects : [selected]} selected={selected !== null}/>;
  } else if (view === 'tasks') {
    const [trackerCapabilities, run] = selected === null ? [null, null] as const : await Promise.all([
      readProjectTrackerCapabilities(database, session.actorId, selected.id),
      query.task === undefined ? Promise.resolve(null)
        : readProjectAgentSubmissionView(database, session.actorId, selected.id, query.task)
    ]);
    content = <Tasks project={selected} task={query.task} filter={query.filter}
      hermesOwnerOptionId={trackerCapabilities?.agentOwnerOptionId}
      executorControl={(task) => selected === null ? null : <TaskExecutorControl
        key={`${run?.deliveryReference ?? task.itemId}:${run?.status ?? 'none'}`}
        projectId={selected.id}
        currentExecutor={executorFact(task, trackerCapabilities?.agentOwnerOptionId)}
        confirmedRun={run}
        task={{itemId: task.itemId, status: task.statusOptionName, blocked: task.blocked}}/>}/>;
  } else if (view === 'process') {
    const tab = query.filter === 'hermes' ? 'hermes' : query.filter === 'context' ? 'context' : 'stages';
    const [role, processPolicy, agentRouting, activeContext, executionMode] = selected === null
      ? [null, null, null, null, {mode:'manual' as const, actorId:null, changedAt:null}] as const
      : await Promise.all([
        readProjectMembershipRole(database, session.actorId, selected.id),
        readProjectProcessPolicy(database, session.actorId, selected.id),
        tab === 'hermes' ? readAgentRoutingPolicy(database, session.actorId, selected.id) : Promise.resolve(null),
        tab === 'context' ? readProjectContextStatus(database, session.actorId, selected.id) : Promise.resolve(null),
        tab === 'stages' ? readProjectExecutionMode(database, session.actorId, selected.id)
          : Promise.resolve({mode:'manual' as const, actorId:null, changedAt:null})
      ]);
    const routing = {policy: agentRouting?.policy ?? defaultAgentRoutingPolicy, version: agentRouting?.version ?? null,
      provenance: agentRouting?.provenance ?? null, createdAt: agentRouting?.createdAt ?? null,
      executorCatalog: hermesExecutorCatalog()};
    content = <Process project={selected} filter={query.filter} routing={routing} processPolicy={processPolicy}
      executionMode={executionMode} activeContext={activeContext} canManageRouting={role === 'project_owner'}
      canManageContext={role === 'project_owner' || role === 'operator'}/>;
  } else {
    const needsEvidence = view !== 'settings';
    const evidenceSections = new Set<ProjectOperatorEvidenceSection>(view === 'conversations'
      ? ['people','messenger','conversations'] : view === 'people' ? ['people']
        : view === 'systems' ? ['receipts','audit','agentSubmissions'] : []);
    const [operatorEvidence, sources, agentProfile, agentDeliveryConfigured] = selected === null
      ? [[], [], null, false] as const : await Promise.all([
        needsEvidence ? listProjectOperatorEvidenceViews(database, session.actorId, evidenceSections) : Promise.resolve([]),
        view === 'settings' ? listProjectSourceViews(database, session.actorId) : Promise.resolve([]),
        view === 'settings' ? readProjectAgentProfile(database, session.actorId, selected.id) : Promise.resolve(null),
        view === 'systems' ? projectAgentDeliveryConfigured(database, session.actorId, selected.id) : Promise.resolve(false)
      ]);
    const evidence = selected === null ? null
      : operatorEvidence.find((item) => item.projectId === selected.id) ?? null;
    content = <PhaseB view={view} project={selected} evidence={evidence} sources={sources}
      actorId={session.actorId} config={integrationConfig(process.env, agentDeliveryConfigured)} agentProfile={agentProfile}/>;
  }

  return <Shell view={view} projects={projects} selected={selected} operatorName={session.displayName}>{content}</Shell>;
}
