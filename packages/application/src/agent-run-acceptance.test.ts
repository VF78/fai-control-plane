import {randomUUID} from 'node:crypto';
import {expect, it, vi} from 'vitest';
import {createActorContextIssuer, type DeliveryProtocolStage} from '@fai-control-plane/domain';
import {
  AGENT_RUN_ACCEPTANCE_COMMAND,
  createAgentRunAcceptanceService,
  mapRunnerCompletionToDeliveryEvidence,
  type AgentRunAcceptanceStore,
  type RunnerCompletionPayload
} from './index';

const runId = '00000000-0000-4000-8000-000000000001';
const receiptSha256 = 'a'.repeat(64);
const summarySha256 = 'b'.repeat(64);
const manifestSha256 = 'c'.repeat(64);
const stage: DeliveryProtocolStage = {
  key: 'development', name: 'Development', enabled: true, taskStatus: 'in_dev',
  responsibility: {kind: 'project_role', role: 'project_owner'},
  executionMode: 'autonomous', entryCriteria: ['Ready'],
  requiredEvidence: ['Implementation change', 'Relevant checks'],
  allowedNextStageKey: 'qa'
};
const payload: RunnerCompletionPayload = {
  runId, attempt: 1, terminal: 'done', receiptSha256, receiptSizeBytes: 100,
  finalStatus: 'succeeded', runtimeId: 'runner', runtimeProfile: 'write_scoped',
  durationMs: 10, cost: {state: 'unknown', reason: 'runtime_usage_not_available'},
  usage: {state: 'unknown', reason: 'runtime_usage_not_available'},
  artifactStore: {provider: 'local', reference: `runs/${runId}`,
    correlationId: `artifact-run-${runId}`},
  receiptArtifact: {name: 'agent-run-receipt.json',
    reference: `runs/${runId}/agent-run-receipt.json`, sha256: receiptSha256, sizeBytes: 100},
  summaryArtifact: {name: 'structured-summary.json',
    reference: `runs/${runId}/structured-summary.json`, sha256: summarySha256, sizeBytes: 80},
  pathManifest: {name: 'observed-path-manifest.json',
    reference: `runs/${runId}/observed-path-manifest.json`, sha256: manifestSha256, sizeBytes: 70},
  changedFiles: ['src/change.ts'],
  checks: [{name: 'pnpm vitest run focused.test.ts', status: 'passed'}],
  riskCount: 0, nextAction: 'review_receipt'
};
const retained = [
  {kind: 'receipt' as const, storageProvider: 'local', storageKey: payload.receiptArtifact.reference,
    sha256: receiptSha256, sizeBytes: 100, redacted: false},
  {kind: 'summary' as const, storageProvider: 'local', storageKey: payload.summaryArtifact!.reference,
    sha256: summarySha256, sizeBytes: 80, redacted: false},
  {kind: 'path_manifest' as const, storageProvider: 'local', storageKey: payload.pathManifest.reference,
    sha256: manifestSha256, sizeBytes: 70, redacted: false}
];

it('maps retained receipt facts to every exact protocol requirement without check-name equality', () => {
  const result = mapRunnerCompletionToDeliveryEvidence(stage, payload, retained);
  expect(result).toMatchObject({ok: true, value: [
    {requirement: 'Implementation change'},
    {requirement: 'Relevant checks'}
  ]});
  if (!result.ok) throw new Error('expected evidence');
  expect(new Set(result.value.map(({reference}) => reference)).size).toBe(1);
  expect(result.value[0]?.reference).toContain(`summary=${summarySha256}`);
  expect(result.value[0]?.reference).toContain('changes=1;passed_checks=1');
});

it.each([
  ['missing retained summary', retained.filter(({kind}) => kind !== 'summary'), payload],
  ['failed check', retained, {...payload, checks: [{name: 'test', status: 'failed' as const}]}],
  ['no changed files', retained, {...payload, changedFiles: []}]
])('rejects %s', (_label, artifacts, candidate) => {
  expect(mapRunnerCompletionToDeliveryEvidence(stage, candidate, artifacts))
    .toMatchObject({ok: false, error: {code: 'INVALID_COMMAND'}});
});

const trusted = (capabilities: readonly string[] = ['write:control_plane:development']) => {
  const actorId = randomUUID();
  const issuer = createActorContextIssuer({
    users: [{actorId, capabilities: capabilities as never}], agents: [], systems: []
  });
  if (!issuer.ok) throw new Error('issuer fixture');
  const actor = issuer.value.issueUser(actorId);
  if (!actor.ok) throw new Error('actor fixture');
  return actor.value;
};

it('validates the first-class PO command and hashes only stable idempotency facts', async () => {
  const execute = vi.fn(async (input) => ({status: 'rejected' as const,
    error: {code: 'NOT_FOUND' as const, message: input.requestHash}}));
  const service = createAgentRunAcceptanceService({execute} as AgentRunAcceptanceStore);
  const actor = trusted();
  const command = {
    commandId: randomUUID(), workspaceId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `agent-run-accept:v1:${runId}:${receiptSha256}:${actor.actorId}`,
    issuedAt: '2026-08-09T10:00:00.000Z', actor,
    type: AGENT_RUN_ACCEPTANCE_COMMAND,
    payload: {runId, receiptSha256, expectedWorkItemVersion: 3}
  };
  await service.execute(command);
  await service.execute({...command, commandId: randomUUID(), correlationId: randomUUID(),
    issuedAt: '2026-08-09T10:01:00.000Z'});
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]![0]).toMatchObject({authorized: true,
    requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)});
  expect(execute.mock.calls[1]![0].requestHash).toBe(execute.mock.calls[0]![0].requestHash);
  await expect(service.execute({...command, idempotencyKey: 'caller-chosen'}))
    .resolves.toMatchObject({status: 'rejected', error: {code: 'INVALID_COMMAND'}});
});

it('passes a deny decision to persistence without broadening actor authority', async () => {
  const execute = vi.fn(async () => ({status: 'rejected' as const,
    error: {code: 'POLICY_DENIED' as const, message: 'denied'}}));
  const service = createAgentRunAcceptanceService({execute} as AgentRunAcceptanceStore);
  const actor = trusted([]);
  await service.execute({commandId: randomUUID(), workspaceId: randomUUID(),
    correlationId: randomUUID(), idempotencyKey: `agent-run-accept:v1:${runId}:${receiptSha256}:${actor.actorId}`,
    issuedAt: '2026-08-09T10:00:00.000Z', actor, type: AGENT_RUN_ACCEPTANCE_COMMAND,
    payload: {runId, receiptSha256, expectedWorkItemVersion: 3}});
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({authorized: false}));
});
