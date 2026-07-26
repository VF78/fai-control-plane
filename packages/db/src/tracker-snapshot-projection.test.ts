import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {trackerSnapshotProjectionRequestHash} from './tracker-snapshot-projection';

const input = () => ({
  mode: 'bootstrap' as const,
  operationId: randomUUID(),
  workspaceId: randomUUID(),
  projectId: randomUUID(),
  actorId: randomUUID(),
  correlationId: 'correlation',
  provider: 'github',
  snapshot: {
    repository: {
      externalId: 'github:repository:1278325372',
      externalVersion: 'github:sha256:repository',
      owner: 'VF78',
      name: 'MSA'
    },
    externalVersion: 'github:sha256:snapshot',
    workItems: [],
    pullRequests: [],
    checks: []
  }
});

describe('tracker snapshot projection request hash', () => {
  it('is deterministic for the same provider snapshot', () => {
    const value = input();
    expect(trackerSnapshotProjectionRequestHash(value)).toBe(
      trackerSnapshotProjectionRequestHash(value)
    );
  });

  it('binds idempotency to immutable repository identity and snapshot version', () => {
    const value = input();
    expect(trackerSnapshotProjectionRequestHash(value)).not.toBe(
      trackerSnapshotProjectionRequestHash({
        ...value,
        snapshot: {...value.snapshot, externalVersion: 'github:sha256:new'}
      })
    );
  });
});
