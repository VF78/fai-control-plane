import {describe, expect, it} from 'vitest';
import {autonomousQaTransportFromEnvironment} from './autonomous-qa-transport';

const configured = {
  RUNNER_ENABLED: 'true',
  LOCAL_RUNNER_TRANSPORT_ENABLED: 'true',
  RUNTIME_OBSERVATION_TRANSPORT_ENABLED: 'true',
  HERMES_ORCHESTRATOR_VERSION: '0.18.2',
  HERMES_ORCHESTRATOR_CONFIG_SHA256: 'a'.repeat(64),
  LOCAL_RUNNER_ID: 'fai-hermes-runner-01',
  LOCAL_RUNNER_WORKSPACE_ID: '11111111-1111-4111-8111-111111111111',
  LOCAL_RUNNER_ALLOWED_PROJECT_IDS: '22222222-2222-4222-8222-222222222222',
  LOCAL_RUNNER_ALLOWED_REPOSITORIES: 'VF78/fai-control-plane',
  LOCAL_RUNNER_ALLOWED_RUNTIME_IDS: 'hermes',
  LOCAL_RUNNER_ALLOWED_RUNTIME_REGISTRATION_KEYS: 'hermes-codex-production',
  RUNTIME_OBSERVATION_ALLOWED_REGISTRATION_IDS: '33333333-3333-4333-8333-333333333333',
  LOCAL_RUNNER_TOKEN_FILE: '/run/credentials/fai-hermes-runner.token',
  RUNTIME_OBSERVATION_TOKEN_FILE: '/run/credentials/fai-hermes-observation.token',
  HERMES_ORCHESTRATOR_EXECUTABLE: '/usr/local/lib/fai-hermes-runner/hermes_no_tools_orchestrator.py',
  HERMES_PYTHON_EXECUTABLE: '/usr/local/lib/hermes-agent/venv/bin/python',
  HERMES_HOME: '/var/lib/fai-hermes-runner/hermes-home',
  HERMES_CONFIG_SHA256: 'a'.repeat(64),
  CODEX_EXECUTABLE: '/usr/bin/codex',
  CODEX_HOME: '/var/lib/fai-hermes-runner/codex-home',
  RUNNER_STATE_DIR: '/var/lib/fai-hermes-runner/state',
  RUNNER_WORKTREE_ROOT: '/var/lib/fai-hermes-runner/worktrees',
  RUNNER_ARTIFACT_ROOT: '/var/lib/fai-hermes-runner/artifacts',
  LOCAL_RUNNER_BASE_URL: 'http://127.0.0.1:13000'
} as const;

describe('autonomousQaTransportFromEnvironment', () => {
  it('admits only the exact authenticated Hermes transport identity', () => {
    expect(autonomousQaTransportFromEnvironment(configured)).toEqual({
      status: 'available',
      identity: {
        kind: 'hermes_authenticated_claim_v1',
        runnerId: 'fai-hermes-runner-01',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        projectIds: ['22222222-2222-4222-8222-222222222222'],
        repositories: [{owner: 'VF78', name: 'fai-control-plane'}],
        runtimeIds: ['hermes'],
        runtimeRegistrationKeys: ['hermes-codex-production']
      }
    });
  });

  it('fails closed without token refs and never consults a feature flag', () => {
    expect(autonomousQaTransportFromEnvironment({
      ...configured,
      LOCAL_RUNNER_TOKEN_FILE: undefined,
      HERMES_RUNNER_ENABLED: 'true'
    })).toMatchObject({status: 'unavailable'});
  });
});
