import {createHash} from 'node:crypto';
import {mkdtemp, realpath, symlink, writeFile} from 'node:fs/promises';
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
  const root = await mkdtemp(path.join(tmpdir(), 'fai-deployment-artifact-'));
  await writeFile(path.join(root, 'release.tar.gz'), body);
  return realpath(root);
};

const claim = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, workspaceId, executorId: 'executor.production', registrationId,
  jobId, deploymentId, deploymentVersion: 2, projectId,
  environment: 'production', releasePackage,
  releasePackageHash: hashDeploymentReleasePackage(releasePackage), approvedByActorId: approverId,
  approvedAt: '2026-08-12T09:59:00.000Z', attempt: 1, leaseToken,
  leaseExpiresAt: '2026-08-12T10:02:00.000Z', ...overrides
});

const options = async (fetcher: typeof fetch, adapter: DeploymentAdapter) => ({
  baseUrl: 'http://127.0.0.1:13000', bearerToken: token, workspaceId, executorId: 'executor.production',
  registrationId, projectId, environment: 'production' as const,
  artifacts: createLocalDeploymentArtifactResolver(await artifactRoot()), adapter, fetch: fetcher,
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
    const adapter: DeploymentAdapter = {adapterId: 'fake', preflight: vi.fn(async () => undefined),
      execute: vi.fn(async () => ({
      outcome: 'succeeded', smokeChecks: [{name: 'health', status: 'passed', reference: 'fake:health'}],
      rollback: {outcome: 'not_required', reference: null}
    } as const))};
    await expect(runDeploymentExecutorOnce(await options(fetcher, adapter))).resolves.toEqual({
      status: 'completed', outcome: 'succeeded'
    });
    expect(adapter.execute).toHaveBeenCalledWith(expect.objectContaining({projectId,
      environment: 'production', sourceCommit: 'a'.repeat(40), artifact: expect.objectContaining({
        reference: releasePackage.artifactReference, sha256: releasePackage.artifactSha256,
        path: expect.stringMatching(/release\.tar\.gz$/)
      })}));
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
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request);
      if (request.url.endsWith('/claim')) return Response.json(claim());
      if (request.url.endsWith('/heartbeat')) return Response.json({leaseExpiresAt: '2026-08-12T10:03:00.000Z'});
      return Response.json({outcome: 'failed', completedAt: '2026-08-12T10:00:02.000Z'});
    }) as unknown as typeof fetch;
    const adapter: DeploymentAdapter = {adapterId: 'fake', preflight: vi.fn(async () => undefined),
      async execute() { throw new Error('deployment_executor_client_adapter_failed'); }};
    await expect(runDeploymentExecutorOnce(await options(fetcher, adapter)))
      .resolves.toEqual({status: 'completed', outcome: 'failed'});
    expect(await requests[2]!.json()).toMatchObject({result: {outcome: 'failed',
      smokeChecks: [{status: 'failed', reference: 'deployment-executor:adapter_failed'}],
      rollback: {outcome: 'not_required', reference: null}}});
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
    const root = await artifactRoot();
    const resolver = createLocalDeploymentArtifactResolver(root);
    await expect(resolver.resolve({...releasePackage, artifactSha256: '0'.repeat(64)}))
      .rejects.toThrow('artifact_hash_mismatch');
    await expect(resolver.resolve({...releasePackage, artifactReference: 'https://provider.test/release'}))
      .rejects.toThrow('artifact_reference');
    await symlink(path.join(root, 'release.tar.gz'), path.join(root, 'linked.tar.gz'));
    await expect(resolver.resolve({...releasePackage, artifactReference: 'artifact:release-package:linked.tar.gz'}))
      .rejects.toThrow();
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

  it('performs a confirmation-free dry run without claiming or executing', async () => {
    const root = await artifactRoot();
    const tokenFile = path.join(root, 'claim-token');
    await writeFile(tokenFile, token, {mode: 0o600});
    const adapter: DeploymentAdapter = {adapterId: 'fake', preflight: vi.fn(async () => undefined),
      execute: vi.fn()};
    await expect(deploymentExecutorFromEnvironment({
      FAI_DEPLOYMENT_EXECUTOR_ENABLED: 'true', FAI_DEPLOYMENT_EXECUTOR_DRY_RUN: 'true',
      FAI_DEPLOYMENT_EXECUTOR_ADAPTER: 'fake', FAI_DEPLOYMENT_EXECUTOR_TOKEN_FILE: tokenFile,
      FAI_DEPLOYMENT_EXECUTOR_ARTIFACT_ROOT: root,
      FAI_DEPLOYMENT_EXECUTOR_BASE_URL: 'http://127.0.0.1:13000',
      FAI_DEPLOYMENT_EXECUTOR_WORKSPACE_ID: workspaceId,
      FAI_DEPLOYMENT_EXECUTOR_ID: 'executor.production',
      FAI_DEPLOYMENT_EXECUTOR_REGISTRATION_ID: registrationId,
      FAI_DEPLOYMENT_EXECUTOR_PROJECT_ID: projectId,
      FAI_DEPLOYMENT_EXECUTOR_ENVIRONMENT: 'production'
    }, adapter)).resolves.toEqual({status: 'dry_run_ready'});
    expect(adapter.preflight).toHaveBeenCalledWith({projectId, environment: 'production'});
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
