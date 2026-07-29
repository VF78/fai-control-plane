import {createHash} from 'node:crypto';
import {
  canonicalJson,
  containsHighConfidenceSecretContent,
  type CanonicalJson,
  type CommandResult
} from './index.ts';

export type InstructionSettings = Readonly<{[key: string]: CanonicalJson}>;

export type InstructionContent = Readonly<{
  instructions: string;
  settings: InstructionSettings;
}>;

export type EffectiveInstructions = Readonly<{
  instructions: string;
  settings: InstructionSettings;
  hash: string;
}>;

export type EffectiveInstructionDiff = Readonly<{
  previousHash: string | null;
  currentHash: string;
  instructions: Readonly<{
    changed: boolean;
    before: string | null;
    after: string;
  }>;
  settings: readonly Readonly<{
    path: string;
    before?: CanonicalJson;
    after?: CanonicalJson;
  }>[];
}>;

const forbiddenSettingKey =
  /(?:secret|password|passphrase|token|credential|api[_-]?key|private[_-]?key)/i;

const isPlainObject = (value: unknown): value is Record<string, CanonicalJson> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasForbiddenSettings = (value: CanonicalJson): boolean => {
  if (typeof value === 'string') return containsHighConfidenceSecretContent(value);
  if (Array.isArray(value)) return value.some(hasForbiddenSettings);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, nested]) => forbiddenSettingKey.test(key) || hasForbiddenSettings(nested)
  );
};

export const validateInstructionContent = (
  content: InstructionContent
): CommandResult<InstructionContent> => {
  let serializedSettings: string;
  try {
    serializedSettings = canonicalJson(content.settings);
  } catch {
    return {
      ok: false,
      error: {code: 'INVALID_COMMAND', message: 'Instruction settings must be canonical JSON.'}
    };
  }
  if (
    typeof content.instructions !== 'string' ||
    Buffer.byteLength(content.instructions, 'utf8') > 64 * 1024 ||
    !isPlainObject(content.settings) ||
    Buffer.byteLength(serializedSettings, 'utf8') > 32 * 1024
  ) {
    return {
      ok: false,
      error: {code: 'INVALID_COMMAND', message: 'Instruction content is invalid or too large.'}
    };
  }
  if (
    containsHighConfidenceSecretContent(content.instructions) ||
    hasForbiddenSettings(content.settings)
  ) {
    return {
      ok: false,
      error: {
        code: 'SECRET_VALUE_FORBIDDEN',
        message: 'Instruction versions never accept secret values or secret-bearing settings.'
      }
    };
  }
  return {
    ok: true,
    value: {
      instructions: content.instructions,
      settings: JSON.parse(serializedSettings) as InstructionSettings
    }
  };
};

const mergeSettings = (
  baseline: InstructionSettings,
  override: InstructionSettings
): InstructionSettings => {
  const merged: Record<string, CanonicalJson> = {};
  for (const key of [...new Set([...Object.keys(baseline), ...Object.keys(override)])].sort()) {
    const baseValue = baseline[key];
    const overrideValue = override[key];
    merged[key] =
      isPlainObject(baseValue) && isPlainObject(overrideValue)
        ? mergeSettings(baseValue, overrideValue)
        : overrideValue === undefined
          ? baseValue!
          : overrideValue;
  }
  return merged;
};

export const effectiveInstructions = (
  baseline: InstructionContent,
  profileOverride?: InstructionContent | null
): EffectiveInstructions => {
  const overrideInstructions = profileOverride?.instructions.trim() ?? '';
  const instructions = overrideInstructions.length === 0
    ? baseline.instructions
    : baseline.instructions.length === 0
      ? profileOverride!.instructions
      : `${baseline.instructions}\n\n${profileOverride!.instructions}`;
  const settings = mergeSettings(baseline.settings, profileOverride?.settings ?? {});
  const hash = createHash('sha256')
    .update(canonicalJson({instructions, settings}), 'utf8')
    .digest('hex');
  return {instructions, settings, hash};
};

const settingChanges = (
  before: CanonicalJson | undefined,
  after: CanonicalJson | undefined,
  path = ''
): EffectiveInstructionDiff['settings'] => {
  if (
    (before === undefined && after === undefined) ||
    (before !== undefined && after !== undefined && canonicalJson(before) === canonicalJson(after))
  ) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .flatMap((key) =>
        settingChanges(before[key], after[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)
      );
  }
  return [{
    path: path || '/',
    ...(before === undefined ? {} : {before}),
    ...(after === undefined ? {} : {after})
  }];
};

export const diffEffectiveInstructions = (
  previous: EffectiveInstructions | null,
  current: EffectiveInstructions
): EffectiveInstructionDiff => ({
  previousHash: previous?.hash ?? null,
  currentHash: current.hash,
  instructions: {
    changed: previous?.instructions !== current.instructions,
    before: previous?.instructions ?? null,
    after: current.instructions
  },
  settings: settingChanges(previous?.settings, current.settings)
});
