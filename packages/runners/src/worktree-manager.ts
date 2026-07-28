import {spawn} from 'node:child_process';
import {lstat, realpath} from 'node:fs/promises';
import path from 'node:path';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_BRANCH_PREFIX = 'fai/run/';

export type WorktreeManagerOptions = Readonly<{
  repositoryRoot: string;
  worktreeRoot: string;
  branchPrefix?: string;
}>;

export type PrepareWorktreeInput = Readonly<{
  runId: string;
  baseCommit: string;
}>;

export type AgentRunWorktree = Readonly<{
  runId: string;
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  status: 'prepared' | 'existing';
}>;

export type AgentRunWorktreeInspection = Readonly<{
  headCommit: string;
  dirty: boolean;
}>;

export interface WorktreeManager {
  prepare(input: PrepareWorktreeInput): Promise<AgentRunWorktree>;
  inspect(worktree: AgentRunWorktree): Promise<AgentRunWorktreeInspection>;
  cleanup(worktree: AgentRunWorktree): Promise<void>;
}

export class WorktreeManagerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'WorktreeManagerError';
    this.code = code;
  }
}

type GitResult = Readonly<{
  exitCode: number;
  stdout: string;
}>;

type GitWorktree = Readonly<{
  worktreePath: string;
  head?: string;
  branch?: string;
}>;

type ValidatedRoots = Readonly<{
  repositoryRoot: string;
  worktreeRoot: string;
}>;

function fail(code: string): never {
  throw new WorktreeManagerError(code);
}

const trimOutput = (value: string): string => value.replace(/\r?\n$/, '');

const isPathWithin = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

function assertAbsoluteNormalizedPath(
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
    fail(`invalid_${field}`);
  }
}

const canonicalDirectory = async (value: unknown, field: string): Promise<string> => {
  assertAbsoluteNormalizedPath(value, field);
  let canonicalPath = '';
  try {
    canonicalPath = await realpath(value);
  } catch {
    fail(`invalid_${field}`);
  }
  if (canonicalPath !== value) fail(`noncanonical_${field}`);

  let metadata;
  try {
    metadata = await lstat(canonicalPath);
  } catch {
    fail(`invalid_${field}`);
  }
  if (!metadata.isDirectory()) fail(`invalid_${field}`);
  return canonicalPath;
};

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await lstat(candidate);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const executeGit = async (
  cwd: string,
  args: readonly string[]
): Promise<GitResult> => new Promise((resolve, reject) => {
  const child = spawn('git', [...args], {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const stdout: Buffer[] = [];

  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.once('error', () => reject(new WorktreeManagerError('git_spawn_failed')));
  child.once('close', (exitCode) => {
    resolve({
      exitCode: exitCode ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8')
    });
  });
});

const requireGit = async (cwd: string, args: readonly string[]): Promise<GitResult> => {
  const result = await executeGit(cwd, args);
  if (result.exitCode !== 0) fail('git_command_failed');
  return result;
};

const parseWorktrees = (output: string): readonly GitWorktree[] => {
  const worktrees: GitWorktree[] = [];
  let current: {worktreePath: string; head?: string; branch?: string} | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line === '') {
      if (current !== undefined) worktrees.push(current);
      current = undefined;
    } else if (line.startsWith('worktree ')) {
      current = {worktreePath: line.slice('worktree '.length)};
    } else if (current !== undefined && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current !== undefined && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }
  if (current !== undefined) worktrees.push(current);
  return worktrees;
};

function validateRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== 'string' || !UUID_PATTERN.test(runId)) fail('invalid_run_id');
}

function validateBaseCommit(baseCommit: unknown): asserts baseCommit is string {
  if (typeof baseCommit !== 'string' || !COMMIT_SHA_PATTERN.test(baseCommit)) {
    fail('invalid_base_commit');
  }
}

const validateBranchPrefix = (branchPrefix: unknown): string => {
  if (
    typeof branchPrefix !== 'string' ||
    branchPrefix.length === 0 ||
    branchPrefix.includes('\0') ||
    !branchPrefix.endsWith('/')
  ) {
    fail('invalid_branch_prefix');
  }
  return branchPrefix;
};

