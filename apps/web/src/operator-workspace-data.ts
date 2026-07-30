import {
  loadAccessData, loadHealthData, loadPortfolioData, loadProjectData, loadRunsData,
  operatorProjectSlugs
} from './operator-data';
import type {WorkspaceRoute} from './prototype-ui';

export async function loadWorkspaceData(route: WorkspaceRoute) {
  const requiresProject = route.project !== null;
  const [portfolio, access, project, runs, health, projectIndex] = await Promise.all([
    loadPortfolioData(),
    loadAccessData(),
    requiresProject ? loadProjectData(route.project) : Promise.resolve(null),
    route.screen === 'dashboard' || requiresProject ? loadRunsData(route.project ?? undefined) : Promise.resolve(null),
    route.screen === 'agents' || route.screen === 'agent' ? loadHealthData(route.globalProject === undefined || route.globalProject === 'all' ? undefined : route.globalProject) : Promise.resolve(null),
    route.screen === 'global_tasks'
      ? Promise.all(operatorProjectSlugs.map((slug) => loadProjectData(slug))).then((loads) =>
        loads.flatMap((load) => load.state === 'ready' && load.data !== null ? [load.data] : []))
      : Promise.resolve([])
  ]);
  return {portfolio, access, project, runs, health, projectIndex};
}
