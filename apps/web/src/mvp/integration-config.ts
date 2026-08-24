export type IntegrationConfig = Readonly<{
  hermes: boolean;
  telegram: Readonly<{configured: boolean; allowedUsers: number}>;
  bitrix: Readonly<{configured: boolean; clientActionsEnabled: boolean}>;
}>;

/** The client contour is deliberately opt-in; an unset or malformed value never enables it. */
type Environment = Readonly<Record<string, string | undefined>>;

export const bitrixClientActionsEnabled = (environment: Environment = process.env): boolean =>
  environment.BITRIX24_CLIENT_ACTIONS_ENABLED === 'true';

export const integrationConfig = (
  environment: Environment = process.env,
  agentDeliveryConfigured = false
): IntegrationConfig => ({
  hermes: Boolean(environment.HERMES_ROLE_REQUEST_URL) && agentDeliveryConfigured,
  telegram: {
    configured: Boolean(environment.TELEGRAM_INTERNAL_CHAT_ID && environment.TELEGRAM_INTERNAL_ALLOWED_USER_IDS &&
      environment.HERMES_INTERNAL_ACTION_TOKEN_FILE),
    allowedUsers: environment.TELEGRAM_INTERNAL_ALLOWED_USER_IDS?.split(',').filter(Boolean).length ?? 0
  },
  bitrix: {
    configured: Boolean(environment.BITRIX24_TASK_ID && environment.HERMES_CLIENT_ACTION_TOKEN_FILE),
    clientActionsEnabled: bitrixClientActionsEnabled(environment)
  }
});
