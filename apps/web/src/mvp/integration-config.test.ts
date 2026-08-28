import {describe, expect, it} from 'vitest';
import {integrationConfig} from './integration-config.ts';

describe('integration configuration', () => {
  it('keeps the removed Bitrix mutation contour disabled', () => {
    expect(integrationConfig({BITRIX24_TASK_ID: '154312'}).bitrix)
      .toEqual({configured: true, clientActionsEnabled: false});
  });

  it('derives Hermes and Telegram readiness only from the project runtime binding', () => {
    expect(integrationConfig({}, null)).toMatchObject({hermes: false,
      telegram: {configured: false, allowedUsers: 0}});
    expect(integrationConfig({TELEGRAM_INTERNAL_CHAT_ID: '-1'},
      {telegramAllowedUserIds: ['42', '43']})).toMatchObject({hermes: true,
      telegram: {configured: true, allowedUsers: 2}});
  });

});
