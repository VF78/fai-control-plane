import {describe, expect, it, vi} from 'vitest';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {
  createGitHubRepositoryReadAdapter,
  GitHubRepositoryReadError,
  type GitHubFetch
} from './github-repository-read';

const issue = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  number: id,
  url: `https://api.github.com/repos/VF78/MSA/issues/${id}`,
  html_url: `https://github.com/VF78/MSA/issues/${id}`,
  title: `Issue ${id}`,
  state: 'open',
  labels: [{id: id + 1_000, name: 'bug', color: 'd73a4a'}],
  assignees: [{id: id + 2_000, login: 'maintainer'}],
  milestone: null,
  ...overrides
});

const pullRequest = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  number: id,
  url: `https://api.github.com/repos/VF78/MSA/pulls/${id}`,
  html_url: `https://github.com/VF78/MSA/pull/${id}`,
  title: `Pull request ${id}`,
  state: 'open',
  draft: false,
  merged_at: null,
  head: {ref: `feature-${id}`, sha: `sha-${id}`},
  base: {ref: 'main'},
  labels: [],
  assignees: [],
  milestone: null,
  ...overrides
});

const credentialRef: OpaqueSecretRef = {
  provider: 'test-secrets',
  reference: 'github/dogfood/read',
  scope: ['VF78/MSA', 'VF78/ascon']
};

const secretsProvider = (value = 'caller-secret'): SecretsProvider => ({
  resolve: async () => ({value})
});

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {'content-type': 'application/json'}
  });

const routeFetch = (
  routes: (url: URL, init: Parameters<GitHubFetch>[1]) => Response
): GitHubFetch => async (input, init) => routes(new URL(input), init);

const adapter = (
  fetch: GitHubFetch,
  provider: SecretsProvider = secretsProvider()
) => createGitHubRepositoryReadAdapter({fetch, secretsProvider: provider});

const readMsa = (
  fetch: GitHubFetch,
  provider: SecretsProvider = secretsProvider()
) => {
  const read = adapter(fetch, provider).readRepositorySnapshot;
  if (!read) throw new Error('Expected repository read capability.');
  return read({
    repository: {owner: 'VF78', repository: 'MSA'},
    credentialRef
  });
};

