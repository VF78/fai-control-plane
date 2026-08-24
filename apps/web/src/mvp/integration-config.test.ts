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

  it('reports Hermes ready only when endpoint and canonical DB credential reference are both present', () => {
    expect(integrationConfig({HERMES_ROLE_REQUEST_URL: 'https://hermes.example/v1/runs'}, false).hermes).toBe(false);
    expect(integrationConfig({}, true).hermes).toBe(false);
    expect(integrationConfig({HERMES_ROLE_REQUEST_URL: 'https://hermes.example/v1/runs'}, true).hermes).toBe(true);
  });

});
