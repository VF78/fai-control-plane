import {describe, expect, it} from 'vitest';
import {projects} from './api.ts';

describe('projects HTTP boundary', () => {
  it('is a read-only endpoint and rejects creation before opening a session or database', async () => {
    const response = await projects(new Request('https://app.f-ai.studio/api/projects', {method: 'POST'}));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });
});
