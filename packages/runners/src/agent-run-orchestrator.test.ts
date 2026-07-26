import {createHash, randomUUID} from 'node:crypto';
import {
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
  createLocalAgentRunOrchestrator,
  type AgentRuntime,
  type AgentRuntimeResult,
  type AgentRunWorktree,
  type LocalAgentRunEnvelope,
  type RedactedProcessOutputMetadata,
  type WorktreeManager
} from './index';

const emptyOutput = (): RedactedProcessOutputMetadata => ({
  observedBytes: 0,
  boundedBytes: 0,
  truncated: false,
  sha256: createHash('sha256').update('').digest('hex'),
  contentRetained: false
});

describe('local AgentRun orchestrator', () => {
  it('writes prompt-free receipts and cleans only clean worktrees', async () => {
    const artifactRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'fai-local-run-'))
    );
    const worktrees = new Map<string, AgentRunWorktree>();
    const dirtyRuns = new Set<string>();
    const manager: WorktreeManager = {
      prepare: vi.fn(async ({runId, baseCommit}) => {
        const worktree: AgentRunWorktree = {
          runId,
          repositoryRoot: '/trusted/repository',
          worktreePath: `/trusted/worktrees/${runId}`,
          branch: `fai/run/${runId}`,
          baseCommit,
          status: worktrees.has(runId) ? 'existing' : 'prepared'
        };
        worktrees.set(runId, worktree);
        return worktree;
      }),
      inspect: vi.fn(async (worktree) => ({
        headCommit: worktree.baseCommit,
        dirty: dirtyRuns.has(worktree.runId)
      })),
      cleanup: vi.fn(async (worktree) => {
        worktrees.delete(worktree.runId);
      })
    };
    const runtime: AgentRuntime = {
      runtimeId: 'codex-cli',
      run: vi.fn(async (input): Promise<AgentRuntimeResult> => {
        if (input.profile === 'write_scoped') {
          dirtyRuns.add(input.runId);
          return {
            runtimeId: 'codex-cli',
            runId: input.runId,
            packetId: input.packetId,
            packetHash: input.packetHash,
            profile: input.profile,
            executionMetadata: {sandbox: 'workspace-write'},
            startedAt: '2026-07-26T08:00:00.000Z',
            finishedAt: '2026-07-26T08:01:00.000Z',
            durationMs: 60_000,
            stdout: emptyOutput(),
            stderr: emptyOutput(),
            status: 'timed_out',
            exitCode: null,
            signal: 'SIGTERM'
          };
        }
        const summaryRef = path.join(
          input.artifactPath,
          `codex-run-${input.runId}-summary.json`
        );
        const summary = Buffer.from('{"status":"completed"}\n');
        await writeFile(summaryRef, summary, {flag: 'wx'});
        return {
          runtimeId: 'codex-cli',
          runId: input.runId,
          packetId: input.packetId,
          packetHash: input.packetHash,
          profile: input.profile,
          executionMetadata: {sandbox: 'read-only'},
          startedAt: '2026-07-26T08:00:00.000Z',
          finishedAt: '2026-07-26T08:00:10.000Z',
          durationMs: 10_000,
          stdout: emptyOutput(),
          stderr: emptyOutput(),
          status: 'succeeded',
          exitCode: 0,
          summaryRef,
          summarySha256: createHash('sha256').update(summary).digest('hex'),
          summarySizeBytes: summary.byteLength,
          schemaRef: path.join(
            input.artifactPath,
            'codex-agent-summary.schema.json'
          )
        };
      })
    };
    const orchestrator = createLocalAgentRunOrchestrator({
      artifactRoot,
      worktrees: manager,
      runtime,
      clock: {now: () => new Date('2026-07-26T08:02:00.000Z')}
    });
    const envelope = (
      profile: LocalAgentRunEnvelope['profile']
    ): LocalAgentRunEnvelope => ({
      runId: randomUUID(),
      packetId: randomUUID(),
      packetHash: 'a'.repeat(64),
      baseCommit: 'b'.repeat(40),
      prompt: 'PRIVATE TASK PACKET PROMPT',
      profile,
      timeboxMinutes: 15
    });

    const clean = envelope('read_safe');
    const cleanResult = await orchestrator.run(clean);
    const cleanBody = await readFile(cleanResult.receiptRef, 'utf8');
    expect(cleanResult.receipt).toMatchObject({
      finalStatus: 'succeeded',
      worktreeDisposition: 'removed_clean',
      nextAction: 'review_receipt',
      cost: {state: 'unknown'},
      writeBack: {state: 'not_attempted'}
    });
    expect(cleanBody).not.toContain(clean.prompt);
    expect((await stat(cleanResult.receiptRef)).mode & 0o777).toBe(0o600);
    expect(manager.cleanup).toHaveBeenCalledTimes(1);
    await expect(orchestrator.run(clean)).rejects.toMatchObject({
      code: 'receipt_already_exists'
    });

    const dirtyTimeout = envelope('write_scoped');
    const dirtyResult = await orchestrator.run(dirtyTimeout);
    expect(dirtyResult.receipt).toMatchObject({
      finalStatus: 'timed_out',
      worktreeDisposition: 'retained_dirty',
      nextAction: 'retry_explicitly',
      cost: {
        state: 'unknown',
        reason: 'codex_cli_usage_not_available'
      }
    });
    expect(manager.cleanup).toHaveBeenCalledTimes(1);
    expect(await readFile(dirtyResult.receiptRef, 'utf8'))
      .not.toContain(dirtyTimeout.prompt);
  });
});
