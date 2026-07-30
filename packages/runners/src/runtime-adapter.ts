import type {OpaqueSecretRef} from '@fai-control-plane/domain';

const RUNTIME_ID = /^[a-z][a-z0-9._-]{0,63}$/;

export type PortableRuntimeBinding = Readonly<{
  workspaceId: string;
  projectId: string;
  actorId: string;
  agentProfileId: string;
  runtimeId: string;
  runtimeProfile: string;
  allowedTools: readonly string[];
  forbiddenSurfaces: readonly string[];
  secretsRef: OpaqueSecretRef | null;
}>;

export type RuntimeSettingsValidation<TSettings> =
  | Readonly<{ok: true; settings: TSettings}>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: 'invalid_runtime_settings';
        runtimeId: string;
      }>;
    }>;

/**
 * Adapter-owned validation boundary. Canonical bindings deliberately carry no
 * runtime-specific settings; a composition root supplies them directly to the
 * matching adapter.
 */
export interface RuntimeSettingsAdapter<TSettings> {
  readonly runtimeId: string;
  validateSettings(value: unknown): TSettings | null;
}

export const validateRuntimeSettings = <TSettings>(
  adapter: RuntimeSettingsAdapter<TSettings>,
  value: unknown
): RuntimeSettingsValidation<TSettings> => {
  const runtimeId = RUNTIME_ID.test(adapter.runtimeId)
    ? adapter.runtimeId
    : 'unknown';
  try {
    const settings = adapter.validateSettings(value);
    return settings === null
      ? {ok: false, error: {code: 'invalid_runtime_settings', runtimeId}}
      : {ok: true, settings};
  } catch {
    return {ok: false, error: {code: 'invalid_runtime_settings', runtimeId}};
  }
};
