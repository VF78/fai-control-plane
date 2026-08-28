export type IntegrationConfig = Readonly<{
  hermes: boolean;
  telegram: Readonly<{configured: boolean; allowedUsers: number}>;
  bitrix: Readonly<{configured: boolean; clientActionsEnabled: boolean}>;
}>;

type Environment = Readonly<Record<string, string | undefined>>;
type ProjectRuntimeConfig = Readonly<{telegramAllowedUserIds: readonly string[]}> | null;

export const integrationConfig = (
  environment: Environment = process.env,
  runtime: ProjectRuntimeConfig = null
): IntegrationConfig => ({
  hermes: runtime !== null,
  telegram: {
    configured: runtime !== null,
    allowedUsers: runtime?.telegramAllowedUserIds.length ?? 0
  },
  bitrix: {
    configured: Boolean(environment.BITRIX24_TASK_ID),
    clientActionsEnabled: false
  }
});
