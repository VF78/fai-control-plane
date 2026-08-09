export type RunnerActivationEnvironment = Readonly<Record<string, string | undefined>>;

export const runnerActivationEnabled = (
  environment: RunnerActivationEnvironment = process.env
): boolean => environment.RUNNER_ENABLED === 'true' &&
  environment.LOCAL_RUNNER_TRANSPORT_ENABLED === 'true';
