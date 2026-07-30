import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createWorktreeManager} from './index';

const git = async (cwd: string, args: readonly string[]): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn('git', [...args], {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.once('error', reject);
  child.once('close', (code) => {
    if (code !== 0) {
      reject(new Error(Buffer.concat(stderr).toString('utf8')));
      return;
    }
    resolve(Buffer.concat(stdout).toString('utf8').trim());
  });
});

describe('WorktreeManager', () => {
  it('prepares one resumable worktree and only removes it once clean', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fai-worktree-manager-')));
    const repositoryRoot = path.join(root, 'repository');
    const worktreeRoot = path.join(root, 'worktrees');
    await Promise.all([mkdir(repositoryRoot), mkdir(worktreeRoot)]);
    await git(repositoryRoot, ['init', '--initial-branch=main']);
    await git(repositoryRoot, ['config', 'user.email', 'test@example.com']);
    await git(repositoryRoot, ['config', 'user.name', 'Test User']);
    await writeFile(path.join(repositoryRoot, 'README.md'), 'base\n');
    await git(repositoryRoot, ['add', 'README.md']);
    await git(repositoryRoot, ['commit', '-m', 'base']);
    const baseCommit = await git(repositoryRoot, ['rev-parse', 'HEAD']);
    const runId = randomUUID();
    const manager = createWorktreeManager({repositoryRoot, worktreeRoot});

    const prepared = await manager.prepare({runId, baseCommit});
    expect(prepared).toMatchObject({
      repositoryRoot,
      worktreePath: path.join(worktreeRoot, runId),
      branch: `fai/run/${runId}`,
      baseCommit,
      status: 'prepared'
    });

    await expect(manager.prepare({runId, baseCommit})).resolves.toEqual({
      ...prepared,
      status: 'existing'
    });

    await writeFile(path.join(prepared.worktreePath, 'dirty.txt'), 'dirty\n');
    await writeFile(path.join(prepared.worktreePath, 'README.md'), 'unstaged\n');
    await writeFile(path.join(prepared.worktreePath, 'staged.txt'), 'staged\n');
    await git(prepared.worktreePath, ['add', 'staged.txt']);
    await expect(manager.inspect(prepared)).resolves.toMatchObject({
      headCommit: baseCommit,
      dirty: true,
      changedPaths: ['README.md', 'dirty.txt', 'staged.txt'],
      mergeCommits: [],
      pathBoundaryViolation: false
    });
    await expect(manager.cleanup(prepared)).rejects.toMatchObject({code: 'worktree_dirty'});
    await expect(git(repositoryRoot, ['rev-parse', `refs/heads/${prepared.branch}`]))
      .resolves.toBe(baseCommit);

    await git(prepared.worktreePath, ['restore', '--staged', 'staged.txt']);
    await git(prepared.worktreePath, ['restore', 'README.md']);
    await Promise.all([
      rm(path.join(prepared.worktreePath, 'dirty.txt')),
      rm(path.join(prepared.worktreePath, 'staged.txt'))
    ]);
    await writeFile(path.join(prepared.worktreePath, 'committed.txt'), 'advanced\n');
    await git(prepared.worktreePath, ['add', 'committed.txt']);
    await git(prepared.worktreePath, ['commit', '-m', 'advance run branch']);
    const advancedCommit = await git(
      repositoryRoot,
      ['rev-parse', `refs/heads/${prepared.branch}`]
    );
    expect(advancedCommit).not.toBe(baseCommit);
    await expect(manager.inspect(prepared)).resolves.toMatchObject({
      headCommit: advancedCommit,
      dirty: false,
      changedPaths: ['committed.txt'],
      mergeCommits: [],
      pathBoundaryViolation: false
    });

    const workflowDirectory = path.join(
      prepared.worktreePath,
      '.github',
      'workflows'
    );
    await mkdir(workflowDirectory, {recursive: true});
    await writeFile(path.join(workflowDirectory, 'release.yml'), 'unsafe\n');
    await git(prepared.worktreePath, ['add', '.github/workflows/release.yml']);
    await git(prepared.worktreePath, ['commit', '-m', 'touch protected path']);
    await rm(path.join(workflowDirectory, 'release.yml'));
    await git(prepared.worktreePath, ['add', '-A']);
    await git(prepared.worktreePath, ['commit', '-m', 'revert protected path']);
    await expect(manager.inspect(prepared)).resolves.toMatchObject({
      dirty: false,
      changedPaths: ['.github/workflows/release.yml', 'committed.txt']
    });

    const sideBranch = `side-${runId}`;
    await git(prepared.worktreePath, ['switch', '-c', sideBranch]);
    await writeFile(path.join(prepared.worktreePath, 'side.txt'), 'side\n');
    await git(prepared.worktreePath, ['add', 'side.txt']);
    await git(prepared.worktreePath, ['commit', '-m', 'side']);
    await git(prepared.worktreePath, ['switch', prepared.branch]);
    await writeFile(path.join(prepared.worktreePath, 'mainline.txt'), 'mainline\n');
    await git(prepared.worktreePath, ['add', 'mainline.txt']);
    await git(prepared.worktreePath, ['commit', '-m', 'mainline']);
    await git(prepared.worktreePath, ['merge', '--no-ff', sideBranch, '-m', 'merge side']);
    const mergeCommit = await git(prepared.worktreePath, ['rev-parse', 'HEAD']);
    await expect(manager.inspect(prepared)).resolves.toMatchObject({
      headCommit: mergeCommit,
      dirty: false,
      changedPaths: [
        '.github/workflows/release.yml',
        'committed.txt',
        'mainline.txt',
        'side.txt'
      ],
      mergeCommits: [mergeCommit],
      pathBoundaryViolation: false
    });
    await expect(manager.prepare({runId, baseCommit})).resolves.toEqual({
      ...prepared,
      status: 'existing'
    });

    await expect(manager.cleanup(prepared)).resolves.toBeUndefined();
    await expect(git(repositoryRoot, ['rev-parse', `refs/heads/${prepared.branch}`]))
      .resolves.toBe(mergeCommit);
  });

  it('isolates run names and fails closed on collisions and traversal input', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fai-worktree-isolation-')));
    const repositoryRoot = path.join(root, 'repository');
    const worktreeRoot = path.join(root, 'worktrees');
    await Promise.all([mkdir(repositoryRoot), mkdir(worktreeRoot)]);
    await git(repositoryRoot, ['init', '--initial-branch=main']);
    await git(repositoryRoot, ['config', 'user.email', 'test@example.com']);
    await git(repositoryRoot, ['config', 'user.name', 'Test User']);
    await writeFile(path.join(repositoryRoot, 'README.md'), 'base\n');
    await git(repositoryRoot, ['add', 'README.md']);
    await git(repositoryRoot, ['commit', '-m', 'base']);
    const baseCommit = await git(repositoryRoot, ['rev-parse', 'HEAD']);
    const manager = createWorktreeManager({repositoryRoot, worktreeRoot});
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();

    const [first, second] = await Promise.all([
      manager.prepare({runId: firstRunId, baseCommit}),
      manager.prepare({runId: secondRunId, baseCommit})
    ]);
    expect(first.branch).not.toBe(second.branch);
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first).toMatchObject({
      branch: `fai/run/${firstRunId}`,
      worktreePath: path.join(worktreeRoot, firstRunId)
    });
    expect(second).toMatchObject({
      branch: `fai/run/${secondRunId}`,
      worktreePath: path.join(worktreeRoot, secondRunId)
    });

    await writeFile(path.join(first.worktreePath, 'uncommitted.txt'), 'discarded\n');
    await expect(manager.cleanup(first)).rejects.toMatchObject({code: 'worktree_dirty'});
    await expect(realpath(first.worktreePath)).resolves.toBe(first.worktreePath);
    await rm(path.join(first.worktreePath, 'uncommitted.txt'));
    await expect(manager.cleanup(first)).resolves.toBeUndefined();
    await expect(git(repositoryRoot, ['rev-parse', `refs/heads/${first.branch}`]))
      .resolves.toBe(baseCommit);
    await manager.cleanup(second);

    const collidingRunId = randomUUID();
    await mkdir(path.join(worktreeRoot, collidingRunId));
    await expect(manager.prepare({runId: collidingRunId, baseCommit}))
      .rejects.toMatchObject({code: 'worktree_replay_mismatch'});
    await expect(manager.prepare({
      runId: `../${randomUUID()}`,
      baseCommit
    })).rejects.toMatchObject({code: 'invalid_run_id'});
    expect(() => createWorktreeManager({
      repositoryRoot,
      worktreeRoot,
      branchPrefix: 'fai/../run/'
    })).toThrow(expect.objectContaining({code: 'invalid_branch_prefix'}));
  });
});
