import {cookies} from 'next/headers';
import {notFound} from 'next/navigation';
import {
  isOperatorProjectSlug, loadAccessData, loadHealthData, loadPortfolioData,
  loadProjectData, loadRunsData, type OperatorProjectSlug
} from '../../../src/operator-data';
import {currentOperatorSession} from '../../../src/operator-auth-runtime';
import {OPERATOR_SESSION_COOKIE} from '../../../src/operator-auth';
import {OperatorLogin} from '../../../src/operator-ui';
import {PrototypeShell, type PrototypeRoute} from '../../../src/prototype-ui';

export const dynamic = 'force-dynamic';

const routeFrom = (path: readonly string[] | undefined, scope: PrototypeRoute['scope']): PrototypeRoute => {
  const [area = 'portfolio', tab, id, extra] = path ?? [];
  if (area === 'portfolio' && tab === undefined) return {area, tab: 'overview', scope, selected: null};
  if (area === 'delivery' && ['overview', 'protocol'].includes(tab ?? '') && id === undefined) return {area, tab: tab as PrototypeRoute['tab'], scope, selected: null};
  if (area === 'delivery' && (tab === 'tasks' || tab === 'runs') && extra === undefined) return {area, tab, scope, selected: id ?? null};
  if ((area === 'conversations' || area === 'agents-systems') && tab === undefined) return {area, tab: 'overview', scope, selected: null};
  if (area === 'people-access' && extra === undefined) return {area, tab: 'overview', scope, selected: tab ?? null};
  notFound();
};

const projectFrom = (value: string | string[] | undefined): OperatorProjectSlug | null =>
  typeof value === 'string' && isOperatorProjectSlug(value) ? value : null;
const stringFrom = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;

export default async function PrototypePage({params, searchParams}: {
  params: Promise<{path?: string[]}>;
  searchParams: Promise<{project?: string | string[]; environment?: string | string[]; from?: string | string[]; to?: string | string[]}>;
}) {
  const [routeParams, query] = await Promise.all([params, searchParams]);
  const route = routeFrom(routeParams.path, {
    project: projectFrom(query.project), environment: stringFrom(query.environment), from: stringFrom(query.from), to: stringFrom(query.to)
  });
  const cookieStore = await cookies();
  const auth = await currentOperatorSession(cookieStore.get(OPERATOR_SESSION_COOKIE)?.value);
  if (auth.enabled && auth.session === null) return <OperatorLogin />;
  const needsProject = route.area === 'delivery' || route.area === 'agents-systems';
  const [portfolio, access, projectData, runs, health] = await Promise.all([
    loadPortfolioData(),
    loadAccessData(),
    needsProject && route.scope.project !== null ? loadProjectData(route.scope.project) : Promise.resolve(null),
    route.area === 'delivery' && route.scope.project !== null ? loadRunsData(route.scope.project) : Promise.resolve(null),
    route.area === 'agents-systems' ? loadHealthData(route.scope.project ?? undefined) : Promise.resolve(null)
  ]);
  return <PrototypeShell route={route} data={{portfolio, access, project: projectData, runs, health}} />;
}
