import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  isTrustedActorContext,
  validateDeliveryEvidenceReferences,
  type CanonicalCommandEnvelope,
  type CommandError,
  type DeliveryEvidenceReference,
  type DeliveryProtocolStage
} from '@fai-control-plane/domain';
import type {RunnerCompletionPayload} from './index.ts';

export const AGENT_RUN_ACCEPTANCE_COMMAND = 'agent_run.accept_result.v1' as const;

export type AcceptAgentRunResultCommand = CanonicalCommandEnvelope<
  typeof AGENT_RUN_ACCEPTANCE_COMMAND,
  Readonly<{
    runId: string;
    receiptSha256: string;
    expectedWorkItemVersion: number;
  }>
>;

export type AgentRunAcceptanceValue = Readonly<{
  projectId: string;
  workItemId: string;
  workItemStatus: string;
  workItemVersion: number;
  journeyStageKey: string;
  journeyVersion: number;
  executionStatus: 'paused';
  executionVersion: number;
  evidenceReferences: readonly DeliveryEvidenceReference[];
}>;

export type AgentRunAcceptanceReceipt = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  requestHash: string;
  commandType: typeof AGENT_RUN_ACCEPTANCE_COMMAND;
  result: Readonly<{ok: true; value: AgentRunAcceptanceValue}> |
    Readonly<{ok: false; error: CommandError}>;
  createdAt: string;
}>;

export type AgentRunAcceptanceExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: AgentRunAcceptanceReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;

export interface AgentRunAcceptanceStore {
  execute(input: Readonly<{
    command: AcceptAgentRunResultCommand;
    requestHash: string;
    authorized: boolean;
    policyError?: CommandError;
  }>): Promise<
    Readonly<{status: 'completed' | 'replayed'; receipt: AgentRunAcceptanceReceipt}> |
    Readonly<{status: 'key_reused'; existingRequestHash: string}> |
    Readonly<{status: 'rejected'; error: CommandError}>
  >;
}

export type RetainedRunnerArtifact = Readonly<{
  kind: 'receipt' | 'summary' | 'path_manifest';
  storageProvider: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  redacted: boolean;
}>;

const failure = (message: string) => ({
  ok: false as const,
  error: {code: 'INVALID_COMMAND' as const, message}
});

/**
 * Product Owner acceptance is a judgement over the retained receipt bundle.
 * Check labels are runner-authored descriptions, never requirement identities.
 */
export const mapRunnerCompletionToDeliveryEvidence = (
  stage: DeliveryProtocolStage,
  payload: RunnerCompletionPayload,
  retained: readonly RetainedRunnerArtifact[]
) => {
  if (payload.summaryArtifact === undefined || payload.changedFiles.length === 0 ||
    payload.checks.length === 0 || payload.checks.some(({status}) => status !== 'passed') ||
    payload.riskCount !== 0) {
    return failure('The retained receipt does not contain a successful summary, change set, and passed checks.');
  }
  const expected = [
    {kind: 'receipt' as const, value: payload.receiptArtifact},
    {kind: 'summary' as const, value: payload.summaryArtifact},
    {kind: 'path_manifest' as const, value: payload.pathManifest}
  ];
  if (expected.some(({kind, value}) => !retained.some((artifact) =>
    artifact.kind === kind && !artifact.redacted &&
    artifact.storageProvider === payload.artifactStore.provider &&
    artifact.storageKey === value.reference && artifact.sha256 === value.sha256 &&
    artifact.sizeBytes === value.sizeBytes))) {
    return failure('The receipt evidence bundle is not retained exactly.');
  }
  const reference = `agent-run-receipt:${payload.runId}:${payload.receiptSha256}` +
    `#summary=${payload.summaryArtifact.sha256};manifest=${payload.pathManifest.sha256};` +
    `changes=${payload.changedFiles.length};passed_checks=${payload.checks.length}`;
  return validateDeliveryEvidenceReferences(stage, stage.requiredEvidence.map((requirement) => ({
    requirement,
    reference
  })));
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/;
const exact = (value: object, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const valid = (command: AcceptAgentRunResultCommand): boolean =>
  typeof command === 'object' && command !== null &&
  exact(command, ['commandId', 'workspaceId', 'correlationId', 'idempotencyKey',
    'issuedAt', 'actor', 'type', 'payload']) &&
  isTrustedActorContext(command.actor) && uuid.test(command.commandId) &&
  uuid.test(command.workspaceId) && uuid.test(command.correlationId) &&
  timestamp(command.issuedAt) && command.type === AGENT_RUN_ACCEPTANCE_COMMAND &&
  typeof command.payload === 'object' && command.payload !== null &&
  exact(command.payload, ['runId', 'receiptSha256', 'expectedWorkItemVersion']) &&
  uuid.test(command.payload.runId) && sha256.test(command.payload.receiptSha256) &&
  Number.isSafeInteger(command.payload.expectedWorkItemVersion) &&
  command.payload.expectedWorkItemVersion > 0 &&
  command.idempotencyKey ===
    `agent-run-accept:v1:${command.payload.runId}:${command.payload.receiptSha256}:${command.actor.actorId}`;

const requestHash = (command: AcceptAgentRunResultCommand): string => createHash('sha256')
  .update(canonicalJson({
    workspaceId: command.workspaceId,
    idempotencyKey: command.idempotencyKey,
    actorId: command.actor.actorId,
    type: command.type,
    payload: command.payload
  } as never)).digest('hex');

const policyRequest = {
  actionCategory: 'write', surface: 'control_plane', environment: 'development'
} as const;

export const createAgentRunAcceptanceService = (store: AgentRunAcceptanceStore) => ({
  async execute(command: AcceptAgentRunResultCommand): Promise<AgentRunAcceptanceExecution> {
    if (!valid(command)) return {status: 'rejected', error: {
      code: 'INVALID_COMMAND', message: 'AgentRun acceptance command is not canonical.'
    }};
    if (command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') {
      return {status: 'rejected', error: {
        code: 'INVALID_ACTOR_CONTEXT', message: 'AgentRun results require an authenticated Product Owner.'
      }};
    }
    const policy = authorize(command.actor, policyRequest);
    const result = await store.execute({
      command,
      requestHash: requestHash(command),
      authorized: policy.ok,
      ...(!policy.ok ? {policyError: policy.error} : {})
    });
    return result.status === 'key_reused'
      ? {status: 'key_reused', error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'The acceptance key was already used for a different receipt command.'
        }}
      : result;
  }
});
