import {
  readProjectAgentProfile,
  recordProjectAgentProfile,
  projectAgentProfileTemplateVersion,
  registerProject,
  resolveAgentSubmissionBinding,
  type Database,
  type ProjectAgentProfileView
} from '@fai-control-plane/db';
import {parseProjectContextSource, projectPassportPaths, type OpaqueSecretRef,
  type ProjectContextSource} from '@fai-control-plane/domain';
import {readSecretFile, secretResolver} from './runtime.ts';

const githubUrls = (projectValue: string, repositoryValue: string) => {
  const projectUrl = new URL(projectValue);
  const repositoryUrl = new URL(repositoryValue);
  const project = /^\/users\/([^/]+)\/projects\/(\d+)\/?$/.exec(projectUrl.pathname);
  const repository = /^\/([^/]+)\/([^/]+)\/?$/.exec(repositoryUrl.pathname);
  if (projectUrl.origin !== 'https://github.com' || repositoryUrl.origin !== 'https://github.com' ||
    project === null || repository === null || project[1]!.toLowerCase() !== repository[1]!.toLowerCase()) {
    throw new Error('github_binding_invalid');
  }
  return {
    projectUrl: projectUrl.toString(), repositoryUrl: repositoryUrl.toString(), owner: project[1]!,
    projectNumber: Number(project[2]), repository: repository[2]!
  };
};
const githubTokenRef = (): OpaqueSecretRef => ({id: 'GITHUB_PROJECTS_TOKEN', purpose: 'tracker_read',
  locator: process.env.GITHUB_PROJECTS_TOKEN_FILE ?? ''});
