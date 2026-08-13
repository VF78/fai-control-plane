import {
  loadAccessData, loadHealthData, loadPortfolioData, loadProjectData, loadRunsData,
  type AuthorizedProjectScope
} from './operator-data';
import type {WorkspaceRoute} from './workspace-ui';

export async function loadWorkspaceData(route: WorkspaceRoute, operatorActorId?: string) {
  const access = await loadAccessData(operatorActorId);
  const authorizedProjects: readonly AuthorizedProjectScope[] = access.state !== 'ready' ? [] : access.data.memberships
    .filter((membership) => membership.active &&
      (operatorActorId === undefined || membership.actorId === operatorActorId))
    .map(({projectId, projectSlug: slug}) => ({projectId, slug}))
    .filter((scope, index, scopes) => scopes.findIndex(({projectId}) => projectId === scope.projectId) === index);
  const selectedProject = route.project === null ? undefined : authorizedProjects.find(({slug}) => slug === route.project);
  const selectedGlobal = route.globalProject === undefined || route.globalProject === 'all'
    ? undefined : authorizedProjects.find(({slug}) => slug === route.globalProject);
  const requiresProject = selectedProject !== undefined;
  const requiresRuns = requiresProject && (route.screen === 'runs' || route.screen === 'run');
  const loadProjectIndex = route.screen === 'dashboard' || route.screen === 'projects' || route.screen === 'global_tasks';
  const [portfolio, project, runs, health, projectIndex] = await Promise.all([
    loadPortfolioData(authorizedProjects),
    requiresProject ? loadProjectData(selectedProject) : Promise.resolve(null),
    requiresRuns ? loadRunsData([selectedProject]) : Promise.resolve(null),
    route.screen === 'agents' || route.screen === 'agent' ? loadHealthData(selectedGlobal === undefined ? authorizedProjects : [selectedGlobal]) : Promise.resolve(null),
    loadProjectIndex
      ? Promise.all(authorizedProjects.map((scope) => loadProjectData(scope))).then((loads) =>
        loads.flatMap((load) => load.state === 'ready' && load.data !== null ? [load.data] : []))
      : Promise.resolve([])
  ]);
  return {portfolio, access, project, runs, health, projectIndex};
}
