import {describe, expect, it} from 'vitest';
import {
  codexRuntimeSettingsAdapter,
  hermesRuntimeSettingsAdapter,
  validateRuntimeSettings,
  type PortableRuntimeBinding,
  type RuntimeSettingsAdapter
} from './index';

describe('runtime-owned settings validation', () => {
  it('keeps canonical runtime binding portable and settings-free', () => {
    const binding: PortableRuntimeBinding = {
      workspaceId: 'workspace',
      projectId: 'project',
      actorId: 'actor',
      agentProfileId: 'profile',
      runtimeId: 'codex-cli',
      runtimeProfile: 'write_scoped',
      allowedTools: ['codex_cli'],
      forbiddenSurfaces: ['production'],
      secretsRef: {
        provider: 'file',
        reference: 'host-owned/runtime-token',
        scope: ['runtime:execute']
      }
    };
    expect(Object.keys(binding)).not.toContain('settings');
  });

  it('validates Codex settings before runtime construction and fails without echoing input', () => {
    expect(validateRuntimeSettings(codexRuntimeSettingsAdapter, {
      codexHome: '/var/lib/fai/codex',
      environment: {PATH: '/usr/bin:/bin'}
    })).toEqual({
      ok: true,
      settings: {
        codexHome: '/var/lib/fai/codex',
        environment: {PATH: '/usr/bin:/bin'}
      }
    });
    const secret = 'sk-this-value-must-never-be-returned';
    const invalid = validateRuntimeSettings(codexRuntimeSettingsAdapter, {
      codexHome: '/var/lib/fai/codex',
      environment: {PATH: '/usr/bin', TOKEN: secret}
    });
    expect(invalid).toEqual({
      ok: false,
      error: {code: 'invalid_runtime_settings', runtimeId: 'codex-cli'}
    });
    expect(JSON.stringify(invalid)).not.toContain(secret);
  });

  it('keeps Hermes validation inside its adapter', () => {
    expect(validateRuntimeSettings(hermesRuntimeSettingsAdapter, {
      resultFormat: 'structured_v1',
      includeEvidence: true
    })).toEqual({
      ok: true,
      settings: {resultFormat: 'structured_v1', includeEvidence: true}
    });
    expect(validateRuntimeSettings(hermesRuntimeSettingsAdapter, {
      resultFormat: 'structured_v1',
      includeEvidence: true,
      token: 'not-canonical'
    })).toEqual({
      ok: false,
      error: {code: 'invalid_runtime_settings', runtimeId: 'hermes'}
    });
  });

  it('adds a fake Claude adapter without changing a shared union or command contract', () => {
    type FakeClaudeSettings = Readonly<{model: string; maxTurns: number}>;
    const fakeClaude: RuntimeSettingsAdapter<FakeClaudeSettings> = {
      runtimeId: 'claude',
      validateSettings(value) {
        if (
          typeof value !== 'object' || value === null || Array.isArray(value) ||
          Object.keys(value).length !== 2 ||
          !('model' in value) || typeof value.model !== 'string' ||
          !('maxTurns' in value) || !Number.isInteger(value.maxTurns) ||
          (value.maxTurns as number) < 1 || (value.maxTurns as number) > 20
        ) return null;
        return {model: value.model, maxTurns: value.maxTurns as number};
      }
    };
    expect(validateRuntimeSettings(fakeClaude, {
      model: 'fake-test-model',
      maxTurns: 5
    })).toEqual({
      ok: true,
      settings: {model: 'fake-test-model', maxTurns: 5}
    });
  });
});
