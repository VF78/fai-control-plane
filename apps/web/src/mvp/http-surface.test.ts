import {describe, expect, it} from 'vitest';
import {mvpApiRoutes, mvpOAuthCallbackRoute, readiness} from './http-surface.ts';

describe('MVP HTTP surface contract', () => {
  it('contains exactly the approved 15 API routes, including context refresh and agent routing', () => {
    expect(mvpApiRoutes).toHaveLength(15);
    expect(new Set(mvpApiRoutes).size).toBe(15);
    expect(mvpApiRoutes).toContain('/api/tasks/executor');
    expect(mvpApiRoutes).toContain('/api/projects/[projectId]/agent-routing');
    expect(mvpApiRoutes).toContain('/api/projects/[projectId]/context/refresh');
  });

  it('keeps OAuth callback outside the API route count', () => {
    expect(mvpOAuthCallbackRoute).toBe('/oauth/github/complete');
    expect(mvpApiRoutes).not.toContain(mvpOAuthCallbackRoute as never);
  });

  it.each([[true, true], [false, false]])('reports readiness for db=%s', (database, ready) => {
    expect(readiness({database}).ready).toBe(ready);
  });
});
