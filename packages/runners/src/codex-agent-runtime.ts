import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeResult,
  RedactedProcessOutputMetadata,
  RuntimeProfile
} from './index';

const MAX_TIMEBOX_MINUTES = 120;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_SUMMARY_BYTES = 64 * 1024;
const OUTPUT_METADATA_BOUND_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const OUTPUT_SCHEMA_FILENAME = 'codex-agent-summary.schema.json';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ALLOWED_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP'
]);

const outputSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'changedFiles', 'checks', 'risks', 'nextAction'],
  properties: {
    status: {type: 'string', enum: ['completed', 'blocked']},
    summary: {type: 'string', minLength: 1, maxLength: 8_000},
    changedFiles: {
      type: 'array',
      maxItems: 100,
      items: {type: 'string', minLength: 1, maxLength: 4_096}
    },
    checks: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status', 'detail'],
        properties: {
          name: {type: 'string', minLength: 1, maxLength: 256},
          status: {
            type: 'string',
            enum: ['passed', 'failed', 'not_run']
          },
          detail: {type: 'string', maxLength: 2_000}
        }
      }
    },
    risks: {
      type: 'array',
      maxItems: 100,
      items: {type: 'string', minLength: 1, maxLength: 2_000}
    },
    nextAction: {type: 'string', minLength: 1, maxLength: 2_000}
  }
} as const;

const outputSchemaBody = `${JSON.stringify(outputSchema, null, 2)}\n`;

export type CodexProcessEnvironment = Readonly<{
  PATH: string;
  PATHEXT?: string;
  SYSTEMROOT?: string;
  TEMP?: string;
  TMP?: string;
}>;

export type ProcessExecutionRequest = Readonly<{
  executable: 'codex';
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export type ProcessExecutionResult = Readonly<{
  termination: 'exit' | 'timeout' | 'cancelled' | 'spawn_error';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
  stdout: RedactedProcessOutputMetadata;
  stderr: RedactedProcessOutputMetadata;
}>;

export type ProcessExecutor = (
  request: ProcessExecutionRequest
) => Promise<ProcessExecutionResult>;

export type CodexAgentRuntimeOptions = Readonly<{
  codexHome: string;
  environment: CodexProcessEnvironment;
  executor?: ProcessExecutor;
}>;

export class CodexRuntimeInputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CodexRuntimeInputError';
    this.code = code;
  }
}

function inputError(code: string): never {
  throw new CodexRuntimeInputError(code);
}

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const emptyOutputMetadata = (): RedactedProcessOutputMetadata => ({
  observedBytes: 0,
  boundedBytes: 0,
  truncated: false,
  sha256: sha256(''),
  contentRetained: false
});

const validateUuid = (value: unknown, field: string): void => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    inputError(`invalid_${field}`);
  }
};

function validateAbsoluteNormalizedPath(
  value: unknown,
  field: string
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.resolve(value) !== value ||
    value === path.parse(value).root
  ) {
    inputError(`unsafe_${field}`);
  }
}

const isWithin = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const rejectOverlappingPaths = (
  first: string,
  second: string,
  code: string
): void => {
  if (isWithin(first, second) || isWithin(second, first)) inputError(code);
};

