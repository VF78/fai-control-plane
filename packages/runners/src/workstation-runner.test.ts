import {createHash} from 'node:crypto';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
  runWorkstationRunnerOnce,
  type LocalAgentRunOrchestrator,
  type LocalAgentRunResult
} from './index';

const token = 'workstation-runner-test-token-0123456789abcdef';
const runId = '00000000-0000-4000-8000-000000000001';
const packetId = '00000000-0000-4000-8000-000000000002';

describe('workstation runner', () => {
  it('claims, heartbeats, orchestrates, and completes one allowed run', async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), 'fai-workstation-runner-'));
    const summaryBody = Buffer.from(JSON.stringify({
      status: 'completed',
      summary: 'Implemented the approved task.',
      changedFiles: ['packages/runners/src/workstation-runner.ts'],
      checks: [{name: 'runner typecheck', status: 'passed', detail: 'ok'}],
      risks: ['Operator review required.'],
      nextAction: 'Review receipt.'
    }));
    const summaryName = 'summary.json';
    await writeFile(path.join(artifactRoot, summaryName), summaryBody);
    const receiptResult: LocalAgentRunResult = {
      receipt: {
        schemaVersion: 1,
        recordedAt: '2026-07-26T08:02:00.000Z',
        runId,
        packetId,
        packetHash: 'a'.repeat(64),
        runtimeId: 'codex-cli',
        profile: 'write_scoped',
        baseCommit: 'b'.repeat(40),
        branch: `fai/run/${runId}`,
        headCommit: 'b'.repeat(40),
        finalStatus: 'succeeded',
        startedAt: '2026-07-26T08:00:00.000Z',
        finishedAt: '2026-07-26T08:01:00.000Z',
        durationMs: 60_000,
        output: {
          stdout: {observedBytes: 0, boundedBytes: 0, truncated: false, sha256: 'c'.repeat(64), contentRetained: false},
          stderr: {observedBytes: 0, boundedBytes: 0, truncated: false, sha256: 'c'.repeat(64), contentRetained: false}
        },
        summaryArtifact: {
          name: summaryName,
          sha256: createHash('sha256').update(summaryBody).digest('hex'),
          sizeBytes: summaryBody.byteLength
        },
        worktreeDisposition: 'retained_dirty',
        cost: {state: 'unknown', reason: 'codex_cli_usage_not_available'},
        nextAction: 'review_worktree',
        writeBack: {
          state: 'not_attempted',
          reason: 'repository_host_publication_disabled'
        }
      },
      receiptRef: path.join(artifactRoot, 'agent-run-receipt.json'),
      receiptSha256: 'e'.repeat(64),
      receiptSizeBytes: 512
    };
    const orchestrator: LocalAgentRunOrchestrator = {
      run: vi.fn(async () => receiptResult)
    };
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith('/claim')) {
        return Response.json({
          runId,
          attempt: 1,
          packetId,
          packetHash: 'a'.repeat(64),
          repository: {owner: 'VF78', name: 'fai-control-plane'},
          baseCommit: 'b'.repeat(40),
          runtimeProfile: 'write_scoped',
          timeboxMinutes: 15,
          prompt: 'approved task',
          leaseToken: 'x'.repeat(32),
          leaseExpiresAt: '2026-07-26T08:02:00.000Z'
        });
      }
      return new Response(null, {status: 200});
    });

    await expect(runWorkstationRunnerOnce({
      baseUrl: 'https://control-plane.test',
      bearerToken: token,
      repository: {owner: 'VF78', name: 'fai-control-plane'},
      orchestrator,
      fetch: fetcher
    })).resolves.toMatchObject({status: 'completed'});

    expect(orchestrator.run).toHaveBeenCalledWith(expect.objectContaining({
      runId,
      packetId,
      profile: 'write_scoped'
    }));
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/runner/claim', '/api/runner/heartbeat', '/api/runner/complete'
    ]);
    expect(requests[1]!.headers.get('x-fai-runner-lease-token')).toBe('x'.repeat(32));
    expect(await requests[2]!.json()).toMatchObject({
      runId,
      attempt: 1,
      terminal: 'done',
      receiptSha256: 'e'.repeat(64),
      receiptSizeBytes: 512,
      finalStatus: 'succeeded',
      runtimeId: 'codex-cli',
      runtimeProfile: 'write_scoped',
      durationMs: 60_000,
      cost: {state: 'unknown', reason: 'codex_cli_usage_not_available'},
      usage: {state: 'unknown', reason: 'codex_cli_usage_not_available'},
      summaryArtifact: {
        name: summaryName,
        sha256: createHash('sha256').update(summaryBody).digest('hex'),
        sizeBytes: summaryBody.byteLength
      },
      changedFiles: ['packages/runners/src/workstation-runner.ts'],
      checks: [{name: 'runner typecheck', status: 'passed'}],
      riskCount: 1,
      nextAction: 'review_worktree',
      branch: `fai/run/${runId}`
    });
  });
});
