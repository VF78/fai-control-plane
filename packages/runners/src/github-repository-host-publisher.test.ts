import {describe, expect, it, vi} from 'vitest';
import {
  createGitHubRepositoryHostPublisher,
  type RepositoryHostProcessExecutor,
  type RepositoryHostProcessRequest
} from './index';

describe('GitHub repository-host publisher', () => {
  it('pushes an exact generated ref and creates only a draft change request', async () => {
    const token = 'test-publication-token-0123456789abcdef';
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
        head: {sha: 'd'.repeat(40)}
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
    const branch = 'fai/run/00000000-0000-4000-8000-000000000001';

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
});
