import {describe, expect, it} from 'vitest';
import {mvpApiRoutes, mvpOAuthCallbackRoute, readiness} from './http-surface.ts';

describe('MVP HTTP surface contract', () => {
  it('contains exactly the approved 19 API routes, including persisted wizard decisions', () => {
    expect(mvpApiRoutes).toHaveLength(19);
    expect(new Set(mvpApiRoutes).size).toBe(19);
    expect(mvpApiRoutes).toContain('/api/tasks/executor');
    expect(mvpApiRoutes).toContain('/api/projects/[projectId]/runtime');
    expect(mvpApiRoutes).toContain('/api/projects/[projectId]/tracker-preparation');
    expect(mvpApiRoutes).toContain('/api/projects/[projectId]/wizard-progress');
    expect(mvpApiRoutes).toContain('/api/projects/[projectId]/agent-routing');
    expect(mvpApiRoutes).toContain('/api/projects/[projectId]/context/refresh');
    expect(mvpApiRoutes).toContain('/api/projects/[projectId]/execution-mode');
  });

  it('keeps OAuth callback outside the API route count', () => {
    expect(mvpOAuthCallbackRoute).toBe('/oauth/github/complete');
    expect(mvpApiRoutes).not.toContain(mvpOAuthCallbackRoute as never);
  });

  it.each([[true, true], [false, false]])('reports readiness for db=%s', (database, ready) => {
    expect(readiness({database}).ready).toBe(ready);
  });
});
