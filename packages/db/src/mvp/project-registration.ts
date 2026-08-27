import {createHash, randomUUID} from 'node:crypto';
import {defaultAgentRoutingPolicy, defaultProjectProcessPolicy, projectContextSnapshotVersion,
  projectContextSourceKind, serializeProjectContextSource, type ProjectContextSource} from '@fai-control-plane/domain';
import type {OpaqueSecretRef} from '@fai-control-plane/domain';
import type {Database} from './runtime.ts';

export const projectAgentProfileTemplateVersion = 'v2026.8.27-fai-project-v2';

export type RegisterProjectInput = Readonly<{
  workspaceId: string; actorId: string; name: string; slug: string; repositoryUrl: string; repositoryId: string;
  projectUrl: string; externalProjectId: string; contextSources: readonly ProjectContextSource[];
  trackerCapabilities: ProjectTrackerCapabilities;
  idempotencyKey: string;
}>;

export type ProjectTrackerCapabilities = Readonly<{
  provider: 'github';
  agentOwnerOptionId: string;
  doneStatusOptionId: string;
  defaultBranch: string;
}>;

const trackerCapabilitiesValue = (capabilities: ProjectTrackerCapabilities) => ({
  contract: 'fai.project-tracker-capabilities.v1',
  ...capabilities
});

const validProviderId = (value: string): boolean =>
  value.length > 0 && value.length <= 512 && !value.includes('\0');

const parseTrackerCapabilities = (content: string): ProjectTrackerCapabilities | null => {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (value.contract !== 'fai.project-tracker-capabilities.v1' || value.provider !== 'github' ||
      typeof value.agentOwnerOptionId !== 'string' || typeof value.doneStatusOptionId !== 'string' ||
      typeof value.defaultBranch !== 'string' || !validProviderId(value.agentOwnerOptionId) ||
      !validProviderId(value.doneStatusOptionId) || !/^[^\0\r\n]{1,256}$/.test(value.defaultBranch)) return null;
    return {provider: 'github', agentOwnerOptionId: value.agentOwnerOptionId,
      doneStatusOptionId: value.doneStatusOptionId, defaultBranch: value.defaultBranch};
  } catch {
    return null;
  }
};

const jsonVersion = (value: unknown): Readonly<{content: string; version: string}> => {
  const content = JSON.stringify(value);
  return {content, version: createHash('sha256').update(content).digest('hex')};
};