const canonicalDirectory = async (
  value: string,
  field: string
): Promise<string> => {
  let stats;
  let canonical;
  try {
    [stats, canonical] = await Promise.all([lstat(value), realpath(value)]);
  } catch {
    return inputError(`missing_${field}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || canonical !== value) {
    inputError(`unsafe_${field}`);
  }
  return canonical;
};

const validateEnvironment = (
  environment: unknown
): Readonly<Record<string, string>> => {
  if (
    typeof environment !== 'object' ||
    environment === null ||
    Array.isArray(environment)
  ) {
    inputError('unsafe_environment');
  }
  const supplied: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    environment as Record<string, unknown>
  )) {
    if (!ALLOWED_ENVIRONMENT_KEYS.has(key) || typeof value !== 'string') {
      inputError('unsafe_environment');
    }
    supplied[key] = value as string;
  }
  const environmentPath = supplied.PATH;
  if (typeof environmentPath !== 'string') {
    inputError('unsafe_environment_path');
  }
  if (environmentPath.length === 0 || environmentPath.includes('\0')) {
    inputError('unsafe_environment_path');
  }
  const lookupPaths = environmentPath.split(path.delimiter);
  if (
    lookupPaths.some(
      (entry) =>
        entry.length === 0 ||
        !path.isAbsolute(entry) ||
        path.normalize(entry) !== entry
    )
  ) {
    inputError('unsafe_environment_path');
  }
  for (const value of Object.values(supplied)) {
    if (value.length === 0 || value.includes('\0')) {
      inputError('unsafe_environment');
    }
  }
  return supplied;
};

const validateInput = (input: AgentRuntimeInput): void => {
  validateUuid(input.runId, 'run_id');
  validateUuid(input.packetId, 'packet_id');
  if (
    typeof input.packetHash !== 'string' ||
    !SHA256_PATTERN.test(input.packetHash)
  ) {
    inputError('invalid_packet_hash');
  }
  if (input.profile !== 'read_safe' && input.profile !== 'write_scoped') {
    inputError('invalid_runtime_profile');
  }
  if (
    !Number.isInteger(input.timeboxMinutes) ||
    input.timeboxMinutes < 1 ||
    input.timeboxMinutes > MAX_TIMEBOX_MINUTES
  ) {
    inputError('invalid_timebox');
  }
  if (typeof input.prompt !== 'string') inputError('invalid_prompt');
  const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
  if (
    promptBytes === 0 ||
    promptBytes > MAX_PROMPT_BYTES ||
    input.prompt.includes('\0')
  ) {
    inputError('invalid_prompt');
  }
  validateAbsoluteNormalizedPath(input.workspacePath, 'workspace_path');
  validateAbsoluteNormalizedPath(input.artifactPath, 'artifact_path');
};

const ensureArtifactDirectory = async (
  artifactPath: string,
  protectedPaths: readonly string[]
): Promise<string> => {
  let existingAncestor = artifactPath;
  while (true) {
    try {
      const [stats, canonicalAncestor] = await Promise.all([
        lstat(existingAncestor),
        realpath(existingAncestor)
      ]);
      if (
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        canonicalAncestor !== existingAncestor
      ) {
        inputError('unsafe_artifact_path');
      }
      const canonicalTarget = path.join(
        canonicalAncestor,
        path.relative(existingAncestor, artifactPath)
      );
      if (canonicalTarget !== artifactPath) inputError('unsafe_artifact_path');
      for (const protectedPath of protectedPaths) {
        rejectOverlappingPaths(
          protectedPath,
          canonicalTarget,
          'unsafe_artifact_path'
        );
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) inputError('unsafe_artifact_path');
      existingAncestor = parent;
    }
  }

  await mkdir(artifactPath, {recursive: true, mode: 0o700});
  return canonicalDirectory(artifactPath, 'artifact_path');
};

const ensureOutputSchema = async (schemaPath: string): Promise<void> => {
  try {
    const stats = await lstat(schemaPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      inputError('unsafe_output_schema');
    }
    const existing = await readFile(schemaPath, 'utf8');
    if (existing !== outputSchemaBody) inputError('output_schema_mismatch');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await writeFile(schemaPath, outputSchemaBody, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      await ensureOutputSchema(schemaPath);
    }
  }
};

const ensureSummaryTargetAbsent = async (summaryPath: string): Promise<void> => {
  try {
    await lstat(summaryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  inputError('summary_target_exists');
};

type StructuredSummary = Readonly<{
  status: 'completed' | 'blocked';
  summary: string;
  changedFiles: readonly string[];
  checks: readonly Readonly<{
    name: string;
    status: 'passed' | 'failed' | 'not_run';
    detail: string;
  }>[];
  risks: readonly string[];
  nextAction: string;
}>;

const isBoundedString = (
  value: unknown,
  minLength: number,
  maxLength: number
): value is string =>
  typeof value === 'string' &&
  value.length >= minLength &&
  value.length <= maxLength;

const isStringArray = (
  value: unknown,
  maxItems: number,
  maxLength: number
): value is string[] =>
  Array.isArray(value) &&
  value.length <= maxItems &&
  value.every((entry) => isBoundedString(entry, 1, maxLength));

const isStructuredSummary = (value: unknown): value is StructuredSummary => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  if (
    Object.keys(summary).sort().join(',') !==
    'changedFiles,checks,nextAction,risks,status,summary'
  ) {
    return false;
  }
  if (
    (summary.status !== 'completed' && summary.status !== 'blocked') ||
    !isBoundedString(summary.summary, 1, 8_000) ||
    !isStringArray(summary.changedFiles, 100, 4_096) ||
    !isStringArray(summary.risks, 100, 2_000) ||
    !isBoundedString(summary.nextAction, 1, 2_000) ||
    !Array.isArray(summary.checks) ||
    summary.checks.length > 100
  ) {
    return false;
  }
  return summary.checks.every((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const check = entry as Record<string, unknown>;
    return (
      Object.keys(check).sort().join(',') === 'detail,name,status' &&
      isBoundedString(check.name, 1, 256) &&
      (check.status === 'passed' ||
        check.status === 'failed' ||
        check.status === 'not_run') &&
      isBoundedString(check.detail, 0, 2_000)
    );
  });
};

const readStructuredSummary = async (
  summaryPath: string
): Promise<Readonly<{sha256: string; sizeBytes: number}>> => {
  const stats = await lstat(summaryPath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size === 0 ||
    stats.size > MAX_SUMMARY_BYTES
  ) {
    throw new Error('invalid_summary');
  }
  const body = await readFile(summaryPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('invalid_summary');
  }
  if (!isStructuredSummary(parsed)) throw new Error('invalid_summary');
  return {sha256: sha256(body), sizeBytes: body.byteLength};
};

type OutputAccumulator = Readonly<{
  observe(chunk: Buffer | string): void;
  finish(): RedactedProcessOutputMetadata;
}>;

const createOutputAccumulator = (): OutputAccumulator => {
  const digest = createHash('sha256');
  let observedBytes = 0;
  return {
    observe(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observedBytes += bytes.byteLength;
      digest.update(bytes);
    },
    finish() {
      return {
        observedBytes,
        boundedBytes: Math.min(observedBytes, OUTPUT_METADATA_BOUND_BYTES),
        truncated: observedBytes > OUTPUT_METADATA_BOUND_BYTES,
        sha256: digest.digest('hex'),
        contentRetained: false
      };
    }
  };
};

const nodeProcessExecutor: ProcessExecutor = async (
  request
): Promise<ProcessExecutionResult> => {
  if (request.signal?.aborted) {
    return {
      termination: 'cancelled',
      exitCode: null,
      signal: null,
      stdout: emptyOutputMetadata(),
      stderr: emptyOutputMetadata()
    };
  }

  return new Promise((resolve) => {
    const stdout = createOutputAccumulator();
    const stderr = createOutputAccumulator();
    let requestedTermination: 'timeout' | 'cancelled' | undefined;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: {...request.env},
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    const finish = (
      termination: ProcessExecutionResult['termination'],
      exitCode: number | null,
      processSignal: NodeJS.Signals | null,
      errorCode?: string
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      request.signal?.removeEventListener('abort', cancel);
      const result: ProcessExecutionResult = {
        termination,
        exitCode,
        signal: processSignal,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
        ...(errorCode === undefined ? {} : {errorCode})
      };
      resolve(result);
    };

    const terminate = (reason: 'timeout' | 'cancelled'): void => {
      if (requestedTermination !== undefined || settled) return;
      requestedTermination = reason;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, TERMINATION_GRACE_MS);
      forceKillTimer.unref();
    };

    const cancel = (): void => terminate('cancelled');
    const timeout = setTimeout(
      () => terminate('timeout'),
      request.timeoutMs
    );
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer | string) => stdout.observe(chunk));
    child.stderr.on('data', (chunk: Buffer | string) => stderr.observe(chunk));
    child.stdin.on('error', () => {
      // EPIPE is reflected by the child exit and must not expose prompt content.
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish('spawn_error', null, null, error.code ?? 'spawn_error');
    });
    child.once('close', (exitCode, processSignal) => {
      finish(
        requestedTermination ?? 'exit',
        exitCode,
        processSignal
      );
    });
    request.signal?.addEventListener('abort', cancel, {once: true});
    if (request.signal?.aborted) cancel();
    child.stdin.end(request.stdin);
  });
};

const sandboxFor = (
  profile: RuntimeProfile
): 'read-only' | 'workspace-write' =>
  profile === 'read_safe' ? 'read-only' : 'workspace-write';

const isoTime = (milliseconds: number): string =>
  new Date(milliseconds).toISOString();

export const createCodexAgentRuntime = (
  options: CodexAgentRuntimeOptions
): AgentRuntime => {
  const executor = options.executor ?? nodeProcessExecutor;

  return {
    runtimeId: 'codex-cli',
    async run(input): Promise<AgentRuntimeResult> {
      validateInput(input);
      validateAbsoluteNormalizedPath(options.codexHome, 'codex_home');
      const suppliedEnvironment = validateEnvironment(options.environment);
      const [workspacePath, codexHome] = await Promise.all([
        canonicalDirectory(input.workspacePath, 'workspace_path'),
        canonicalDirectory(options.codexHome, 'codex_home')
      ]);
      rejectOverlappingPaths(workspacePath, codexHome, 'unsafe_codex_home');
      rejectOverlappingPaths(workspacePath, input.artifactPath, 'unsafe_artifact_path');
      rejectOverlappingPaths(codexHome, input.artifactPath, 'unsafe_artifact_path');

      const artifactPath = await ensureArtifactDirectory(
        input.artifactPath,
        [workspacePath, codexHome]
      );
      rejectOverlappingPaths(workspacePath, artifactPath, 'unsafe_artifact_path');
      rejectOverlappingPaths(codexHome, artifactPath, 'unsafe_artifact_path');

      const schemaPath = path.join(artifactPath, OUTPUT_SCHEMA_FILENAME);
      const summaryPath = path.join(
        artifactPath,
        `codex-run-${input.runId}-summary.json`
      );
      await Promise.all([
        ensureOutputSchema(schemaPath),
        ensureSummaryTargetAbsent(summaryPath)
      ]);

      const sandbox = sandboxFor(input.profile);
      const args = [
        'exec',
        '-C',
        workspacePath,
        '--ephemeral',
        '--ignore-user-config',
        '--strict-config',
        '--json',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        summaryPath,
        '--sandbox',
        sandbox,
        '-'
      ] as const;
      const env = {
        ...suppliedEnvironment,
        CODEX_HOME: codexHome,
        NO_COLOR: '1'
      };
      const started = Date.now();
      const execution = await executor({
        executable: 'codex',
        args,
        cwd: workspacePath,
        env,
        stdin: input.prompt,
        timeoutMs: input.timeboxMinutes * 60_000,
        ...(input.signal === undefined ? {} : {signal: input.signal})
      });
      const finished = Date.now();
      const base = {
        runtimeId: 'codex-cli',
        runId: input.runId,
        packetId: input.packetId,
        packetHash: input.packetHash,
        profile: input.profile,
        executionMetadata: {sandbox},
        startedAt: isoTime(started),
        finishedAt: isoTime(finished),
        durationMs: Math.max(0, finished - started),
        stdout: execution.stdout,
        stderr: execution.stderr
      } as const;

      if (execution.termination === 'timeout') {
        return {
          ...base,
          status: 'timed_out',
          exitCode: execution.exitCode,
          signal: execution.signal
        };
      }
      if (execution.termination === 'cancelled') {
        return {
          ...base,
          status: 'cancelled',
          exitCode: execution.exitCode,
          signal: execution.signal
        };
      }
      if (execution.termination === 'spawn_error') {
        return {
          ...base,
          status: 'process_failed',
          exitCode: execution.exitCode,
          signal: execution.signal,
          failureKind: 'spawn',
          ...(execution.errorCode === undefined
            ? {}
            : {errorCode: execution.errorCode})
        };
      }
      if (execution.exitCode !== 0) {
        return {
          ...base,
          status: 'process_failed',
          exitCode: execution.exitCode,
          signal: execution.signal,
          failureKind: 'exit'
        };
      }

      try {
        const summary = await readStructuredSummary(summaryPath);
        return {
          ...base,
          status: 'succeeded',
          exitCode: 0,
          summaryRef: summaryPath,
          summarySha256: summary.sha256,
          summarySizeBytes: summary.sizeBytes,
          schemaRef: schemaPath
        };
      } catch {
        return {
          ...base,
          status: 'process_failed',
          exitCode: 0,
          signal: execution.signal,
          failureKind: 'invalid_summary'
        };
      }
    }
  };
};
