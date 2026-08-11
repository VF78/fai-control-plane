import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson, type CanonicalJson, type HermesCodexWorkOrder, type HermesDirective} from '@fai-control-plane/domain';
import {createLocalFilesystemArtifactStore} from './artifact-store';
import {createLocalAgentRunOrchestrator} from './agent-run-orchestrator';
import {createCodexAgentRuntime} from './codex-agent-runtime';
import {codexPrompt, validateHermesDirective} from './hermes-codex-runtime';
import {createWorktreeManager} from './worktree-manager';
import type {AgentRuntime} from './index';

const MAX_FRAME = 256 * 1024; const SHA256 = /^[0-9a-f]{64}$/;
const fail = (code: string): never => { throw new Error(`hermes_executor_${code}`); };
const required = (name: string): string => process.env[name] || fail(`missing_${name.toLowerCase()}`);
const absolute = (name: string): string => { const value = required(name); return path.isAbsolute(value) &&
  path.normalize(value) === value && path.resolve(value) === value && value !== path.parse(value).root
  ? value : fail(`invalid_${name.toLowerCase()}`); };
const inputChunks: Buffer[] = []; for await (const chunk of process.stdin) inputChunks.push(Buffer.from(chunk));
const raw = Buffer.concat(inputChunks); if (raw.byteLength < 1 || raw.byteLength > MAX_FRAME) fail('frame_size');
const request = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
if (Object.keys(request).length === 3 && request.schemaVersion === 1 && request.operation === 'preflight' &&
  request.expectedConfigSha256 === required('FAI_EXECUTOR_EXPECTED_HERMES_CONFIG_SHA256')) {
  const run = promisify(execFile); const repositoryRoot = absolute('FAI_EXECUTOR_REPOSITORY_ROOT');
  for (const directory of [absolute('FAI_EXECUTOR_CODEX_HOME'), repositoryRoot,
    absolute('FAI_EXECUTOR_WORKTREE_ROOT'), absolute('FAI_EXECUTOR_ARTIFACT_ROOT')]) {
    const [canonical, metadata] = await Promise.all([realpath(directory), lstat(directory)]);
    if (canonical !== directory || !metadata.isDirectory() || metadata.isSymbolicLink()) fail('directory');
  }
  const codex = await run('/usr/bin/codex', ['--version'], {env: {HOME: absolute('FAI_EXECUTOR_CODEX_HOME'),
    NODE_ENV: 'production', PATH: '/usr/bin:/bin'}, timeout: 10_000});
  if (codex.stdout.trim() !== `codex-cli ${required('FAI_EXECUTOR_CODEX_VERSION')}`) fail('codex_version');
  const remote = await run('/usr/bin/git', ['-C', repositoryRoot, 'config', '--get', 'remote.origin.url'],
    {env: {HOME: absolute('FAI_EXECUTOR_CODEX_HOME'), NODE_ENV: 'production', PATH: '/usr/bin:/bin'}, timeout: 10_000});
  const repository = required('FAI_EXECUTOR_REPOSITORY');
  if (![ `https://github.com/${repository}.git`, `git@github.com:${repository}.git`].includes(remote.stdout.trim())) {
    fail('repository_identity');
  }
  process.stdout.write(canonicalJson({schemaVersion: 1, status: 'ready'})); process.exit(0);
}
const exact = ['schemaVersion', 'runId', 'packetId', 'packetHash', 'baseCommit', 'profile', 'timeboxMinutes',
  'workOrderHash', 'workOrder', 'hermesVersion', 'hermesConfigHash', 'directive'];
if (Object.keys(request).length !== exact.length || exact.some((key) => !Object.hasOwn(request, key)) ||
  request.schemaVersion !== 1 || request.hermesVersion !== '0.18.2' ||
  request.hermesConfigHash !== required('FAI_EXECUTOR_EXPECTED_HERMES_CONFIG_SHA256') ||
  !SHA256.test(String(request.workOrderHash))) fail('schema');
const workOrder = request.workOrder as HermesCodexWorkOrder;
const workOrderHash = request.workOrderHash as string;
if (createHash('sha256').update(canonicalJson(workOrder as unknown as CanonicalJson)).digest('hex') !== request.workOrderHash ||
  workOrder.runtime.hermesVersion !== request.hermesVersion ||
  workOrder.runtime.hermesConfigSha256 !== request.hermesConfigHash) fail('work_order');
const directive = validateHermesDirective(workOrder, workOrderHash, request.directive) as HermesDirective;
const codex = createCodexAgentRuntime({codexHome: absolute('FAI_EXECUTOR_CODEX_HOME'),
  environment: {PATH: '/usr/bin:/bin'}});
const runtime: AgentRuntime = {runtimeId: 'hermes', async run(input) {
  const result = await codex.run({...input, prompt: codexPrompt(workOrder, workOrderHash, directive)});
  return {...result, runtimeId: 'hermes', executionMetadata: {...result.executionMetadata,
    orchestrator: 'hermes', executor: 'codex-cli', workOrderHash,
    directiveHash: createHash('sha256').update(canonicalJson(directive as unknown as CanonicalJson)).digest('hex'),
    directiveJson: canonicalJson(directive as unknown as CanonicalJson), strategy: directive.strategy,
    hermesVersion: '0.18.2', hermesConfigHash: String(request.hermesConfigHash)}};
}};
const orchestrator = createLocalAgentRunOrchestrator({runtime,
  artifactStore: createLocalFilesystemArtifactStore({root: absolute('FAI_EXECUTOR_ARTIFACT_ROOT')}),
  worktrees: createWorktreeManager({repositoryRoot: absolute('FAI_EXECUTOR_REPOSITORY_ROOT'),
    worktreeRoot: absolute('FAI_EXECUTOR_WORKTREE_ROOT')})});
const result = await orchestrator.run({runId: String(request.runId), packetId: String(request.packetId),
  packetHash: String(request.packetHash), baseCommit: String(request.baseCommit), prompt: '',
  profile: request.profile as 'read_safe' | 'write_scoped', timeboxMinutes: Number(request.timeboxMinutes),
  workOrder, workOrderHash: request.workOrderHash as string});
process.stdout.write(canonicalJson(result as unknown as CanonicalJson));
