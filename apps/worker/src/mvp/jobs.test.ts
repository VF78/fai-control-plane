import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {exclusiveRunner, workerActive, workerAgentObserveIntervalMs, workerRetryIntervalMs,
  workerTrackerPollIntervalMs, workerReady} from './jobs.ts';
describe('worker readiness', () => {
  it('polls GitHub every five minutes, Hermes every minute, and retries the local outbox promptly', () => {
    expect(workerTrackerPollIntervalMs).toBe(300_000);
    expect(workerAgentObserveIntervalMs).toBe(60_000);
    expect(workerRetryIntervalMs).toBe(10_000);
  });
  it('requires an exact activation gate', () => {
    expect(workerActive('false')).toBe(false);
    expect(workerActive('true')).toBe(true);
    expect(() => workerActive(undefined)).toThrow('FCP_WORKER_ACTIVE_required');
  });
  it('is ready only after all jobs succeed', () => expect(workerReady({lastReconcileAt: '2026-08-13T10:00:00Z',
    lastObserveAt: '2026-08-13T10:00:00Z',
    lastRetryAt: '2026-08-13T10:00:01Z', lastErrorAt: null}).ready).toBe(true));
  it('reports factual reconciliation and notification delivery separately', () => expect(workerReady({
    lastReconcileAt: '2026-08-13T10:00:00Z', lastObserveAt: '2026-08-13T10:00:00Z',
    lastRetryAt: '2026-08-13T10:00:01Z', lastErrorAt: null
  })).toMatchObject({ready: true, checks: {github: true, agents: true, notifications: true}}));
  it('fails closed after a later cycle error', () => expect(workerReady({lastReconcileAt: '2026-08-13T10:00:00Z',
    lastObserveAt: '2026-08-13T10:00:00Z', lastRetryAt: '2026-08-13T10:00:01Z',
    lastErrorAt: '2026-08-13T10:00:02Z'}).ready).toBe(false));
  it('does not overlap worker cycles', async () => {
    let release!: () => void; let calls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = exclusiveRunner(async () => { calls += 1; await gate; });
    const first = run(); const second = run();
    expect(calls).toBe(1); release(); await Promise.all([first, second]); expect(calls).toBe(1);
  });
  it('observes terminal agent evidence outside the five-minute GitHub repair pass', () => {
    const source = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
    expect(source.indexOf('await reconcileActiveAgentAttempts')).toBeGreaterThan(-1);
    const reconcile = source.split('async reconcile()', 2)[1]!;
    expect(reconcile).not.toContain('reconcileActiveAgentAttempts');
    expect(source).toContain('tracker: trackerMutation');
    expect(source).toContain('readActiveProjectProcessPolicy(database, projectId)');
    expect(source).toContain("env('BOOTSTRAP_REPOSITORY_ID')");
    expect(source).not.toContain('GITHUB_REPOSITORY_ID');
    expect(source).not.toContain("item.statusOptionName === 'QA'");
  });
});
