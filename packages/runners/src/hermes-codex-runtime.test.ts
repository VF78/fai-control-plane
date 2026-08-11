import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {canonicalJson, type CanonicalJson, type HermesCodexWorkOrder} from '@fai-control-plane/domain';
import {describe, expect, it, vi} from 'vitest';
import {createHermesDirectivePlanner, type HermesProcessExecutor,
  type RedactedProcessOutputMetadata} from './index';

const emptyOutput = (): RedactedProcessOutputMetadata => ({observedBytes: 0, boundedBytes: 0,
  truncated: false, sha256: createHash('sha256').update('').digest('hex'), contentRetained: false});

describe('Hermes orchestrator with Codex CLI executor', () => {
  it('accepts only bounded canonical choices and preserves factual provenance', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fai-hermes-codex-')));
    const home = path.join(root, 'hermes'); await mkdir(home);
    const python = path.join(root, 'python'); const entrypoint = path.join(root, 'entrypoint.py');
    const config = path.join(home, 'config.yaml');
    await Promise.all([writeFile(python, ''), writeFile(entrypoint, ''), writeFile(config, 'bounded: true\n')]);
    const configHash = createHash('sha256').update('bounded: true\n').digest('hex');
    const packetId = randomUUID(); const packetHash = 'a'.repeat(64);
    const workOrder = {schemaVersion: 1, runtime: {hermesVersion: '0.18.2', hermesConfigSha256: configHash},
      taskPacket: {id: packetId, sha256: packetHash,
      timeboxMinutes: 15, acceptanceCriteria: ['typecheck passes']}, orchestration: {
        strategyOptions: ['evidence_first', 'risk_first', 'minimal_change'],
        stepIds: ['step.inspect_scope', 'step.implement_scoped_change', 'step.verify_evidence', 'step.report'],
        checkCandidates: [{id: 'check.acceptance.0', requirementIndex: 0}],
        riskControlIds: ['risk.no_external_provider_write', 'risk.no_merge', 'risk.no_release',
          'risk.no_deploy', 'risk.no_production_access']}} as unknown as HermesCodexWorkOrder;
    const workOrderHash = createHash('sha256').update(canonicalJson(workOrder as unknown as CanonicalJson)).digest('hex');
    const hermesRequests: string[] = [];
    const hermes = vi.fn<HermesProcessExecutor>(async (request) => {
      hermesRequests.push(request.stdin);
      return {termination: 'exit', exitCode: 0, signal: null, stderr: emptyOutput(),
        stdout: request.args.includes('--preflight')
          ? JSON.stringify({status: 'ready', version: '0.18.2', engine: 'hermes_auxiliary_client',
              agentBootstrap: false, toolArgumentCount: 0, configSha256: configHash})
          : JSON.stringify({schemaVersion: 1, orchestrator: 'hermes', executor: 'codex-cli',
              taskPacketId: packetId, taskPacketHash: packetHash, workOrderHash, strategy: 'risk_first',
              orderedStepIds: ['step.inspect_scope', 'step.verify_evidence', 'step.implement_scoped_change', 'step.report'],
              selectedCheckIds: ['check.acceptance.0'], selectedRiskControlIds: [
                'risk.no_production_access', 'risk.no_deploy', 'risk.no_release', 'risk.no_merge',
                'risk.no_external_provider_write']})};
    });
    const planner = createHermesDirectivePlanner({pythonExecutable: python, entrypoint, home,
      configFile: config, configSha256: configHash, expectedVersion: '0.18.2', executor: hermes});
    await planner.preflight();
    const result = await planner.plan({runId: randomUUID(), packetId, packetHash,
      timeboxMinutes: 15, workOrder, workOrderHash});
    expect(result).toMatchObject({workOrderHash, hermesVersion: '0.18.2', hermesConfigHash: configHash,
      directive: {strategy: 'risk_first'}});
  });

  it('fails closed when preflight observes any Hermes tool', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fai-hermes-tools-')));
    const home = path.join(root, 'home'); await mkdir(home);
    const python = path.join(root, 'python'); const entrypoint = path.join(root, 'entrypoint.py');
    const config = path.join(home, 'config.yaml'); await Promise.all([writeFile(python, ''),
      writeFile(entrypoint, ''), writeFile(config, 'x')]);
    const hash = createHash('sha256').update('x').digest('hex');
    const planner = createHermesDirectivePlanner({pythonExecutable: python, entrypoint, home,
      configFile: config, configSha256: hash, expectedVersion: '0.18.2', executor: async () => ({
        termination: 'exit', exitCode: 0, signal: null, stderr: emptyOutput(), stdout: JSON.stringify({
          status: 'ready', version: '0.18.2', engine: 'hermes_auxiliary_client',
          agentBootstrap: false, toolArgumentCount: 1, configSha256: hash})})});
    await expect(planner.preflight()).rejects.toThrow('hermes_codex_preflight_invalid');
  });
});
