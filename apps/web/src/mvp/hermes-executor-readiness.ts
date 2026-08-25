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
export const trustedExecutionReadiness = {contract: 'fai.trusted-execution-readiness.v1'} as const;

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

type TrustedEvidence = Readonly<{
  contract: 'fai.trusted-execution-readiness.v1'; githubAppId: string; installationId: string; release: string;
  repositoryBrokerImageId: string; executorImageId: string; executorPublicKeySha256: string;
  configurationSha256: string; verifiedAt: string; evidenceSha256: string;
}>;
const trustedPayload = (value: Omit<TrustedEvidence, 'evidenceSha256'>): string => [
  value.contract, value.githubAppId, value.installationId, value.release, value.repositoryBrokerImageId,
  value.executorImageId, value.executorPublicKeySha256, value.configurationSha256, value.verifiedAt
].join('\n');
export const parseTrustedExecutionReadiness = (value: unknown): TrustedEvidence | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [
    'configurationSha256', 'contract', 'evidenceSha256', 'executorImageId', 'executorPublicKeySha256',
    'githubAppId', 'installationId', 'release', 'repositoryBrokerImageId', 'verifiedAt'
  ].sort().join(',') || record.contract !== trustedExecutionReadiness.contract ||
    typeof record.githubAppId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(record.githubAppId) ||
    typeof record.installationId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(record.installationId) ||
    typeof record.release !== 'string' || !/^[a-f0-9]{40}$/.test(record.release) ||
    typeof record.repositoryBrokerImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.repositoryBrokerImageId) ||
    typeof record.executorImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.executorImageId) ||
    typeof record.executorPublicKeySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.executorPublicKeySha256) ||
    typeof record.configurationSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.configurationSha256) ||
    typeof record.verifiedAt !== 'string' || Number.isNaN(Date.parse(record.verifiedAt)) ||
    typeof record.evidenceSha256 !== 'string') return null;
  const candidate = record as unknown as TrustedEvidence;
  return createHash('sha256').update(trustedPayload(candidate)).digest('hex') === candidate.evidenceSha256
    ? candidate : null;
};

export const hermesExecutorCatalog = (path = '/run/fai-readiness/codex-cli.json',
  trustedPath = '/run/fai-readiness/trusted-execution.json',
  publicKeyPath = '/run/fai-readiness/executor-attestation-public-key.pem'): AgentExecutorCatalog => {
  let parsed: unknown; let trusted: unknown; let publicKey: string;
  try {
    const content = readFileSync(path, {encoding: 'utf8'});
    const trustedContent = readFileSync(trustedPath, {encoding: 'utf8'});
    publicKey = readFileSync(publicKeyPath, {encoding: 'utf8'});
    if (content.length === 0 || content.length > 4_096 || trustedContent.length === 0 ||
      trustedContent.length > 4_096 || publicKey.length < 100 || publicKey.length > 8_192) return unavailable;
    parsed = JSON.parse(content); trusted = JSON.parse(trustedContent);
  } catch { return unavailable; }
  const trustedEvidence = parseTrustedExecutionReadiness(trusted);
  return parseCodexReadiness(parsed) === null || trustedEvidence === null ||
    createHash('sha256').update(publicKey).digest('hex') !== trustedEvidence.executorPublicKeySha256
    ? unavailable : available;
};

const available: AgentExecutorCatalog = {
  'codex-cli': {available: true, models: ['gpt-5.6-terra', 'gpt-5.6-sol']},
  'claude-code-cli': {available: false, models: []}
};
const unavailable: AgentExecutorCatalog = {
  'codex-cli': {available: false, models: []}, 'claude-code-cli': {available: false, models: []}
};
