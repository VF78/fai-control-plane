import {
  loadAccessData, loadConversationsData, loadDeliveryLifecycleData, loadHealthData, loadPortfolioData, loadProjectData, loadRunsData,
  operatorProjectSlugs
} from './operator-data';
import type {WorkspaceRoute} from './workspace-ui';

export async function loadWorkspaceData(route: WorkspaceRoute, operatorActorId?: string) {
  const access = await loadAccessData(operatorActorId);
  const operatorProjectSlugsForSession = operatorActorId === undefined
    ? operatorProjectSlugs
    : access.state === 'ready'
      ? access.data.memberships.flatMap((membership) =>
        membership.actorId === operatorActorId && membership.active ? [membership.projectSlug] : [])
      : [];
  const requiresProject = route.project !== null && operatorProjectSlugsForSession.includes(route.project);
  const loadProjectIndex = route.screen === 'dashboard' || route.screen === 'global_tasks';
  const [portfolio, project, runs, health, projectIndex, lifecycle, conversations] = await Promise.all([
    route.screen === 'dashboard' ? Promise.resolve({state: 'unconfigured'} as const) : loadPortfolioData(),
    requiresProject ? loadProjectData(route.project!) : Promise.resolve(null),
    requiresProject ? loadRunsData(route.project!) : Promise.resolve(null),
    route.screen === 'agents' || route.screen === 'agent' ? loadHealthData(route.globalProject === undefined || route.globalProject === 'all' ? undefined : route.globalProject) : Promise.resolve(null),
    loadProjectIndex
      ? Promise.all(operatorProjectSlugsForSession.map((slug) => loadProjectData(slug))).then((loads) =>
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
