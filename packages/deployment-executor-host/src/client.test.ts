import {createHash} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {hashDeploymentReleasePackage, type DeploymentReleasePackage} from '@fai-control-plane/domain';
import {
  createLocalDeploymentArtifactResolver,
  createUnavailableDeploymentAdapter,
  deploymentExecutorFromEnvironment,
  runDeploymentExecutorOnce,
  type DeploymentAdapter
} from './client';
import type {DeploymentExecutorTransport} from './unix-socket-json-transport';

const jobId = '00000000-0000-4000-8000-000000000001';
const deploymentId = '00000000-0000-4000-8000-000000000002';
const projectId = '00000000-0000-4000-8000-000000000003';
const registrationId = '00000000-0000-4000-8000-000000000004';
const approverId = '00000000-0000-4000-8000-000000000005';
const workspaceId = '00000000-0000-4000-8000-000000000006';
const token = 'deployment-executor-test-token-0123456789';
const leaseToken = 'l'.repeat(32);
const body = Buffer.from('immutable release package');
const releasePackage: DeploymentReleasePackage = {
  schemaVersion: 1,
  sourceCommit: 'a'.repeat(40),
  artifactReference: 'artifact:release-package:release.tar.gz',
  artifactSha256: createHash('sha256').update(body).digest('hex')
};

const artifactRoot = async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'fai-deployment-artifact-'));
  const sourceRoot = path.join(parent, 'source'); const stagingRoot = path.join(parent, 'staging');
  await Promise.all([mkdir(sourceRoot, {mode: 0o700}), mkdir(stagingRoot, {mode: 0o700})]);
  await writeFile(path.join(sourceRoot, 'release.tar.gz'), body, {mode: 0o600});
  return {sourceRoot: await realpath(sourceRoot), stagingRoot: await realpath(stagingRoot)};
};

const claim = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, workspaceId, executorId: 'executor.production', registrationId,
  jobId, deploymentId, deploymentVersion: 2, projectId,
  environment: 'production', releasePackage,
  releasePackageHash: hashDeploymentReleasePackage(releasePackage), approvedByActorId: approverId,
  approvedAt: '2026-08-12T09:59:00.000Z', attempt: 1, leaseToken,
  leaseExpiresAt: '2026-08-12T10:02:00.000Z', ...overrides
});

const transport = (fetcher: typeof fetch): DeploymentExecutorTransport => ({
  async preflight() {},
  async post(endpoint, headers, requestBody) {
    return fetcher(new URL(endpoint, 'http://unix.invalid'), {method: 'POST', headers,
      ...(requestBody === undefined ? {} : {body: requestBody})});
  }
});

const options = async (fetcher: typeof fetch, adapter: DeploymentAdapter) => ({
  bearerToken: token, workspaceId, executorId: 'executor.production',
  registrationId, projectId, environment: 'production' as const,
  artifacts: createLocalDeploymentArtifactResolver(await artifactRoot()), adapter, transport: transport(fetcher),
  now: vi.fn()
    .mockReturnValueOnce(new Date('2026-08-12T10:00:00.000Z'))
    .mockReturnValueOnce(new Date('2026-08-12T10:00:01.000Z'))
    .mockReturnValueOnce(new Date('2026-08-12T10:00:02.000Z'))
});

