import {describe, expect, it} from 'vitest';
import {mvpApiRoutes, mvpOAuthCallbackRoute, readiness} from './http-surface.ts';

describe('MVP HTTP surface contract', () => {
  it('contains exactly the approved 10 API routes', () => {
    expect(mvpApiRoutes).toHaveLength(10);
    expect(new Set(mvpApiRoutes).size).toBe(10);
  });

  it('keeps OAuth callback outside the API route count', () => {
    expect(mvpOAuthCallbackRoute).toBe('/oauth/github/complete');
    expect(mvpApiRoutes).not.toContain(mvpOAuthCallbackRoute as never);
  });

  it.each([[true, true], [false, false]])('reports readiness for db=%s', (database, ready) => {
    expect(readiness({database}).ready).toBe(ready);
  });
});
