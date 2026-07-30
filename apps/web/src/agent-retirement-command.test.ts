import {expect, it, vi} from 'vitest';
import {agentRetirementCommand} from './agent-retirement-command';

const agentId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '33333333-3333-4333-8333-333333333333';
const request = (body: unknown) => new Request(
  `https://app.example/api/agents/${agentId}/retire`,
  {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body)
  }
);
const authorization = {
  ok: true as const,
  session: {actorId, csrfToken: 'csrf'},
  runtime: {config: {workspaceId}},
  sessionToken: 'session'
};

it('returns the canonical retirement receipt', async () => {
  const retire = vi.fn().mockResolvedValue({
    status: 'retired',
    commandId: '44444444-4444-4444-8444-444444444444',
    disabledAt: '2026-07-30T08:00:00.000Z'
  });
  const response = await agentRetirementCommand(request({_csrf: 'csrf'}), agentId, {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({retire})
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    status: 'retired',
    agent: {id: agentId},
    receipt: {commandType: 'actor.retire'}
  });
  expect(retire).toHaveBeenCalledWith({workspaceId, operatorActorId: actorId, agentId});
});

it('fails closed on malformed input and maps already-retired conflict', async () => {
  const requireSession = vi.fn();
  expect((await agentRetirementCommand(request({_csrf: 'csrf', extra: true}), agentId, {
    requireSession: requireSession as never,
    getRuntime: vi.fn()
  })).status).toBe(400);
  expect(requireSession).not.toHaveBeenCalled();

  const response = await agentRetirementCommand(request({_csrf: 'csrf'}), agentId, {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({
      retire: vi.fn().mockResolvedValue({status: 'conflict'})
    })
  });
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({status: 'already_retired'});
});
