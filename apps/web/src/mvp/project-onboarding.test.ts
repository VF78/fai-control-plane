import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Database} from '@fai-control-plane/db';
import {activateProjectAgentProfile, resolveAndRegisterProject} from './project-onboarding.ts';

const environments = ['GITHUB_PROJECTS_TOKEN_FILE', 'HERMES_MANAGEMENT_URL', 'HERMES_MANAGEMENT_USERNAME_FILE',
  'HERMES_MANAGEMENT_PASSWORD_FILE', 'HERMES_GATEWAY_INTERNAL_BASE_URL'] as const;
const originals = Object.fromEntries(environments.map((name) => [name, process.env[name]]));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const name of environments) {
    const value = originals[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const secretFiles = async () => {
  const root = await mkdtemp(join(tmpdir(), 'fai-project-onboarding-'));
  const token = join(root, 'token'); const username = join(root, 'username'); const password = join(root, 'password');
  await Promise.all([writeFile(token, 'agent-secret'), writeFile(username, 'operator'), writeFile(password, 'password')]);
  return {root, token, username, password};
};

describe('project onboarding composition', () => {
  it('requires AGENTS.md but skips absent optional project context documents', async () => {
    const files = await secretFiles(); process.env.GITHUB_PROJECTS_TOKEN_FILE = files.token;
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (value: string | URL | Request) => {
      const url = String(value); requests.push(url);
      if (url.endsWith('/graphql')) return new Response(JSON.stringify({data: {
        user: {projectV2: {id: 'PVT_1', fields: {nodes: [
          {name: 'Owner', options: [{id: 'owner-hermes-1', name: 'Hermes'}]},
          {name: 'Status', options: [{id: 'status-done-1', name: 'Done'}]}
        ], pageInfo: {hasNextPage: false}}}}, repository: {id: 'R_1', defaultBranchRef: {name: 'main'}}
      }}));
      if (url.endsWith('/AGENTS.md')) return new Response(JSON.stringify({type: 'file', encoding: 'base64',
        content: Buffer.from('Project instructions').toString('base64')}));
      return new Response('{}', {status: 404});
    }));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("m.role='project_owner'")) return {rowCount: 1, rows: [{}]};
      if (sql.includes('from projects p join tracker_bindings')) return {rowCount: 0, rows: []};
      if (sql.includes("purpose='tracker_read'")) return {rowCount: 1, rows: [{id: 'tracker-secret'}]};
      return {rowCount: 1, rows: []};
    });
    const client = {query, release: vi.fn()};
    const database = {connect: vi.fn(async () => client)} as unknown as Database;
    await expect(resolveAndRegisterProject(database, {workspaceId: 'workspace', actorId: 'actor', name: 'Control',
      slug: 'control', projectUrl: 'https://github.com/users/VF78/projects/1',
      repositoryUrl: 'https://github.com/VF78/control', idempotencyKey: 'register:1'})).resolves.toMatchObject({created: true});
    expect(requests.filter((url) => url.includes('/contents/'))).toHaveLength(3);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('insert into project_source_artifacts'))).toHaveLength(4);
    await rm(files.root, {recursive: true});
  });

  it('never records readiness when the native capabilities probe is not authenticated', async () => {
    const files = await secretFiles();
    vi.useFakeTimers({toFake: ['setTimeout']});
    process.env.HERMES_MANAGEMENT_URL = 'http://hermes-management:9119';
    process.env.HERMES_MANAGEMENT_USERNAME_FILE = files.username;
    process.env.HERMES_MANAGEMENT_PASSWORD_FILE = files.password;
    process.env.HERMES_GATEWAY_INTERNAL_BASE_URL = 'http://hermes-gateway:8642';
    const calls: string[] = [];
    let firstProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => { firstProbe = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(value)); calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (url.pathname === '/auth/password-login') return new Response('{}', {headers: {'set-cookie': 'session=ok; Path=/'}});
      if (url.pathname === '/api/profiles' && init?.method === undefined) return new Response(JSON.stringify({profiles: []}));
      if (url.pathname === '/api/config' && init?.method === undefined) return new Response(JSON.stringify({gateway: {multiplex_profile_allowlist: []}}));
      if (url.pathname.endsWith('/v1/capabilities')) {
        firstProbe();
        return new Response('{}', {status: 401});
      }
      return new Response('{}');
    }));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("s.kind='project_agent_profile_v1'")) return {rowCount: 0, rows: []};
      if (sql.includes('tracker_secret.id as')) return {rowCount: 1, rows: [{workspaceId: 'workspace', projectId: 'project',
        requesterRole: 'project_owner', bindingId: 'binding', provider: 'github', externalProjectId: 'PVT_1',
        projectUrl: 'https://github.com/users/VF78/projects/1', repositoryId: 'R_1',
        repositoryUrl: 'https://github.com/VF78/control', cursor: null, trackerSecretId: 'tracker-secret',
        trackerSecretPurpose: 'tracker_read', trackerSecretLocator: files.token, agentSecretId: 'agent-secret',
        agentSecretLocator: files.token}]};
      if (sql.startsWith('select slug from projects')) return {rowCount: 1, rows: [{slug: 'control'}]};
      return {rowCount: 0, rows: []};
    });
    const database = {query, connect: vi.fn()} as unknown as Database;
    const activation = activateProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'activate:1'});
    const rejection = expect(activation).rejects.toThrow('agent_profile_probe_failed');
    await probeStarted;
    await vi.runAllTimersAsync();
    await rejection;
    expect(database.connect).not.toHaveBeenCalled();
    expect(calls).toContain('PUT /api/config?profile=project-control');
    expect(calls.filter((call) => call.endsWith('/v1/capabilities'))).toHaveLength(12);
    await rm(files.root, {recursive: true});
  });

  it('persists readiness only after the ordered native activation contract succeeds', async () => {
    const files = await secretFiles();
    process.env.HERMES_MANAGEMENT_URL = 'http://hermes-management:9119';
    process.env.HERMES_MANAGEMENT_USERNAME_FILE = files.username;
    process.env.HERMES_MANAGEMENT_PASSWORD_FILE = files.password;
    process.env.HERMES_GATEWAY_INTERNAL_BASE_URL = 'http://hermes-gateway:8642';
    const calls: {request: string; body: string}[] = [];
    vi.stubGlobal('fetch', vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(value));
      calls.push({request: `${init?.method ?? 'GET'} ${url.pathname}${url.search}`, body: String(init?.body ?? '')});
      if (url.pathname === '/auth/password-login') return new Response('{}', {headers: {'set-cookie': 'session=ok; Path=/'}});
      if (url.pathname === '/api/profiles' && init?.method === undefined) return new Response(JSON.stringify({profiles: []}));
      if (url.pathname === '/api/config' && init?.method === undefined) return new Response(JSON.stringify({gateway: {multiplex_profile_allowlist: []}}));
      if (url.pathname.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({object: 'hermes.api_server.capabilities'}));
      }
      return new Response('{}');
    }));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("s.kind='project_agent_profile_v1'")) return {rowCount: 0, rows: []};
      if (sql.includes('tracker_secret.id as')) return {rowCount: 1, rows: [{workspaceId: 'workspace', projectId: 'project',
        requesterRole: 'project_owner', bindingId: 'binding', provider: 'github', externalProjectId: 'PVT_1',
        projectUrl: 'https://github.com/users/VF78/projects/1', repositoryId: 'R_1',
        repositoryUrl: 'https://github.com/VF78/control', cursor: null, trackerSecretId: 'tracker-secret',
        trackerSecretPurpose: 'tracker_read', trackerSecretLocator: files.token, agentSecretId: 'agent-secret',
        agentSecretLocator: files.token}]};
      if (sql.startsWith('select slug from projects')) return {rowCount: 1, rows: [{slug: 'control'}]};
      return {rowCount: 0, rows: []};
    });
    const persisted: unknown[][] = [];
    const clientQuery = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      persisted.push([sql, parameters]);
      if (sql.includes("role='project_owner'")) return {rowCount: 1, rows: [{}]};
      return {rowCount: 1, rows: []};
    });
    const database = {query, connect: vi.fn(async () => ({query: clientQuery, release: vi.fn()}))} as unknown as Database;
    await expect(activateProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'activate:1'})).resolves.toMatchObject({status: 'ready', profile: 'project-control'});
    const ordered = calls.map(({request}) => request);
    const positions = [
      'POST /api/profiles', 'POST /api/files/mkdir', 'PUT /api/env?profile=project-control',
      'PUT /api/config?profile=project-control', 'GET /p/project-control/v1/capabilities'
    ].map((request) => ordered.indexOf(request));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(JSON.parse(calls.find(({request}) => request.startsWith('PUT /api/env'))!.body)).toEqual({
      key: 'API_SERVER_KEY', value: 'agent-secret', profile: 'project-control'
    });
    expect(JSON.stringify(persisted)).not.toContain('agent-secret');
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("'project.agent.activate'"), expect.any(Array));
    await rm(files.root, {recursive: true});
  });
});
