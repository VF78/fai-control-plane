import {mkdtemp, readFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
  createLocalAgentRunOrchestrator,
  runWorkstationRunnerOnce,
  type AgentRuntime,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type AgentRunWorktree,
  type RedactedProcessOutputMetadata,
  type RepositoryHostPublicationReceipt,
  type RepositoryHostPublishDraftChangeInput,
  type WorktreeManager
} from './index';

const baseCommit = 'a'.repeat(40);
const headCommit = 'b'.repeat(40);
const packetHash = 'c'.repeat(64);
const leaseToken = 'd'.repeat(32);
const runnerToken = 'golden-path-runner-token-0123456789abcdef';
const requiredCheck = 'local runner typecheck';

const emptyOutput = (): RedactedProcessOutputMetadata => ({
  observedBytes: 0,
  boundedBytes: 0,
  truncated: false,
  sha256: 'e'.repeat(64),
  contentRetained: false
});

const scopes = [
  {
    project: 'MSA',
    repository: {owner: 'VF78', name: 'MSA'},
    runId: '00000000-0000-4000-8000-000000000011',
    packetId: '00000000-0000-4000-8000-000000000012'
  },
  {
    project: 'ascon',
    repository: {owner: 'VF78', name: 'ascon'},
    runId: '00000000-0000-4000-8000-000000000021',
    packetId: '00000000-0000-4000-8000-000000000022'
  }
] as const;

describe('draft publication golden path', () => {
  it('completes isolated MSA and ascon runs with one allowlisted draft each', async () => {
    for (const scope of scopes) {
      const artifactRoot = await realpath(
        await mkdtemp(path.join(tmpdir(), 'fai-draft-publication-golden-path-'))
      );
      const publicationInputs: RepositoryHostPublishDraftChangeInput[] = [];
      const completionBodies: Record<string, unknown>[] = [];
      const worktrees = new Map<string, AgentRunWorktree>();
      const worktreeManager: WorktreeManager = {
        prepare: vi.fn(async ({runId, baseCommit: requestedBaseCommit}) => {
          const worktree: AgentRunWorktree = {
            runId,
            repositoryRoot: `/local/${scope.repository.name}`,
            worktreePath: `/local/worktrees/${runId}`,
            branch: `fai/run/${runId}`,
            baseCommit: requestedBaseCommit,
            status: 'prepared'
          };
          worktrees.set(runId, worktree);
          return worktree;
        }),
        inspect: vi.fn(async (worktree) => ({
          headCommit,
          dirty: false,
          changedPaths: [`packages/${scope.repository.name}/approved-change.ts`],
          mergeCommits: [],
          pathBoundaryViolation: false
        })),
        cleanup: vi.fn(async (worktree) => {
          worktrees.delete(worktree.runId);
        })
      };
      const runtime: AgentRuntime = {
        runtimeId: 'local-golden-runtime',
        run: vi.fn(async (input: AgentRuntimeInput): Promise<AgentRuntimeResult> => ({
          runtimeId: 'local-golden-runtime',
          runId: input.runId,
          packetId: input.packetId,
          packetHash: input.packetHash,
          profile: input.profile,
          executionMetadata: {adapter: 'local-fake'},
          startedAt: '2026-07-30T08:00:00.000Z',
          finishedAt: '2026-07-30T08:00:01.000Z',
          durationMs: 1_000,
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
          status: 'succeeded',
          exitCode: 0,
          summaryRef: path.join(input.artifactPath, 'runtime-summary.json'),
          schemaRef: path.join(input.artifactPath, 'runtime-summary.schema.json'),
          evidence: {
            status: 'completed',
            changedFiles: [`packages/${scope.repository.name}/approved-change.ts`],
            checks: [{name: requiredCheck, status: 'passed'}],
            riskCount: 0,
            artifact: {sha256: 'f'.repeat(64), sizeBytes: 128}
          }
        }))
      };
      const publishDraftChange = vi.fn(async (
        input: RepositoryHostPublishDraftChangeInput
      ): Promise<RepositoryHostPublicationReceipt> => {
        publicationInputs.push(input);
        return {
          status: 'published',
          externalChangeRef: `${scope.repository.name}-17`,
          externalChangeUrl: `https://host.test/${scope.repository.name}/changes/17`,
          externalChangeStatus: 'draft'
        };
      });
      const orchestrator = createLocalAgentRunOrchestrator({
        artifactRoot,
        worktrees: worktreeManager,
        runtime,
        publication: {
          enabled: true,
          repositoryTarget: `repository:${scope.repository.owner}/${scope.repository.name}`,
          baseRef: 'main',
          requiredCheckNames: [requiredCheck],
          publisher: {publishDraftChange}
        }
      });
      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        switch (new URL(request.url).pathname) {
          case '/api/runner/claim':
            return Response.json({
              runId: scope.runId,
              attempt: 1,
              packetId: scope.packetId,
              packetHash,
              repository: scope.repository,
              baseCommit,
              runtimeId: 'local-golden-runtime',
              runtimeProfile: 'write_scoped',
              timeboxMinutes: 15,
              prompt: 'local approved packet',
              leaseToken,
              leaseExpiresAt: '2026-07-30T08:10:00.000Z'
            });
          case '/api/runner/heartbeat':
            return Response.json({leaseExpiresAt: '2026-07-30T08:10:00.000Z'});
          case '/api/runner/complete':
            completionBodies.push(await request.json() as Record<string, unknown>);
            return Response.json({terminal: 'done'});
          default:
            throw new Error(`unexpected local endpoint: ${request.url}`);
        }
      };
      const options = {
        baseUrl: 'https://control-plane.local',
        bearerToken: runnerToken,
        repository: scope.repository,
        runtimes: new Map([['local-golden-runtime', orchestrator]]),
        fetch: fetcher
      };

      const completed = await runWorkstationRunnerOnce(options);
      expect(completed.status).toBe('completed');
      if (completed.status !== 'completed') throw new Error('expected completed run');
      expect(completed.result.receipt).toMatchObject({
        runId: scope.runId,
        branch: `fai/run/${scope.runId}`,
        finalStatus: 'succeeded',
        worktreeDisposition: 'removed_clean',
        nextAction: 'review_receipt',
        writeBack: {
          state: 'published',
          externalChangeStatus: 'draft'
        }
      });
      expect(completed.result.completionEvidence).toEqual({
        changedFiles: [`packages/${scope.repository.name}/approved-change.ts`],
        checks: [{name: requiredCheck, status: 'passed'}],
        riskCount: 0
      });
      expect(publicationInputs).toEqual([expect.objectContaining({
        repositoryTarget: `repository:${scope.repository.owner}/${scope.repository.name}`,
        baseRef: 'main',
        baseCommit,
        headCommit,
        branch: `fai/run/${scope.runId}`
      })]);
      expect(completionBodies).toEqual([expect.objectContaining({
        runId: scope.runId,
        attempt: 1,
        terminal: 'done',
        finalStatus: 'succeeded',
        checks: [{name: requiredCheck, status: 'passed'}],
        nextAction: 'review_receipt',
        branch: `fai/run/${scope.runId}`,
        receiptSha256: completed.result.receiptSha256
      })]);
      await expect(readFile(path.join(
        artifactRoot,
        scope.runId,
        'agent-run-receipt.json'
      ), 'utf8')).resolves.toContain('"externalChangeStatus": "draft"');

      await expect(runWorkstationRunnerOnce(options)).rejects.toMatchObject({
        code: 'artifact_directory_collision'
      });
      expect(publishDraftChange).toHaveBeenCalledTimes(1);
      expect(completionBodies).toHaveLength(1);
    }
  });
});
