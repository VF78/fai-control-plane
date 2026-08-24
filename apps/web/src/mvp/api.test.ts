import {describe, expect, it} from 'vitest';
import {projects, pushChangedPaths, taskAssignableUsers, taskExecutor} from './api.ts';

describe('projects HTTP boundary', () => {
  it('is a read-only endpoint and rejects creation before opening a session or database', async () => {
    const response = await projects(new Request('https://app.f-ai.studio/api/projects', {method: 'POST'}));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });
});

describe('task executor HTTP boundary', () => {
  it('exposes only GET candidates and POST assignment', async () => {
    await expect(taskAssignableUsers(new Request('https://app.f-ai.studio/api/tasks/executor', {method: 'POST'}))).resolves.toMatchObject({status: 405});
    await expect(taskExecutor(new Request('https://app.f-ai.studio/api/tasks/executor', {method: 'GET'}))).resolves.toMatchObject({status: 405});
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
});
