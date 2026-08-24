import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {exclusiveRunner, workerActive, workerRetryIntervalMs, workerTrackerPollIntervalMs, workerReady} from './jobs.ts';
describe('worker readiness', () => {
  it('polls GitHub every five minutes and retries the local outbox promptly', () => {
    expect(workerTrackerPollIntervalMs).toBe(300_000);
    expect(workerRetryIntervalMs).toBe(10_000);
  });
  it('requires an exact activation gate', () => {
    expect(workerActive('false')).toBe(false);
    expect(workerActive('true')).toBe(true);
    expect(() => workerActive(undefined)).toThrow('FCP_WORKER_ACTIVE_required');
  });
  it('is ready only after both jobs succeed', () => expect(workerReady({lastReconcileAt: '2026-08-13T10:00:00Z',
    lastRetryAt: '2026-08-13T10:00:01Z', lastErrorAt: null}).ready).toBe(true));
  it('reports factual reconciliation and notification delivery separately', () => expect(workerReady({
    lastReconcileAt: '2026-08-13T10:00:00Z', lastRetryAt: '2026-08-13T10:00:01Z', lastErrorAt: null
  })).toMatchObject({ready: true, checks: {github: true, notifications: true}}));
  it('fails closed after a later cycle error', () => expect(workerReady({lastReconcileAt: '2026-08-13T10:00:00Z',
    lastRetryAt: '2026-08-13T10:00:01Z', lastErrorAt: '2026-08-13T10:00:02Z'}).ready).toBe(false));
  it('does not overlap worker cycles', async () => {
    let release!: () => void; let calls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = exclusiveRunner(async () => { calls += 1; await gate; });
    const first = run(); const second = run();
    expect(calls).toBe(1); release(); await Promise.all([first, second]); expect(calls).toBe(1);
  });
  it('records accepted terminal agent evidence before evaluating a QA status transition', () => {
    const source = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
    expect(source.indexOf('await reconcileActiveAgentAttempts')).toBeGreaterThan(-1);
    expect(source.indexOf('await reconcileActiveAgentAttempts')).toBeLessThan(source.indexOf('await reconcileTracker'));
    expect(source).toContain('readActiveProjectProcessPolicy(database, projectId)');
    expect(source).not.toContain("item.statusOptionName === 'QA'");
  });
});
