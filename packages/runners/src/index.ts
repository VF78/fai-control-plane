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
}>;

export type AgentRuntimeResult =
  | (AgentRuntimeResultBase & Readonly<{
      status: 'succeeded';
      exitCode: 0;
      summaryRef: string;
      summarySha256: string;
      summarySizeBytes: number;
      schemaRef: string;
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
    }>);

export interface AgentRuntime {
  readonly runtimeId: string;
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>;
}

export interface SecretsProvider {
  resolve(reference: string, purpose: string): Promise<{
    value: string;
    expiresAt?: Date;
  }>;
}

export interface ArtifactStore {
  put(input: {
    runId: string;
    name: string;
    contentType: string;
    body: Uint8Array;
  }): Promise<{storageKey: string; sha256: string; sizeBytes: number}>;
}

export {
  CodexRuntimeInputError,
  createCodexAgentRuntime,
  type CodexAgentRuntimeOptions,
  type CodexProcessEnvironment,
  type ProcessExecutionRequest,
  type ProcessExecutionResult,
  type ProcessExecutor
} from './codex-agent-runtime';

export {
  createWorktreeManager,
  WorktreeManagerError,
  type AgentRunWorktree,
  type PrepareWorktreeInput,
  type WorktreeManager,
  type WorktreeManagerOptions
} from './worktree-manager';
