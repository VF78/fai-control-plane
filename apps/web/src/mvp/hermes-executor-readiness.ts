import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {AgentExecutorCatalog} from '@fai-control-plane/domain';

export const codexReadiness = {
  contract: 'fai.hermes-codex-readiness.v1',
  upstreamImage: 'nousresearch/hermes-agent:v2026.8.13@sha256:68e15ae2a6d894d0ccbd9f8aacbbe13d4d28fa5dc9b6a303970b67bb2499b1a6',
  codexVersion: '0.144.1',
  codexHome: '/opt/data/codex-home',
  workdir: '/opt/data/work/project'
} as const;

type Evidence = Readonly<typeof codexReadiness & {
  loginStatus: 'authenticated'; imageId: string; verifiedAt: string; evidenceSha256: string;
}>;

const evidencePayload = (value: Omit<Evidence, 'evidenceSha256'>): string => [
  value.contract, value.upstreamImage, value.codexVersion, value.codexHome, value.workdir,
  value.loginStatus, value.imageId, value.verifiedAt
].join('\n');

export const parseCodexReadiness = (value: unknown): Evidence | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [
    'codexHome', 'codexVersion', 'contract', 'evidenceSha256', 'imageId', 'loginStatus',
    'upstreamImage', 'verifiedAt', 'workdir'
  ].sort().join(',') || record.contract !== codexReadiness.contract ||
    record.upstreamImage !== codexReadiness.upstreamImage || record.codexVersion !== codexReadiness.codexVersion ||
    record.codexHome !== codexReadiness.codexHome || record.workdir !== codexReadiness.workdir ||
    record.loginStatus !== 'authenticated' || typeof record.imageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(record.imageId) || typeof record.verifiedAt !== 'string' ||
    Number.isNaN(Date.parse(record.verifiedAt)) || typeof record.evidenceSha256 !== 'string') return null;
  const candidate = record as unknown as Evidence;
  const expected = createHash('sha256').update(evidencePayload(candidate)).digest('hex');
  return candidate.evidenceSha256 === expected ? candidate : null;
};

export const hermesExecutorCatalog = (path = '/run/fai-readiness/codex-cli.json'): AgentExecutorCatalog => {
  let parsed: unknown;
  try {
    const content = readFileSync(path, {encoding: 'utf8'});
    if (content.length === 0 || content.length > 4_096) return unavailable;
    parsed = JSON.parse(content);
  } catch { return unavailable; }
  return parseCodexReadiness(parsed) === null ? unavailable : available;
};

const available: AgentExecutorCatalog = {
  'codex-cli': {available: true, models: ['gpt-5.6-terra', 'gpt-5.6-sol']},
  'claude-code-cli': {available: false, models: []}
};
const unavailable: AgentExecutorCatalog = {
  'codex-cli': {available: false, models: []}, 'claude-code-cli': {available: false, models: []}
};
