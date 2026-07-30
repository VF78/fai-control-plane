import {describe, expect, it} from 'vitest';
import {
  isTaskPacketProfileEligible
} from './runtime-availability';

describe('runtime composition availability', () => {
  it('requires Hermes snapshots while preserving the codex-cli legacy path', () => {
    expect(isTaskPacketProfileEligible('hermes', null, 'profile-1', {
      HERMES_RUNNER_ENABLED: 'true'
    })).toBe(false);
    expect(isTaskPacketProfileEligible('hermes', 'profile-1', 'profile-1', {
      HERMES_RUNNER_ENABLED: 'true'
    })).toBe(true);
    expect(isTaskPacketProfileEligible('hermes', 'profile-1', 'profile-1', {
      HERMES_RUNNER_ENABLED: 'false'
    })).toBe(false);
    expect(isTaskPacketProfileEligible('codex-cli', null, 'profile-1')).toBe(true);
    expect(isTaskPacketProfileEligible('codex-cli', 'profile-1', 'profile-2')).toBe(false);
    expect(isTaskPacketProfileEligible('claude', 'profile-1', 'profile-1', {
      HERMES_RUNNER_ENABLED: 'true'
    })).toBe(false);
  });
});
