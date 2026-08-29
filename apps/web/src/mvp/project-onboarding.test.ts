import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Database} from '@fai-control-plane/db';
import {projectAgentProfileTemplateVersion,projectHermesSecretPurpose,
  readProjectHermesRuntimeBinding,type ProjectHermesSecretKind} from '@fai-control-plane/db';
import {activateProjectAgentProfile, ensureProjectAgentProfile, resolveAndRegisterProject} from './project-onboarding.ts';

const environments = ['GITHUB_PROJECTS_TOKEN_FILE'] as const;
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
  const tracker = join(root, 'tracker'); const agent = join(root, 'agent'); const username = join(root, 'username');
  const password = join(root, 'password'); const telegram = join(root, 'telegram'); const inbound = join(root, 'inbound');
  await Promise.all([writeFile(tracker, 'tracker-secret'),writeFile(agent, 'agent-secret'),
    writeFile(username, 'operator'), writeFile(password, 'password'),writeFile(telegram,'telegram-secret'),
    writeFile(inbound,'inbound-secret')]);
  return {root, tracker, agent, username, password, telegram, inbound};
};
const projectId='project';const runtimeId='control';
const runtimeSecretIds={
  'agent-delivery':'00000000-0000-4000-8100-000000000001',
  'management-username':'00000000-0000-4000-8100-000000000002',
  'management-password':'00000000-0000-4000-8100-000000000003',
  'telegram-bot':'00000000-0000-4000-8100-000000000004',
  'inbound-actions':'00000000-0000-4000-8100-000000000005'} as const;
const runtimeKinds=Object.keys(runtimeSecretIds) as ProjectHermesSecretKind[];
const runtimeArtifact=JSON.stringify({contract:'fai.project-hermes-runtime.v1',status:'ready',runtimeId,
  gatewayEndpoint:'http://control-gateway:8642/v1/runs',managementEndpoint:'http://control-management:9119/',
  workspacePath:'/opt/hermes/control',telegram:{chatId:'-1001',allowedUserIds:['42']},secretRefs:{
    agentDelivery:runtimeSecretIds['agent-delivery'],managementUsername:runtimeSecretIds['management-username'],
    managementPassword:runtimeSecretIds['management-password'],telegramBot:runtimeSecretIds['telegram-bot'],
    inboundActions:runtimeSecretIds['inbound-actions']}});
const runtimeQuery=(sql:string,files:Awaited<ReturnType<typeof secretFiles>>) => {
  if(sql.includes('runtime.sha256'))return {rowCount:1,rows:[{workspaceId:'workspace',projectId,slug:'control',
    artifactVersion:'r'.repeat(64),content:runtimeArtifact}]};
  if(sql.includes('select p.workspace_id as "workspaceId"')&&!sql.includes('tracker_secret.id as'))
    return {rowCount:1,rows:[{workspaceId:'workspace'}]};
  if(sql.includes('from secret_refs')&&sql.includes('id=any')){const locators:Record<ProjectHermesSecretKind,string>={
    'agent-delivery':files.agent,'management-username':files.username,'management-password':files.password,
    'telegram-bot':files.telegram,'inbound-actions':files.inbound};
    return {rowCount:5,rows:runtimeKinds.map((kind)=>({id:runtimeSecretIds[kind],
      purpose:projectHermesSecretPurpose(projectId,kind),locator:locators[kind]}))};}
  return null;
};
const documentRows=()=>['requirements','passport'].map((category,index)=>({id:`document-${index}`,projectId:'project',
  kind:`project_document_v1:${category}`,name:`${category}.txt`,mediaType:'text/plain',sha256:String(index+1).repeat(64),
  sizeBytes:10,provenance:'operator-upload',createdAt:new Date('2026-08-27T10:00:00Z')}));
const documentFingerprint=createHash('sha256').update(documentRows().slice().sort((a,b)=>
  a.kind.localeCompare(b.kind)).map(({kind,sha256})=>`${kind}:${sha256}`).join('\n')).digest('hex');

