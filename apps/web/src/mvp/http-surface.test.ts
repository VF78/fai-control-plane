import {describe, expect, it} from 'vitest';
import {mvpApiRoutes, mvpOAuthCallbackRoute, readiness} from './http-surface.ts';

describe('MVP HTTP surface contract', () => {
  it('contains exactly the approved 12 API routes, including explicit Hermes submission', () => {
    expect(mvpApiRoutes).toHaveLength(12);
    expect(new Set(mvpApiRoutes).size).toBe(12);
    expect(mvpApiRoutes).toContain('/api/tasks/executor');
  });

  it('keeps OAuth callback outside the API route count', () => {
    expect(mvpOAuthCallbackRoute).toBe('/oauth/github/complete');
    expect(mvpApiRoutes).not.toContain(mvpOAuthCallbackRoute as never);
  });

  it.each([[true, true], [false, false]])('reports readiness for db=%s', (database, ready) => {
    expect(readiness({database}).ready).toBe(ready);
  });
});
