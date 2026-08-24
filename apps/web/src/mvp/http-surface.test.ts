import {describe, expect, it} from 'vitest';
import {mvpApiRoutes, mvpOAuthCallbackRoute, readiness} from './http-surface.ts';

describe('MVP HTTP surface contract', () => {
  it('contains exactly the approved 13 API routes, including explicit Hermes submission and routing policy', () => {
    expect(mvpApiRoutes).toHaveLength(13);
    expect(new Set(mvpApiRoutes).size).toBe(13);
    expect(mvpApiRoutes).toContain('/api/tasks/executor');
    expect(mvpApiRoutes).toContain('/api/projects/[projectId]/hermes-routing');
  });

  it('keeps OAuth callback outside the API route count', () => {
    expect(mvpOAuthCallbackRoute).toBe('/oauth/github/complete');
    expect(mvpApiRoutes).not.toContain(mvpOAuthCallbackRoute as never);
  });

  it.each([[true, true], [false, false]])('reports readiness for db=%s', (database, ready) => {
    expect(readiness({database}).ready).toBe(ready);
  });
});
