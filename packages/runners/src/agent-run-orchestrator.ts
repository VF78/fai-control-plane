import {createHash} from 'node:crypto';
import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeResult,
  RedactedProcessOutputMetadata,
  RuntimePolicyRuleId,
  RuntimeProfile
} from './index';
import type {
  RepositoryHostPublicationFailureReason,
  RepositoryHostPublisher
} from './repository-host-publisher';
import type {
  AgentRunWorktree,
  AgentRunWorktreeInspection,
  WorktreeManager
} from './worktree-manager';
import {
  createLocalFilesystemArtifactStore,
  type ArtifactDescriptor,
  type ArtifactRun,
  type ArtifactStore
} from './artifact-store';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_CHECK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,_:()/-]{0,127}$/;
const SAFE_BASE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/;

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
  provider: string;
  name: string;
  reference: string;
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
  policy: AgentRuntimeResult['policy'];
  artifacts: Readonly<{
    provider: string;
    storeRef: string;
    correlationId: string;
    pathManifest: ReceiptArtifact;
    summary?: ReceiptArtifact;
  }>;
  summaryArtifact?: ReceiptArtifact;
  worktreeDisposition:
    | 'removed_clean'
    | 'retained_dirty'
    | 'retained_policy_denied';
  cost: Readonly<{
    state: 'unknown';
    reason: 'runtime_usage_not_available';
  }>;
  nextAction: 'review_receipt' | 'review_worktree' | 'retry_explicitly';
  writeBack:
    | Readonly<{
        state: 'not_attempted';
        reason: 'repository_host_publication_disabled';
      }>
    | Readonly<{
        state: 'blocked';
        reason:
          | 'runtime_not_succeeded'
          | 'worktree_dirty'
          | 'no_changes'
          | 'unsafe_generated_branch'
          | 'evidence_unavailable'
          | 'evidence_not_satisfied';
      }>
    | Readonly<{
        state: 'failed';
        reason: RepositoryHostPublicationFailureReason | 'publisher_failed';
      }>
    | Readonly<{
        state: 'published';
        externalChangeRef: string;
        externalChangeUrl: string;
        externalChangeStatus: 'draft';
      }>;
}>;

export type LocalAgentRunResult = Readonly<{
  receipt: LocalAgentRunReceipt;
  completionEvidence: Readonly<{
    changedFiles: readonly string[];
    checks: readonly Readonly<{
      name: string;
      status: 'passed' | 'failed' | 'not_run';
    }>[];
    riskCount: number;
  }>;
  receiptArtifact: ArtifactDescriptor;
  receiptRef: string;
  receiptSha256: string;
  receiptSizeBytes: number;
}>;

