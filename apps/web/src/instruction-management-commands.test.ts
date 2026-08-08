import {expect, it, vi} from 'vitest';
import {mutateInstructionVersionCommand} from './instruction-management-commands';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const versionId = '44444444-4444-4444-8444-444444444444';
const authorization = {
  ok: true as const, session: {actorId, csrfToken: 'csrf'},
  runtime: {config: {workspaceId}}, sessionToken: 'session'
};
const request = (values: Record<string, string>) => new Request('https://app.example/api/instructions/versions', {
  method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', referer: 'https://app.example/agents'},
  body: new URLSearchParams(values)
});
const base = {
  _csrf: 'csrf', action: 'publish', scope: 'agent_profile', targetId: profileId,
  expectedVersion: '2', instructions: 'Следовать протоколу.', rollbackOfVersionId: ''
};

it('publishes a version through the authenticated runtime', async () => {
  const publish = vi.fn().mockResolvedValue('updated');
  const response = await mutateInstructionVersionCommand(request(base), {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({publish})
  });
  expect(response.status).toBe(303);
  expect(publish).toHaveBeenCalledWith({
    workspaceId, operatorActorId: actorId,
    target: {scope: 'agent_profile', agentProfileId: profileId},
    expectedVersion: 2, instructions: 'Следовать протоколу.'
  });
});

it('rolls back only to a bounded version in the same requested scope', async () => {
  const rollback = vi.fn().mockResolvedValue('updated');
  const response = await mutateInstructionVersionCommand(request({
    ...base, action: 'rollback', instructions: '', rollbackOfVersionId: versionId
  }), {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({rollback})
  });
  expect(response.status).toBe(303);
  expect(rollback).toHaveBeenCalledWith(expect.objectContaining({
    target: {scope: 'agent_profile', agentProfileId: profileId},
    expectedVersion: 2, rollbackOfVersionId: versionId
  }));
});

it('rejects ambiguous or stale mutations', async () => {
  const malformed = await mutateInstructionVersionCommand(request({...base, extra: 'x'}), {
    requireSession: vi.fn().mockResolvedValue(authorization) as never, getRuntime: vi.fn()
  });
  expect(malformed.status).toBe(400);
  const stale = await mutateInstructionVersionCommand(request(base), {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({publish: vi.fn().mockResolvedValue('stale')})
  });
  expect(stale.status).toBe(409);
});
