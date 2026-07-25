import {describe, expect, it, vi} from 'vitest';
import {
  createGitHubRepositoryReadAdapter,
  GitHubRepositoryReadError,
  type GitHubFetch
} from './github-repository-read';

const issue = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  number: id,
  title: `Issue ${id}`,
  state: 'open',
  labels: [{id: id + 1_000, name: 'bug', color: 'd73a4a'}],
  assignees: [{id: id + 2_000, login: 'maintainer'}],
  milestone: null,
  ...overrides
});

const pullRequest = (id: number) => ({
  id,
  number: id,
  title: `Pull request ${id}`,
  state: 'open',
  draft: false,
  merged_at: null,
  head: {ref: `feature-${id}`, sha: `sha-${id}`},
  base: {ref: 'main'},
  labels: [],
  assignees: [],
  milestone: null
});

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {'content-type': 'application/json'}
  });

const routeFetch = (
  routes: (url: URL, init: Parameters<GitHubFetch>[1]) => Response
): GitHubFetch => async (input, init) => routes(new URL(input), init);

const readMsa = (fetch: GitHubFetch, credential = 'caller-secret') => {
  const read = createGitHubRepositoryReadAdapter(fetch).readRepositorySnapshot;
  if (!read) throw new Error('Expected repository read capability.');
  return read({
    repository: {owner: 'VF78', repository: 'MSA'},
    credential
  });
};