export const registerProject = async (database: Database, input: RegisterProjectInput): Promise<Readonly<{
  projectId: string; slug: string; created: boolean;
}>> => {
  if (!validProviderId(input.trackerCapabilities.agentOwnerOptionId) ||
    !validProviderId(input.trackerCapabilities.doneStatusOptionId) ||
    !/^[^\0\r\n]{1,256}$/.test(input.trackerCapabilities.defaultBranch)) {
    throw new Error('project_tracker_capabilities_invalid');
  }
  const client = await database.connect();
  try {
    await client.query('begin');
    const authority = await client.query(`select 1 from project_memberships m join projects p on p.id=m.project_id
      where m.actor_id=$1 and p.workspace_id=$2 and m.role='project_owner' and m.active=true limit 1 for update`,
    [input.actorId, input.workspaceId]);
    if (authority.rowCount !== 1) throw new Error('project_registration_denied');
    const prior = await client.query<{
      id: string; name: string; repositoryUrl: string; projectUrl: string;
      repositoryId: string; externalProjectId: string;
    }>(
      `select p.id,p.name,p.repository_url as "repositoryUrl",b.project_url as "projectUrl",
       b.repository_id as "repositoryId",b.external_project_id as "externalProjectId"
       from projects p join tracker_bindings b on b.project_id=p.id where p.workspace_id=$1 and p.slug=$2`,
    [input.workspaceId, input.slug]);
    const existing = prior.rows[0];
    if (existing !== undefined) {
      if (existing.name !== input.name || existing.repositoryUrl !== input.repositoryUrl ||
        existing.projectUrl !== input.projectUrl || existing.repositoryId !== input.repositoryId ||
        existing.externalProjectId !== input.externalProjectId) throw new Error('project_registration_conflict');
      await client.query('commit');
      return {projectId: existing.id, slug: input.slug, created: false};
    }
    const secret = await client.query<{id: string}>(`select id from secret_refs
      where workspace_id=$1 and purpose='tracker_read' and locator like '/%'`, [input.workspaceId]);
    if (secret.rowCount !== 1) throw new Error('project_registration_unavailable');
    const projectId = randomUUID();
    const bindingId = randomUUID();
    await client.query(`insert into projects(id,workspace_id,slug,name,repository_url) values($1,$2,$3,$4,$5)`,
      [projectId, input.workspaceId, input.slug, input.name, input.repositoryUrl]);
    await client.query(`insert into project_memberships(project_id,actor_id,role,active)
      values($1,$2,'project_owner',true)`, [projectId, input.actorId]);
    await client.query(`insert into tracker_bindings(id,project_id,secret_ref_id,provider,external_project_id,project_url,
      repository_id,repository_url) values($1,$2,$3,'github',$4,$5,$6,$7)`,
    [bindingId, projectId, secret.rows[0]!.id, input.externalProjectId, input.projectUrl,
      input.repositoryId, input.repositoryUrl]);
    const policies = [
      {kind: 'project_process_policy_v1', name: 'Project process policy', ...jsonVersion(defaultProjectProcessPolicy)},
      {kind: 'agent_routing_policy_v1', name: 'Agent routing policy', ...jsonVersion(defaultAgentRoutingPolicy)},
      {kind: 'project_tracker_capabilities_v1', name: 'Project tracker capabilities',
        ...jsonVersion(trackerCapabilitiesValue(input.trackerCapabilities))}
    ];
    for (const policy of policies) await client.query(`insert into project_source_artifacts
      (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
      values($1,$2,$3,$4,$5,'application/json',$6,$7,null,'control-plane:project-registration')`,
    [randomUUID(), projectId, input.actorId, policy.kind, policy.name, policy.version, policy.content]);
    for (const source of input.contextSources) {
      const content = serializeProjectContextSource(source);
      const version = projectContextSnapshotVersion(content);
      await client.query(`insert into project_source_artifacts
        (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
        values($1,$2,$3,$4,$5,'application/json',$6,$7,$8,$9)`,
      [randomUUID(), projectId, input.actorId, projectContextSourceKind, source.key, version, content, null,
        `repo-file:${source.key}`]);
    }
    await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,
      correlation_id,details,occurred_at) values($1,$2,$3,'project.register',$2,$4,$5,now())`,
    [input.workspaceId, projectId, input.actorId, input.idempotencyKey,
      JSON.stringify({slug: input.slug, provider: 'github'})]);
    await client.query('commit');
    return {projectId, slug: input.slug, created: true};
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
};

export const readProjectTrackerCapabilities = async (
  database: Database,
  actorId: string,
  projectId: string
): Promise<ProjectTrackerCapabilities | null> => {
  const result = await database.query<{content: string}>(`select s.content_text as content
    from project_source_artifacts s join project_memberships m on m.project_id=s.project_id
    where s.project_id=$1 and m.actor_id=$2 and m.active=true and s.kind='project_tracker_capabilities_v1'
    order by s.created_at desc,s.id desc limit 1`, [projectId, actorId]);
  return result.rows[0] === undefined ? null : parseTrackerCapabilities(result.rows[0].content);
};

export type ProjectRuntimeBinding = Readonly<{
  workspaceId: string;
  projectId: string;
  ownerActorId: string;
  bindingId: string;
  provider: string;
  projectUrl: string;
  repositoryId: string;
  repositoryUrl: string;
  cursor: string | null;
  trackerCredentialRef: OpaqueSecretRef;
  trackerCapabilities: ProjectTrackerCapabilities;
}>;

type ProjectRuntimeRow = Omit<ProjectRuntimeBinding,
  'trackerCredentialRef' | 'trackerCapabilities'> & Readonly<{
  trackerSecretId: string;
  trackerSecretPurpose: string;
  trackerSecretLocator: string;
  trackerCapabilitiesContent: string;
}>;

const runtimeBinding = (rows: readonly ProjectRuntimeRow[]): ProjectRuntimeBinding | null => {
  const candidates = rows.flatMap((row) => {
    const capabilities = parseTrackerCapabilities(row.trackerCapabilitiesContent);
    if (capabilities === null || row.trackerSecretPurpose !== 'tracker_read' ||
      !row.trackerSecretLocator.startsWith('/')) return [];
    return [{workspaceId: row.workspaceId, projectId: row.projectId, ownerActorId: row.ownerActorId,
      bindingId: row.bindingId, provider: row.provider, projectUrl: row.projectUrl,
      repositoryId: row.repositoryId, repositoryUrl: row.repositoryUrl, cursor: row.cursor,
      trackerCredentialRef: {id: row.trackerSecretId, purpose: 'tracker_read', locator: row.trackerSecretLocator},
      trackerCapabilities: capabilities}];
  });
  return candidates.length === 1 ? candidates[0]! : null;
};

const projectRuntimeRows = async (database: Database, workspaceId: string,
  repositoryUrl: string): Promise<readonly ProjectRuntimeRow[]> => {
  const result = await database.query<ProjectRuntimeRow>(`select p.workspace_id as "workspaceId",p.id as "projectId",
    owner.actor_id as "ownerActorId",b.id as "bindingId",b.provider,b.project_url as "projectUrl",
    b.repository_id as "repositoryId",b.repository_url as "repositoryUrl",b.cursor,
    secret.id as "trackerSecretId",secret.purpose as "trackerSecretPurpose",secret.locator as "trackerSecretLocator",
    capabilities.content_text as "trackerCapabilitiesContent"
    from projects p join tracker_bindings b on b.project_id=p.id and b.enabled=true
    join secret_refs secret on secret.id=b.secret_ref_id and secret.workspace_id=p.workspace_id
    join lateral (select actor_id from project_memberships where project_id=p.id and role='project_owner' and active=true
      order by created_at,id limit 1) owner on true
    join lateral (select content_text from project_source_artifacts where project_id=p.id
      and kind='project_tracker_capabilities_v1' order by created_at desc,id desc limit 1) capabilities on true
    where p.workspace_id=$1 and lower(b.repository_url)=lower($2)`, [workspaceId, repositoryUrl]);
  return result.rows;
};

export const resolveProjectRuntimeByRepository = async (database: Database, workspaceId: string,
  repositoryUrl: string): Promise<ProjectRuntimeBinding | null> => {
  let url: URL;
  try { url = new URL(repositoryUrl); } catch { return null; }
  if (url.origin !== 'https://github.com' || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) return null;
  return runtimeBinding(await projectRuntimeRows(database, workspaceId, url.toString()));
};

export type ProjectAgentProfileView = Readonly<{
  status: 'not_configured' | 'ready';
  profile: string | null;
  endpointPath: string | null;
  version: string | null;
}>;

export const readProjectAgentProfile = async (
  database: Database,
  actorId: string,
  projectId: string
): Promise<ProjectAgentProfileView> => {
  const result = await database.query<{sha256: string; content: string}>(`select s.sha256,s.content_text as content
    from project_source_artifacts s join project_memberships m on m.project_id=s.project_id
    where s.project_id=$1 and m.actor_id=$2 and m.active=true and s.kind='project_agent_profile_v1'
    order by s.created_at desc limit 1`, [projectId, actorId]);
  const row = result.rows[0];
  if (row === undefined) {
    return {status: 'not_configured', profile: null, endpointPath: null, version: null};
  }
  try {
    const value = JSON.parse(row.content) as Record<string, unknown>;
    if (value.contract === 'fai.project-agent-profile.v1' && value.status === 'ready' &&
      value.templateVersion === projectAgentProfileTemplateVersion &&
      typeof value.profile === 'string' &&
      /^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/.test(value.profile) &&
      value.endpointPath === `/p/${encodeURIComponent(value.profile)}/v1/runs`) {
      return {status: 'ready', profile: value.profile, endpointPath: value.endpointPath, version: row.sha256};
    }
  } catch { /* fail closed */ }
  return {status: 'not_configured', profile: null, endpointPath: null, version: null};
};

export const recordProjectAgentProfile = async (
  database: Database,
  input: Readonly<{
    workspaceId: string; projectId: string; actorId: string; profile: string; endpointPath: string;
    templateVersion: string; idempotencyKey: string; occurredAt: string;
  }>
): Promise<ProjectAgentProfileView> => {
  const client = await database.connect();
  try {
    await client.query('begin');
    const allowed = await client.query(`select 1 from project_memberships where project_id=$1 and actor_id=$2
      and role='project_owner' and active=true for update`, [input.projectId, input.actorId]);
    if (allowed.rowCount !== 1) throw new Error('agent_profile_denied');
    const value = {contract: 'fai.project-agent-profile.v1', status: 'ready', profile: input.profile,
      endpointPath: input.endpointPath, templateVersion: input.templateVersion};
    const {content, version} = jsonVersion(value);
    await client.query(`insert into project_source_artifacts
      (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
      values($1,$2,$3,'project_agent_profile_v1','Project AI agent profile','application/json',$4,$5,null,'hermes:verified-capabilities')
      on conflict(project_id,kind,sha256) do nothing`,
    [randomUUID(), input.projectId, input.actorId, version, content]);
    await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
      select $1,$2,$3,'project.agent.activate',$4,$5,$6,$7 where not exists
      (select 1 from audit_events where project_id=$2 and action='project.agent.activate' and target_reference=$4)`,
    [input.workspaceId, input.projectId, input.actorId, version, input.idempotencyKey,
      JSON.stringify({profile: input.profile, templateVersion: input.templateVersion}), input.occurredAt]);
    await client.query('commit');
    return {status: 'ready', profile: input.profile, endpointPath: input.endpointPath, version};
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};