export const createWorktreeManager = (options: WorktreeManagerOptions): WorktreeManager => {
  const branchPrefix = validateBranchPrefix(options.branchPrefix ?? DEFAULT_BRANCH_PREFIX);

  const validateRoots = async (): Promise<ValidatedRoots> => {
    const [repositoryRoot, worktreeRoot] = await Promise.all([
      canonicalDirectory(options.repositoryRoot, 'repository_root'),
      canonicalDirectory(options.worktreeRoot, 'worktree_root')
    ]);
    if (isPathWithin(repositoryRoot, worktreeRoot) || isPathWithin(worktreeRoot, repositoryRoot)) {
      fail('overlapping_roots');
    }
    const topLevel = trimOutput((await requireGit(
      repositoryRoot,
      ['rev-parse', '--show-toplevel']
    )).stdout);
    if (topLevel !== repositoryRoot) fail('repository_root_mismatch');
    return {repositoryRoot, worktreeRoot};
  };

  const refsFor = async (
    roots: ValidatedRoots,
    input: PrepareWorktreeInput
  ): Promise<Omit<AgentRunWorktree, 'status'>> => {
    validateRunId(input.runId);
    validateBaseCommit(input.baseCommit);
    const resolvedCommit = trimOutput((await requireGit(
      roots.repositoryRoot,
      ['rev-parse', '--verify', `${input.baseCommit}^{commit}`]
    )).stdout);
    if (resolvedCommit !== input.baseCommit) fail('base_commit_mismatch');

    const branch = `${branchPrefix}${input.runId}`;
    await requireGit(roots.repositoryRoot, ['check-ref-format', '--branch', branch]);
    return {
      runId: input.runId,
      repositoryRoot: roots.repositoryRoot,
      worktreePath: path.join(roots.worktreeRoot, input.runId),
      branch,
      baseCommit: input.baseCommit
    };
  };

  const branchCommit = async (repositoryRoot: string, branch: string): Promise<string | undefined> => {
    const result = await executeGit(repositoryRoot, [
      'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`
    ]);
    if (result.exitCode === 1) return undefined;
    if (result.exitCode !== 0) fail('git_command_failed');
    return trimOutput(result.stdout);
  };

  const requireBaseAncestor = async (
    repositoryRoot: string,
    baseCommit: string,
    headCommit: string
  ): Promise<void> => {
    const result = await executeGit(repositoryRoot, [
      'merge-base', '--is-ancestor', baseCommit, headCommit
    ]);
    if (result.exitCode === 1) fail('base_commit_not_ancestor');
    if (result.exitCode !== 0) fail('git_command_failed');
  };

  const validateExistingWorktree = async (
    refs: Omit<AgentRunWorktree, 'status'>,
    requireBaseHead = false
  ): Promise<string> => {
    const branchHead = await branchCommit(refs.repositoryRoot, refs.branch);
    if (branchHead === undefined) fail('worktree_branch_mismatch');
    const entries = parseWorktrees((await requireGit(
      refs.repositoryRoot,
      ['worktree', 'list', '--porcelain']
    )).stdout).filter((entry) => entry.worktreePath === refs.worktreePath);
    if (entries.length !== 1) fail('worktree_registration_mismatch');
    const entry = entries[0]!;
    if (
      entry.head !== branchHead ||
      entry.branch !== `refs/heads/${refs.branch}` ||
      !(await pathExists(refs.worktreePath))
    ) {
      fail('worktree_state_mismatch');
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(refs.worktreePath);
    } catch {
      fail('worktree_state_mismatch');
    }
    if (canonicalPath !== refs.worktreePath) fail('worktree_state_mismatch');
    const [topLevel, head] = await Promise.all([
      requireGit(refs.worktreePath, ['rev-parse', '--show-toplevel']),
      requireGit(refs.worktreePath, ['rev-parse', 'HEAD'])
    ]);
    if (
      trimOutput(topLevel.stdout) !== refs.worktreePath ||
      trimOutput(head.stdout) !== branchHead
    ) {
      fail('worktree_state_mismatch');
    }
    if (requireBaseHead && branchHead !== refs.baseCommit) fail('worktree_state_mismatch');
    await requireBaseAncestor(refs.repositoryRoot, refs.baseCommit, branchHead);
    return branchHead;
  };

  const inspectWorktree = async (
    worktree: AgentRunWorktree
  ): Promise<AgentRunWorktreeInspection> => {
    const roots = await validateRoots();
    const refs = await refsFor(roots, worktree);
    if (
      worktree.repositoryRoot !== refs.repositoryRoot ||
      worktree.worktreePath !== refs.worktreePath ||
      worktree.branch !== refs.branch ||
      worktree.baseCommit !== refs.baseCommit ||
      (worktree.status !== 'prepared' && worktree.status !== 'existing')
    ) {
      fail('worktree_reference_mismatch');
    }
    const headCommit = await validateExistingWorktree(refs);
    const status = await requireGit(refs.worktreePath, [
      'status', '--porcelain=v1', '--untracked-files=all'
    ]);
    return {headCommit, dirty: status.stdout !== ''};
  };

  return {
    async prepare(input) {
      const roots = await validateRoots();
      const refs = await refsFor(roots, input);
      const [existingBranchCommit, targetExists, listedWorktrees] = await Promise.all([
        branchCommit(refs.repositoryRoot, refs.branch),
        pathExists(refs.worktreePath),
        requireGit(refs.repositoryRoot, ['worktree', 'list', '--porcelain'])
      ]);
      const registered = parseWorktrees(listedWorktrees.stdout)
        .some((entry) => entry.worktreePath === refs.worktreePath);

      if (existingBranchCommit === undefined && !targetExists && !registered) {
        await requireGit(refs.repositoryRoot, [
          'worktree', 'add', '-b', refs.branch, refs.worktreePath, refs.baseCommit
        ]);
        await validateExistingWorktree(refs, true);
        return {...refs, status: 'prepared'};
      }

      if (
        existingBranchCommit !== undefined &&
        targetExists &&
        registered
      ) {
        await validateExistingWorktree(refs);
        return {...refs, status: 'existing'};
      }

      fail('worktree_replay_mismatch');
    },

    inspect: inspectWorktree,

    async cleanup(worktree) {
      const inspection = await inspectWorktree(worktree);
      if (inspection.dirty) fail('worktree_dirty');

      await requireGit(worktree.repositoryRoot, [
        'worktree', 'remove', worktree.worktreePath
      ]);
    }
  };
};
