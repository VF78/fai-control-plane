import {expect, it, vi} from 'vitest';
import {deliveryProtocolCommand, governedQaCommand, type DeliveryCommandDependencies} from './delivery-commands';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
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
  const chunkedOversized = await deliveryProtocolCommand(new Request('https://control.test/api/delivery-protocol', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({padding: 'x'.repeat(32 * 1024)})
  }), deps);
  const invalidUtf8 = await deliveryProtocolCommand(new Request('https://control.test/api/delivery-protocol', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: new Uint8Array([0xc3, 0x28])
  }), deps);
  expect(malformed.status).toBe(400); expect(oversized.status).toBe(400);
  expect(chunkedOversized.status).toBe(400); expect(invalidUtf8.status).toBe(400);
  expect(execute).not.toHaveBeenCalled();
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

it('creates an immutable-source draft revision without mutating the active protocol', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId, commandType: 'delivery_protocol.draft'}});
  const get = vi.fn().mockResolvedValue({
    id: commandId, projectId, name: 'Delivery', version: 3, revision: 5,
    state: 'published', active: true,
    definition: {schemaVersion: 1, stages: []}
  });
  const deps: DeliveryCommandDependencies = {
    requireSession: authorized(), nextId: () => commandId,
    getRuntime: async () => ({
      actor: async () => ({ok: true, value: {} as never}),
      protocol: {execute, get, simulate: vi.fn()}, journey: {} as never
    } as never)
  };
  const response = await deliveryProtocolCommand(request({
    _csrf: 'csrf', action: 'create_revision', projectId, protocolId: commandId, expectedRevision: 5
  }), deps);
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({
    type: 'delivery_protocol.draft',
    payload: expect.objectContaining({
      projectId, name: 'Delivery', expectedRevision: null,
      protocolId: expect.stringMatching(/^[0-9a-f-]{36}$/)
    })
  }));
});

it('requires session, CSRF-shaped body, and canonical QA evidence before dispatch', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {result: {ok: true, value: {taskPacketId: commandId, remediation: null}}}});
  const deps: DeliveryCommandDependencies = {requireSession: authorized(), nextId: () => commandId,
    getRuntime: async () => ({actor: async () => ({ok: true, value: {} as never}), governedQa: {execute}} as never)};
  const invalid = await governedQaCommand(request({_csrf: 'csrf', action: 'record', expectedWorkItemVersion: 1, expectedJourneyVersion: 1, taskPacketId: commandId, evidence: {}}), commandId, deps);
  expect(invalid.status).toBe(400); expect(execute).not.toHaveBeenCalled();
  const prepared = await governedQaCommand(request({_csrf: 'csrf', action: 'prepare', expectedWorkItemVersion: 1, expectedJourneyVersion: 1}), commandId, deps);
  expect(prepared.status).toBe(200); expect(execute).toHaveBeenCalledWith(expect.objectContaining({type: 'qa_task_packet.prepare.v1'}));
});

it.each([
  ['CAPABILITY_DENIED', 403], ['POLICY_DENIED', 403], ['NOT_FOUND', 404],
  ['VERSION_CONFLICT', 409], ['INVALID_TRANSITION', 409], ['IDEMPOTENCY_KEY_REUSED', 409],
  ['INVALID_COMMAND', 422],
  ['unexpected_store_failure', 503]
])('maps governed QA %s to HTTP %i', async (code, status) => {
  const execute = vi.fn().mockResolvedValue({status: 'rejected', error: {code, message: code}});
  const deps: DeliveryCommandDependencies = {requireSession: authorized(), nextId: () => commandId,
    getRuntime: async () => ({actor: async () => ({ok: true, value: {} as never}), governedQa: {execute}} as never)};
  const response = await governedQaCommand(request({_csrf: 'csrf', action: 'prepare',
    expectedWorkItemVersion: 1, expectedJourneyVersion: 1}), commandId, deps);
  expect(response.status).toBe(status);
});

it('maps a retained governed QA command rejection instead of returning a false receipt', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId,
    result: {ok: false, error: {code: 'NOT_FOUND', message: 'QA packet not found'}}}});
  const deps: DeliveryCommandDependencies = {requireSession: authorized(), nextId: () => commandId,
    getRuntime: async () => ({actor: async () => ({ok: true, value: {} as never}), governedQa: {execute}} as never)};
  const response = await governedQaCommand(request({_csrf: 'csrf', action: 'prepare',
    expectedWorkItemVersion: 1, expectedJourneyVersion: 1}), commandId, deps);
  expect(response.status).toBe(404);
});