export type LocalAgentRunOrchestratorOptions = Readonly<{
  /** @deprecated Use artifactStore. Kept as the local adapter convenience. */
  artifactRoot?: string;
  artifactStore?: ArtifactStore;
  worktrees: WorktreeManager;
  runtime: AgentRuntime;
  clock?: Readonly<{now(): Date}>;
  publication?: Readonly<{
    enabled: true;
    repositoryTarget: string;
    baseRef: string;
    requiredCheckNames: readonly string[];
    publisher: RepositoryHostPublisher;
  }>;
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

const summaryArtifact = (
  result: AgentRuntimeResult,
  artifact: ArtifactDescriptor | undefined
): ReceiptArtifact | undefined => {
  if (result.status !== 'succeeded' || artifact === undefined) return undefined;
  return {
    provider: artifact.provider,
    name: artifact.name,
    reference: artifact.reference,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes
  };
};

const safeObservedPath = (value: string): boolean =>
  /^[A-Za-z0-9.][A-Za-z0-9._/-]{0,191}$/.test(value) &&
  !value.includes('//') &&
  !value.split('/').some((part) => part === '.' || part === '..');

const observedPathManifest = (
  worktree: AgentRunWorktree,
  inspection: AgentRunWorktreeInspection
): Readonly<{
  schemaVersion: 1;
  source: 'worktree_inspection';
  baseCommit: string;
  headCommit: string;
  pathBoundaryViolation: boolean;
  mergeCommitCount: number;
  paths: readonly string[];
  pathsTruncated: boolean;
}> => {
  const safePaths = inspection.changedPaths.filter(safeObservedPath);
  if (safePaths.length !== inspection.changedPaths.length) {
    fail('unsafe_observed_path');
  }
  const paths = [...new Set(safePaths)].sort();
  return {
    schemaVersion: 1,
    source: 'worktree_inspection',
    baseCommit: worktree.baseCommit,
    headCommit: inspection.headCommit,
    pathBoundaryViolation: inspection.pathBoundaryViolation,
    mergeCommitCount: inspection.mergeCommits.length,
    paths: paths.slice(0, 100),
    pathsTruncated: paths.length > 100
  };
};

const structuredSummary = (
  result: AgentRuntimeResult,
  manifest: ReturnType<typeof observedPathManifest>
): Readonly<{
  schemaVersion: 1;
  status: 'completed' | 'blocked';
  changedFiles: readonly string[];
  checks: readonly Readonly<{
    name: string;
    status: 'passed' | 'failed' | 'not_run';
  }>[];
  riskCount: number;
}> | undefined => result.status === 'succeeded'
  ? {
      schemaVersion: 1,
      status: result.evidence.status,
      changedFiles: manifest.paths,
      checks: result.evidence.checks,
      riskCount: result.evidence.riskCount
    }
  : undefined;

const artifactStoreFor = (
  options: LocalAgentRunOrchestratorOptions
): ArtifactStore => {
  if (options.artifactStore !== undefined && options.artifactRoot !== undefined) {
    fail('ambiguous_artifact_store');
  }
  if (options.artifactStore !== undefined) return options.artifactStore;
  if (options.artifactRoot !== undefined) {
    return createLocalFilesystemArtifactStore({root: options.artifactRoot});
  }
  return fail('missing_artifact_store');
};

const nextActionFor = (
  result: AgentRuntimeResult,
  retainedWorktree: boolean,
  writeBack: LocalAgentRunReceipt['writeBack']
): LocalAgentRunReceipt['nextAction'] => {
  if (retainedWorktree) return 'review_worktree';
  if (result.status !== 'succeeded') return 'retry_explicitly';
  if (writeBack.state === 'failed') return 'retry_explicitly';
  if (writeBack.state === 'blocked' && writeBack.reason !== 'no_changes') {
    return 'retry_explicitly';
  }
  return 'review_receipt';
};

const safeRef = (value: string): boolean =>
  SAFE_BASE_REF_PATTERN.test(value) &&
  !value.includes('//') &&
  !value.split('/').some((part) => part === '.' || part === '..');

const protectedObservedPath = (value: string): boolean =>
  value === '.git' ||
  value.startsWith('.git/') ||
  value === '.github/workflows' ||
  value.startsWith('.github/workflows/') ||
  value === 'scripts/deploy' ||
  value.startsWith('scripts/deploy-') ||
  value.startsWith('scripts/deploy/');

const observedPolicyRules = (
  profile: RuntimeProfile,
  inspection: AgentRunWorktreeInspection
): readonly RuntimePolicyRuleId[] => {
  const denied: RuntimePolicyRuleId[] = [];
  if (profile === 'read_safe' && inspection.changedPaths.length > 0) {
    denied.push('read_safe_worktree_changed');
  }
  if (inspection.changedPaths.some(protectedObservedPath)) {
    denied.push('protected_path_changed');
  }
  if (inspection.pathBoundaryViolation) denied.push('worktree_path_escape');
  if (inspection.mergeCommits.length > 0) denied.push('merge_history_changed');
  return denied;
};

const denyFromObservedState = (
  result: AgentRuntimeResult,
  deniedRuleIds: readonly RuntimePolicyRuleId[]
): AgentRuntimeResult => {
  if (deniedRuleIds.length === 0) return result;
  const base = {
    runtimeId: result.runtimeId,
    runId: result.runId,
    packetId: result.packetId,
    packetHash: result.packetHash,
    profile: result.profile,
    executionMetadata: result.executionMetadata,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    policy: {
      ...result.policy,
      decision: 'denied' as const,
      deniedRuleIds: [...new Set([
        ...result.policy.deniedRuleIds,
        ...deniedRuleIds
      ])]
    }
  };
  return {
    ...base,
    status: 'policy_denied',
    exitCode: null,
    signal: null
  };
};

const validatePublicationOptions = (
  publication: LocalAgentRunOrchestratorOptions['publication']
): void => {
  if (publication === undefined) return;
  if (
    publication.enabled !== true ||
    publication.repositoryTarget.length === 0 ||
    publication.repositoryTarget.length > 256 ||
    publication.repositoryTarget.includes('\0') ||
    !safeRef(publication.baseRef) ||
    publication.requiredCheckNames.length === 0 ||
    publication.requiredCheckNames.length > 24 ||
    new Set(publication.requiredCheckNames).size !==
      publication.requiredCheckNames.length ||
    publication.requiredCheckNames.some(
      (name) => !SAFE_CHECK_NAME_PATTERN.test(name)
    )
  ) {
    fail('invalid_publication_configuration');
  }
};

const publicationWriteBack = async (
  options: LocalAgentRunOrchestratorOptions,
  envelope: LocalAgentRunEnvelope,
  worktree: AgentRunWorktree,
  result: AgentRuntimeResult,
  inspection: AgentRunWorktreeInspection,
  summary: ReceiptArtifact | undefined
): Promise<LocalAgentRunReceipt['writeBack']> => {
  const publication = options.publication;
  if (publication === undefined) {
    return {
      state: 'not_attempted',
      reason: 'repository_host_publication_disabled'
    };
  }
  if (result.status !== 'succeeded') {
    return {state: 'blocked', reason: 'runtime_not_succeeded'};
  }
  if (inspection.dirty) return {state: 'blocked', reason: 'worktree_dirty'};
  if (inspection.headCommit === worktree.baseCommit) {
    return {state: 'blocked', reason: 'no_changes'};
  }
  if (worktree.branch !== `fai/run/${envelope.runId}`) {
    return {state: 'blocked', reason: 'unsafe_generated_branch'};
  }
  if (summary === undefined) {
    return {state: 'blocked', reason: 'evidence_unavailable'};
  }
  const values = result.evidence;
  if (
    values.status !== 'completed' ||
    values.changedFiles.length === 0 ||
    values.checks.length === 0 ||
    values.checks.some((check) => check.status !== 'passed') ||
    publication.requiredCheckNames.some(
      (required) => !values.checks.some(
        (check) => check.name === required && check.status === 'passed'
      )
    )
  ) {
    return {state: 'blocked', reason: 'evidence_not_satisfied'};
  }

  const idempotencyKey = sha256(Buffer.from([
    publication.repositoryTarget,
    publication.baseRef,
    worktree.branch,
    inspection.headCommit
  ].join('\0'), 'utf8'));
  try {
    const published = await publication.publisher.publishDraftChange({
      repositoryTarget: publication.repositoryTarget,
      baseRef: publication.baseRef,
      baseCommit: worktree.baseCommit,
      headCommit: inspection.headCommit,
      branch: worktree.branch,
      title: `Automated change for run ${envelope.runId}`,
      body: [
        'Automated draft change request.',
        '',
        `Run: ${envelope.runId}`,
        `Packet: ${envelope.packetId}`,
        `Evidence: ${values.artifact.sha256}`
      ].join('\n'),
      idempotencyKey
    });
    if (published.status === 'failed') {
      return {state: 'failed', reason: published.reason};
    }
    return {
      state: 'published',
      externalChangeRef: published.externalChangeRef,
      externalChangeUrl: published.externalChangeUrl,
      externalChangeStatus: published.externalChangeStatus
    };
  } catch {
    return {state: 'failed', reason: 'publisher_failed'};
  }
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
  validatePublicationOptions(options.publication);
  const clock = options.clock ?? {now: () => new Date()};
  const artifactStore = artifactStoreFor(options);

  return {
    async run(envelope) {
      if (!UUID_PATTERN.test(envelope.runId)) fail('invalid_run_id');
      let artifacts: ArtifactRun;
      try {
        artifacts = await artifactStore.allocateRun(envelope.runId);
      } catch (error) {
        if ((error as {code?: string}).code === 'run_collision') {
          fail('artifact_directory_collision');
        }
        throw error;
      }

      let worktree: AgentRunWorktree;
      try {
        worktree = await options.worktrees.prepare({
          runId: envelope.runId,
          baseCommit: envelope.baseCommit
        });
      } catch (error) {
        await artifacts.abandon().catch(() => undefined);
        throw error;
      }
      let runtimeResult: AgentRuntimeResult;
      try {
        runtimeResult = await options.runtime.run(
          runtimeInput(envelope, worktree, artifacts.runtimePath)
        );
      } catch (error) {
        try {
          const inspection = await options.worktrees.inspect(worktree);
          if (!inspection.dirty) await options.worktrees.cleanup(worktree);
        } catch {
          // Cleanup is best-effort here; preserve the original runtime failure.
        }
        await artifacts.discardRuntimeScratch().catch(() => undefined);
        throw error;
      }
      try {
        const inspection = await options.worktrees.inspect(worktree);
        const observedRules = observedPolicyRules(envelope.profile, inspection);
        const effectiveRuntimeResult = denyFromObservedState(
          runtimeResult,
          observedRules
        );
        const retainForPolicy = observedRules.length > 0;
        const retainWorktree = inspection.dirty || retainForPolicy;
        const worktreeDisposition = inspection.dirty
          ? 'retained_dirty'
          : retainForPolicy
            ? 'retained_policy_denied'
            : 'removed_clean';
        const manifest = observedPathManifest(worktree, inspection);
        const pathManifest = await artifacts.writeJson('pathManifest', manifest);
        const summaryEvidence = structuredSummary(effectiveRuntimeResult, manifest);
        const storedSummary = summaryEvidence === undefined
          ? undefined
          : await artifacts.writeJson('summary', summaryEvidence);
        const summary = summaryArtifact(effectiveRuntimeResult, storedSummary);
        const writeBack = await publicationWriteBack(
          options,
          envelope,
          worktree,
          effectiveRuntimeResult,
          inspection,
          summary
        );
        if (!retainWorktree) await options.worktrees.cleanup(worktree);

        const receipt: LocalAgentRunReceipt = {
        schemaVersion: 1,
        recordedAt: clock.now().toISOString(),
        runId: envelope.runId,
        packetId: envelope.packetId,
        packetHash: envelope.packetHash,
        runtimeId: effectiveRuntimeResult.runtimeId,
        profile: envelope.profile,
        baseCommit: worktree.baseCommit,
        branch: worktree.branch,
        headCommit: inspection.headCommit,
        finalStatus: effectiveRuntimeResult.status,
        startedAt: effectiveRuntimeResult.startedAt,
        finishedAt: effectiveRuntimeResult.finishedAt,
        durationMs: effectiveRuntimeResult.durationMs,
        output: {
          stdout: effectiveRuntimeResult.stdout,
          stderr: effectiveRuntimeResult.stderr
        },
        policy: effectiveRuntimeResult.policy,
        artifacts: {
          provider: artifacts.provider,
          storeRef: artifacts.reference,
          correlationId: artifacts.correlationId,
          pathManifest: {
            provider: pathManifest.provider,
            name: pathManifest.name,
            reference: pathManifest.reference,
            sha256: pathManifest.sha256,
            sizeBytes: pathManifest.sizeBytes
          },
          ...(summary === undefined ? {} : {summary})
        },
        ...(summary === undefined ? {} : {summaryArtifact: summary}),
        worktreeDisposition,
        cost: {
          state: 'unknown',
          reason: 'runtime_usage_not_available'
        },
        nextAction: nextActionFor(
          effectiveRuntimeResult,
          retainWorktree,
          writeBack
        ),
        writeBack
        };
        const storedReceipt = await artifacts.writeJson('receipt', receipt);
        await artifacts.discardRuntimeScratch();
        await artifacts.finalize();
        return {
        receipt,
        completionEvidence: {
          changedFiles: summaryEvidence?.changedFiles ?? [],
          checks: summaryEvidence?.checks ?? [],
          riskCount: summaryEvidence?.riskCount ?? 0
        },
        receiptArtifact: storedReceipt,
        receiptRef: storedReceipt.reference,
        receiptSha256: storedReceipt.sha256,
        receiptSizeBytes: storedReceipt.sizeBytes
        };
      } finally {
        await artifacts.discardRuntimeScratch().catch(() => undefined);
      }
    }
  };
};
