import path from 'node:path';

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const list = (value: string | undefined): readonly string[] => value?.split(',').map((item) => item.trim()) ?? [];
const exactList = (values: readonly string[], valid: (value: string) => boolean): boolean =>
  values.length > 0 && values.length <= 64 && new Set(values).size === values.length && values.every(valid);
const absoluteFileRef = (value: string | undefined): boolean => typeof value === 'string' &&
  value.length > 1 && path.isAbsolute(value) && path.normalize(value) === value && path.resolve(value) === value;

export const isHermesTransportConfigured = (environment: RuntimeEnvironment = process.env): boolean => {
  const projects = list(environment.LOCAL_RUNNER_ALLOWED_PROJECT_IDS);
  const repositories = list(environment.LOCAL_RUNNER_ALLOWED_REPOSITORIES);
  const runtimes = list(environment.LOCAL_RUNNER_ALLOWED_RUNTIME_IDS);
  const registrationKeys = list(environment.LOCAL_RUNNER_ALLOWED_RUNTIME_REGISTRATION_KEYS);
  const observationRegistrations = list(environment.RUNTIME_OBSERVATION_ALLOWED_REGISTRATION_IDS);
  return environment.RUNNER_ENABLED === 'true' && environment.LOCAL_RUNNER_TRANSPORT_ENABLED === 'true' &&
    environment.RUNTIME_OBSERVATION_TRANSPORT_ENABLED === 'true' &&
    environment.HERMES_ORCHESTRATOR_VERSION === '0.18.2' &&
    /^[0-9a-f]{64}$/.test(environment.HERMES_ORCHESTRATOR_CONFIG_SHA256 ?? '') &&
    UUID.test(environment.LOCAL_RUNNER_WORKSPACE_ID ?? '') && SAFE_ID.test(environment.LOCAL_RUNNER_ID ?? '') &&
    exactList(projects, (value) => UUID.test(value)) && exactList(repositories, (value) => REPOSITORY.test(value)) &&
    exactList(runtimes, (value) => SAFE_ID.test(value)) && runtimes.includes('hermes') &&
    exactList(registrationKeys, (value) => SAFE_ID.test(value)) &&
    exactList(observationRegistrations, (value) => UUID.test(value)) &&
    absoluteFileRef(environment.LOCAL_RUNNER_TOKEN_FILE) &&
    absoluteFileRef(environment.RUNTIME_OBSERVATION_TOKEN_FILE);
};

export const isRuntimeAvailable = (
  runtimeId: string | null | undefined,
  environment: RuntimeEnvironment = process.env
): boolean => runtimeId === 'codex-cli' || (runtimeId === 'hermes' && isHermesTransportConfigured(environment));

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
