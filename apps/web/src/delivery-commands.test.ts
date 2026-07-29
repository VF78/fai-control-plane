import {expect, it, vi} from 'vitest';
import {deliveryProtocolCommand, type DeliveryCommandDependencies} from './delivery-commands';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const protocolId = '33333333-3333-4333-8333-333333333333';
const commandId = '44444444-4444-4444-8444-444444444444';
const request = (body: unknown, extra: HeadersInit = {}) => new Request('https://control.test/api/delivery-protocol', {
  method: 'POST', headers: {'content-type': 'application/json', ...extra}, body: JSON.stringify(body)
});

const authorized = (): DeliveryCommandDependencies['requireSession'] => async () => ({
  ok: true,
  session: {actorId: commandId},
  runtime: {config: {workspaceId}},
  sessionToken: 'session'
} as never);
const dependencies = (execute: ReturnType<typeof vi.fn>): DeliveryCommandDependencies => ({
  requireSession: authorized(), nextId: () => commandId,
  getRuntime: async () => ({
    actor: async () => ({ok: true, value: {} as never}),
    protocol: {execute, get: vi.fn(), simulate: vi.fn()},
    journey: {} as never
  } as never)
});

it('denies a delivery protocol command without an operator session', async () => {
  const response = await deliveryProtocolCommand(request({_csrf: 'csrf', action: 'create_default', projectId}), {
    requireSession: async () => ({ok: false, response: new Response(null, {status: 401})}),
    getRuntime: vi.fn(), nextId: () => commandId
  } as never);
  expect(response.status).toBe(401);
});

it('rejects malformed and oversized delivery protocol bodies before a runtime command', async () => {
  const execute = vi.fn(); const deps = dependencies(execute);
  const malformed = await deliveryProtocolCommand(request({_csrf: 'csrf', action: 'create_default', projectId: 'not-a-uuid'}), deps);
  const oversized = await deliveryProtocolCommand(new Request('https://control.test/api/delivery-protocol', {
    method: 'POST', headers: {'content-type': 'application/json', 'content-length': '32769'}, body: '{}'
  }), deps);
  expect(malformed.status).toBe(400); expect(oversized.status).toBe(400); expect(execute).not.toHaveBeenCalled();
});

it('returns a receipt only when the canonical draft command persisted', async () => {
  const persisted = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId, commandType: 'delivery_protocol.draft'}});
  const rejected = vi.fn().mockResolvedValue({status: 'rejected', error: {message: 'Policy denied'}});
  const body = {_csrf: 'csrf', action: 'create_default', projectId};
  const success = await deliveryProtocolCommand(request(body), dependencies(persisted));
  const failure = await deliveryProtocolCommand(request(body), dependencies(rejected));
  await expect(success.json()).resolves.toEqual({receipt: {commandId, commandType: 'delivery_protocol.draft'}});
  expect(failure.status).toBe(409);
});
