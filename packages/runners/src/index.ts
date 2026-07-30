export type RuntimeProfile = 'read_safe' | 'write_scoped';

export type AgentRuntimeInput = Readonly<{
  runId: string;
  packetId: string;
  packetHash: string;
  prompt: string;
  workspacePath: string;
  artifactPath: string;
  profile: RuntimeProfile;
  timeboxMinutes: number;
  signal?: AbortSignal;
}>;

export type RedactedProcessOutputMetadata = Readonly<{
  observedBytes: number;
  boundedBytes: number;
  truncated: boolean;
  sha256: string;
  contentRetained: false;
}>;

export type RuntimePolicyRuleId =
  | 'protected_path_write'
  | 'repository_merge'
  | 'release_operation'
  | 'deployment_operation'
  | 'production_access'
  | 'read_safe_worktree_changed'
  | 'protected_path_changed'
  | 'worktree_path_escape'
  | 'merge_history_changed';

export type RuntimePolicyEvidence = Readonly<{
  decision: 'allowed' | 'denied';
  filesystem: 'read_only' | 'workspace_only';
  network: 'denied';
  approvals: 'never';
  environment: 'allowlisted';
  tools: readonly ['codex_cli'];
  deniedRuleIds: readonly RuntimePolicyRuleId[];
}>;

export type AgentRuntimeEvidence = Readonly<{
  status: 'completed' | 'blocked';
  changedFiles: readonly string[];
  checks: readonly Readonly<{
    name: string;
    status: 'passed' | 'failed' | 'not_run';
  }>[];
  riskCount: number;
  artifact: Readonly<{
    sha256: string;
    sizeBytes: number;
  }>;
}>;

type AgentRuntimeResultBase = Readonly<{
  runtimeId: string;
  runId: string;
  packetId: string;
  packetHash: string;
  profile: RuntimeProfile;
  executionMetadata: Readonly<Record<string, string | number | boolean | null>>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdout: RedactedProcessOutputMetadata;
  stderr: RedactedProcessOutputMetadata;
  policy: RuntimePolicyEvidence;
}>;

export type AgentRuntimeResult =
  | (AgentRuntimeResultBase & Readonly<{
      status: 'succeeded';
      exitCode: 0;
      summaryRef: string;
      schemaRef: string;
      evidence: AgentRuntimeEvidence;
    }>)
  | (AgentRuntimeResultBase & Readonly<{
      status: 'process_failed';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      failureKind: 'spawn' | 'exit' | 'invalid_summary';
      errorCode?: string;
    }>)
  | (AgentRuntimeResultBase & Readonly<{
      status: 'timed_out' | 'cancelled';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>)
  | (AgentRuntimeResultBase & Readonly<{
      status: 'policy_denied';
      exitCode: null;
      signal: null;
    }>);

export interface AgentRuntime {
  readonly runtimeId: string;
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>;
}

export {
  CodexRuntimeInputError,
  codexRuntimeSettingsAdapter,
  createCodexAgentRuntime,
  readCodexStructuredSummary,
  type CodexAgentRuntimeOptions,
  type CodexProcessEnvironment,
  type CodexRuntimeSettings,
  type CodexStructuredSummary,
  type ProcessExecutionRequest,
  type ProcessExecutionResult,
  type ProcessExecutor
} from './codex-agent-runtime';

export {
  validateRuntimeSettings,
  type PortableRuntimeBinding,
  type RuntimeSettingsAdapter,
  type RuntimeSettingsValidation
} from './runtime-adapter';

export {
  hermesRuntimeSettingsAdapter,
  type HermesRuntimeSettings
} from './hermes-runtime-adapter';

export {
  createWorktreeManager,
  WorktreeManagerError,
  type AgentRunWorktree,
  type AgentRunWorktreeInspection,
  type PrepareWorktreeInput,
  type WorktreeManager,
  type WorktreeManagerOptions
} from './worktree-manager';

export {
  ArtifactStoreError,
  createLocalFilesystemArtifactStore,
  type ArtifactDescriptor,
  type ArtifactKind,
  type ArtifactRun,
  type ArtifactStore,
  type LocalFilesystemArtifactStoreOptions
} from './artifact-store';

export {
  createLocalAgentRunOrchestrator,
  LocalAgentRunOrchestratorError,
  type LocalAgentRunEnvelope,
  type LocalAgentRunOrchestrator,
  type LocalAgentRunOrchestratorOptions,
  type LocalAgentRunReceipt,
  type LocalAgentRunResult
} from './agent-run-orchestrator';

export {
  type RepositoryHostPublicationFailureReason,
  type RepositoryHostPublicationReceipt,
  type RepositoryHostPublisher,
  type RepositoryHostPublishDraftChangeInput
} from './repository-host-publisher';

export {
  createGitHubRepositoryHostPublisher,
  type GitHubRepositoryHostPublisherOptions,
  type RepositoryHostProcessExecutor,
  type RepositoryHostProcessRequest
} from './github-repository-host-publisher';

export {
  runWorkstationRunnerFromEnvironment,
  runWorkstationRunnerOnce,
  type WorkstationRunnerClientOptions,
  type WorkstationRunnerEnvironment,
  type WorkstationRunnerFromEnvironmentResult,
  type WorkstationRunnerOnceResult
} from './workstation-runner';
