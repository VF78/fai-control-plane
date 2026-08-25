import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {codexReadiness, hermesExecutorCatalog, parseCodexReadiness} from './hermes-executor-readiness.ts';

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
});