const githubRequest = async (url: string, token: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(url, {...init, headers: {accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', ...(init?.headers ?? {})},
  signal: AbortSignal.timeout(15_000)});
  if (!response.ok) throw new Error('github_read_failed');
  return response;
};

export const resolveAndRegisterProject = async (database: Database, input: Readonly<{
  workspaceId: string; actorId: string; name: string; slug: string; projectUrl: string;
  repositoryUrl: string; idempotencyKey: string;
}>) => {
  const urls = githubUrls(input.projectUrl, input.repositoryUrl);
  const token = (await secretResolver.resolve(githubTokenRef(), 'tracker_read')).value;
  const query = `query($owner:String!,$number:Int!,$repository:String!){user(login:$owner){projectV2(number:$number){id
    fields(first:100){nodes{... on ProjectV2SingleSelectField{name options{id name}}}pageInfo{hasNextPage}}}}
    repository(owner:$owner,name:$repository){id defaultBranchRef{name}}}`;
  const graph = await githubRequest('https://api.github.com/graphql', token, {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({query, variables: {
      owner: urls.owner, number: urls.projectNumber, repository: urls.repository
    }})});
  const payload = await graph.json() as {data?: {user?: {projectV2?: {id?: string; fields?: {
    nodes?: readonly {name?: string; options?: readonly {id?: string; name?: string}[]}[];
    pageInfo?: {hasNextPage?: boolean};
  }}}, repository?: {id?: string; defaultBranchRef?: {name?: string}}}};
  const project = payload.data?.user?.projectV2;
  const externalProjectId = project?.id;
  const repositoryId = payload.data?.repository?.id;
  const defaultBranch = payload.data?.repository?.defaultBranchRef?.name;
  const fields = project?.fields;
  const single = (fieldName: string, optionName: string): string | null => {
    const field = fields?.nodes?.find((candidate) => candidate.name === fieldName);
    const option = field?.options?.find((candidate) => candidate.name === optionName);
    return typeof option?.id === 'string' && option.id.length > 0 && option.id.length <= 512
      ? option.id : null;
  };
  const agentOwnerOptionId = single('Owner', 'Hermes');
  const doneStatusOptionId = single('Status', 'Done');
  if (typeof externalProjectId !== 'string' || typeof repositoryId !== 'string' ||
    typeof defaultBranch !== 'string' || !/^[^\0\r\n]{1,256}$/.test(defaultBranch) ||
    fields?.pageInfo?.hasNextPage === true || agentOwnerOptionId === null || doneStatusOptionId === null) {
    throw new Error('github_binding_invalid');
  }
  const contextSources: ProjectContextSource[] = [];
  const readContextFile = async (key: string, path: string): Promise<'found'|'missing'> => {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(urls.owner)}/${encodeURIComponent(urls.repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28'}, signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 404) return 'missing';
    if (!response.ok) throw new Error('github_read_failed');
    const value = await response.json() as {type?: string; content?: string; encoding?: string};
    if (value.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string') {
      throw new Error('github_context_read_invalid');
    }
    const source = parseProjectContextSource({contract: 'fai.project-context-source.v1', key,
      content: Buffer.from(value.content.replace(/\s/g, ''), 'base64').toString('utf8')});
    if (source === null) throw new Error('github_context_read_invalid');
    contextSources.push(source);
    return 'found';
  };
  if (await readContextFile('repo:agents', 'AGENTS.md') !== 'found') throw new Error('project_context_not_configured');
  let passportFound = false;
  for (const path of projectPassportPaths) {
    if (await readContextFile('repo:passport', path) === 'found') { passportFound = true; break; }
  }
  if (!passportFound) throw new Error('project_passport_not_configured');
  return registerProject(database, {...input, projectUrl: urls.projectUrl, repositoryUrl: urls.repositoryUrl,
    externalProjectId, repositoryId, contextSources,
    trackerCapabilities: {provider: 'github', agentOwnerOptionId, doneStatusOptionId, defaultBranch}});
};

type CookieClient = Readonly<{request: (path: string, init?: RequestInit) => Promise<Response>}>;
const managementClient = async (): Promise<CookieClient> => {
  const base = process.env.HERMES_MANAGEMENT_URL;
  const usernameFile = process.env.HERMES_MANAGEMENT_USERNAME_FILE;
  const passwordFile = process.env.HERMES_MANAGEMENT_PASSWORD_FILE;
  if (base === undefined || usernameFile === undefined || passwordFile === undefined) {
    throw new Error('agent_profile_unavailable');
  }
  const endpoint = new URL(base);
  if (!['http:', 'https:'].includes(endpoint.protocol) || (endpoint.protocol === 'http:' &&
    endpoint.hostname.includes('.') && !['127.0.0.1', 'localhost'].includes(endpoint.hostname))) {
    throw new Error('agent_profile_unavailable');
  }
  const username = await readSecretFile(usernameFile);
  const password = await readSecretFile(passwordFile);
  const login = await fetch(new URL('/auth/password-login', endpoint), {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({provider: 'basic', username, password}),
    signal: AbortSignal.timeout(10_000)});
  if (!login.ok) throw new Error('agent_profile_unavailable');
  const values = typeof login.headers.getSetCookie === 'function'
    ? login.headers.getSetCookie() : [login.headers.get('set-cookie') ?? ''];
  const cookie = values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
  return {request: async (path, init) => fetch(new URL(path, endpoint), {...init,
    headers: {cookie, ...(init?.headers ?? {})}, signal: AbortSignal.timeout(10_000)})};
};
const expectJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error('agent_profile_unavailable');
  return response.json() as Promise<T>;
};

const projectProfileVersion = projectAgentProfileTemplateVersion;
const projectProfileMarker = (slug: string): string => `<!-- fai-project-profile:${projectProfileVersion}:${slug} -->`;
const projectSoul = (input: Readonly<{slug: string; repositoryUrl: string; projectUrl: string}>): string => {
  const coordinates = githubUrls(input.projectUrl, input.repositoryUrl);
  return `${projectProfileMarker(input.slug)}
# Project Hermes

You are the permanent project manager and project interface for this one project.
Repository: ${input.repositoryUrl}
GitHub Project: ${input.projectUrl} (owner ${coordinates.owner}, number ${coordinates.projectNumber})

Keep durable decisions and compact project facts in native Hermes memory. GitHub Issues and this GitHub Project are the
only task and status truth. For every task trigger, read the issue, comments, Project fields and linked PR yourself with
native git/gh access, and read repository AGENTS.md before project work. Never interpret Control Plane internal
identifiers as GitHub Project identifiers.

The repository project/product passport is the authoritative project overview. Use its compact indexed context for
orientation and read the full passport or documents it references from the repository only when the current question or
task needs them. Do not copy the full passport into memory, Telegram history or every Codex prompt.

Perform planning and Project operations directly. If scope or acceptance criteria are incomplete, update the same issue
and request confirmation in Telegram before execution. For implementation, documentation, QA and DevOps evidence, run
one fresh bounded Codex CLI task using the role, CLI, model and reasoning route from the trigger, with only the issue URL
and smallest necessary repository context. Preserve this Hermes profile, its memory and Telegram sessions across tasks
and restarts.

Before execution, check that the issue, repository, required credentials and target environment are reachable. If an
essential input or access is missing, do not repeat failing actions: keep the task at its current stage, record the exact
missing prerequisite, notify Telegram and return a structured blocked result. Otherwise continue until the stage has a
real result; do not stop because of an arbitrary small turn count.

Development must produce every requested artifact before moving the item to QA. QA verifies those existing artifacts and
may fix one localized issue or return the item to development with concrete findings. Update the same Project item after
each completed stage and report every stage, result and blocker in Telegram. Never create a duplicate issue, run or PR.
Never merge, release, deploy, mutate production or send customer material without Vladimir's exact approval.
`;
};
const projectProfileConfig = (workDirectory: string) => ({
  terminal: {backend: 'local', cwd: workDirectory},
  platform_toolsets: {api_server: ['terminal', 'fai_internal', 'no_mcp']},
  // Hermes' native default is 500. Keep only the emergency runaway ceiling;
  // ordinary stopping is governed by the semantic project rules in SOUL.
  agent: {max_turns: 500},
  toolsets: ['file', 'terminal', 'search', 'web', 'skills', 'todo', 'memory', 'session_search',
    'fai_internal', 'clarify']
});
const recordValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const projectConfigMatches = (value: unknown, workDirectory: string): boolean => {
  const root = recordValue(value); const config = recordValue(root?.config) ?? root;
  const terminal = recordValue(config?.terminal); const agent = recordValue(config?.agent);
  const platform = recordValue(config?.platform_toolsets);
  const apiServer = Array.isArray(platform?.api_server) ? platform.api_server : [];
  const toolsets = Array.isArray(config?.toolsets) ? config.toolsets : [];
  return terminal?.backend === 'local' && terminal.cwd === workDirectory &&
    typeof agent?.max_turns === 'number' && agent.max_turns >= 500 &&
    ['terminal', 'fai_internal', 'no_mcp'].every((item) => apiServer.includes(item)) &&
    ['terminal', 'memory', 'session_search', 'fai_internal'].every((item) => toolsets.includes(item));
};

const ensureProjectProfileConfiguration = async (client: CookieClient, input: Readonly<{
  profile: string; slug: string; repositoryUrl: string; projectUrl: string; workDirectory: string; token: string;
  force: boolean;
}>): Promise<void> => {
  const soulPath = `/api/profiles/${encodeURIComponent(input.profile)}/soul`;
  const soulValue = await expectJson<unknown>(await client.request(soulPath));
  const soul = recordValue(soulValue)?.content;
  const configValue = await expectJson<unknown>(await client.request(`/api/config?profile=${encodeURIComponent(input.profile)}`));
  const configured = typeof soul === 'string' && soul.includes(projectProfileMarker(input.slug)) &&
    soul.includes(input.repositoryUrl) && soul.includes(input.projectUrl) &&
    projectConfigMatches(configValue, input.workDirectory);
  if (configured && !input.force) return;
  await expectJson(await client.request('/api/files/mkdir', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({path: input.workDirectory})}));
  await expectJson(await client.request(`/api/env?profile=${encodeURIComponent(input.profile)}`, {method: 'PUT',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({key: 'API_SERVER_KEY',
      value: input.token, profile: input.profile})}));
  await expectJson(await client.request(`/api/config?profile=${encodeURIComponent(input.profile)}`, {method: 'PUT',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({profile: input.profile,
      config: projectProfileConfig(input.workDirectory)})}));
  await expectJson(await client.request(soulPath, {method: 'PUT', headers: {'content-type': 'application/json'},
    body: JSON.stringify({content: projectSoul(input)})}));
};

