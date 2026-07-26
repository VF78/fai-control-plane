import {createHash} from 'node:crypto';
import {lstat, mkdir, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeResult,
  RedactedProcessOutputMetadata,
  RuntimeProfile
} from './index';
import type {
  AgentRunWorktree,
  WorktreeManager
} from './worktree-manager';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT_FILENAME = 'agent-run-receipt.json';

export type LocalAgentRunEnvelope = Readonly<{
  runId: string;
  packetId: string;
  packetHash: string;
  baseCommit: string;
  prompt: string;
  profile: RuntimeProfile;
  timeboxMinutes: number;
  signal?: AbortSignal;
}>;

type ReceiptArtifact = Readonly<{
  name: string;
  sha256: string;
  sizeBytes: number;
}>;

export type LocalAgentRunReceipt = Readonly<{
  schemaVersion: 1;
  recordedAt: string;
  runId: string;
  packetId: string;
  packetHash: string;
  runtimeId: string;
  profile: RuntimeProfile;
  baseCommit: string;
  branch: string;
  headCommit: string;
  finalStatus: AgentRuntimeResult['status'];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  output: Readonly<{
    stdout: RedactedProcessOutputMetadata;
    stderr: RedactedProcessOutputMetadata;
  }>;
  summaryArtifact?: ReceiptArtifact;
  worktreeDisposition: 'removed_clean' | 'retained_dirty';
  cost: Readonly<{
    state: 'unknown';
    reason: 'codex_cli_usage_not_available';
  }>;
  nextAction: 'review_receipt' | 'review_worktree' | 'retry_explicitly';
  writeBack: Readonly<{state: 'not_attempted'}>;
}>;

export type LocalAgentRunResult = Readonly<{
  receipt: LocalAgentRunReceipt;
  receiptRef: string;
  receiptSha256: string;
  receiptSizeBytes: number;
}>;

export type LocalAgentRunOrchestratorOptions = Readonly<{
  artifactRoot: string;
  worktrees: WorktreeManager;
  runtime: AgentRuntime;
  clock?: Readonly<{now(): Date}>;
}>;

export interface LocalAgentRunOrchestrator {
  run(envelope: LocalAgentRunEnvelope): Promise<LocalAgentRunResult>;
}

export class LocalAgentRunOrchestratorError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'LocalAgentRunOrchestratorError';
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new LocalAgentRunOrchestratorError(code);
};

const sha256 = (value: Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const canonicalRoot = async (value: string): Promise<string> => {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.resolve(value) !== value ||
    value === path.parse(value).root ||
    value.includes('\0')
  ) {
    fail('unsafe_artifact_root');
  }
  let canonical: string;
  let metadata;
  try {
    [canonical, metadata] = await Promise.all([realpath(value), lstat(value)]);
  } catch {
    return fail('missing_artifact_root');
  }
  if (
    canonical !== value ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    fail('unsafe_artifact_root');
  }
  return canonical;
};

const receiptExists = async (receiptPath: string): Promise<boolean> => {
  try {
    await lstat(receiptPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const summaryArtifact = (
  result: AgentRuntimeResult,
  artifactPath: string
): ReceiptArtifact | undefined => {
  if (result.status !== 'succeeded') return undefined;
  if (
    path.dirname(result.summaryRef) !== artifactPath ||
    path.basename(result.summaryRef).length === 0
  ) {
    fail('unsafe_summary_reference');
  }
  return {
    name: path.basename(result.summaryRef),
    sha256: result.summarySha256,
    sizeBytes: result.summarySizeBytes
  };
};

const nextActionFor = (
  result: AgentRuntimeResult,
  dirty: boolean
): LocalAgentRunReceipt['nextAction'] => {
  if (result.status !== 'succeeded') return 'retry_explicitly';
  return dirty ? 'review_worktree' : 'review_receipt';
};

const runtimeInput = (
  envelope: LocalAgentRunEnvelope,
  worktree: AgentRunWorktree,
  artifactPath: string
): AgentRuntimeInput => ({
  runId: envelope.runId,
  packetId: envelope.packetId,
  packetHash: envelope.packetHash,
  prompt: envelope.prompt,
  workspacePath: worktree.worktreePath,
  artifactPath,
  profile: envelope.profile,
  timeboxMinutes: envelope.timeboxMinutes,
  ...(envelope.signal === undefined ? {} : {signal: envelope.signal})
});

export const createLocalAgentRunOrchestrator = (
  options: LocalAgentRunOrchestratorOptions
): LocalAgentRunOrchestrator => {
  const clock = options.clock ?? {now: () => new Date()};

  return {
    async run(envelope) {
      if (!UUID_PATTERN.test(envelope.runId)) fail('invalid_run_id');
      const artifactRoot = await canonicalRoot(options.artifactRoot);
      const artifactPath = path.join(artifactRoot, envelope.runId);
      const receiptPath = path.join(artifactPath, RECEIPT_FILENAME);
      if (await receiptExists(receiptPath)) fail('receipt_already_exists');
      await mkdir(artifactPath, {recursive: true, mode: 0o700});

      const worktree = await options.worktrees.prepare({
        runId: envelope.runId,
        baseCommit: envelope.baseCommit
      });
      const runtimeResult = await options.runtime.run(
        runtimeInput(envelope, worktree, artifactPath)
      );
      const inspection = await options.worktrees.inspect(worktree);
      const worktreeDisposition = inspection.dirty
        ? 'retained_dirty'
        : 'removed_clean';
      if (!inspection.dirty) await options.worktrees.cleanup(worktree);
      const summary = summaryArtifact(runtimeResult, artifactPath);

      const receipt: LocalAgentRunReceipt = {
        schemaVersion: 1,
        recordedAt: clock.now().toISOString(),
        runId: envelope.runId,
        packetId: envelope.packetId,
        packetHash: envelope.packetHash,
        runtimeId: runtimeResult.runtimeId,
        profile: envelope.profile,
        baseCommit: worktree.baseCommit,
        branch: worktree.branch,
        headCommit: inspection.headCommit,
        finalStatus: runtimeResult.status,
        startedAt: runtimeResult.startedAt,
        finishedAt: runtimeResult.finishedAt,
        durationMs: runtimeResult.durationMs,
        output: {
          stdout: runtimeResult.stdout,
          stderr: runtimeResult.stderr
        },
        ...(summary === undefined ? {} : {summaryArtifact: summary}),
        worktreeDisposition,
        cost: {
          state: 'unknown',
          reason: 'codex_cli_usage_not_available'
        },
        nextAction: nextActionFor(runtimeResult, inspection.dirty),
        writeBack: {state: 'not_attempted'}
      };
      const body = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      try {
        await writeFile(receiptPath, body, {flag: 'wx', mode: 0o600});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          fail('receipt_already_exists');
        }
        throw error;
      }
      return {
        receipt,
        receiptRef: receiptPath,
        receiptSha256: sha256(body),
        receiptSizeBytes: body.byteLength
      };
    }
  };
};
