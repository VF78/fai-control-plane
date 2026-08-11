import {describe, expect, it, vi} from 'vitest';
import {reconcileEnvironmentAccess, type EnvironmentAccessAdapter, type EnvironmentAccessBinding} from './environment-access-reconciliation';

const ref = {provider: 'file', reference: 'opaque-ref', scope: ['ssh:principal']} as const;
const binding = (overrides: Partial<EnvironmentAccessBinding> = {}): EnvironmentAccessBinding => ({
  grantId: '11111111-1111-4111-8111-111111111111', grantVersion: 1,
  projectId: '22222222-2222-4222-8222-222222222222',
  actorId: '33333333-3333-4333-8333-333333333333',
  environment: {id: '44444444-4444-4444-8444-444444444444', kind: 'development',
    provider: 'fake', endpoint: 'dev.internal', port: 22, adapterKey: 'fake', enabled: true,
    reconcilerActorId: '55555555-5555-4555-8555-555555555555'},
  desiredLevel: 'write', expiresAt: '2026-09-01T00:00:00.000Z',
  adapterCredentialRef: {...ref, scope: ['environment_access:admin']},
  principalCredentialRef: ref, ...overrides
});

describe('environment access reconciliation', () => {
  it('applies and records only a matching observation', async () => {
    const adapter: EnvironmentAccessAdapter = {adapterKey: 'fake', provider: 'fake',
      apply: vi.fn(), revoke: vi.fn(), observe: vi.fn(async () => ({level: 'write' as const,
        externalResourceRef: 'host-account:developer', observedAt: '2026-08-11T10:00:00.000Z'}))};
    const recordObservation = vi.fn();
    await expect(reconcileEnvironmentAccess({binding: binding(), adapters: [adapter], recordObservation,
      now: new Date('2026-08-11T09:00:00.000Z')})).resolves.toMatchObject({state: 'observed', effect: 'apply'});
    expect(adapter.apply).toHaveBeenCalledOnce(); expect(adapter.revoke).not.toHaveBeenCalled();
    expect(recordObservation).toHaveBeenCalledWith(expect.objectContaining({
      actorId: binding().environment.reconcilerActorId, confirmedLevel: 'write'
    }));
  });

  it('revokes expired access and fails closed without an adapter or on mismatch', async () => {
    await expect(reconcileEnvironmentAccess({binding: binding(), adapters: [], recordObservation: vi.fn(),
      now: new Date('2026-08-11T09:00:00.000Z')})).resolves.toMatchObject({state: 'unsupported'});
    const adapter: EnvironmentAccessAdapter = {adapterKey: 'fake', provider: 'fake',
      apply: vi.fn(), revoke: vi.fn(), observe: vi.fn(async () => ({level: 'write' as const,
        externalResourceRef: 'stale', observedAt: '2026-08-11T10:00:00.000Z'}))};
    await expect(reconcileEnvironmentAccess({binding: binding({expiresAt: '2026-08-01T00:00:00.000Z'}),
      adapters: [adapter], recordObservation: vi.fn(), now: new Date('2026-08-11T09:00:00.000Z')})).resolves.toMatchObject({state: 'unavailable'});
    expect(adapter.revoke).toHaveBeenCalledOnce();
  });

  it('still revokes and observes none after the environment is disabled', async () => {
    const adapter: EnvironmentAccessAdapter = {adapterKey: 'fake', provider: 'fake',
      apply: vi.fn(), revoke: vi.fn(), observe: vi.fn(async () => ({level: 'none' as const,
        externalResourceRef: 'host-account:revoked', observedAt: '2026-08-11T10:00:00.000Z'}))};
    const recordObservation = vi.fn();
    await expect(reconcileEnvironmentAccess({binding: binding({
      desiredLevel: 'none', expiresAt: null,
      environment: {...binding().environment, enabled: false}
    }), adapters: [adapter], recordObservation,
    now: new Date('2026-08-11T09:00:00.000Z')})).resolves.toMatchObject({
      state: 'observed', effect: 'revoke'
    });
    expect(adapter.apply).not.toHaveBeenCalled();
    expect(adapter.revoke).toHaveBeenCalledOnce();
    expect(recordObservation).toHaveBeenCalledWith(expect.objectContaining({confirmedLevel: 'none'}));
  });
});