describe('GitHub repository read adapter', () => {
  it('exposes only repository read capabilities and no write operation', () => {
    const adapter = createGitHubRepositoryReadAdapter(vi.fn());

    expect(adapter.provider).toBe('github');
    expect(adapter.capabilities).toEqual({
      readWorkItems: true,
      writeWorkItems: false,
      readPullRequests: true,
      readChecks: true
    });
    expect(adapter.readRepositorySnapshot).toBeTypeOf('function');
    expect(adapter.transitionWorkItem).toBeUndefined();
  });

  it.each([
    {owner: 'vf78', repository: 'MSA'},
    {owner: 'VF78', repository: 'msa'},
    {owner: 'VF78', repository: 'other'},
    {owner: 'someone', repository: 'ascon'}
  ])('rejects non-exact repository $owner/$repository before transport', async (repository) => {
    const fetch = vi.fn<GitHubFetch>();
    const read = createGitHubRepositoryReadAdapter(fetch).readRepositorySnapshot!;

    await expect(read({repository, credential: 'secret'})).rejects.toMatchObject({
      code: 'github_repository_not_allowed',
      message: 'github_repository_not_allowed'
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts both exact dogfood repositories', async () => {
    const seen = new Set<string>();
    const fetch = routeFetch((url) => {
      seen.add(url.pathname.split('/').slice(1, 4).join('/'));
      if (url.pathname.endsWith('/issues') || url.pathname.endsWith('/pulls')) {
        return jsonResponse([]);
      }
      return jsonResponse({
        id: url.pathname.endsWith('/MSA') ? 1 : 2,
        full_name: url.pathname.endsWith('/MSA') ? 'VF78/MSA' : 'VF78/ascon'
      });
    });
    const adapter = createGitHubRepositoryReadAdapter(fetch);
    const read = adapter.readRepositorySnapshot!;

    await read({
      repository: {owner: 'VF78', repository: 'MSA'},
      credential: 'secret'
    });
    await read({
      repository: {owner: 'VF78', repository: 'ascon'},
      credential: 'secret'
    });

    expect(seen).toEqual(new Set(['repos/VF78/MSA', 'repos/VF78/ascon']));
  });

  it('paginates work items and filters pull requests from the issues endpoint', async () => {
    const requestedPages: number[] = [];
    const fetch = routeFetch((url, init) => {
      expect(init.headers.authorization).toBe('Bearer caller-secret');
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse({id: 9, full_name: 'VF78/MSA'});
      }
      if (url.pathname.endsWith('/issues')) {
        const page = Number(url.searchParams.get('page'));
        requestedPages.push(page);
        if (page === 1) {
          return jsonResponse(Array.from({length: 100}, (_, index) => issue(index + 1)));
        }
        return jsonResponse([
          issue(101),
          issue(102, {pull_request: {url: 'https://api.github.test/pulls/102'}})
        ]);
      }
      if (url.pathname.endsWith('/pulls')) return jsonResponse([]);
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    const snapshot = await readMsa(fetch);

    expect(requestedPages).toEqual([1, 2]);
    expect(snapshot.workItems).toHaveLength(101);
    expect(snapshot.workItems.at(-1)).toMatchObject({
      externalId: 'github:issue:101',
      title: 'Issue 101'
    });
    expect(snapshot.workItems[0]).not.toHaveProperty('body');
    expect(snapshot.workItems[0]?.externalVersion).toMatch(/^github:sha256:[0-9a-f]{64}$/);
    expect(snapshot.externalVersion).toMatch(/^github:sha256:[0-9a-f]{64}$/);
  });

  it('rejects a snapshot that exceeds the fixed pagination bound', async () => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse({id: 9, full_name: 'VF78/MSA'});
      }
      if (url.pathname.endsWith('/issues')) {
        const page = Number(url.searchParams.get('page'));
        return jsonResponse(Array.from(
          {length: 100},
          (_, index) => issue((page - 1) * 100 + index + 1)
        ));
      }
      if (url.pathname.endsWith('/pulls')) return jsonResponse([]);
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    await expect(readMsa(fetch)).rejects.toMatchObject({
      code: 'github_pagination_exceeded',
      message: 'github_pagination_exceeded'
    });
  });

  it('reads pull requests and their check runs into stable provider-neutral models', async () => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse({id: 9, full_name: 'VF78/MSA'});
      }
      if (url.pathname.endsWith('/issues')) {
        return jsonResponse([issue(7), issue(8, {pull_request: {url: 'ignored'}})]);
      }
      if (url.pathname.endsWith('/pulls')) return jsonResponse([pullRequest(8)]);
      if (url.pathname.endsWith('/commits/sha-8/check-runs')) {
        return jsonResponse({
          total_count: 1,
          check_runs: [{
            id: 44,
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            details_url: 'https://github.test/check/44'
          }]
        });
      }
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    const first = await readMsa(fetch);
    const second = await readMsa(fetch);

    expect(first.pullRequests).toEqual([expect.objectContaining({
      externalId: 'github:pull-request:8',
      externalVersion: expect.stringMatching(/^github:sha256:[0-9a-f]{64}$/),
      headRef: 'feature-8',
      headSha: 'sha-8',
      baseRef: 'main',
      merged: false
    })]);
    expect(first.checks).toEqual([expect.objectContaining({
      externalId: 'github:check-run:44',
      pullRequestExternalId: 'github:pull-request:8',
      status: 'completed',
      conclusion: 'success'
    })]);
    expect(second).toEqual(first);
  });

  it.each([
    {
      name: 'malformed payload',
      fetch: routeFetch((url) => url.pathname === '/repos/VF78/MSA'
        ? jsonResponse({id: 'not-an-id', full_name: 'VF78/MSA'})
        : jsonResponse([])),
      code: 'github_response_invalid'
    },
    {
      name: 'provider rejection',
      fetch: routeFetch(() => jsonResponse({message: 'caller-secret'}, 403)),
      code: 'github_provider_rejected'
    },
    {
      name: 'transport failure',
      fetch: (async () => {
        throw new Error('network failed with caller-secret');
      }) as GitHubFetch,
      code: 'github_transport_failed'
    }
  ])('returns a redacted stable error for $name', async ({fetch, code}) => {
    let failure: unknown;
    try {
      await readMsa(fetch);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GitHubRepositoryReadError);
    expect(failure).toMatchObject({code, message: code});
    expect(String(failure)).not.toContain('caller-secret');
    expect(JSON.stringify(failure)).not.toContain('caller-secret');
  });
});
