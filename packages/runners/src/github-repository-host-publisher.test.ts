import {describe, expect, it, vi} from 'vitest';
import {
  createGitHubRepositoryHostPublisher,
  type RepositoryHostProcessExecutor,
  type RepositoryHostProcessRequest
} from './index';

describe('GitHub repository-host publisher', () => {
  it('pushes an exact generated ref and creates only a draft change request', async () => {
    const token = 'test-publication-token-0123456789abcdef';
    const branch = 'fai/run/00000000-0000-4000-8000-000000000001';
    let processRequest: RepositoryHostProcessRequest | undefined;
    const process: RepositoryHostProcessExecutor = vi.fn(async (request) => {
      processRequest = request;
      return {exitCode: 0};
    });
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === 'GET') return Response.json([]);
      return Response.json({
        number: 17,
        html_url: 'https://github.com/VF78/fai-control-plane/pull/17',
        draft: true,
        state: 'open',
        head: {ref: branch, sha: 'd'.repeat(40)},
        base: {ref: 'main'}
      }, {status: 201});
    });
    const publisher = createGitHubRepositoryHostPublisher({
      repositoryTarget: 'repository:VF78/fai-control-plane',
      owner: 'VF78',
      repository: 'fai-control-plane',
      repositoryRoot: '/trusted/repository',
      credentialRef: {
        provider: 'file',
        reference: '/trusted/secrets/repository-host-publisher',
        scope: ['repository_host_publish_draft_change']
      },
      secrets: {
        resolve: vi.fn(async () => ({value: token}))
      },
      environment: {PATH: '/usr/bin:/bin'},
      process,
      fetch: fetcher,
      apiBaseUrl: 'https://api.github.test'
    });
    await expect(publisher.publishDraftChange({
      repositoryTarget: 'repository:VF78/fai-control-plane',
      baseRef: 'main',
      baseCommit: 'b'.repeat(40),
      headCommit: 'd'.repeat(40),
      branch,
      title: 'Automated change for run 00000000-0000-4000-8000-000000000001',
      body: 'Deterministic evidence metadata.',
      idempotencyKey: 'e'.repeat(64)
    })).resolves.toEqual({
      status: 'published',
      externalChangeRef: '17',
      externalChangeUrl: 'https://github.com/VF78/fai-control-plane/pull/17',
      externalChangeStatus: 'draft'
    });

    expect(process).toHaveBeenCalledWith(expect.objectContaining({
      executable: 'git',
      cwd: '/trusted/repository',
      args: [
        'push',
        '--no-verify',
        'https://github.com/VF78/fai-control-plane.git',
        `${'d'.repeat(40)}:refs/heads/${branch}`
      ]
    }));
    expect(processRequest).toBeDefined();
    expect(JSON.stringify(processRequest?.args ?? [])).not.toContain(token);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]!.url).searchParams.get('head'))
      .toBe(`VF78:${branch}`);
    expect(await requests[1]!.json()).toMatchObject({
      head: branch,
      base: 'main',
      draft: true,
      maintainer_can_modify: false
    });
  });

  it('reuses only the exact open draft for a replayed run', async () => {
    const branch = 'fai/run/00000000-0000-4000-8000-000000000001';
    const process: RepositoryHostProcessExecutor = vi.fn(async () => ({exitCode: 0}));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'POST') throw new Error('must not create a duplicate');
      return Response.json([{
        number: 17,
        html_url: 'https://github.com/VF78/fai-control-plane/pull/17',
        draft: true,
        state: 'open',
        head: {ref: branch, sha: 'd'.repeat(40)},
        base: {ref: 'main'}
      }]);
    });
    const publisher = createGitHubRepositoryHostPublisher({
      repositoryTarget: 'repository:VF78/fai-control-plane',
      owner: 'VF78',
      repository: 'fai-control-plane',
      repositoryRoot: '/trusted/repository',
      credentialRef: {
        provider: 'file',
        reference: '/trusted/secrets/repository-host-publisher',
        scope: ['repository_host_publish_draft_change']
      },
      secrets: {resolve: vi.fn(async () => ({value: 'test-publication-token-0123456789abcdef'}))},
      environment: {PATH: '/usr/bin:/bin'},
      process,
      fetch: fetcher,
      apiBaseUrl: 'https://api.github.test'
    });

    await expect(publisher.publishDraftChange({
      repositoryTarget: 'repository:VF78/fai-control-plane',
      baseRef: 'main',
      baseCommit: 'b'.repeat(40),
      headCommit: 'd'.repeat(40),
      branch,
      title: 'Automated change for run 00000000-0000-4000-8000-000000000001',
      body: 'Deterministic evidence metadata.',
      idempotencyKey: 'e'.repeat(64)
    })).resolves.toMatchObject({status: 'published', externalChangeRef: '17'});

    expect(process).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the existing draft does not match the exact ref', async () => {
    const branch = 'fai/run/00000000-0000-4000-8000-000000000001';
    const process: RepositoryHostProcessExecutor = vi.fn(async () => ({exitCode: 0}));
    const fetcher = vi.fn(async () => Response.json([{
      number: 17,
      html_url: 'https://github.com/VF78/fai-control-plane/pull/17',
      draft: true,
      state: 'open',
      head: {ref: branch, sha: 'c'.repeat(40)},
      base: {ref: 'main'}
    }]));
    const publisher = createGitHubRepositoryHostPublisher({
      repositoryTarget: 'repository:VF78/fai-control-plane',
      owner: 'VF78',
      repository: 'fai-control-plane',
      repositoryRoot: '/trusted/repository',
      credentialRef: {
        provider: 'file',
        reference: '/trusted/secrets/repository-host-publisher',
        scope: ['repository_host_publish_draft_change']
      },
      secrets: {resolve: vi.fn(async () => ({value: 'test-publication-token-0123456789abcdef'}))},
      environment: {PATH: '/usr/bin:/bin'},
      process,
      fetch: fetcher,
      apiBaseUrl: 'https://api.github.test'
    });

    await expect(publisher.publishDraftChange({
      repositoryTarget: 'repository:VF78/fai-control-plane',
      baseRef: 'main',
      baseCommit: 'b'.repeat(40),
      headCommit: 'd'.repeat(40),
      branch,
      title: 'Automated change for run 00000000-0000-4000-8000-000000000001',
      body: 'Deterministic evidence metadata.',
      idempotencyKey: 'e'.repeat(64)
    })).resolves.toEqual({status: 'failed', reason: 'existing_change_not_draft'});

    expect(process).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