describe('project onboarding composition', () => {
  it('registers before authoritative documents exist without reading repository documents', async () => {
    const files = await secretFiles(); process.env.GITHUB_PROJECTS_TOKEN_FILE = files.tracker;
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
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('insert into project_source_artifacts'))).toHaveLength(2);
    await rm(files.root, {recursive: true});
  });

  it('never records readiness when the native capabilities probe is not authenticated', async () => {
    const files = await secretFiles();
    vi.useFakeTimers({toFake: ['setTimeout']});
    const calls: string[] = [];
    let firstProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => { firstProbe = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(value)); calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (url.pathname === '/auth/password-login') return new Response('{}', {headers: {'set-cookie': 'session=ok; Path=/'}});
      if (url.pathname.endsWith('/v1/capabilities')) {
        firstProbe();
        return new Response('{}', {status: 401});
      }
      return new Response('{}');
    }));
    const query = vi.fn(async (sql: string) => {
      const runtime=runtimeQuery(sql,files);if(runtime!==null)return runtime;
      if (sql.includes("s.kind='project_agent_profile_v1'")) return {rowCount: 0, rows: []};
      if (sql.includes("s.kind like 'project_document_v1:%'")) return {rowCount: 2, rows: documentRows()};
      if (sql.includes('tracker_secret.id as')) return {rowCount: 1, rows: [{workspaceId: 'workspace', projectId: 'project',
        requesterRole: 'project_owner', bindingId: 'binding', provider: 'github', externalProjectId: 'PVT_1',
        projectUrl: 'https://github.com/users/VF78/projects/1', repositoryId: 'R_1',
        repositoryUrl: 'https://github.com/VF78/control', cursor: null, trackerSecretId: 'tracker-secret',
        trackerSecretPurpose: 'tracker_read', trackerSecretLocator: files.tracker}]};
      if (sql.startsWith('select slug from projects')) return {rowCount: 1, rows: [{slug: 'control'}]};
      return {rowCount: 0, rows: []};
    });
    const database = {query, connect: vi.fn()} as unknown as Database;
    const activation = activateProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'activate:1'});
    const rejection = activation.catch((error:unknown)=>error);
    await probeStarted;
    await vi.runAllTimersAsync();
    await expect(rejection).resolves.toMatchObject({message:'agent_profile_probe_failed'});
    expect(database.connect).not.toHaveBeenCalled();
    expect(calls.some((call)=>call.includes('/api/profiles')||call.includes('?profile='))).toBe(false);
    expect(calls.filter((call) => call.endsWith('/v1/capabilities'))).toHaveLength(13);
    await rm(files.root, {recursive: true});
  });

  it('persists readiness only after the ordered native activation contract succeeds', async () => {
    const files = await secretFiles();
    const calls: {request: string; body: string}[] = [];
    vi.stubGlobal('fetch', vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(value));
      calls.push({request: `${init?.method ?? 'GET'} ${url.pathname}${url.search}`, body: String(init?.body ?? '')});
      if (url.pathname === '/auth/password-login') return new Response('{}', {headers: {'set-cookie': 'session=ok; Path=/'}});
      if (url.pathname.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({object: 'hermes.api_server.capabilities'}));
      }
      if(url.pathname.endsWith('/v1/runs')&&init?.method==='POST')
        return new Response(JSON.stringify({run_id:'run_context_1',status:'started'}),{status:202});
      return new Response('{}');
    }));
    const query = vi.fn(async (sql: string) => {
      const runtime=runtimeQuery(sql,files);if(runtime!==null)return runtime;
      if (sql.includes("s.kind='project_agent_profile_v1'")) return {rowCount: 0, rows: []};
      if(sql.includes('s.content_bytes as bytes'))return {rowCount:1,rows:[{name:'source.txt',mediaType:'text/plain',
        bytes:Buffer.from('exact source')}]};
      if (sql.includes("s.kind like 'project_document_v1:%'")) return {rowCount: 2, rows: documentRows()};
      if (sql.includes('tracker_secret.id as')) return {rowCount: 1, rows: [{workspaceId: 'workspace', projectId: 'project',
        requesterRole: 'project_owner', bindingId: 'binding', provider: 'github', externalProjectId: 'PVT_1',
        projectUrl: 'https://github.com/users/VF78/projects/1', repositoryId: 'R_1',
        repositoryUrl: 'https://github.com/VF78/control', cursor: null, trackerSecretId: 'tracker-secret',
        trackerSecretPurpose: 'tracker_read', trackerSecretLocator: files.tracker}]};
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
    await expect(readProjectHermesRuntimeBinding(database,'actor','project')).resolves.toMatchObject({runtimeId:'control'});
    await expect(activateProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'activate:1'})).resolves.toMatchObject({status: 'configuring', profile: 'control'});
    const ordered = calls.map(({request}) => request);
    const positions = [
      'POST /auth/password-login', 'GET /v1/capabilities', 'DELETE /api/files?path=%2Fopt%2Fhermes%2Fcontrol%2F.fai-context%2Fsource&recursive=true',
      'POST /api/files/mkdir', 'POST /v1/runs'
    ].map((request) => ordered.indexOf(request));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(ordered.some((request)=>request.includes('/api/profiles')||request.includes('?profile='))).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain('agent-secret');
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("'project.context-bootstrap.start'"), expect.any(Array));
    await rm(files.root, {recursive: true});
  });

  it('keeps a configured runtime stable and restores compact context only on explicit refresh', async () => {
    const files = await secretFiles();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(value));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (url.pathname === '/auth/password-login') return new Response('{}', {headers: {'set-cookie': 'session=ok; Path=/'}});
      return new Response(JSON.stringify({object: 'hermes.api_server.capabilities'}));
    }));
    const query = vi.fn(async (sql: string,parameters?:readonly unknown[]) => {
      const runtime=runtimeQuery(sql,files);if(runtime!==null)return runtime;
      if(typeof parameters?.[2]==='string'&&parameters[2].startsWith('project_context_compact_v1:'))
        return {rowCount:1,rows:[{sha256:'a'.repeat(64),
        content:'approved compact context'}]};
      if (sql.includes("s.kind like 'project_document_v1:%'")) return {rowCount: 2, rows: documentRows()};
      if (sql.includes("s.kind='project_agent_profile_v1'")) return {rowCount: 1, rows: [{sha256: 'version-1',
        content: JSON.stringify({contract: 'fai.project-agent-profile.v1', status: 'ready', profile: 'control',
          endpointPath: '/v1/runs', templateVersion: projectAgentProfileTemplateVersion,
          documentFingerprint})}]};
      if (sql.includes('tracker_secret.id as')) return {rowCount: 1, rows: [{workspaceId: 'workspace',
        projectId: 'project', requesterRole: 'project_owner', bindingId: 'binding', provider: 'github',
        externalProjectId: 'PVT_1', projectUrl: 'https://github.com/users/VF78/projects/1', repositoryId: 'R_1',
        repositoryUrl: 'https://github.com/VF78/control', cursor: null, trackerSecretId: 'tracker-secret',
        trackerSecretPurpose: 'tracker_read', trackerSecretLocator: files.tracker}]};
      if (sql.startsWith('select slug from projects')) return {rowCount: 1, rows: [{slug: 'control'}]};
      return {rowCount: 0, rows: []};
    });
    const clientQuery = vi.fn(async (sql: string) => sql.includes("role='project_owner'")
      ? {rowCount: 1, rows: [{}]} : {rowCount: 1, rows: []});
    const database = {query, connect: vi.fn(async () => ({query: clientQuery, release: vi.fn()}))} as unknown as Database;
    await expect(ensureProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'ensure:1'})).resolves.toMatchObject({status: 'ready', profile: 'control',
      endpointPath: '/v1/runs'});
    expect(calls).toContain('GET /v1/capabilities');
    expect(calls.filter((call) => call.startsWith('PUT '))).toEqual([]);
    expect(calls).not.toContain('POST /api/files/mkdir');
    expect(database.connect).not.toHaveBeenCalled();

    calls.length = 0;
    await expect(ensureProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'ensure:forced', force: true})).resolves.toMatchObject({
      status: 'ready', profile: 'control', endpointPath: '/v1/runs'
    });
    expect(calls).toContain('POST /api/files/upload-stream');
    expect(calls.some((call)=>call.includes('/api/profiles')||call.includes('?profile='))).toBe(false);
    await rm(files.root, {recursive: true});
  });

  it('keeps an existing ready runtime read-only and restarts only when unavailable', async () => {
    const files = await secretFiles();
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
      return new Response('{}');
    }));
    const query = vi.fn(async (sql: string,parameters?:readonly unknown[]) => {
      const runtime=runtimeQuery(sql,files);if(runtime!==null)return runtime;
      if (sql.includes("s.kind like 'project_document_v1:%'")) return {rowCount: 2, rows: documentRows()};
      if(typeof parameters?.[2]==='string'&&parameters[2].startsWith('project_context_compact_v1:'))
        return {rowCount:1,rows:[{sha256:'a'.repeat(64),
        content:'approved compact context'}]};
      if (sql.includes("s.kind='project_agent_profile_v1'")) return {rowCount: 1, rows: [{sha256: 'version-1',
        content: JSON.stringify({contract: 'fai.project-agent-profile.v1', status: 'ready', profile: 'control',
          endpointPath: '/v1/runs',templateVersion:projectAgentProfileTemplateVersion,
          documentFingerprint})}]};
      if (sql.includes('tracker_secret.id as')) return {rowCount: 1, rows: [{workspaceId: 'workspace', projectId: 'project',
        requesterRole: 'project_owner', bindingId: 'binding', provider: 'github', externalProjectId: 'PVT_1',
        projectUrl: 'https://github.com/users/VF78/projects/1', repositoryId: 'R_1',
        repositoryUrl: 'https://github.com/VF78/control', cursor: null, trackerSecretId: 'tracker-secret',
        trackerSecretPurpose: 'tracker_read', trackerSecretLocator: files.tracker}]};
      if (sql.startsWith('select slug from projects')) return {rowCount: 1, rows: [{slug: 'control'}]};
      return {rowCount: 0, rows: []};
    });
    const clientQuery = vi.fn(async (sql: string) => sql.includes("role='project_owner'")
      ? {rowCount: 1, rows: [{}]} : {rowCount: 1, rows: []});
    const database = {query, connect: vi.fn(async () => ({query: clientQuery, release: vi.fn()}))} as unknown as Database;
    await expect(ensureProjectAgentProfile(database, {workspaceId: 'workspace', actorId: 'actor',
      projectId: 'project', idempotencyKey: 'ensure:1'})).resolves.toMatchObject({status: 'ready', profile: 'control'});
    const requests = calls.map(({request}) => request);
    expect(requests).toContain('POST /api/gateway/restart');
    expect(requests).not.toContain('POST /api/files/mkdir');
    expect(requests.some((request)=>request.includes('/api/profiles')||request.includes('?profile='))).toBe(false);
    expect(requests).toContain('POST /api/gateway/restart');
    expect(probes).toBe(2);
    await rm(files.root, {recursive: true});
  });
});