describe('deployment executor host client', () => {
  it('binds the exact claim, heartbeats, invokes the typed adapter, and completes', async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request);
      if (request.url.endsWith('/claim')) return Response.json(claim());
      if (request.url.endsWith('/heartbeat')) {
        return Response.json({leaseExpiresAt: '2026-08-12T10:03:00.000Z'});
      }
      return Response.json({outcome: 'succeeded', completedAt: '2026-08-12T10:00:02.000Z'});
    }) as unknown as typeof fetch;
    let stagedPath = '';
    const adapter: DeploymentAdapter = {adapterId: 'fake', preflight: vi.fn(async () => undefined),
      execute: vi.fn(async ({artifact}) => {
      stagedPath = artifact.path;
      expect(await readFile(artifact.path)).toEqual(body);
      return {
      outcome: 'succeeded', smokeChecks: [{name: 'health', status: 'passed', reference: 'fake:health'}],
      rollback: {outcome: 'not_required', reference: null}
    } as const;})};
    await expect(runDeploymentExecutorOnce(await options(fetcher, adapter))).resolves.toEqual({
      status: 'completed', outcome: 'succeeded'
    });
    expect(adapter.execute).toHaveBeenCalledWith(expect.objectContaining({projectId,
      environment: 'production', sourceCommit: 'a'.repeat(40), artifact: expect.objectContaining({
        reference: releasePackage.artifactReference, sha256: releasePackage.artifactSha256,
        path: expect.stringMatching(/\.package$/)
      })}));
    await expect(lstat(stagedPath)).rejects.toThrow();
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/deployment-executor/claim', '/api/deployment-executor/heartbeat',
      '/api/deployment-executor/complete'
    ]);
    expect(requests[1]!.headers.get('x-fai-deployment-lease-token')).toBe(leaseToken);
    const completionPayload = await requests[2]!.json();
    expect(completionPayload).toMatchObject({jobId, deploymentId, deploymentVersion: 2, attempt: 1,
      result: {outcome: 'succeeded', smokeChecks: [{name: 'health', status: 'passed'}],
        rollback: {outcome: 'not_required'}}});
    expect(JSON.stringify(completionPayload)).not.toContain(token);
  });

  it.each([
    ['workspace', {workspaceId: '00000000-0000-4000-8000-000000000099'}],
    ['executor', {executorId: 'executor.wrong'}],
    ['registration', {registrationId: '00000000-0000-4000-8000-000000000099'}],
    ['project', {projectId: '00000000-0000-4000-8000-000000000099'}],
    ['environment', {environment: 'staging'}],
    ['package hash', {releasePackageHash: '0'.repeat(64)}],
    ['commit package', {releasePackage: {...releasePackage, sourceCommit: 'b'.repeat(40)}}],
    ['expired lease', {leaseExpiresAt: '2026-08-12T09:59:59.000Z'}]
  ])('rejects a mismatched %s before artifact or adapter use', async (_label, override) => {
    const fetcher = vi.fn(async () => Response.json(claim(override))) as unknown as typeof fetch;
    const adapter: DeploymentAdapter = {adapterId: 'fake', preflight: vi.fn(async () => undefined), execute: vi.fn()};
    const configured = await options(fetcher, adapter);
    await expect(runDeploymentExecutorOnce(configured)).rejects.toThrow('invalid_claim');
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('rejects an unavailable adapter before claiming a job', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(runDeploymentExecutorOnce(await options(fetcher,
      createUnavailableDeploymentAdapter()))).rejects.toThrow('adapter_unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('submits a structured failure when a bound adapter cannot execute', async () => {
    const requests: Request[] = [];
    let stagedPath = '';
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request);
      if (request.url.endsWith('/claim')) return Response.json(claim());
      if (request.url.endsWith('/heartbeat')) return Response.json({leaseExpiresAt: '2026-08-12T10:03:00.000Z'});
      return Response.json({outcome: 'failed', completedAt: '2026-08-12T10:00:02.000Z'});
    }) as unknown as typeof fetch;
    const adapter: DeploymentAdapter = {adapterId: 'fake', preflight: vi.fn(async () => undefined),
      async execute({artifact}) { stagedPath = artifact.path;
        throw new Error('deployment_executor_client_adapter_failed'); }};
    await expect(runDeploymentExecutorOnce(await options(fetcher, adapter)))
      .resolves.toEqual({status: 'completed', outcome: 'failed'});
    expect(await requests[2]!.json()).toMatchObject({result: {outcome: 'failed',
      smokeChecks: [{status: 'failed', reference: 'deployment-executor:adapter_failed'}],
      rollback: {outcome: 'not_required', reference: null}}});
    await expect(lstat(stagedPath)).rejects.toThrow();
  });

  it('submits exact approved rollback facts from the typed adapter', async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request);
      if (request.url.endsWith('/claim')) return Response.json(claim());
      if (request.url.endsWith('/heartbeat')) return Response.json({leaseExpiresAt: '2026-08-12T10:03:00.000Z'});
      return Response.json({outcome: 'rolled_back', completedAt: '2026-08-12T10:00:02.000Z'});
    }) as unknown as typeof fetch;
    const adapter: DeploymentAdapter = {adapterId: 'fake', async preflight() {}, async execute() { return {
      outcome: 'rolled_back', smokeChecks: [{name: 'health', status: 'failed', reference: 'fake:health'}],
      rollback: {outcome: 'completed', reference: 'fake:rollback'}
    }; }};
    await expect(runDeploymentExecutorOnce(await options(fetcher, adapter))).resolves.toEqual({
      status: 'completed', outcome: 'rolled_back'
    });
    expect(await requests[2]!.json()).toMatchObject({result: {outcome: 'rolled_back',
      rollback: {outcome: 'completed', reference: 'fake:rollback'}}});
  });

  it('replays the exact completion once after an ambiguous server failure', async () => {
    const completions: string[] = [];
    let completionAttempt = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith('/claim')) return Response.json(claim());
      if (request.url.endsWith('/heartbeat')) return Response.json({leaseExpiresAt: '2026-08-12T10:03:00.000Z'});
      completions.push(await request.text()); completionAttempt += 1;
      return completionAttempt === 1 ? Response.json({status: 'unavailable'}, {status: 503})
        : Response.json({outcome: 'succeeded', completedAt: '2026-08-12T10:00:02.000Z'});
    }) as unknown as typeof fetch;
    const adapter: DeploymentAdapter = {adapterId: 'fake', async preflight() {}, async execute() { return {
      outcome: 'succeeded', smokeChecks: [{name: 'health', status: 'passed', reference: 'fake:health'}],
      rollback: {outcome: 'not_required', reference: null}
    }; }};
    await expect(runDeploymentExecutorOnce(await options(fetcher, adapter))).resolves.toEqual({
      status: 'completed', outcome: 'succeeded'
    });
    expect(completions).toHaveLength(2);
    expect(completions[0]).toBe(completions[1]);
  });

  it('fails closed on heartbeat loss and does not complete', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => new URL(input.toString()).pathname.endsWith('/claim')
      ? Response.json(claim()) : new Response(null, {status: 404})) as unknown as typeof fetch;
    const adapter: DeploymentAdapter = {adapterId: 'fake', preflight: vi.fn(async () => undefined), execute: vi.fn()};
    await expect(runDeploymentExecutorOnce(await options(fetcher, adapter))).rejects.toThrow('heartbeat_404');
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight adapter when a renewed lease is denied', async () => {
    let heartbeatCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname.endsWith('/claim')) return Response.json(claim());
      if (pathname.endsWith('/heartbeat')) {
        heartbeatCount += 1;
        return heartbeatCount === 1 ? Response.json({leaseExpiresAt: '2026-08-12T10:03:00.000Z'})
          : new Response(null, {status: 404});
      }
      return Response.json({outcome: 'succeeded', completedAt: '2026-08-12T10:00:02.000Z'});
    }) as unknown as typeof fetch;
    const adapter: DeploymentAdapter = {adapterId: 'fake', preflight: vi.fn(async () => undefined),
      execute: vi.fn(async ({signal}) =>
      new Promise<never>((_resolve, reject) => signal.addEventListener('abort',
        () => reject(new Error('aborted')), {once: true})))};
    await expect(runDeploymentExecutorOnce({...await options(fetcher, adapter), heartbeatIntervalMs: 1_000}))
      .rejects.toThrow('heartbeat_404');
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(3);
  }, 3_000);

  it('fails closed on artifact hash drift, arbitrary references, and symlinks', async () => {
    const roots = await artifactRoot();
    const resolver = createLocalDeploymentArtifactResolver(roots);
    await expect(resolver.resolve({...releasePackage, artifactSha256: '0'.repeat(64)}, {jobId, attempt: 1}))
      .rejects.toThrow('artifact_hash_mismatch');
    await expect(resolver.resolve({...releasePackage, artifactReference: 'https://provider.test/release'},
      {jobId, attempt: 1}))
      .rejects.toThrow('artifact_reference');
    await symlink(path.join(roots.sourceRoot, 'release.tar.gz'), path.join(roots.sourceRoot, 'linked.tar.gz'));
    await expect(resolver.resolve({...releasePackage,
      artifactReference: 'artifact:release-package:linked.tar.gz'}, {jobId, attempt: 1}))
      .rejects.toThrow();
  });

  it('stages exact verified bytes and is unaffected when the source is replaced', async () => {
    const roots = await artifactRoot();
    const resolver = createLocalDeploymentArtifactResolver(roots);
    const staged = await resolver.resolve(releasePackage, {jobId, attempt: 1});
    const sourcePath = path.join(roots.sourceRoot, 'release.tar.gz');
    await rename(sourcePath, `${sourcePath}.replaced`);
    await writeFile(sourcePath, 'attacker replacement', {mode: 0o600});
    expect(staged.artifact.path.startsWith(`${roots.stagingRoot}${path.sep}`)).toBe(true);
    await expect(readFile(staged.artifact.path)).resolves.toEqual(body);
    await staged.cleanup();
    await expect(lstat(staged.artifact.path)).rejects.toThrow();
  });

  it('rejects unsafe artifact directory ownership and modes', async () => {
    const roots = await artifactRoot();
    await chmod(roots.sourceRoot, 0o770);
    await expect(createLocalDeploymentArtifactResolver(roots).preflight())
      .rejects.toThrow('artifact_root_binding');
    await chmod(roots.sourceRoot, 0o700);
    await chmod(roots.stagingRoot, 0o750);
    await expect(createLocalDeploymentArtifactResolver(roots).preflight())
      .rejects.toThrow('artifact_staging_root_binding');
    await chmod(roots.stagingRoot, 0o700);
    const currentUid = process.getuid?.();
    const currentGid = process.getgid?.();
    if (currentUid === undefined || currentGid === undefined) throw new Error('test_identity_unavailable');
    await expect(createLocalDeploymentArtifactResolver({...roots, expectedUid: currentUid + 1,
      expectedGid: currentGid}).preflight()).rejects.toThrow('artifact_root_binding');
  });

  it('fails closed without deleting a pre-existing per-job stage', async () => {
    const roots = await artifactRoot();
    const stagedPath = path.join(roots.stagingRoot,
      `${jobId}.1.${releasePackage.artifactSha256}.package`);
    await writeFile(stagedPath, 'existing stage', {mode: 0o600});
    await expect(createLocalDeploymentArtifactResolver(roots).resolve(releasePackage, {jobId, attempt: 1}))
      .rejects.toMatchObject({code: 'EEXIST'});
    await expect(readFile(stagedPath, 'utf8')).resolves.toBe('existing stage');
  });

  it('is disabled by default and requires confirmation before reading a token', async () => {
    await expect(deploymentExecutorFromEnvironment({})).resolves.toEqual({status: 'disabled'});
    await expect(deploymentExecutorFromEnvironment({FAI_DEPLOYMENT_EXECUTOR_ENABLED: 'true'}))
      .rejects.toThrow('missing_fai_deployment_executor_dry_run');
    await expect(deploymentExecutorFromEnvironment({FAI_DEPLOYMENT_EXECUTOR_ENABLED: 'true',
      FAI_DEPLOYMENT_EXECUTOR_DRY_RUN: 'false'})).rejects.toThrow('activation_confirmation');
    await expect(deploymentExecutorFromEnvironment({FAI_DEPLOYMENT_EXECUTOR_ENABLED: 'true',
      FAI_DEPLOYMENT_EXECUTOR_DRY_RUN: 'true',
      FAI_DEPLOYMENT_EXECUTOR_CONFIRM_ACTIVATION: 'I_APPROVE_DEPLOYMENT_EXECUTOR',
      FAI_DEPLOYMENT_EXECUTOR_ADAPTER: 'unavailable'})).rejects.toThrow('adapter_unavailable');
  });

  it('keeps dry run confirmation-free but fails closed until its root-owned socket is present', async () => {
    const roots = await artifactRoot();
    const tokenFile = path.join(roots.sourceRoot, 'claim-token');
    await writeFile(tokenFile, token, {mode: 0o600});
    const adapter: DeploymentAdapter = {adapterId: 'fake', preflight: vi.fn(async () => undefined),
      execute: vi.fn()};
    await expect(deploymentExecutorFromEnvironment({
      FAI_DEPLOYMENT_EXECUTOR_ENABLED: 'true', FAI_DEPLOYMENT_EXECUTOR_DRY_RUN: 'true',
      FAI_DEPLOYMENT_EXECUTOR_ADAPTER: 'fake', FAI_DEPLOYMENT_EXECUTOR_TOKEN_FILE: tokenFile,
      FAI_DEPLOYMENT_EXECUTOR_ARTIFACT_ROOT: roots.sourceRoot,
      FAI_DEPLOYMENT_EXECUTOR_STAGING_ROOT: roots.stagingRoot,
      FAI_DEPLOYMENT_EXECUTOR_SOCKET_PATH: path.join(roots.sourceRoot, 'missing.sock'),
      FAI_DEPLOYMENT_EXECUTOR_SOCKET_UID: '0', FAI_DEPLOYMENT_EXECUTOR_SOCKET_GID: '0',
      FAI_DEPLOYMENT_EXECUTOR_WORKSPACE_ID: workspaceId,
      FAI_DEPLOYMENT_EXECUTOR_ID: 'executor.production',
      FAI_DEPLOYMENT_EXECUTOR_REGISTRATION_ID: registrationId,
      FAI_DEPLOYMENT_EXECUTOR_PROJECT_ID: projectId,
      FAI_DEPLOYMENT_EXECUTOR_ENVIRONMENT: 'production'
    }, adapter)).rejects.toThrow('socket_directory_binding');
    expect(adapter.preflight).toHaveBeenCalledWith({projectId, environment: 'production'});
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
