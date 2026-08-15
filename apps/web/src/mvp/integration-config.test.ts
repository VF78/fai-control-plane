import {describe, expect, it} from 'vitest';
import {bitrixClientActionsEnabled, integrationConfig} from './integration-config.ts';

describe('integration configuration', () => {
  it('keeps Bitrix client actions disabled until the exact opt-in is set', () => {
    expect(bitrixClientActionsEnabled({})).toBe(false);
    expect(bitrixClientActionsEnabled({BITRIX24_CLIENT_ACTIONS_ENABLED: 'false'})).toBe(false);
    expect(bitrixClientActionsEnabled({BITRIX24_CLIENT_ACTIONS_ENABLED: 'TRUE'})).toBe(false);
    expect(bitrixClientActionsEnabled({BITRIX24_CLIENT_ACTIONS_ENABLED: 'true'})).toBe(true);
  });

  it('separates configured credentials from the client-action activation policy', () => {
    expect(integrationConfig({BITRIX24_TASK_ID: '154312', HERMES_CLIENT_ACTION_TOKEN_FILE: '/run/secret'}).bitrix)
      .toEqual({configured: true, clientActionsEnabled: false});
  });
});
