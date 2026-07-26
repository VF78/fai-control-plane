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
    await expect(manager.cleanup(prepared)).rejects.toMatchObject({code: 'worktree_dirty'});
    await expect(git(repositoryRoot, ['rev-parse', `refs/heads/${prepared.branch}`]))
      .resolves.toBe(baseCommit);

    await rm(path.join(prepared.worktreePath, 'dirty.txt'));
    await writeFile(path.join(prepared.worktreePath, 'committed.txt'), 'advanced\n');
    await git(prepared.worktreePath, ['add', 'committed.txt']);
    await git(prepared.worktreePath, ['commit', '-m', 'advance run branch']);
    const advancedCommit = await git(
      repositoryRoot,
      ['rev-parse', `refs/heads/${prepared.branch}`]
    );
    expect(advancedCommit).not.toBe(baseCommit);
    await expect(manager.prepare({runId, baseCommit})).resolves.toEqual({
      ...prepared,
      status: 'existing'
    });

    await expect(manager.cleanup(prepared)).resolves.toBeUndefined();
    await expect(git(repositoryRoot, ['rev-parse', `refs/heads/${prepared.branch}`]))
      .resolves.toBe(advancedCommit);
  });
});
