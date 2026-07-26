import {createHash} from 'node:crypto';
import {expect, it} from 'vitest';
import {
  createProjectShareService,
  type CreateProjectShareGrantInput,
  type ProjectShareGrant,
  type ProjectShareStore
} from './project-share';

const now = new Date('2026-07-26T12:00:00.000Z');
const token = 'v'.repeat(43);
const tokenHash = createHash('sha256').update(token).digest('hex');
const scopedWorkItemId = '00000000-0000-4000-8000-000000000004';
const unscopedWorkItemId = '00000000-0000-4000-8000-000000000005';

it('creates a hash-only grant and exposes only the allowlist for valid shares', async () => {
  let created: CreateProjectShareGrantInput | undefined;
  let grant: ProjectShareGrant | null = null;
  let accessCount = 0;
  const availableItems = new Map([
    [scopedWorkItemId, {
      title: 'Client-ready task',
      status: 'acceptance',
      summary: 'Ready for review.',
      updatedAt: new Date('2026-07-26T11:00:00.000Z'),
      repositoryUrl: 'https://example.invalid/private',
      branch: 'secret-branch',
      actor: 'internal-user',
      logs: 'private logs'
    }],
    [unscopedWorkItemId, {
      title: 'Unscoped internal task',
      status: 'in_dev',
      summary: 'Must never be shared.',
      updatedAt: new Date('2026-07-26T11:30:00.000Z')
    }]
  ]);
  const store: ProjectShareStore = {
    createGrant: async (input) => {
      created = input;
      return true;
    },
    revokeGrant: async () => true,
    findGrantByTokenHash: async (candidateHash) => {
      if (grant?.tokenHash !== candidateHash) return null;
      return {
        ...grant,
        items: (created?.workItemIds ?? []).flatMap((id) => {
          const item = availableItems.get(id);
          return item === undefined ? [] : [item];
        })
      };
    },
    recordAccessIfActive: async () => {
      accessCount += 1;
      return true;
    }
  };
  const service = createProjectShareService({
    store,
    clock: {now: () => now},
    idGenerator: {next: () => '00000000-0000-4000-8000-000000000007'},
    tokenGenerator: () => token
  });
  const createInput = {
    workspaceId: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    createdByActorId: '00000000-0000-4000-8000-000000000003',
    workItemIds: [scopedWorkItemId],
    expiresAt: new Date('2026-07-27T12:00:00.000Z'),
    commandId: 'share-create-1',
    correlationId: 'share-correlation-1'
  } as const;
  const issued = await service.create(createInput);
  expect(issued.token).toBe(token);
  expect(created?.tokenHash).toBe(tokenHash);
  expect(created?.workItemIds).toEqual([scopedWorkItemId]);
  expect(JSON.stringify(created)).not.toContain(token);

  for (const invalidScope of [
    [],
    ['not-a-uuid'],
    [scopedWorkItemId, scopedWorkItemId]
  ]) {
    await expect(service.create({
      ...createInput,
      workItemIds: invalidScope
    })).rejects.toThrow('project_share_scope_invalid');
  }

  const cases = [
    {
      name: 'valid',
      value: {
        id: issued.shareId,
        tokenHash,
        expiresAt: issued.expiresAt,
        revokedAt: null,
        items: []
      },
      suppliedToken: token,
      valid: true
    },
    {
      name: 'expired',
      value: {
        id: issued.shareId,
        tokenHash,
        expiresAt: now,
        revokedAt: null,
        items: []
      },
      suppliedToken: token,
      valid: false
    },
    {
      name: 'revoked',
      value: {
        id: issued.shareId,
        tokenHash,
        expiresAt: issued.expiresAt,
        revokedAt: new Date('2026-07-26T11:30:00.000Z'),
        items: []
      },
      suppliedToken: token,
      valid: false
    },
    {
      name: 'invalid',
      value: {
        id: issued.shareId,
        tokenHash,
        expiresAt: issued.expiresAt,
        revokedAt: null,
        items: []
      },
      suppliedToken: 'x'.repeat(43),
      valid: false
    }
  ] as const;

  for (const scenario of cases) {
    grant = scenario.value;
    const projection = await service.resolve(scenario.suppliedToken);
    if (!scenario.valid) {
      expect(projection, scenario.name).toBeNull();
      continue;
    }
    expect(projection).toEqual({
      items: [{
        publicTitle: 'Client-ready task',
        publicStatus: 'acceptance',
        publicSummary: 'Ready for review.',
        updatedTime: '2026-07-26T11:00:00.000Z'
      }]
    });
    expect(Object.keys(projection!.items[0]!).sort()).toEqual([
      'publicStatus',
      'publicSummary',
      'publicTitle',
      'updatedTime'
    ]);
    expect(JSON.stringify(projection)).not.toMatch(
      /repository|url|branch|actor|prompt|log|artifact|error|internal|secret/i
    );
    expect(JSON.stringify(projection)).not.toContain('Unscoped internal task');
  }
  expect(accessCount).toBe(1);
});
