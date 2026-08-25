import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {codexReadiness, hermesExecutorCatalog, parseCodexReadiness,
  parseTrustedExecutionReadiness} from './hermes-executor-readiness.ts';

const evidence = () => {
  const value = {...codexReadiness, loginStatus: 'authenticated' as const,
    imageId: `sha256:${'a'.repeat(64)}`, verifiedAt: '2026-08-24T12:00:00.000Z'};
  return {...value, evidenceSha256: createHash('sha256').update([
    value.contract, value.upstreamImage, value.codexVersion, value.codexHome, value.workdir,
    value.loginStatus, value.imageId, value.verifiedAt
  ].join('\n')).digest('hex')};
};

describe('Hermes Codex readiness evidence', () => {
  it('accepts exact deploy-produced evidence and keeps Claude unavailable', () => {
    expect(parseCodexReadiness(evidence())).toMatchObject({codexVersion: '0.144.1'});
  });

  it.each([
    {...evidence(), codexVersion: 'latest'},
    {...evidence(), workdir: '/tmp/project'},
    {...evidence(), loginStatus: 'unknown'},
    {...evidence(), evidenceSha256: 'a'.repeat(64)},
    {...evidence(), extra: true}
  ])('fails closed on drifted or malformed evidence', (value) => {
    expect(parseCodexReadiness(value)).toBeNull();
  });

  it('keeps Codex unavailable when the readiness artifact is absent', () => {
    expect(hermesExecutorCatalog('/definitely/missing/codex-readiness.json')['codex-cli'])
      .toEqual({available: false, models: []});
  });

  it('accepts only self-hashed trusted execution activation evidence', () => {
    const value = {contract: 'fai.trusted-execution-readiness.v1' as const, githubAppId: '123',
      installationId: '456', release: 'a'.repeat(40), repositoryBrokerImageId: `sha256:${'b'.repeat(64)}`,
      executorImageId: `sha256:${'c'.repeat(64)}`, executorPublicKeySha256: 'd'.repeat(64),
      configurationSha256: 'e'.repeat(64), verifiedAt: '2026-08-25T12:00:00.000Z'};
    const evidenceSha256 = createHash('sha256').update(Object.values(value).join('\n')).digest('hex');
    expect(parseTrustedExecutionReadiness({...value, evidenceSha256})).toMatchObject({installationId: '456'});
    expect(parseTrustedExecutionReadiness({...value, evidenceSha256: 'f'.repeat(64)})).toBeNull();
  });
});