describe('GitHub repository read adapter', () => {
  it('exposes only repository read capabilities and no write operation', () => {
    const github = adapter(vi.fn());

    expect(github.provider).toBe('github');
    expect(github.capabilities).toEqual({
      readWorkItems: true,
      writeWorkItems: false,
      readPullRequests: true,
      readChecks: true
    });
    expect(github.readRepositorySnapshot).toBeTypeOf('function');
    expect(github.transitionWorkItem).toBeUndefined();
  });

  it.each([
    {owner: 'vf78', repository: 'MSA'},
    {owner: 'VF78', repository: 'msa'},
    {owner: 'VF78', repository: 'other'},
    {owner: 'someone', repository: 'ascon'}
  ])('rejects non-exact repository $owner/$repository before transport', async (repository) => {
    const fetch = vi.fn<GitHubFetch>();
    const provider = {resolve: vi.fn(secretsProvider().resolve)};
    const read = adapter(fetch, provider).readRepositorySnapshot!;

    await expect(read({repository, credentialRef})).rejects.toMatchObject({
      code: 'github_repository_not_allowed',
      message: 'github_repository_not_allowed'
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it('passes the opaque ref to the secrets boundary and accepts both exact dogfood repositories', async () => {
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
    const resolve = vi.fn(async () => ({value: 'caller-secret'}));
    const read = adapter(fetch, {resolve}).readRepositorySnapshot!;

    await read({
      repository: {owner: 'VF78', repository: 'MSA'},
      credentialRef
    });
    await read({
      repository: {owner: 'VF78', repository: 'ascon'},
      credentialRef
    });

    expect(seen).toEqual(new Set(['repos/VF78/MSA', 'repos/VF78/ascon']));
    expect(resolve).toHaveBeenNthCalledWith(
      1,
      credentialRef,
      'github_repository_snapshot_read'
    );
    expect(resolve).toHaveBeenNthCalledWith(
      2,
      credentialRef,
      'github_repository_snapshot_read'
    );
  });

  it('paginates work items and filters pull requests from the issues endpoint', async () => {
    const requestedPages: number[] = [];
    const fetch = routeFetch((url, init) => {
      expect(init.headers.authorization).toBe('Bearer caller-secret');
      expect(init.headers['user-agent']).toBe('fai-control-plane-repository-reader/0.1');
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
      url: 'https://api.github.com/repos/VF78/MSA/issues/101',
      htmlUrl: 'https://github.com/VF78/MSA/issues/101',
      title: 'Issue 101'
    });
    expect(snapshot.workItems[0]).not.toHaveProperty('body');
    expect(snapshot.workItems[0]?.externalVersion).toMatch(/^github:sha256:[0-9a-f]{64}$/);
    expect(snapshot.externalVersion).toMatch(/^github:sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(snapshot)).not.toContain('caller-secret');
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
      url: 'https://api.github.com/repos/VF78/MSA/pulls/8',
      htmlUrl: 'https://github.com/VF78/MSA/pull/8',
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

  it('normalizes provider ordering and reads checks only for open pull requests', async () => {
    const providerPayloads = (reversed: boolean): GitHubFetch => routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse({id: 9, full_name: 'VF78/MSA'});
      }
      const order = <T>(values: T[]) => reversed ? values.reverse() : values;
      if (url.pathname.endsWith('/issues')) {
        return jsonResponse(order([
          issue(1, {
            labels: order([
              {id: 12, name: 'second', color: '222222'},
              {id: 11, name: 'first', color: '111111'}
            ]),
            assignees: order([
              {id: 22, login: 'second'},
              {id: 21, login: 'first'}
            ])
          }),
          issue(2)
        ]));
      }
      if (url.pathname.endsWith('/pulls')) {
        return jsonResponse(order([
          pullRequest(8, {
            labels: order([
              {id: 32, name: 'second', color: '222222'},
              {id: 31, name: 'first', color: '111111'}
            ]),
            assignees: order([
              {id: 42, login: 'second'},
              {id: 41, login: 'first'}
            ])
          }),
          pullRequest(9, {state: 'closed'})
        ]));
      }
      if (url.pathname.endsWith('/commits/sha-8/check-runs')) {
        return jsonResponse({
          total_count: 2,
          check_runs: order([
            {
              id: 52,
              name: 'second',
              status: 'completed',
              conclusion: 'success',
              details_url: null
            },
            {
              id: 51,
              name: 'first',
              status: 'completed',
              conclusion: 'success',
              details_url: null
            }
          ])
        });
      }
      throw new Error(`Unexpected check fanout route ${url.pathname}`);
    });

    const ordered = await readMsa(providerPayloads(false));
    const reordered = await readMsa(providerPayloads(true));

    expect(reordered).toEqual(ordered);
    expect(reordered.externalVersion).toBe(ordered.externalVersion);
    expect(ordered.workItems.map(({externalId}) => externalId)).toEqual([
      'github:issue:1',
      'github:issue:2'
    ]);
    expect(ordered.pullRequests.map(({externalId}) => externalId)).toEqual([
      'github:pull-request:8',
      'github:pull-request:9'
    ]);
    expect(ordered.checks.map(({externalId}) => externalId)).toEqual([
      'github:check-run:51',
      'github:check-run:52'
    ]);
    expect(ordered.workItems[0]?.labels.map(({externalId}) => externalId)).toEqual([
      'github:label:11',
      'github:label:12'
    ]);
  });

  it.each([
    {
      name: 'missing merged_at',
      pull: pullRequest(8, {merged_at: undefined})
    },
    {
      name: 'non-GitHub URL',
      pull: pullRequest(8, {html_url: 'https://example.com/VF78/MSA/pull/8'})
    }
  ])('rejects $name in a pull request response', async ({pull}) => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse({id: 9, full_name: 'VF78/MSA'});
      }
      if (url.pathname.endsWith('/issues')) return jsonResponse([]);
      if (url.pathname.endsWith('/pulls')) return jsonResponse([pull]);
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    await expect(readMsa(fetch)).rejects.toMatchObject({
      code: 'github_response_invalid',
      message: 'github_response_invalid'
    });
  });

  it('rejects a non-GitHub work-item URL', async () => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse({id: 9, full_name: 'VF78/MSA'});
      }
      if (url.pathname.endsWith('/issues')) {
        return jsonResponse([issue(1, {url: 'https://example.com/issues/1'})]);
      }
      if (url.pathname.endsWith('/pulls')) return jsonResponse([]);
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    await expect(readMsa(fetch)).rejects.toMatchObject({
      code: 'github_response_invalid',
      message: 'github_response_invalid'
    });
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
      name: 'credential rejection',
      fetch: routeFetch(() => jsonResponse({message: 'caller-secret'}, 401)),
      code: 'github_credential_invalid'
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

  it('redacts secret resolution failures', async () => {
    const provider: SecretsProvider = {
      resolve: async () => {
        throw new Error('vault failure exposed caller-secret');
      }
    };

    let failure: unknown;
    try {
      await readMsa(vi.fn(), provider);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GitHubRepositoryReadError);
    expect(failure).toMatchObject({
      code: 'github_credential_invalid',
      message: 'github_credential_invalid'
    });
    expect(String(failure)).not.toContain('caller-secret');
    expect(JSON.stringify(failure)).not.toContain('caller-secret');
  });
});
