import path from 'node:path';
import type {AutonomousQaClaimTransport} from '@fai-control-plane/db';
import {isHermesTransportConfigured} from '@fai-control-plane/db';

type Environment = Readonly<Record<string, string | undefined>>;
const split = (value: string | undefined): readonly string[] => value?.split(',').map((item) => item.trim()) ?? [];
const absolute = (value: string | undefined): boolean => typeof value === 'string' && path.isAbsolute(value) &&
  path.normalize(value) === value && path.resolve(value) === value;

export const autonomousQaTransportFromEnvironment = (
  environment: Environment = process.env
): AutonomousQaClaimTransport => {
  if (!isHermesTransportConfigured(environment) || !absolute(environment.LOCAL_RUNNER_TOKEN_FILE) ||
    !absolute(environment.RUNTIME_OBSERVATION_TOKEN_FILE)) return Object.freeze({status: 'unavailable',
      reason: 'Hermes claim identity or authenticated runtime-observation transport is incomplete.'});
  return Object.freeze({status: 'available', identity: Object.freeze({
    kind: 'hermes_authenticated_claim_v1', runnerId: environment.LOCAL_RUNNER_ID!,
    workspaceId: environment.LOCAL_RUNNER_WORKSPACE_ID!,
    projectIds: Object.freeze(split(environment.LOCAL_RUNNER_ALLOWED_PROJECT_IDS)),
    repositories: Object.freeze(split(environment.LOCAL_RUNNER_ALLOWED_REPOSITORIES).map((repository) => {
      const [owner, name] = repository.split('/') as [string, string]; return Object.freeze({owner, name});
    })),
    runtimeIds: Object.freeze(split(environment.LOCAL_RUNNER_ALLOWED_RUNTIME_IDS)),
    runtimeRegistrationKeys: Object.freeze(split(environment.LOCAL_RUNNER_ALLOWED_RUNTIME_REGISTRATION_KEYS))
  })});
};

export const autonomousQaClaimTransport = autonomousQaTransportFromEnvironment();
export const autonomousQaTransportAvailable = autonomousQaClaimTransport.status === 'available';
