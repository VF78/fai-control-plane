import {describe, expect, it} from 'vitest';
import {projects, taskAssignableUsers, taskExecutor} from './api.ts';

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
