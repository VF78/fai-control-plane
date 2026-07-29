import {cookies} from 'next/headers';
import {notFound, redirect} from 'next/navigation';
import {
  isOperatorProjectSlug, loadAccessData, loadHealthData, loadPortfolioData, operatorProjectSlugs,
  loadProjectData, loadRunsData, type OperatorProjectSlug
} from '../../../src/operator-data';
import {currentOperatorSession} from '../../../src/operator-auth-runtime';
import {OPERATOR_SESSION_COOKIE} from '../../../src/operator-auth';
import {OperatorLogin} from '../../../src/operator-ui';
import {PrototypeShell, type PrototypeRoute} from '../../../src/prototype-ui';

export const dynamic = 'force-dynamic';

const exact = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
const project = (value: string | undefined): OperatorProjectSlug | null =>
  value !== undefined && isOperatorProjectSlug(value) ? value : null;

const routeFrom = (path: readonly string[] | undefined, scope: PrototypeRoute['scope'], filter: string | null): PrototypeRoute => {
  const parts = path ?? [];
  if (parts.length === 0) redirect('/prototype/dashboard');
  if (parts.length === 1 && parts[0] === 'dashboard') return {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope};
  if (parts.length === 1 && parts[0] === 'projects') return {screen: 'projects', project: null, taskId: null, runId: null, agentId: null, scope};
  if (parts.length === 1 && parts[0] === 'tasks' && (filter === null || filter === 'all' || (filter !== null && isOperatorProjectSlug(filter)))) return {screen: 'global_tasks', project: null, globalProject: filter ?? 'all', taskId: null, runId: null, agentId: null, scope};
  if (parts.length === 1 && parts[0] === 'chats' && (filter === null || filter === 'all' || (filter !== null && isOperatorProjectSlug(filter)))) return {screen: 'global_chats', project: null, globalProject: filter ?? 'all', taskId: null, runId: null, agentId: null, scope};
  if (parts.length === 1 && parts[0] === 'agents') return {screen: 'agents', project: null, taskId: null, runId: null, agentId: null, scope};
  if (parts.length === 2 && parts[0] === 'agents') return {screen: 'agent', project: null, taskId: null, runId: null, agentId: parts[1]!, scope};
  const slug = project(parts[1]);
  if (parts[0] !== 'projects' || slug === null) notFound();
  const tab = parts[2];
  if (tab === 'overview' && parts.length === 3) return {screen: 'overview', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'tasks' && parts.length === 3) return {screen: 'tasks', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'tasks' && parts.length === 4) return {screen: 'task', project: slug, taskId: parts[3]!, runId: null, agentId: null, scope};
  if (tab === 'protocol' && parts.length === 3) return {screen: 'protocol', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'runs' && parts.length === 3) return {screen: 'runs', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'runs' && parts.length === 4) return {screen: 'run', project: slug, taskId: null, runId: parts[3]!, agentId: null, scope};
  if (tab === 'chats' && parts.length === 3) return {screen: 'chats', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'access' && parts.length === 3) return {screen: 'access', project: slug, taskId: null, runId: null, agentId: null, scope};
  return notFound();
};

export default async function PrototypePage({params, searchParams}: {
  params: Promise<{path?: string[]}>;
  searchParams: Promise<{environment?: string | string[]; from?: string | string[]; to?: string | string[]; project?: string | string[]}>;
}) {
  const [resolvedParams, query] = await Promise.all([params, searchParams]);
  const route = routeFrom(resolvedParams.path, {environment: exact(query.environment), from: exact(query.from), to: exact(query.to)}, exact(query.project));
  const cookieStore = await cookies();
  const auth = await currentOperatorSession(cookieStore.get(OPERATOR_SESSION_COOKIE)?.value);
  if (auth.enabled && auth.session === null) return <OperatorLogin />;
  const requiresProject = route.project !== null;
  const [portfolio, access, projectData, runs, health, projectIndex] = await Promise.all([
    loadPortfolioData(), loadAccessData(),
    requiresProject ? loadProjectData(route.project!) : Promise.resolve(null),
    route.screen === 'dashboard' || requiresProject ? loadRunsData(route.project ?? undefined) : Promise.resolve(null),
    route.screen === 'agents' || route.screen === 'agent' ? loadHealthData() : Promise.resolve(null),
    route.screen === 'global_tasks' ? Promise.all(operatorProjectSlugs.map((slug) => loadProjectData(slug))).then((loads) => loads.flatMap((load) => load.state === 'ready' && load.data !== null ? [load.data] : [])) : Promise.resolve([])
  ]);
  return <PrototypeShell route={route} data={{portfolio, access, project: projectData, runs, health, projectIndex, csrfToken: auth.session?.csrfToken ?? null}} />;
}
