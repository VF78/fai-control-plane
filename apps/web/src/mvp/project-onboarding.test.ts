import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Database} from '@fai-control-plane/db';
import {projectAgentProfileTemplateVersion} from '@fai-control-plane/db';
import {activateProjectAgentProfile, ensureProjectAgentProfile, resolveAndRegisterProject} from './project-onboarding.ts';

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
const documentRows=()=>['requirements','passport'].map((category,index)=>({id:`document-${index}`,projectId:'project',
  kind:`project_document_v1:${category}`,name:`${category}.txt`,mediaType:'text/plain',sha256:String(index+1).repeat(64),
  sizeBytes:10,provenance:'operator-upload',createdAt:new Date('2026-08-27T10:00:00Z')}));
const documentFingerprint=createHash('sha256').update(documentRows().slice().sort((a,b)=>
  a.kind.localeCompare(b.kind)).map(({kind,sha256})=>`${kind}:${sha256}`).join('\n')).digest('hex');

describe('project onboarding composition', () => {
  it('registers before authoritative documents exist without reading repository documents', async () => {
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
      if (url.endsWith('/docs/product-passport.md')) return new Response(JSON.stringify({type: 'file', encoding: 'base64',
        content: Buffer.from('Project passport').toString('base64')}));
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
    expect(requests.filter((url) => url.includes('/contents/'))).toHaveLength(0);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('insert into project_source_artifacts'))).toHaveLength(3);
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
      if (sql.includes("s.kind like 'project_document_v1:%'")) return {rowCount: 2, rows: documentRows()};
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
    expect(calls.filter((call) => call.endsWith('/v1/capabilities'))).toHaveLength(13);
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
      if(url.pathname.endsWith('/v1/runs')&&init?.method==='POST')
        return new Response(JSON.stringify({run_id:'run_context_1',status:'started'}),{status:202});
      return new Response('{}');
    }));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("s.kind='project_agent_profile_v1'")) return {rowCount: 0, rows: []};
      if(sql.includes('s.content_bytes as bytes'))return {rowCount:1,rows:[{name:'source.txt',mediaType:'text/plain',
        bytes:Buffer.from('exact source')}]};
      if (sql.includes("s.kind like 'project_document_v1:%'")) return {rowCount: 2, rows: documentRows()};
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
      if(sql.includes("command_type='project.context-bootstrap.start'"))return {rowCount:0,rows:[]};
      return {rowCount: 1, rows: []};
    });
    const database = {query, connect: vi.fn(async () => ({query: clientQuery, release: vi.fn()}))} as unknown as Database;
    await expect(activateProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'activate:1'})).resolves.toMatchObject({status: 'configuring', profile: 'project-control'});
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
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("'project.context-bootstrap.start'"), expect.any(Array));
    await rm(files.root, {recursive: true});
  });

  it('keeps a configured profile stable during normal checks and rewrites it only on explicit refresh', async () => {
    const files = await secretFiles();
    process.env.HERMES_MANAGEMENT_URL = 'http://hermes-management:9119';
    process.env.HERMES_MANAGEMENT_USERNAME_FILE = files.username;
    process.env.HERMES_MANAGEMENT_PASSWORD_FILE = files.password;
    process.env.HERMES_GATEWAY_INTERNAL_BASE_URL = 'http://hermes-gateway:8642';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(value));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (url.pathname === '/auth/password-login') return new Response('{}', {headers: {'set-cookie': 'session=ok; Path=/'}});
      if (url.pathname === '/api/profiles') return new Response(JSON.stringify({profiles: [{name: 'internal'}]}));
      if (url.pathname.endsWith('/soul')) return new Response(JSON.stringify({
        content: '<!-- fai-project-profile:v2026.8.27-fai-project-v2:ascon -->\nhttps://github.com/VF78/control\nhttps://github.com/users/VF78/projects/1'
      }));
      if (url.pathname === '/api/config') return new Response(JSON.stringify({terminal: {backend: 'local',
        cwd: '/opt/data/work/projects/ascon'}, agent: {max_turns: 500},
      platform_toolsets: {api_server: ['terminal', 'fai_internal', 'no_mcp']},
      toolsets: ['terminal', 'memory', 'session_search', 'fai_internal']}));
      return new Response(JSON.stringify({object: 'hermes.api_server.capabilities'}));
    }));
    const query = vi.fn(async (sql: string,parameters?:readonly unknown[]) => {
      if(typeof parameters?.[2]==='string'&&parameters[2].startsWith('project_context_compact_v1:'))
        return {rowCount:1,rows:[{sha256:'a'.repeat(64),
        content:'approved compact context'}]};
      if (sql.includes("s.kind like 'project_document_v1:%'")) return {rowCount: 2, rows: documentRows()};
      if (sql.includes("s.kind='project_agent_profile_v1'")) return {rowCount: 1, rows: [{sha256: 'version-1',
        content: JSON.stringify({contract: 'fai.project-agent-profile.v1', status: 'ready', profile: 'internal',
          endpointPath: '/p/internal/v1/runs', templateVersion: projectAgentProfileTemplateVersion,
          documentFingerprint})}]};
      if (sql.includes('tracker_secret.id as')) return {rowCount: 1, rows: [{workspaceId: 'workspace',
        projectId: 'project', requesterRole: 'project_owner', bindingId: 'binding', provider: 'github',
        externalProjectId: 'PVT_1', projectUrl: 'https://github.com/users/VF78/projects/1', repositoryId: 'R_1',
        repositoryUrl: 'https://github.com/VF78/control', cursor: null, trackerSecretId: 'tracker-secret',
        trackerSecretPurpose: 'tracker_read', trackerSecretLocator: files.token, agentSecretId: 'agent-secret',
        agentSecretLocator: files.token}]};
      if (sql.startsWith('select slug from projects')) return {rowCount: 1, rows: [{slug: 'ascon'}]};
      return {rowCount: 0, rows: []};
    });
    const clientQuery = vi.fn(async (sql: string) => sql.includes("role='project_owner'")
      ? {rowCount: 1, rows: [{}]} : {rowCount: 1, rows: []});
    const database = {query, connect: vi.fn(async () => ({query: clientQuery, release: vi.fn()}))} as unknown as Database;
    await expect(ensureProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'ensure:1'})).resolves.toMatchObject({status: 'ready', profile: 'internal',
      endpointPath: '/p/internal/v1/runs'});
    expect(calls).toContain('GET /p/internal/v1/capabilities');
    expect(calls.filter((call) => call.startsWith('PUT '))).toEqual([]);
    expect(calls).not.toContain('POST /api/files/mkdir');
    expect(database.connect).not.toHaveBeenCalled();

    calls.length = 0;
    await expect(ensureProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'ensure:forced', force: true})).resolves.toMatchObject({
      status: 'ready', profile: 'internal', endpointPath: '/p/internal/v1/runs'
    });
    expect(calls).toContain('POST /api/files/mkdir');
    expect(calls).toContain('PUT /api/env?profile=internal');
    expect(calls).toContain('PUT /api/config?profile=internal');
    expect(calls).toContain('PUT /api/profiles/internal/soul');
    await rm(files.root, {recursive: true});
  });

  it('keeps an existing ready profile read-only and restarts only when unavailable', async () => {
    const files = await secretFiles();
    process.env.HERMES_MANAGEMENT_URL = 'http://hermes-management:9119';
    process.env.HERMES_MANAGEMENT_USERNAME_FILE = files.username;
    process.env.HERMES_MANAGEMENT_PASSWORD_FILE = files.password;
    process.env.HERMES_GATEWAY_INTERNAL_BASE_URL = 'http://hermes-gateway:8642';
    const calls: {request: string; body: string}[] = [];
    let probes = 0;
    vi.stubGlobal('fetch', vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(value));
      calls.push({request: `${init?.method ?? 'GET'} ${url.pathname}${url.search}`, body: String(init?.body ?? '')});
      if (url.pathname.endsWith('/v1/capabilities')) {
        probes += 1;
        return probes === 1 ? new Response('{}', {status: 401})
          : new Response(JSON.stringify({object: 'hermes.api_server.capabilities'}));
      }
      if (url.pathname === '/auth/password-login') return new Response('{}', {headers: {'set-cookie': 'session=ok; Path=/'}});
      if (url.pathname === '/api/profiles' && init?.method === undefined) {
        return new Response(JSON.stringify({profiles: [{name: 'internal'}]}));
      }
      return new Response('{}');
    }));
    const query = vi.fn(async (sql: string,parameters?:readonly unknown[]) => {
      if (sql.includes("s.kind like 'project_document_v1:%'")) return {rowCount: 2, rows: documentRows()};
      if(typeof parameters?.[2]==='string'&&parameters[2].startsWith('project_context_compact_v1:'))
        return {rowCount:1,rows:[{sha256:'a'.repeat(64),
        content:'approved compact context'}]};
      if (sql.includes("s.kind='project_agent_profile_v1'")) return {rowCount: 1, rows: [{sha256: 'version-1',
        content: JSON.stringify({contract: 'fai.project-agent-profile.v1', status: 'ready', profile: 'internal',
          endpointPath: '/p/internal/v1/runs',templateVersion:projectAgentProfileTemplateVersion,
          documentFingerprint})}]};
      if (sql.includes('tracker_secret.id as')) return {rowCount: 1, rows: [{workspaceId: 'workspace', projectId: 'project',
        requesterRole: 'project_owner', bindingId: 'binding', provider: 'github', externalProjectId: 'PVT_1',
        projectUrl: 'https://github.com/users/VF78/projects/1', repositoryId: 'R_1',
        repositoryUrl: 'https://github.com/VF78/control', cursor: null, trackerSecretId: 'tracker-secret',
        trackerSecretPurpose: 'tracker_read', trackerSecretLocator: files.token, agentSecretId: 'agent-secret',
        agentSecretLocator: files.token}]};
      if (sql.startsWith('select slug from projects')) return {rowCount: 1, rows: [{slug: 'ascon'}]};
      return {rowCount: 0, rows: []};
    });
    const clientQuery = vi.fn(async (sql: string) => sql.includes("role='project_owner'")
      ? {rowCount: 1, rows: [{}]} : {rowCount: 1, rows: []});
    const database = {query, connect: vi.fn(async () => ({query: clientQuery, release: vi.fn()}))} as unknown as Database;
    await expect(ensureProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'ensure:1'})).resolves.toMatchObject({status: 'ready', profile: 'internal'});
    const requests = calls.map(({request}) => request);
    expect(requests).toContain('POST /api/gateway/restart');
    expect(requests).not.toContain('POST /api/files/mkdir');
    expect(requests).not.toContain('PUT /api/env?profile=internal');
    expect(requests).not.toContain('POST /api/profiles');
    expect(requests).not.toContain('PUT /api/config?profile=internal');
    expect(requests).not.toContain('PUT /api/profiles/internal/soul');
    expect(requests).toContain('POST /api/gateway/restart');
    expect(probes).toBe(2);
    await rm(files.root, {recursive: true});
  });
});
