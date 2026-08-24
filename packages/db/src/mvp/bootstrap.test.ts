import {describe, expect, it, vi} from 'vitest';
import {ensureAgentDeliverySecretRef} from './bootstrap.ts';

describe('agent delivery bootstrap', () => {
  it('registers one opaque workspace reference and verifies the exact locator', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({rows: []})
      .mockResolvedValueOnce({rows: [{locator: '/run/secrets/hermes-token'}]});
    await expect(ensureAgentDeliverySecretRef({query} as never, 'workspace', '/run/secrets/hermes-token'))
      .resolves.toBeUndefined();
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("'agent_delivery'"),
      ['workspace', '/run/secrets/hermes-token']);
  });

  it('rejects a conflicting existing reference instead of overwriting it', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({rows: []})
      .mockResolvedValueOnce({rows: [{locator: '/run/secrets/other'}]});
    await expect(ensureAgentDeliverySecretRef({query} as never, 'workspace', '/run/secrets/hermes-token'))
      .rejects.toThrow('bootstrap_existing_state_conflict');
  });
});
