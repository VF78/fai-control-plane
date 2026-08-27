import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Database} from '@fai-control-plane/db';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {effectiveAgentRouting, githubRuntimeCoordinates, githubWebhookRepository, projects,
  pushChangedPaths, refreshGitHubContextSources, taskAssignableUsers, taskExecutor} from './api.ts';

afterEach(() => vi.restoreAllMocks());

describe('projects HTTP boundary', () => {
  it('rejects unauthenticated creation before calling a provider', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
    const response = await projects(new Request('https://app.f-ai.studio/api/projects', {method: 'POST'}));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('task executor HTTP boundary', () => {
  it('exposes only GET candidates and POST assignment', async () => {
    await expect(taskAssignableUsers(new Request('https://app.f-ai.studio/api/tasks/executor', {method: 'POST'}))).resolves.toMatchObject({status: 405});
    await expect(taskExecutor(new Request('https://app.f-ai.studio/api/tasks/executor', {method: 'GET'}))).resolves.toMatchObject({status: 405});
  });

  it('uses the canonical base routing policy when a project has no saved override', () => {
    expect(effectiveAgentRouting(null)).toEqual({
      policy: defaultAgentRoutingPolicy,
      version: createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex')
    });
  });
});

describe('project context push selection', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const base = {after:'a'.repeat(40),ref:'refs/heads/main',repository:{full_name:'VF78/ascon'},
    commits:[{added:[],modified:['AGENTS.md'],removed:[]}]};

  it('accepts only canonical paths from the configured repository default branch', () => {
    expect(pushChangedPaths(bytes(base),{repository:'VF78/ascon',branch:'main'})).toEqual({
      after:'a'.repeat(40),paths:['AGENTS.md'],removed:[]
    });
    expect(pushChangedPaths(bytes({...base,ref:'refs/heads/feature'}),{repository:'VF78/ascon',branch:'main'})).toBeNull();
    expect(pushChangedPaths(bytes({...base,repository:{full_name:'VF78/other'}}),
      {repository:'VF78/ascon',branch:'main'})).toBeNull();
  });

  it('separates deleted canonical files so their prior context cannot remain current', () => {
    expect(pushChangedPaths(bytes({...base,commits:[{added:[],modified:[],removed:['AGENTS.md']}]}),
      {repository:'VF78/ascon',branch:'main'})).toEqual({after:'a'.repeat(40),paths:[],removed:['AGENTS.md']});
  });

  it('keeps two repository and Project bindings exact', () => {
    const first = {provider:'github',projectUrl:'https://github.com/users/VF78/projects/1',
      repositoryUrl:'https://github.com/VF78/control'};
    const second = {provider:'github',projectUrl:'https://github.com/users/VF78/projects/4',
      repositoryUrl:'https://github.com/VF78/ascon'};
    expect(githubRuntimeCoordinates(first)).toEqual({owner:'VF78',repository:'control',projectNumber:1});
    expect(githubRuntimeCoordinates(second)).toEqual({owner:'VF78',repository:'ascon',projectNumber:4});
    expect(githubWebhookRepository(bytes(base))).toBe('VF78/ascon');
  });

  it('refreshes only the repository selected by the canonical runtime binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fai-webhook-binding-'));
    const token = join(root, 'tracker-token');
    await writeFile(token, 'github-token');
    const fetch = vi.fn(async (...arguments_: [string | URL | Request]) => {
      void arguments_;
      return new Response(JSON.stringify({type:'file',encoding:'base64',
        content:Buffer.from('Project A instructions').toString('base64')}));
    });
    vi.stubGlobal('fetch', fetch);
    const query = vi.fn(async (...arguments_: [sql: string, parameters?: readonly unknown[]]) => {
      void arguments_;
      return {rowCount:1,rows:[{id:'artifact-a'}]};
    });
    await refreshGitHubContextSources({query} as unknown as Database, {projectId:'project-a',actorId:'owner-a',
      owner:'VF78',repository:'control',credentialRef:{id:'tracker-a',purpose:'tracker_read',locator:token},
      after:'a'.repeat(40),paths:['AGENTS.md']});
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/repos/VF78/control/contents/AGENTS.md'),
      expect.any(Object));
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/repos/VF78/ascon/'), expect.any(Object));
    expect(query.mock.calls[0]![1]).toEqual(expect.arrayContaining(['project-a','owner-a']));
    await rm(root,{recursive:true});
  });

  it('records an optional missing repository document as removed instead of failing refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fai-webhook-optional-'));
    const token = join(root, 'tracker-token'); await writeFile(token, 'github-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}',{status:404})));
    const query = vi.fn(async (...arguments_: [sql: string, parameters?: readonly unknown[]]) => {
      void arguments_; return {rowCount:1,rows:[{id:'artifact-removed'}]};
    });
    await expect(refreshGitHubContextSources({query} as unknown as Database,{projectId:'project-a',actorId:'owner-a',
      owner:'VF78',repository:'ascon',credentialRef:{id:'tracker-a',purpose:'tracker_read',locator:token},
      after:'a'.repeat(40),paths:['docs/project-passport.md']})).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      'project-a','owner-a','repo:passport',expect.stringContaining('Source removed')
    ]));
    await rm(root,{recursive:true});
  });

  it('uses the first available passport path without recording missing alternatives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fai-webhook-passport-'));
    const token = join(root, 'tracker-token'); await writeFile(token, 'github-token');
    const fetch = vi.fn(async (value: string | URL | Request) => String(value).includes('project-passport.md')
      ? new Response('{}',{status:404})
      : new Response(JSON.stringify({type:'file',encoding:'base64',
        content:Buffer.from('Canonical passport').toString('base64')})));
    vi.stubGlobal('fetch', fetch);
    const query = vi.fn(async () => ({rowCount:1,rows:[{id:'artifact-passport'}]}));
    await expect(refreshGitHubContextSources({query} as unknown as Database,{projectId:'project-a',actorId:'owner-a',
      owner:'VF78',repository:'ascon',credentialRef:{id:'tracker-a',purpose:'tracker_read',locator:token},
      after:'a'.repeat(40),paths:['docs/project-passport.md','docs/product-passport.md','PROJECT.md'],
      requiredKeys:['repo:passport']})).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledOnce();
    expect(JSON.stringify(query.mock.calls)).toContain('Canonical passport');
    expect(JSON.stringify(query.mock.calls)).not.toContain('Source removed');
    await rm(root,{recursive:true});
  });
});
