import {describe, expect, it, vi} from 'vitest';
import {trackerPollIntervalMs, trackerStaleAfterMs} from '@fai-control-plane/domain';
import {projectAgentDeliveryConfigured, trackerSnapshotFreshness, type Database} from './runtime.ts';

describe('tracker snapshot freshness', () => {
  const observedAt = new Date('2026-08-23T10:00:00.000Z');

  it('uses five-minute polls and three missed cycles as the stale boundary', () => {
    expect(trackerPollIntervalMs).toBe(300_000);
    expect(trackerStaleAfterMs).toBe(900_000);
    expect(trackerSnapshotFreshness(observedAt, new Date(observedAt.getTime() + trackerStaleAfterMs))).toBe('fresh');
    expect(trackerSnapshotFreshness(observedAt, new Date(observedAt.getTime() + trackerStaleAfterMs + 1))).toBe('stale');
  });

  it('reports unavailable before the first successful observation', () => {
    expect(trackerSnapshotFreshness(null, observedAt)).toBe('unavailable');
  });
});

describe('agent delivery readiness', () => {
  it('uses the authorized project DB projection without exposing the secret locator', async () => {
    const query = vi.fn().mockResolvedValue({rows: [{configured: true}]});
    await expect(projectAgentDeliveryConfigured({query} as unknown as Database, 'actor', 'project')).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("s.purpose='agent_delivery'"), ['actor', 'project']);
  });

  it('fails closed when no canonical reference is visible', async () => {
    const query = vi.fn().mockResolvedValue({rows: [{configured: false}]});
    await expect(projectAgentDeliveryConfigured({query} as unknown as Database, 'actor', 'project')).resolves.toBe(false);
  });
});

describe('agent submission evidence projection', () => {
  it('keeps task and delivery references in the same bounded DB projection', async () => {
    const source = await import('node:fs/promises').then(({readFile}) => readFile(new URL('./runtime.ts', import.meta.url), 'utf8'));
    expect(source).toContain("a.action='agent.submit'");
    expect(source).toContain("r.command_type='agent.submit'");
    expect(source).toContain('a.target_reference as "targetReference"');
    expect(source).toContain('r.result_reference as "deliveryReference"');
    expect(source).toContain('r.occurred_at=a.occurred_at');
  });
});
