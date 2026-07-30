import type {RuntimeSettingsAdapter} from './runtime-adapter';

export type HermesRuntimeSettings = Readonly<{
  resultFormat: 'structured_v1';
  includeEvidence: boolean;
}>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export const hermesRuntimeSettingsAdapter: RuntimeSettingsAdapter<HermesRuntimeSettings> = {
  runtimeId: 'hermes',
  validateSettings(value) {
    if (
      !isPlainObject(value) ||
      Object.keys(value).length !== 2 ||
      value.resultFormat !== 'structured_v1' ||
      typeof value.includeEvidence !== 'boolean'
    ) return null;
    return {
      resultFormat: 'structured_v1',
      includeEvidence: value.includeEvidence
    };
  }
};
