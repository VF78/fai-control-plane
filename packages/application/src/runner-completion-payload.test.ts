import {createHash} from 'node:crypto';
import {canonicalJson} from '@fai-control-plane/domain';
import {describe, expect, it} from 'vitest';
import {parseRunnerCompletionPayload} from './index';

const runId = '00000000-0000-4000-8000-000000000001';
const hash = 'a'.repeat(64);
const directive = {schemaVersion: 1, orchestrator: 'hermes', executor: 'codex-cli', taskPacketId: runId,
  taskPacketHash: hash, workOrderHash: hash, strategy: 'risk_first',
  orderedStepIds: ['step.inspect_scope'], selectedCheckIds: ['check.acceptance.001'],
  selectedRiskControlIds: ['risk.no_deploy']} as const;
const directiveHash = createHash('sha256').update(canonicalJson(directive)).digest('hex');
const base = {
  runId, attempt: 1, terminal: 'done', receiptSha256: hash, receiptSizeBytes: 256,
  finalStatus: 'succeeded', runtimeId: 'hermes', runtimeProfile: 'write_scoped', durationMs: 1,
  cost: {state: 'unknown', reason: 'runtime_usage_not_available'},
  usage: {state: 'unknown', reason: 'runtime_usage_not_available'},
  artifactStore: {provider: 'workstation-local', reference: `runs/${runId}`,
    correlationId: `artifact-run-${runId}`},
  receiptArtifact: {name: 'agent-run-receipt.json', reference: `runs/${runId}/agent-run-receipt.json`,
    sha256: hash, sizeBytes: 256},
  pathManifest: {name: 'observed-path-manifest.json',
    reference: `runs/${runId}/observed-path-manifest.json`, sha256: hash, sizeBytes: 100},
  changedFiles: [], checks: [], riskCount: 0, nextAction: 'review_receipt',
  runtimeProvenance: {orchestrator: 'hermes', executor: 'codex-cli', workOrderHash: hash,
    directiveHash, strategy: 'risk_first', hermesVersion: '0.18.2',
    hermesConfigHash: 'c'.repeat(64), directive}
} as const;

describe('runner completion composed provenance', () => {
  it('requires exact bounded Hermes/Codex provenance and rejects drift', () => {
    expect(parseRunnerCompletionPayload(base)?.runtimeProvenance).toEqual(base.runtimeProvenance);
    expect(parseRunnerCompletionPayload({...base, runtimeProvenance: undefined})).toBeNull();
    expect(parseRunnerCompletionPayload({...base, runtimeProvenance: {
      ...base.runtimeProvenance, executor: 'hermes'
    }})).toBeNull();
    expect(parseRunnerCompletionPayload({...base, runtimeId: 'codex-cli'})).toBeNull();
  });
});
