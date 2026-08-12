import {describe, expect, it} from 'vitest';
import {
  isTaskPacketProfileEligible
} from './runtime-availability';

describe('runtime composition availability', () => {
  const configured = {
    RUNNER_ENABLED: 'true', LOCAL_RUNNER_TRANSPORT_ENABLED: 'true',
    LOCAL_RUNNER_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
    LOCAL_RUNNER_ID: 'runner-hermes',
    LOCAL_RUNNER_ALLOWED_PROJECT_IDS: '00000000-0000-4000-8000-000000000002',
    LOCAL_RUNNER_ALLOWED_REPOSITORIES: 'VF78/fai-control-plane',
    LOCAL_RUNNER_ALLOWED_RUNTIME_IDS: 'hermes',
    LOCAL_RUNNER_ALLOWED_RUNTIME_REGISTRATION_KEYS: 'hermes-codex-v1',
    LOCAL_RUNNER_TOKEN_FILE: '/run/secrets/local-runner-token',
    RUNTIME_OBSERVATION_TRANSPORT_ENABLED: 'true',
    RUNTIME_OBSERVATION_ALLOWED_REGISTRATION_IDS: '00000000-0000-4000-8000-000000000003',
    RUNTIME_OBSERVATION_TOKEN_FILE: '/run/secrets/runtime-observation-token',
    HERMES_ORCHESTRATOR_VERSION: '0.18.2', HERMES_ORCHESTRATOR_CONFIG_SHA256: 'a'.repeat(64)
  } as const;
  it('requires Hermes snapshots while preserving the codex-cli legacy path', () => {
    expect(isTaskPacketProfileEligible('hermes', null, 'profile-1', configured)).toBe(false);
    expect(isTaskPacketProfileEligible('hermes', 'profile-1', 'profile-1', configured)).toBe(true);
    expect(isTaskPacketProfileEligible('hermes', 'profile-1', 'profile-1', {
      ...configured, LOCAL_RUNNER_ALLOWED_RUNTIME_IDS: 'codex-cli'
    })).toBe(false);
    expect(isTaskPacketProfileEligible('codex-cli', null, 'profile-1')).toBe(true);
    expect(isTaskPacketProfileEligible('codex-cli', 'profile-1', 'profile-2')).toBe(false);
    expect(isTaskPacketProfileEligible('claude', 'profile-1', 'profile-1', configured)).toBe(false);
  });
});
