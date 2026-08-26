import {describe, expect, it} from 'vitest';
import {integrationConfig} from './integration-config.ts';

describe('integration configuration', () => {
  it('keeps the removed Bitrix mutation contour disabled', () => {
    expect(integrationConfig({BITRIX24_TASK_ID: '154312'}).bitrix)
      .toEqual({configured: true, clientActionsEnabled: false});
  });

  it('reports Hermes ready only when endpoint and canonical DB credential reference are both present', () => {
    expect(integrationConfig({HERMES_ROLE_REQUEST_URL: 'https://hermes.example/v1/runs'}, false).hermes).toBe(false);
    expect(integrationConfig({}, true).hermes).toBe(false);
    expect(integrationConfig({HERMES_ROLE_REQUEST_URL: 'https://hermes.example/v1/runs'}, true).hermes).toBe(true);
  });

});
