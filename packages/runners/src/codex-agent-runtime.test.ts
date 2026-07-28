import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
  createCodexAgentRuntime,
  type AgentRuntimeInput,
  type ProcessExecutionRequest,
  type ProcessExecutionResult,
  type ProcessExecutor,
  type RedactedProcessOutputMetadata
} from './index';

const emptyOutput = (): RedactedProcessOutputMetadata => ({
  observedBytes: 0,
  boundedBytes: 0,
  truncated: false,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  contentRetained: false
});

describe('Codex CLI agent runtime', () => {
  it('maps bounded inputs to an isolated CLI process and rejects unsafe or timed-out runs', async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'fai-codex-runtime-'))
    );
    const workspacePath = path.join(root, 'worktree');
    const codexHome = path.join(root, 'codex-home');
    const artifactPath = path.join(root, 'artifacts', 'read-run');
    await Promise.all([
      mkdir(workspacePath),
      mkdir(codexHome),
      mkdir(path.dirname(artifactPath))
    ]);

    const requests: ProcessExecutionRequest[] = [];
    const completedExecutor = vi.fn<ProcessExecutor>(async (request) => {
      requests.push(request);
      const outputIndex = request.args.indexOf('--output-last-message');
      const summaryPath = request.args[outputIndex + 1];
      if (summaryPath === undefined) throw new Error('missing summary path');
      await writeFile(summaryPath, JSON.stringify({
        status: 'completed',
        summary: 'Bounded implementation complete.',
        changedFiles: ['packages/runners/src/index.ts'],
        checks: [{name: 'typecheck', status: 'passed', detail: ''}],
        risks: [],
        nextAction: 'Create the local runner transport.'
      }));
      return {
        termination: 'exit',
        exitCode: 0,
        signal: null,
        stdout: emptyOutput(),
        stderr: emptyOutput()
      } satisfies ProcessExecutionResult;
    });
    const runtime = createCodexAgentRuntime({
      codexHome,
      environment: {
        PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
        TMP: tmpdir()
      },
      executor: completedExecutor
    });
    const input: AgentRuntimeInput = {
      runId: randomUUID(),
      packetId: randomUUID(),
      packetHash: 'a'.repeat(64),
      prompt: 'Implement the exact approved packet.',
      workspacePath,
      artifactPath,
      profile: 'read_safe',
      timeboxMinutes: 15
    };

    const result = await runtime.run(input);

    expect(result.status).toBe('succeeded');
    expect(result).toMatchObject({
      evidence: {
        status: 'completed',
        changedFiles: ['packages/runners/src/index.ts'],
        checks: [{name: 'typecheck', status: 'passed'}],
        artifact: {
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          sizeBytes: expect.any(Number)
        }
      }
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.executable).toBe('codex');
    expect(request.cwd).toBe(workspacePath);
    expect(request.stdin).toBe(input.prompt);
    expect(request.timeoutMs).toBe(15 * 60_000);
    expect(request.env).toEqual({
      PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
      TMP: tmpdir(),
      CODEX_HOME: codexHome,
      NO_COLOR: '1'
    });
    expect(request.args).toEqual([
      'exec',
      '-C',
      workspacePath,
      '--ephemeral',
      '--ignore-user-config',
      '--strict-config',
      '-c',
      'approval_policy="never"',
      '--json',
      '--output-schema',
      path.join(artifactPath, 'codex-agent-summary.schema.json'),
      '--output-last-message',
      path.join(artifactPath, `codex-run-${input.runId}-summary.json`),
      '--sandbox',
      'read-only',
      '-'
    ]);
    expect(request.args).not.toContain(input.prompt);
    expect(request.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(request.args).not.toContain('danger-full-access');
    expect(request.args).not.toContain('--add-dir');
    expect(JSON.parse(await readFile(
      path.join(artifactPath, 'codex-agent-summary.schema.json'),
      'utf8'
    ))).toMatchObject({
      type: 'object',
      additionalProperties: false
    });

    const unsafeExecutor = vi.fn<ProcessExecutor>();
    const unsafeRuntime = createCodexAgentRuntime({
      codexHome,
      environment: {PATH: '/usr/bin'},
      executor: unsafeExecutor
    });
    await expect(unsafeRuntime.run({
      ...input,
      runId: randomUUID(),
      artifactPath: path.join(root, 'artifacts', 'unsafe-run'),
      packetHash: 'A'.repeat(64)
    })).rejects.toMatchObject({
      code: 'invalid_packet_hash'
    });
    expect(unsafeExecutor).not.toHaveBeenCalled();

    const timeoutRequests: ProcessExecutionRequest[] = [];
    const timeoutExecutor: ProcessExecutor = vi.fn(async (request) => {
      timeoutRequests.push(request);
      return {
        termination: 'timeout',
        exitCode: null,
        signal: 'SIGTERM',
        stdout: emptyOutput(),
        stderr: emptyOutput()
      } satisfies ProcessExecutionResult;
    });
    const timeoutRuntime = createCodexAgentRuntime({
      codexHome,
      environment: {PATH: '/usr/bin'},
      executor: timeoutExecutor
    });
    const timeoutResult = await timeoutRuntime.run({
      ...input,
      runId: randomUUID(),
      artifactPath: path.join(root, 'artifacts', 'timeout-run'),
      profile: 'write_scoped',
      timeboxMinutes: 1
    });

    expect(timeoutResult).toMatchObject({
      status: 'timed_out',
      exitCode: null,
      signal: 'SIGTERM',
      executionMetadata: {sandbox: 'workspace-write'}
    });
    expect(timeoutRequests[0]?.args).toContain('workspace-write');
    expect(timeoutRequests[0]?.timeoutMs).toBe(60_000);
  });
});
