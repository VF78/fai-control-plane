import {
  loadAccessData, loadConversationsData, loadDeliveryLifecycleData, loadHealthData, loadPortfolioData, loadProjectData, loadRunsData,
  operatorProjectSlugs
} from './operator-data';
import type {WorkspaceRoute} from './workspace-ui';

export async function loadWorkspaceData(route: WorkspaceRoute, operatorActorId?: string) {
  const requiresProject = route.project !== null;
  const [portfolio, access, project, runs, health, projectIndex, lifecycle, conversations] = await Promise.all([
    loadPortfolioData(),
    loadAccessData(operatorActorId),
    requiresProject ? loadProjectData(route.project) : Promise.resolve(null),
    route.screen === 'dashboard' || requiresProject ? loadRunsData(route.project ?? undefined) : Promise.resolve(null),
    route.screen === 'agents' || route.screen === 'agent' ? loadHealthData(route.globalProject === undefined || route.globalProject === 'all' ? undefined : route.globalProject) : Promise.resolve(null),
    route.screen === 'global_tasks'
      ? Promise.all(operatorProjectSlugs.map((slug) => loadProjectData(slug))).then((loads) =>
        loads.flatMap((load) => load.state === 'ready' && load.data !== null ? [load.data] : []))
      : Promise.resolve([]),
    route.screen === 'task' && route.project !== null && route.taskId !== null
      ? loadDeliveryLifecycleData(route.project, route.taskId)
      : Promise.resolve(null),
    route.screen === 'global_chats' || route.screen === 'chats'
      ? loadConversationsData(
        route.screen === 'chats'
          ? route.project ?? undefined
          : route.globalProject === undefined || route.globalProject === 'all'
            ? undefined
            : route.globalProject
      )
      : Promise.resolve(null)
  ]);
  return {portfolio, access, project, runs, health, projectIndex, lifecycle, conversations};
}
