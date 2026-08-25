import {
  readProjectAgentProfile,
  recordProjectAgentProfile,
  registerProject,
  resolveAgentSubmissionBinding,
  type Database,
  type ProjectAgentProfileView
} from '@fai-control-plane/db';
import {parseProjectContextSource, type OpaqueSecretRef} from '@fai-control-plane/domain';
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
  const files = [
    {key: 'repo:agents', path: 'AGENTS.md', required: true},
    {key: 'repo:ai-context', path: 'docs/AI_CONTEXT.md', required: false},
    {key: 'repo:adr-0006', path: 'docs/adr/0006-thin-control-plane-authority.md', required: false}
  ] as const;
  const contextSources = [];
  for (const {key, path, required} of files) {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(urls.owner)}/${encodeURIComponent(urls.repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28'}, signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 404 && !required) continue;
    if (!response.ok) throw new Error('github_read_failed');
    const value = await response.json() as {type?: string; content?: string; encoding?: string};
    if (value.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string') {
      throw new Error('github_context_read_invalid');
    }
    const source = parseProjectContextSource({contract: 'fai.project-context-source.v1', key,
      content: Buffer.from(value.content.replace(/\s/g, ''), 'base64').toString('utf8')});
    if (source === null) throw new Error('github_context_read_invalid');
    contextSources.push(source);
  }
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

export const activateProjectAgentProfile = async (database: Database, input: Readonly<{
  workspaceId: string; actorId: string; projectId: string; idempotencyKey: string;
}>): Promise<ProjectAgentProfileView> => {
  const current = await readProjectAgentProfile(database, input.actorId, input.projectId);
  if (current.status === 'ready') return current;
  const binding = await resolveAgentSubmissionBinding(database, input.actorId, input.projectId);
  if (binding === null || binding.agentCredentialRef === null || binding.requesterRole !== 'project_owner') {
    throw new Error('agent_profile_denied');
  }
  const project = await database.query<{slug: string}>(
    'select slug from projects where id=$1 and workspace_id=$2', [input.projectId, input.workspaceId]);
  const slug = project.rows[0]?.slug;
  if (slug === undefined) throw new Error('agent_profile_denied');
  const profile = slug === 'ascon' ? 'internal' : `project-${slug}`;
  const template = process.env.HERMES_PROFILE_TEMPLATE ?? 'fai-project-template';
  const workDirectory = `/opt/data/work/projects/${slug}`;
  const token = (await secretResolver.resolve(binding.agentCredentialRef, 'agent_delivery')).value;
  const client = await managementClient();
  const listed = await expectJson<{profiles: readonly {name?: string}[]}>(await client.request('/api/profiles'));
  if (!listed.profiles.some((item) => item.name === profile)) {
    await expectJson(await client.request('/api/profiles', {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({name: profile, clone_from: template,
        no_skills: false, description: `Project manager for ${slug}`})}));
  }
  await expectJson(await client.request('/api/files/mkdir', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({path: workDirectory})}));
  await expectJson(await client.request(`/api/env?profile=${encodeURIComponent(profile)}`, {method: 'PUT',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({key: 'API_SERVER_KEY', value: token, profile})}));
  await expectJson(await client.request(`/api/config?profile=${encodeURIComponent(profile)}`, {method: 'PUT',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({profile, config: {terminal: {
      backend: 'local', cwd: workDirectory}, platform_toolsets: {api_server: ['terminal', 'no_mcp']},
    toolsets: ['file', 'terminal', 'search', 'web', 'skills', 'todo', 'memory', 'session_search',
      'fai_internal', 'clarify']}})}));
  const base = process.env.HERMES_GATEWAY_INTERNAL_BASE_URL;
  if (base === undefined) throw new Error('agent_profile_unavailable');
  const endpointPath = `/p/${encodeURIComponent(profile)}/v1/runs`;
  let verified = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(new URL(`/p/${encodeURIComponent(profile)}/v1/capabilities`, base),
      {headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(2_000)}).catch(() => null);
    if (response?.ok) {
      const value = await response.json().catch(() => null) as {object?: string}|null;
      if (value?.object === 'hermes.api_server.capabilities') { verified = true; break; }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!verified) throw new Error('agent_profile_probe_failed');
  return recordProjectAgentProfile(database, {...input, profile, endpointPath,
    templateVersion: 'v2026.8.13-fai-project-v1', occurredAt: new Date().toISOString()});
};