const profileCapabilitiesAvailable = async (
  profile: string,
  token: string,
  attempts = 1
): Promise<boolean> => {
  const base = process.env.HERMES_GATEWAY_INTERNAL_BASE_URL;
  if (base === undefined) throw new Error('agent_profile_unavailable');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(new URL(`/p/${encodeURIComponent(profile)}/v1/capabilities`, base),
      {headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(2_000)}).catch(() => null);
    if (response?.ok) {
      const value = await response.json().catch(() => null) as {object?: string}|null;
      if (value?.object === 'hermes.api_server.capabilities') return true;
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

export const activateProjectAgentProfile = async (database: Database, input: Readonly<{
  workspaceId: string; actorId: string; projectId: string; idempotencyKey: string; force?: boolean;
}>): Promise<ProjectAgentProfileView> => {
  const binding = await resolveAgentSubmissionBinding(database, input.actorId, input.projectId);
  if (binding === null || binding.agentCredentialRef === null || binding.requesterRole !== 'project_owner') {
    throw new Error('agent_profile_denied');
  }
  const stored = await readProjectAgentProfile(database, input.actorId, input.projectId);
  const token = (await secretResolver.resolve(binding.agentCredentialRef, 'agent_delivery')).value;
  const project = await database.query<{slug: string}>(
    'select slug from projects where id=$1 and workspace_id=$2', [input.projectId, input.workspaceId]);
  const slug = project.rows[0]?.slug;
  if (slug === undefined) throw new Error('agent_profile_denied');
  const profile = stored.profile ?? `project-${slug}`;
  const template = process.env.HERMES_PROFILE_TEMPLATE ?? 'fai-project-template';
  const workDirectory = '/opt/data/work/project';
  const client = await managementClient();
  const listed = await expectJson<{profiles: readonly {name?: string}[]}>(await client.request('/api/profiles'));
  const created = !listed.profiles.some((item) => item.name === profile);
  if (created) {
    await expectJson(await client.request('/api/profiles', {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({name: profile, clone_from: template,
        no_skills: false, description: `Project manager for ${slug}`})}));
  }
  await ensureProjectProfileConfiguration(client, {profile, slug, repositoryUrl: binding.repositoryUrl,
    projectUrl: binding.projectUrl, workDirectory, token, force: input.force === true});
  const endpointPath = `/p/${encodeURIComponent(profile)}/v1/runs`;
  if (!await profileCapabilitiesAvailable(profile, token)) {
    const restarted = await client.request('/api/gateway/restart', {method: 'POST'});
    if (!restarted.ok || !await profileCapabilitiesAvailable(profile, token, 12)) {
      throw new Error('agent_profile_probe_failed');
    }
  }
  return recordProjectAgentProfile(database, {...input, profile, endpointPath,
    templateVersion: projectProfileVersion, occurredAt: new Date().toISOString()});
};

export const ensureProjectAgentProfile = async (database: Database, input: Readonly<{
  workspaceId: string; actorId: string; projectId: string; idempotencyKey: string; force?: boolean;
}>): Promise<ProjectAgentProfileView> => {
  return activateProjectAgentProfile(database, input);
};
