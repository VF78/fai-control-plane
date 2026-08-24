import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {defaultHermesRoutingPolicy, trackerPollIntervalMs, trackerStaleAfterMs} from '@fai-control-plane/domain';
import {projectAgentDeliveryConfigured, readHermesRoutingPolicy, resolveReceiptBoundRoleRun, trackerSnapshotFreshness, type Database} from './runtime.ts';

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

describe('versioned Hermes routing projection', () => {
  it('reads the latest valid immutable source artifact with provenance', async () => {
    const contentText = JSON.stringify(defaultHermesRoutingPolicy);
    const query = vi.fn().mockResolvedValue({rows: [{id: 'version-id', projectId: 'project',
      sha256: createHash('sha256').update(contentText).digest('hex'), provenance: 'control-plane:command',
      createdAt: new Date('2026-08-24T10:00:00.000Z'), contentText}]});
    await expect(readHermesRoutingPolicy({query} as unknown as Database, 'owner', 'project')).resolves.toMatchObject({
      id: 'version-id', provenance: 'control-plane:command', policy: defaultHermesRoutingPolicy
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("s.kind='hermes_routing_policy_v1'"), ['owner', 'project']);
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
    expect(source).toContain("insert into outbox_events(project_id,topic,idempotency_key,payload,available_at)");
    expect(source).toContain("values($1,'messenger-notification',$2,$3,$4)");
  });
});

describe('receipt-bound role-run projection', () => {
  it('derives the exact submit key and returns only one active operator receipt/audit match', async () => {
    const query = vi.fn().mockResolvedValue({rows: [{actorId: 'actor', projectId: 'project',
      requesterRole: 'operator', role: 'developer', itemId: 'PVTI_1', observedVersion: 'v1',
      occurredAt: new Date('2026-08-24T10:00:00.000Z')}]});
    const sessionId = `browser:${'a'.repeat(64)}`;
    await expect(resolveReceiptBoundRoleRun({query} as unknown as Database, sessionId, 'project'))
      .resolves.toMatchObject({sessionId, actorId: 'actor', role: 'developer', itemId: 'PVTI_1'});
    expect(query).toHaveBeenCalledWith(expect.stringContaining("r.command_type='agent.submit'"),
      [sessionId, 'project', `agent.submit:${'a'.repeat(64)}`]);
  });

  it('fails closed for malformed ids, duplicate matches, clients, or malformed receipt details', async () => {
    const query = vi.fn();
    await expect(resolveReceiptBoundRoleRun({query} as unknown as Database, 'browser:nope', 'project'))
      .resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
    for (const rows of [
      [{actorId: 'a'}, {actorId: 'b'}],
      [{actorId: 'a', projectId: 'project', requesterRole: 'client', role: 'developer', itemId: 'item',
        observedVersion: 'v1', occurredAt: new Date()}],
      [{actorId: 'a', projectId: 'project', requesterRole: 'operator', role: 'devops', itemId: 'item',
        observedVersion: 'v1', occurredAt: new Date()}]
    ]) {
      query.mockResolvedValueOnce({rows});
      await expect(resolveReceiptBoundRoleRun({query} as unknown as Database, `browser:${'a'.repeat(64)}`, 'project'))
        .resolves.toBeNull();
    }
  });
});
