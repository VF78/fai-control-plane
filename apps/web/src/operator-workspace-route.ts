import {isOperatorProjectSlug} from './operator-data';
import type {WorkspaceRoute} from './prototype-ui';

export type WorkspaceQuery = Readonly<{
  environment?: string | string[];
  from?: string | string[];
  to?: string | string[];
  project?: string | string[];
}>;

const exact = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;

export function workspaceRoute(path: readonly string[], query: WorkspaceQuery): WorkspaceRoute | null {
  const scope = {environment: exact(query.environment), from: exact(query.from), to: exact(query.to)};
  const filter = exact(query.project);
  if (path.length === 1 && path[0] === 'dashboard') return {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope};
  if (path.length === 1 && path[0] === 'projects') return {screen: 'projects', project: null, taskId: null, runId: null, agentId: null, scope};
  if (path.length === 1 && path[0] === 'tasks' && (filter === null || filter === 'all' || isOperatorProjectSlug(filter))) return {screen: 'global_tasks', project: null, globalProject: filter ?? 'all', taskId: null, runId: null, agentId: null, scope};
  if (path.length === 1 && path[0] === 'chats' && (filter === null || filter === 'all' || isOperatorProjectSlug(filter))) return {screen: 'global_chats', project: null, globalProject: filter ?? 'all', taskId: null, runId: null, agentId: null, scope};
  if (path.length === 1 && path[0] === 'people') return {screen: 'people', project: null, taskId: null, runId: null, agentId: null, scope};
  if (path.length === 1 && path[0] === 'agents' && (filter === null || isOperatorProjectSlug(filter))) return {screen: 'agents', project: null, globalProject: filter ?? 'all', taskId: null, runId: null, agentId: null, scope};
  if (path.length === 2 && path[0] === 'agents' && exact(path[1]) !== null) return {screen: 'agent', project: null, taskId: null, runId: null, agentId: path[1]!, scope};
  const slug = path[1];
  if (path[0] !== 'projects' || slug === undefined || !isOperatorProjectSlug(slug)) return null;
  const tab = path[2];
  if (tab === 'overview' && path.length === 3) return {screen: 'overview', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'tasks' && path.length === 3) return {screen: 'tasks', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'tasks' && path.length === 4 && exact(path[3]) !== null) return {screen: 'task', project: slug, taskId: path[3]!, runId: null, agentId: null, scope};
  if (tab === 'protocol' && path.length === 3) return {screen: 'protocol', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'runs' && path.length === 3) return {screen: 'runs', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'runs' && path.length === 4 && exact(path[3]) !== null) return {screen: 'run', project: slug, taskId: null, runId: path[3]!, agentId: null, scope};
  if (tab === 'chats' && path.length === 3) return {screen: 'chats', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'access' && path.length === 3) return {screen: 'access', project: slug, taskId: null, runId: null, agentId: null, scope};
  if (tab === 'access' && path.length === 4 && exact(path[3]) !== null) return {screen: 'access', project: slug, taskId: null, runId: null, agentId: null, accessActorId: path[3]!, scope};
  return null;
}
