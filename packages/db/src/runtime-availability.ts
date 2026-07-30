type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export const isRuntimeAvailable = (
  runtimeId: string | null | undefined,
  environment: RuntimeEnvironment = process.env
): boolean => runtimeId === 'codex-cli' || (
  runtimeId === 'hermes' && environment.HERMES_RUNNER_ENABLED === 'true'
);

export const matchesTaskPacketProfileSnapshot = (
  snapshotProfileId: string | null,
  profileId: string
): boolean => snapshotProfileId === null || snapshotProfileId === profileId;

export const isTaskPacketProfileEligible = (
  runtimeId: string | null | undefined,
  snapshotProfileId: string | null,
  profileId: string,
  environment: RuntimeEnvironment = process.env
): boolean => isRuntimeAvailable(runtimeId, environment) &&
  matchesTaskPacketProfileSnapshot(snapshotProfileId, profileId) &&
  (runtimeId !== 'hermes' || snapshotProfileId !== null);
