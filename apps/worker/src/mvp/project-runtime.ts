import {listProjectHermesRuntimeBindings, type Database, type ProjectHermesRuntimeBinding} from '@fai-control-plane/db';
import type {OpaqueSecretRef} from '@fai-control-plane/domain';

export type WorkerProjectBinding = Readonly<{
  workspaceId: string;
  projectId: string;
  slug: string;
  bindingId: string;
  provider: string;
  externalProjectId: string;
  projectUrl: string;
  repositoryId: string;
  repositoryUrl: string;
  cursor: string | null;
  trackerCredentialRef: OpaqueSecretRef;
  runtime: ProjectHermesRuntimeBinding;
  agentOwnerOptionId: string;
  doneStatusOptionId: string;
  defaultBranch: string;
}>;

type BindingRow = Omit<WorkerProjectBinding,
  'trackerCredentialRef' | 'runtime' |
  'agentOwnerOptionId' | 'doneStatusOptionId' | 'defaultBranch'> & Readonly<{
  trackerSecretId: string;
  trackerSecretPurpose: string;
  trackerSecretLocator: string;
  trackerCapabilitiesArtifact: string;
}>;

const trackerCapabilities = (content: string): Readonly<{
  agentOwnerOptionId: string;
  doneStatusOptionId: string;
  defaultBranch: string;
}> | null => {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const bounded = (candidate: unknown): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 512 &&
      !candidate.includes('\0');
    if (value.contract !== 'fai.project-tracker-capabilities.v1' || value.provider !== 'github' ||
      !bounded(value.agentOwnerOptionId) || !bounded(value.doneStatusOptionId) ||
      typeof value.defaultBranch !== 'string' || !/^[^\0\r\n]{1,256}$/.test(value.defaultBranch)) return null;
    return {agentOwnerOptionId: value.agentOwnerOptionId, doneStatusOptionId: value.doneStatusOptionId,
      defaultBranch: value.defaultBranch};
  } catch {
    return null;
  }
};

export const listWorkerProjectBindings = async (
  database: Database,
  workspaceId: string
): Promise<readonly WorkerProjectBinding[]> => {
  const runtimes = new Map((await listProjectHermesRuntimeBindings(database, workspaceId)).map((runtime) =>
    [runtime.projectId, runtime]));
  const result = await database.query<BindingRow>(
    `select p.workspace_id as "workspaceId",p.id as "projectId",p.slug,
       b.id as "bindingId",b.provider,b.external_project_id as "externalProjectId",b.project_url as "projectUrl",
       b.repository_id as "repositoryId",b.repository_url as "repositoryUrl",b.cursor,
       tracker_secret.id as "trackerSecretId",tracker_secret.purpose as "trackerSecretPurpose",
       tracker_secret.locator as "trackerSecretLocator",capabilities.content_text as "trackerCapabilitiesArtifact"
     from projects p
     join tracker_bindings b on b.project_id=p.id and b.enabled=true
     join secret_refs tracker_secret on tracker_secret.id=b.secret_ref_id and tracker_secret.workspace_id=p.workspace_id
     join lateral (select content_text from project_source_artifacts
       where project_id=p.id and kind='project_tracker_capabilities_v1'
       order by created_at desc,id desc limit 1) capabilities on true
     where p.workspace_id=$1 order by p.id`,
    [workspaceId]
  );
  return result.rows.flatMap((row) => {
    const runtime = runtimes.get(row.projectId);
    const capabilities = trackerCapabilities(row.trackerCapabilitiesArtifact);
    if (row.trackerSecretPurpose !== 'tracker_read' || !row.trackerSecretLocator.startsWith('/') ||
      runtime === undefined || capabilities === null) return [];
    return [{workspaceId: row.workspaceId, projectId: row.projectId, slug: row.slug,
      bindingId: row.bindingId, provider: row.provider, externalProjectId: row.externalProjectId,
      projectUrl: row.projectUrl, repositoryId: row.repositoryId, repositoryUrl: row.repositoryUrl,
      cursor: row.cursor, runtime, ...capabilities,
      trackerCredentialRef: {id: row.trackerSecretId, purpose: 'tracker_read', locator: row.trackerSecretLocator}}];
  });
};

export const githubBindingCoordinates = (binding: WorkerProjectBinding): Readonly<{
  owner: string; repository: string; projectNumber: number;
}> | null => {
  if (binding.provider !== 'github') return null;
  let projectUrl: URL;
  let repositoryUrl: URL;
  try {
    projectUrl = new URL(binding.projectUrl);
    repositoryUrl = new URL(binding.repositoryUrl);
  } catch {
    return null;
  }
  const project = /^\/users\/([^/]+)\/projects\/(\d+)\/?$/.exec(projectUrl.pathname);
  const repository = /^\/([^/]+)\/([^/]+)\/?$/.exec(repositoryUrl.pathname);
  if (projectUrl.origin !== 'https://github.com' || repositoryUrl.origin !== 'https://github.com' ||
    project === null || repository === null || project[1]!.toLowerCase() !== repository[1]!.toLowerCase()) return null;
  const projectNumber = Number(project[2]);
  if (!Number.isSafeInteger(projectNumber) || projectNumber < 1) return null;
  return {owner: project[1]!, repository: repository[2]!, projectNumber};
};

export const runProjectBindingsIsolated = async <T,B extends Readonly<{projectId:string}>>(
  bindings: readonly B[],
  operation: (binding: B) => Promise<T>
): Promise<readonly Readonly<{projectId: string; status: 'completed' | 'failed'; value?: T}>[]> => {
  const results = [];
  for (const binding of bindings) {
    try {
      results.push({projectId: binding.projectId, status: 'completed' as const, value: await operation(binding)});
    } catch {
      results.push({projectId: binding.projectId, status: 'failed' as const});
    }
  }
  return results;
};

export const enqueueProjectFailureBlockers = async (
  operation: 'observe' | 'reconcile',
  results: readonly Readonly<{projectId: string; status: 'completed' | 'failed'}>[],
  enqueue: (input: Readonly<{projectId: string; idempotencyKey: string; text: string}>) => Promise<unknown>
): Promise<void> => {
  for (const result of results) {
    if (result.status !== 'failed') continue;
    const idempotencyKey = `worker:${result.projectId}:${operation}:blocker`;
    try {
      await enqueue({projectId: result.projectId, idempotencyKey,
        text: `Автоматическая обработка проекта остановлена на этапе ${operation}. Требуется проверка интеграции.`});
    } catch {
      // Notification persistence must never block another project's runtime.
    }
  }
};
