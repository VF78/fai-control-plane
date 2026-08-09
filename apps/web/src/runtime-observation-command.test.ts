import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {runtimeObservationCommand} from './runtime-observation-command';

const token = 'runtime-observation-token-1234567890';
const body = {
  registrationId: '00000000-0000-4000-8000-000000000001',
  component: 'service',
  state: 'available',
  observedAt: '2026-08-09T10:00:00.000Z',
  ttlSeconds: 300,
  evidenceReference: 'probe:service:ok'
} as const;
const request = (value: unknown = body, authorization = `Bearer ${token}`) =>
  new Request('https://control.test/api/runtime-observations', {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization},
    body: JSON.stringify(value)
  });
const runtime = (status: 'recorded' | 'replayed' = 'recorded') => ({
  tokenHash: createHash('sha256').update(token).digest(),
  workspaceId: '00000000-0000-4000-8000-000000000002',
  systemActorId: '00000000-0000-4000-8000-000000000003',
  execute: vi.fn().mockResolvedValue({status, commandId: 'command-1'})
});
afterEach(() => {
  delete process.env.RUNTIME_OBSERVATION_TRANSPORT_ENABLED;
});

describe('runtime observation ingress', () => {
  it('is unavailable when runtime configuration is not enabled', async () => {
    const response = await runtimeObservationCommand(request(), {getRuntime: vi.fn() as never});
    expect(response.status).toBe(503);
  });

  it('denies an invalid credential before parsing or persistence', async () => {
    process.env.RUNTIME_OBSERVATION_TRANSPORT_ENABLED = 'true';
    const configured = runtime();
    const response = await runtimeObservationCommand(request(body, `Bearer ${token}x`), {
      getRuntime: vi.fn().mockResolvedValue(configured)
    });
    expect(response.status).toBe(401);
    expect(configured.execute).not.toHaveBeenCalled();
  });

  it('rejects malformed and secret-like evidence and returns replay truthfully', async () => {
    process.env.RUNTIME_OBSERVATION_TRANSPORT_ENABLED = 'true';
    const configured = runtime('replayed');
    const malformed = await runtimeObservationCommand(request({...body, extra: true}), {
      getRuntime: vi.fn().mockResolvedValue(configured)
    });
    expect(malformed.status).toBe(400);
    const secret = await runtimeObservationCommand(request({
      ...body, evidenceReference: `github_pat_${'a'.repeat(30)}`
    }), {getRuntime: vi.fn().mockResolvedValue(configured)});
    expect(secret.status).toBe(400);
    const replay = await runtimeObservationCommand(request(), {
      getRuntime: vi.fn().mockResolvedValue(configured)
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({status: 'replayed'});
  });
});
