import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createDatabase, refreshProjectContext, subjectHash} from './runtime.ts';
import {parseProjectContextSource, parseProjectProcessPolicy, projectContextSnapshotVersion, projectContextSourceKind, serializeProjectContextSource} from '@fai-control-plane/domain';
import type {PoolClient} from 'pg';

const required = (name: string, max = 2_048): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.length > max || value.includes('\0')) throw new Error(`${name}_required`);
  return value;
};
const optional = (name: string): string | null => process.env[name]?.trim() || null;
const secretPath = (name: string): string => {
  const value = required(name);
  if (!value.startsWith('/')) throw new Error(`${name}_invalid`);
  return value;
};
const uuid = (name: string): string => {
  const value = required(name, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name}_invalid`);
  return value;
};
const https = (name: string): string => {
  const value = required(name); const url = new URL(value);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new Error(`${name}_invalid`);
  return url.toString();
};

export const bootstrap = async (): Promise<void> => {
  const database = createDatabase(); const client = await database.connect();
  const workspaceId = uuid('FCP_WORKSPACE_ID'); const projectId = uuid('FCP_PROJECT_ID');
  const ownerId = uuid('BOOTSTRAP_OWNER_ACTOR_ID'); const bindingId = uuid('GITHUB_BINDING_ID');
  const secretId = uuid('BOOTSTRAP_TRACKER_SECRET_REF_ID');
  const agentSecretLocator = secretPath('HERMES_TOKEN_FILE');
  const workspace = {slug: required('BOOTSTRAP_WORKSPACE_SLUG', 100), name: required('BOOTSTRAP_WORKSPACE_NAME', 200)};
  const projectSlug = required('BOOTSTRAP_PROJECT_SLUG', 100);
  const repositoryUrl = https('BOOTSTRAP_REPOSITORY_URL');
  try {
    await client.query('begin');
    await client.query(`insert into workspaces(id,slug,name) values($1,$2,$3) on conflict(id) do nothing`,
      [workspaceId,workspace.slug,workspace.name]);
    await client.query(`insert into actors(id,workspace_id,kind,display_name) values($1,$2,'human',$3) on conflict(id) do nothing`,
      [ownerId,workspaceId,required('BOOTSTRAP_OWNER_NAME',200)]);
    await client.query(`insert into actor_external_identities(actor_id,provider,subject_hash)
      values($1,'github',$2) on conflict(provider,subject_hash) do nothing`,
      [ownerId,subjectHash('github',required('BOOTSTRAP_OWNER_GITHUB_USER_ID',32))]);
    const ownerTelegram = optional('BOOTSTRAP_OWNER_TELEGRAM_USER_ID');
    if (ownerTelegram !== null) await client.query(`insert into actor_external_identities(actor_id,provider,subject_hash)
      values($1,'telegram',$2) on conflict(provider,subject_hash) do nothing`, [ownerId,subjectHash('telegram',ownerTelegram)]);
    await client.query(`insert into projects(id,workspace_id,slug,name,repository_url) values($1,$2,$3,$4,$5)
      on conflict(id) do nothing`, [projectId,workspaceId,projectSlug,
      required('BOOTSTRAP_PROJECT_NAME',200),repositoryUrl]);
    await client.query(`insert into project_memberships(project_id,actor_id,role) values($1,$2,'project_owner')
      on conflict(project_id,actor_id) do nothing`, [projectId,ownerId]);
    await client.query(`insert into secret_refs(id,workspace_id,purpose,locator) values($1,$2,'tracker_read',$3)
      on conflict(id) do nothing`, [secretId,workspaceId,required('GITHUB_PROJECTS_TOKEN_FILE')]);
    await ensureAgentDeliverySecretRef(client, workspaceId, agentSecretLocator);
    await client.query(`insert into tracker_bindings(id,project_id,secret_ref_id,provider,external_project_id,project_url,
      repository_id,repository_url) values($1,$2,$3,'github',$4,$5,$6,$7) on conflict(id) do nothing`,
      [bindingId,projectId,secretId,required('GITHUB_PROJECT_ID',256),https('BOOTSTRAP_GITHUB_PROJECT_URL'),
        required('BOOTSTRAP_REPOSITORY_ID',256),repositoryUrl]);
    await seedTrackerCapabilities(client, {projectId, actorId: ownerId,
      agentOwnerOptionId: required('HERMES_TRACKER_OWNER_OPTION_ID', 512),
      doneStatusOptionId: required('STATUS_DONE_ID', 512),
      defaultBranch: required('GITHUB_DEFAULT_BRANCH', 256)});
    await seedProjectProcessPolicy(client, {workspaceId, projectId, actorId: ownerId,
      path: required('FCP_PROJECT_PROCESS_POLICY_FILE')});
    await seedCanonicalProjectContextSources(client, {projectId, actorId: ownerId,
      root: required('FCP_CONTEXT_SOURCE_ROOT'), processPolicyPath: required('FCP_PROJECT_PROCESS_POLICY_FILE')});
    const result = await client.query<{workspaceId:string;repositoryUrl:string;ownerRole:string;bindingProjectId:string}>(
      `select p.workspace_id as "workspaceId",p.repository_url as "repositoryUrl",m.role as "ownerRole",
       b.project_id as "bindingProjectId" from projects p join project_memberships m on m.project_id=p.id and m.actor_id=$2
       join tracker_bindings b on b.project_id=p.id where p.id=$1`, [projectId,ownerId]);
    const row = result.rows[0];
    if (row?.workspaceId !== workspaceId || row.repositoryUrl !== repositoryUrl || row.ownerRole !== 'project_owner' ||
      row.bindingProjectId !== projectId) throw new Error('bootstrap_existing_state_conflict');
    await client.query('commit');
    await refreshProjectContext(database, {workspaceId, projectId, actorId: ownerId,
      idempotencyKey: `bootstrap-context:${projectId}`, occurredAt: new Date().toISOString()});
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); await database.end(); }
};

const seedTrackerCapabilities = async (client: Pick<PoolClient, 'query'>, input: Readonly<{
  projectId: string;
  actorId: string;
  agentOwnerOptionId: string;
  doneStatusOptionId: string;
  defaultBranch: string;
}>): Promise<void> => {
  const content = JSON.stringify({contract: 'fai.project-tracker-capabilities.v1', provider: 'github',
    agentOwnerOptionId: input.agentOwnerOptionId, doneStatusOptionId: input.doneStatusOptionId,
    defaultBranch: input.defaultBranch});
  const version = createHash('sha256').update(content).digest('hex');
  await client.query(`insert into project_source_artifacts
    (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
    values($1,$2,$3,'project_tracker_capabilities_v1','Project tracker capabilities','application/json',$4,$5,null,
      'composition:bootstrap') on conflict(project_id,kind,sha256) do nothing`,
  [randomUUID(), input.projectId, input.actorId, version, content]);
};

const seedCanonicalProjectContextSources = async (client: Pick<PoolClient, 'query'>, input: Readonly<{
  projectId: string; actorId: string; root: string; processPolicyPath: string;
}>): Promise<void> => {
  if (!input.root.startsWith('/') || input.root.includes('\0')) throw new Error('FCP_CONTEXT_SOURCE_ROOT_invalid');
  const sources = [
    ['repo:agents', 'AGENTS.md'],
    ['repo:ai-context', 'docs/AI_CONTEXT.md'],
    ['repo:adr-0006', 'docs/adr/0006-thin-control-plane-authority.md'],
    ['composition:project-process-policy', input.processPolicyPath]
  ] as const;
  for (const [key, path] of sources) {
    const resolved = path.startsWith('/') ? path : `${input.root.replace(/\/$/, '')}/${path}`;
    const content = await readFile(resolved, 'utf8');
    const source = parseProjectContextSource({contract:'fai.project-context-source.v1', key, content});
    if (source === null) throw new Error('project_context_source_invalid');
    const serialized = serializeProjectContextSource(source);
    const sha256 = projectContextSnapshotVersion(serialized);
    await client.query(`insert into project_source_artifacts
      (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
      values($1,$2,$3,$4,$5,'application/json',$6,$7,null,$8)
      on conflict(project_id,kind,sha256) do nothing`,
    [randomUUID(),input.projectId,input.actorId,projectContextSourceKind,key,sha256,serialized,
      path.startsWith('/') ? 'composition-file' : `repo-file:${path}`]);
  }
};

const seedProjectProcessPolicy = async (client: Pick<PoolClient, 'query'>, input: Readonly<{
  workspaceId: string; projectId: string; actorId: string; path: string;
}>): Promise<void> => {
  if (!input.path.startsWith('/') || input.path.length > 2_048 || input.path.includes('\0')) {
    throw new Error('FCP_PROJECT_PROCESS_POLICY_FILE_invalid');
  }
  const content = await readFile(input.path, 'utf8');
  let decoded: unknown;
  try { decoded = JSON.parse(content); } catch { throw new Error('project_process_policy_invalid'); }
  const policy = parseProjectProcessPolicy(decoded);
  if (policy === null || JSON.stringify(policy) !== content.trim()) throw new Error('project_process_policy_invalid');
  const version = createHash('sha256').update(content.trim()).digest('hex');
  const existing = await client.query<{id: string}>(`select id from project_source_artifacts
    where project_id=$1 and kind='project_process_policy_v1' and sha256=$2`, [input.projectId, version]);
  const id = existing.rows[0]?.id;
  const artifactId = id ?? randomUUID();
  if (id === undefined) await client.query(`insert into project_source_artifacts
    (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
    values($1,$2,$3,'project_process_policy_v1','Project process policy','application/json',$4,$5,null,'composition:project-process-policy')`,
  [artifactId,input.projectId,input.actorId,version,content.trim()]);
  await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
    select $1,$2,$3,'project.process.configure',$4,$5,$6,now() where not exists (
      select 1 from audit_events where project_id=$2 and action='project.process.configure' and target_reference=$4)`,
  [input.workspaceId,input.projectId,input.actorId,artifactId,`bootstrap:${version}`,JSON.stringify({version})]);
};

export const ensureAgentDeliverySecretRef = async (
  client: Pick<PoolClient, 'query'>,
  workspaceId: string,
  locator: string
): Promise<void> => {
  if (!locator.startsWith('/') || locator.length > 2_048 || locator.includes('\0')) {
    throw new Error('HERMES_TOKEN_FILE_invalid');
  }
  await client.query(`insert into secret_refs(workspace_id,purpose,locator) values($1,'agent_delivery',$2)
    on conflict(workspace_id,purpose) do nothing`, [workspaceId, locator]);
  const existing = await client.query<{locator: string}>(
    `select locator from secret_refs where workspace_id=$1 and purpose='agent_delivery'`, [workspaceId]
  );
  if (existing.rows[0]?.locator !== locator) throw new Error('bootstrap_existing_state_conflict');
};

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) await bootstrap();
