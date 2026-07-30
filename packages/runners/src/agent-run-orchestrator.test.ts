import {createHash, randomUUID} from 'node:crypto';
import {
  lstat,
  mkdir,
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
  type RepositoryHostPublicationReceipt,
  type WorktreeManager
} from './index';

const emptyOutput = (): RedactedProcessOutputMetadata => ({
  observedBytes: 0,
  boundedBytes: 0,
  truncated: false,
  sha256: createHash('sha256').update('').digest('hex'),
  contentRetained: false
});

const localArtifactPath = (artifactRoot: string, reference: string): string =>
  path.join(artifactRoot, ...reference.replace(/^runs\//, '').split('/'));

describe('local AgentRun orchestrator', () => {
  it('writes prompt-free receipts and cleans only clean worktrees', async () => {
    const artifactRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'fai-local-run-'))
    );
    const worktrees = new Map<string, AgentRunWorktree>();
    const dirtyRuns = new Set<string>();
    const publishRuns = new Set<string>();
    const unsatisfiedEvidenceRuns = new Set<string>();
    const observedPaths = new Map<string, readonly string[]>();
    const mergeRuns = new Set<string>();
    const pathBoundaryRuns = new Set<string>();
    const falseEvidenceRuns = new Set<string>();
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
        headCommit: publishRuns.has(worktree.runId)
          ? 'd'.repeat(40)
          : worktree.baseCommit,
        dirty: dirtyRuns.has(worktree.runId),
        changedPaths: observedPaths.get(worktree.runId) ??
          (dirtyRuns.has(worktree.runId) ? ['dirty.txt'] : []),
        mergeCommits: mergeRuns.has(worktree.runId)
          ? ['e'.repeat(40)]
          : [],
        pathBoundaryViolation: pathBoundaryRuns.has(worktree.runId)
      })),
      cleanup: vi.fn(async (worktree) => {
        worktrees.delete(worktree.runId);
      })
    };
    const runtime: AgentRuntime = {
      runtimeId: 'test-runtime',
      run: vi.fn(async (input): Promise<AgentRuntimeResult> => {
        if (input.prompt.includes('POLICY DENIAL')) {
          return {
            runtimeId: 'test-runtime',
            runId: input.runId,
            packetId: input.packetId,
            packetHash: input.packetHash,
            profile: input.profile,
            executionMetadata: {sandbox: 'workspace-write'},
            startedAt: '2026-07-26T08:00:00.000Z',
            finishedAt: '2026-07-26T08:00:00.000Z',
            durationMs: 0,
            stdout: emptyOutput(),
            stderr: emptyOutput(),
            policy: {
              decision: 'denied',
              filesystem: 'workspace_only',
              network: 'denied',
              approvals: 'never',
              environment: 'allowlisted',
              tools: ['codex_cli'],
              deniedRuleIds: ['deployment_operation']
            },
            status: 'policy_denied',
            exitCode: null,
            signal: null
          };
        }
        if (input.profile === 'write_scoped' && !publishRuns.has(input.runId)) {
          dirtyRuns.add(input.runId);
          return {
            runtimeId: 'test-runtime',
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
            policy: {
              decision: 'allowed',
              filesystem: 'workspace_only',
              network: 'denied',
              approvals: 'never',
              environment: 'allowlisted',
              tools: ['codex_cli'],
              deniedRuleIds: []
            },
            status: input.signal?.aborted ? 'cancelled' : 'timed_out',
            exitCode: null,
            signal: 'SIGTERM'
          };
        }
        const summaryRef = path.join(
          input.artifactPath,
          `runtime-evidence-${input.runId}.bin`
        );
        const summary = Buffer.from('opaque runtime evidence artifact\n');
        await writeFile(summaryRef, summary, {flag: 'wx'});
        return {
          runtimeId: 'test-runtime',
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
          policy: {
            decision: 'allowed',
            filesystem: input.profile === 'read_safe'
              ? 'read_only'
              : 'workspace_only',
            network: 'denied',
            approvals: 'never',
            environment: 'allowlisted',
            tools: ['codex_cli'],
            deniedRuleIds: []
          },
          status: 'succeeded',
          exitCode: 0,
          summaryRef,
          schemaRef: path.join(
            input.artifactPath,
            'runtime-evidence.schema.json'
          ),
          evidence: {
            status: 'completed',
            changedFiles: falseEvidenceRuns.has(input.runId)
              ? []
              : ['packages/runners/src/agent-run-orchestrator.ts'],
            checks: [{
              name: 'runner typecheck',
              status: unsatisfiedEvidenceRuns.has(input.runId)
                ? 'failed'
                : 'passed'
            }],
            riskCount: 3,
            artifact: {
              sha256: createHash('sha256').update(summary).digest('hex'),
              sizeBytes: summary.byteLength
            }
          }
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
    const cleanBody = await readFile(localArtifactPath(artifactRoot, cleanResult.receiptRef), 'utf8');
    expect(cleanResult.receipt).toMatchObject({
      finalStatus: 'succeeded',
      worktreeDisposition: 'removed_clean',
      nextAction: 'review_receipt',
      cost: {state: 'unknown'},
      writeBack: {
        state: 'not_attempted',
        reason: 'repository_host_publication_disabled'
      }
    });
    expect(cleanBody).not.toContain(clean.prompt);
    expect(cleanBody).not.toContain('opaque runtime evidence artifact');
    expect(cleanResult.receipt.artifacts.correlationId).toBe(`artifact-run-${clean.runId}`);
    expect(cleanResult.completionEvidence.riskCount).toBe(3);
    const manifestPath = localArtifactPath(
      artifactRoot,
      cleanResult.receipt.artifacts.pathManifest.reference
    );
    const manifestBody = await readFile(manifestPath);
    expect(createHash('sha256').update(manifestBody).digest('hex')).toBe(
      cleanResult.receipt.artifacts.pathManifest.sha256
    );
    expect(manifestBody.byteLength).toBe(cleanResult.receipt.artifacts.pathManifest.sizeBytes);
    await expect(lstat(path.join(artifactRoot, clean.runId, 'runtime')))
      .rejects.toMatchObject({code: 'ENOENT'});
    expect((await stat(localArtifactPath(artifactRoot, cleanResult.receiptRef))).mode & 0o777).toBe(0o400);
    expect(manager.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({runId: clean.runId})
    );
    await expect(orchestrator.run(clean)).rejects.toMatchObject({
      code: 'artifact_directory_collision'
    });

    const denied = {
      ...envelope('write_scoped'),
      prompt: 'POLICY DENIAL SECRET=do-not-retain'
    };
    const deniedResult = await orchestrator.run(denied);
    expect(deniedResult.receipt).toMatchObject({
      finalStatus: 'policy_denied',
      worktreeDisposition: 'removed_clean',
      nextAction: 'retry_explicitly',
      policy: {
        decision: 'denied',
        deniedRuleIds: ['deployment_operation']
      },
      writeBack: {state: 'not_attempted'}
    });
    const deniedBody = await readFile(localArtifactPath(artifactRoot, deniedResult.receiptRef), 'utf8');
    expect(deniedBody).not.toContain('SECRET');
    expect(deniedBody).not.toContain('do-not-retain');

    const readSafeObserved = envelope('read_safe');
    publishRuns.add(readSafeObserved.runId);
    observedPaths.set(readSafeObserved.runId, ['README.md']);
    falseEvidenceRuns.add(readSafeObserved.runId);
    const readSafeDenied = await orchestrator.run(readSafeObserved);
    expect(readSafeDenied.receipt).toMatchObject({
      finalStatus: 'policy_denied',
      worktreeDisposition: 'retained_policy_denied',
      nextAction: 'review_worktree',
      policy: {
        decision: 'denied',
        deniedRuleIds: ['read_safe_worktree_changed']
      }
    });
    expect(worktrees.has(readSafeObserved.runId)).toBe(true);

    const dirtyTimeout = envelope('write_scoped');
    const dirtyResult = await orchestrator.run(dirtyTimeout);
    expect(dirtyResult.receipt).toMatchObject({
      finalStatus: 'timed_out',
      worktreeDisposition: 'retained_dirty',
      nextAction: 'review_worktree',
      cost: {
        state: 'unknown',
        reason: 'runtime_usage_not_available'
      }
    });
    expect(manager.cleanup).not.toHaveBeenCalledWith(
      expect.objectContaining({runId: dirtyTimeout.runId})
    );
    expect(worktrees.has(dirtyTimeout.runId)).toBe(true);
    expect(await readFile(localArtifactPath(artifactRoot, dirtyResult.receiptRef), 'utf8'))
      .not.toContain(dirtyTimeout.prompt);

    const cancellation = envelope('write_scoped');
    const controller = new AbortController();
    controller.abort();
    const cancelledResult = await orchestrator.run({
      ...cancellation,
      signal: controller.signal
    });
    expect(cancelledResult.receipt).toMatchObject({
      finalStatus: 'cancelled',
      worktreeDisposition: 'retained_dirty',
      nextAction: 'review_worktree'
    });
    expect(worktrees.has(cancellation.runId)).toBe(true);
    await expect(readFile(localArtifactPath(artifactRoot, cancelledResult.receiptRef), 'utf8'))
      .resolves.toContain('"finalStatus": "cancelled"');

    const publisher = {
      publishDraftChange: vi.fn(async (): Promise<RepositoryHostPublicationReceipt> => ({
        status: 'published' as const,
        externalChangeRef: '17',
        externalChangeUrl: 'https://github.com/VF78/fai-control-plane/pull/17',
        externalChangeStatus: 'draft' as const
      }))
    };
    const publishingOrchestrator = createLocalAgentRunOrchestrator({
      artifactRoot,
      worktrees: manager,
      runtime,
      publication: {
        enabled: true,
        repositoryTarget: 'repository:VF78/fai-control-plane',
        baseRef: 'main',
        requiredCheckNames: ['runner typecheck'],
        publisher
      }
    });
    const protectedObserved = envelope('write_scoped');
    publishRuns.add(protectedObserved.runId);
    observedPaths.set(protectedObserved.runId, ['.github/workflows/release.yml']);
    falseEvidenceRuns.add(protectedObserved.runId);
    const protectedDenied = await publishingOrchestrator.run(protectedObserved);
    expect(protectedDenied.receipt).toMatchObject({
      finalStatus: 'policy_denied',
      worktreeDisposition: 'retained_policy_denied',
      policy: {deniedRuleIds: ['protected_path_changed']},
      writeBack: {state: 'blocked', reason: 'runtime_not_succeeded'}
    });
    expect(publisher.publishDraftChange).not.toHaveBeenCalled();

    const mergeObserved = envelope('write_scoped');
    publishRuns.add(mergeObserved.runId);
    observedPaths.set(mergeObserved.runId, ['packages/runners/src/index.ts']);
    mergeRuns.add(mergeObserved.runId);
    falseEvidenceRuns.add(mergeObserved.runId);
    const mergeDenied = await publishingOrchestrator.run(mergeObserved);
    expect(mergeDenied.receipt).toMatchObject({
      finalStatus: 'policy_denied',
      worktreeDisposition: 'retained_policy_denied',
      policy: {deniedRuleIds: ['merge_history_changed']},
      writeBack: {state: 'blocked', reason: 'runtime_not_succeeded'}
    });
    expect(publisher.publishDraftChange).not.toHaveBeenCalled();

    const pathEscapeObserved = envelope('write_scoped');
    publishRuns.add(pathEscapeObserved.runId);
    pathBoundaryRuns.add(pathEscapeObserved.runId);
    falseEvidenceRuns.add(pathEscapeObserved.runId);
    const pathEscapeDenied = await publishingOrchestrator.run(
      pathEscapeObserved
    );
    expect(pathEscapeDenied.receipt).toMatchObject({
      finalStatus: 'policy_denied',
      worktreeDisposition: 'retained_policy_denied',
      policy: {deniedRuleIds: ['worktree_path_escape']},
      writeBack: {state: 'blocked', reason: 'runtime_not_succeeded'}
    });
    expect(publisher.publishDraftChange).not.toHaveBeenCalled();

    const publishable = envelope('write_scoped');
    publishRuns.add(publishable.runId);
    const published = await publishingOrchestrator.run(publishable);
    expect(published.receipt.writeBack).toEqual({
      state: 'published',
      externalChangeRef: '17',
      externalChangeUrl: 'https://github.com/VF78/fai-control-plane/pull/17',
      externalChangeStatus: 'draft'
    });
    expect(published.receipt.nextAction).toBe('review_receipt');
    expect(publisher.publishDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryTarget: 'repository:VF78/fai-control-plane',
        baseRef: 'main',
        baseCommit: 'b'.repeat(40),
        headCommit: 'd'.repeat(40),
        branch: `fai/run/${publishable.runId}`
      })
    );
    expect(manager.cleanup).toHaveBeenCalledTimes(3);

    const unsatisfied = envelope('write_scoped');
    publishRuns.add(unsatisfied.runId);
    unsatisfiedEvidenceRuns.add(unsatisfied.runId);
    const blocked = await publishingOrchestrator.run(unsatisfied);
    expect(blocked.receipt).toMatchObject({
      writeBack: {state: 'blocked', reason: 'evidence_not_satisfied'},
      nextAction: 'retry_explicitly'
    });
    expect(publisher.publishDraftChange).toHaveBeenCalledTimes(1);

    publisher.publishDraftChange.mockResolvedValueOnce({
      status: 'failed',
      reason: 'change_create_failed'
    });
    const publisherFailure = envelope('write_scoped');
    publishRuns.add(publisherFailure.runId);
    const failed = await publishingOrchestrator.run(publisherFailure);
    expect(failed.receipt).toMatchObject({
      writeBack: {state: 'failed', reason: 'change_create_failed'},
      nextAction: 'retry_explicitly'
    });
    expect(manager.cleanup).toHaveBeenCalledTimes(5);
  });

  it('rejects artifact collisions and traversal before starting a runtime', async () => {
    const artifactRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'fai-local-run-collision-'))
    );
    const collidingRunId = randomUUID();
    await mkdir(path.join(artifactRoot, collidingRunId));
    const manager: WorktreeManager = {
      prepare: vi.fn(),
      inspect: vi.fn(),
      cleanup: vi.fn()
    };
    const runtime: AgentRuntime = {
      runtimeId: 'test-runtime',
      run: vi.fn()
    };
    const orchestrator = createLocalAgentRunOrchestrator({
      artifactRoot,
      worktrees: manager,
      runtime
    });
    const envelope = {
      runId: collidingRunId,
      packetId: randomUUID(),
      packetHash: 'a'.repeat(64),
      baseCommit: 'b'.repeat(40),
      prompt: 'approved task',
      profile: 'read_safe' as const,
      timeboxMinutes: 15
    };

    await expect(orchestrator.run(envelope)).rejects.toMatchObject({
      code: 'artifact_directory_collision'
    });
    await expect(orchestrator.run({
      ...envelope,
      runId: `../${randomUUID()}`
    })).rejects.toMatchObject({code: 'invalid_run_id'});
    expect(manager.prepare).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it('removes empty allocation on prepare failure', async () => {
    const artifactRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'fai-local-run-prepare-failure-'))
    );
    const runId = randomUUID();
    const prepareFailure = new Error('prepare failed');
    const manager: WorktreeManager = {
      prepare: vi.fn(async () => {
        throw prepareFailure;
      }),
      inspect: vi.fn(),
      cleanup: vi.fn()
    };
    const runtime: AgentRuntime = {
      runtimeId: 'test-runtime',
      run: vi.fn()
    };
    const orchestrator = createLocalAgentRunOrchestrator({
      artifactRoot,
      worktrees: manager,
      runtime
    });

    await expect(orchestrator.run({
      runId,
      packetId: randomUUID(),
      packetHash: 'a'.repeat(64),
      baseCommit: 'b'.repeat(40),
      prompt: 'approved task',
      profile: 'read_safe',
      timeboxMinutes: 15
    })).rejects.toBe(prepareFailure);
    await expect(lstat(path.join(artifactRoot, runId)))
      .rejects.toMatchObject({code: 'ENOENT'});
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it('preserves runtime failures and exception-cleans only clean worktrees', async () => {
    const artifactRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'fai-local-run-runtime-failure-'))
    );
    const cleanRunId = randomUUID();
    const dirtyRunId = randomUUID();
    const runtimeFailures = new Map([
      [cleanRunId, new Error('clean runtime failed')],
      [dirtyRunId, new Error('dirty runtime failed')]
    ]);
    const manager: WorktreeManager = {
      prepare: vi.fn(async ({runId, baseCommit}) => ({
        runId,
        repositoryRoot: '/trusted/repository',
        worktreePath: `/trusted/worktrees/${runId}`,
        branch: `fai/run/${runId}`,
        baseCommit,
        status: 'prepared' as const
      })),
      inspect: vi.fn(async (worktree) => ({
        headCommit: worktree.baseCommit,
        dirty: worktree.runId === dirtyRunId,
        changedPaths: worktree.runId === dirtyRunId ? ['dirty.txt'] : [],
        mergeCommits: [],
        pathBoundaryViolation: false
      })),
      cleanup: vi.fn(async () => {
        throw new Error('cleanup failed');
      })
    };
    const runtime: AgentRuntime = {
      runtimeId: 'test-runtime',
      run: vi.fn(async (input) => {
        throw runtimeFailures.get(input.runId);
      })
    };
    const orchestrator = createLocalAgentRunOrchestrator({
      artifactRoot,
      worktrees: manager,
      runtime
    });
    const envelope = (runId: string): LocalAgentRunEnvelope => ({
      runId,
      packetId: randomUUID(),
      packetHash: 'a'.repeat(64),
      baseCommit: 'b'.repeat(40),
      prompt: 'approved task',
      profile: 'write_scoped',
      timeboxMinutes: 15
    });

    await expect(orchestrator.run(envelope(cleanRunId)))
      .rejects.toBe(runtimeFailures.get(cleanRunId));
    await expect(orchestrator.run(envelope(dirtyRunId)))
      .rejects.toBe(runtimeFailures.get(dirtyRunId));
    expect(manager.cleanup).toHaveBeenCalledTimes(1);
    expect(manager.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({runId: cleanRunId})
    );
  });
});
