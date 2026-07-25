import {describe, expect, it, vi} from 'vitest';
import {
  trackerCheckStatuses,
  type OpaqueSecretRef,
  type SecretsProvider
} from '@fai-control-plane/domain';
import {
  createGitHubRepositoryReadAdapter,
  GitHubRepositoryReadError,
  type GitHubFetch
} from './github-repository-read';

const sha = (id: number): string => id.toString(16).padStart(40, '0');

const repositoryPayload = (
  fullName: 'VF78/MSA' | 'VF78/ascon' = 'VF78/MSA',
  overrides: Record<string, unknown> = {}
) => ({
  id: fullName === 'VF78/MSA' ? 1278325372 : 1279114011,
  full_name: fullName,
  owner: {id: 75837222},
  ...overrides
});

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
  head: {ref: `feature-${id}`, sha: sha(id)},
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

const jsonResponse = (
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {'content-type': 'application/json', ...headers}
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
      return jsonResponse(repositoryPayload(
        url.pathname.endsWith('/MSA') ? 'VF78/MSA' : 'VF78/ascon'
      ));
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

  it.each([
    {
      name: 'repository ID',
      payload: repositoryPayload('VF78/MSA', {id: 1278325373})
    },
    {
      name: 'owner ID',
      payload: repositoryPayload('VF78/MSA', {owner: {id: 75837223}})
    }
  ])('rejects a wrong $name before collection reads', async ({payload}) => {
    const paths: string[] = [];
    const fetch = routeFetch((url) => {
      paths.push(url.pathname);
      return jsonResponse(payload);
    });

    await expect(readMsa(fetch)).rejects.toMatchObject({
      code: 'github_response_invalid',
      message: 'github_response_invalid'
    });
    expect(paths).toEqual(['/repos/VF78/MSA']);
  });

  it('paginates work items and filters pull requests from the issues endpoint', async () => {
    const requestedPages: number[] = [];
    const fetch = routeFetch((url, init) => {
      expect(init.headers.authorization).toBe('Bearer caller-secret');
      expect(init.headers['user-agent']).toBe('fai-control-plane-repository-reader/0.1');
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse(repositoryPayload());
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
        return jsonResponse(repositoryPayload());
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

  it('allows 16 open-PR check fanouts and rejects the 17th', async () => {
    const run = async (pullRequestCount: number) => {
      let requestCount = 0;
      let checkRequests = 0;
      const fetch = routeFetch((url) => {
        requestCount += 1;
        if (url.pathname === '/repos/VF78/MSA') {
          return jsonResponse(repositoryPayload());
        }
        if (url.pathname.endsWith('/issues')) return jsonResponse([]);
        if (url.pathname.endsWith('/pulls')) {
          return jsonResponse(Array.from(
            {length: pullRequestCount},
            (_, index) => pullRequest(index + 1)
          ));
        }
        if (url.pathname.endsWith('/check-runs')) {
          checkRequests += 1;
          return jsonResponse({total_count: 0, check_runs: []});
        }
        throw new Error(`Unexpected route ${url.pathname}`);
      });
      return {
        read: readMsa(fetch),
        counts: () => ({requestCount, checkRequests})
      };
    };

    const atLimit = await run(16);
    await expect(atLimit.read).resolves.toMatchObject({checks: []});
    expect(atLimit.counts()).toEqual({requestCount: 19, checkRequests: 16});

    const overLimit = await run(17);
    await expect(overLimit.read).rejects.toMatchObject({
      code: 'github_request_budget_exceeded',
      message: 'github_request_budget_exceeded'
    });
    expect(overLimit.counts()).toEqual({requestCount: 3, checkRequests: 0});
  });

  it('allows request 32 and rejects request 33 within one snapshot', async () => {
    const run = async (exceed: boolean) => {
      let requestCount = 0;
      const fetch = routeFetch((url) => {
        requestCount += 1;
        if (url.pathname === '/repos/VF78/MSA') {
          return jsonResponse(repositoryPayload());
        }
        if (url.pathname.endsWith('/issues')) return jsonResponse([]);
        if (url.pathname.endsWith('/pulls')) {
          return jsonResponse([pullRequest(8), pullRequest(9), pullRequest(10)]);
        }
        if (url.pathname.endsWith('/check-runs')) {
          const pullNumber = [8, 9, 10].find(
            (candidate) => url.pathname.includes(sha(candidate))
          );
          if (pullNumber === undefined) {
            throw new Error(`Unexpected check SHA ${url.pathname}`);
          }
          const page = Number(url.searchParams.get('page'));
          const terminalPage = pullNumber === 10 && !exceed ? 9 : 10;
          if (page === terminalPage) {
            return jsonResponse({total_count: 0, check_runs: []});
          }
          return jsonResponse({
            total_count: 100,
            check_runs: Array.from({length: 100}, (_, index) => ({
              id: pullNumber * 100_000 + page * 100 + index + 1,
              name: `check-${pullNumber}-${page}-${index}`,
              status: 'completed',
              conclusion: 'success',
              details_url: null
            }))
          });
        }
        throw new Error(`Unexpected route ${url.pathname}`);
      });
      return {
        read: readMsa(fetch),
        count: () => requestCount
      };
    };

    const atBudget = await run(false);
    await expect(atBudget.read).resolves.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({pullRequestExternalId: 'github:pull-request:10'})
      ])
    });
    expect(atBudget.count()).toBe(32);

    const overBudget = await run(true);
    await expect(overBudget.read).rejects.toMatchObject({
      code: 'github_request_budget_exceeded',
      message: 'github_request_budget_exceeded'
    });
    expect(overBudget.count()).toBe(32);
  });

  it('reads pull requests and their check runs into stable provider-neutral models', async () => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith('/issues')) {
        return jsonResponse([issue(7), issue(8, {pull_request: {url: 'ignored'}})]);
      }
      if (url.pathname.endsWith('/pulls')) return jsonResponse([pullRequest(8)]);
      if (url.pathname.endsWith(`/commits/${sha(8)}/check-runs`)) {
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
      headSha: sha(8),
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
        return jsonResponse(repositoryPayload());
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
      if (url.pathname.endsWith(`/commits/${sha(8)}/check-runs`)) {
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
      name: 'duplicate issue IDs',
      issues: [
        issue(1),
        issue(1, {
          number: 2,
          url: 'https://api.github.com/repos/VF78/MSA/issues/2',
          html_url: 'https://github.com/VF78/MSA/issues/2'
        })
      ],
      pulls: []
    },
    {
      name: 'duplicate issue numbers',
      issues: [
        issue(1),
        issue(2, {
          number: 1,
          url: 'https://api.github.com/repos/VF78/MSA/issues/1',
          html_url: 'https://github.com/VF78/MSA/issues/1'
        })
      ],
      pulls: []
    },
    {
      name: 'duplicate pull request IDs',
      issues: [],
      pulls: [
        pullRequest(1),
        pullRequest(1, {
          number: 2,
          url: 'https://api.github.com/repos/VF78/MSA/pulls/2',
          html_url: 'https://github.com/VF78/MSA/pull/2'
        })
      ]
    },
    {
      name: 'duplicate pull request numbers',
      issues: [],
      pulls: [
        pullRequest(1),
        pullRequest(2, {
          number: 1,
          url: 'https://api.github.com/repos/VF78/MSA/pulls/1',
          html_url: 'https://github.com/VF78/MSA/pull/1'
        })
      ]
    }
  ])('rejects $name after pagination', async ({issues, pulls}) => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith('/issues')) return jsonResponse(issues);
      if (url.pathname.endsWith('/pulls')) return jsonResponse(pulls);
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    await expect(readMsa(fetch)).rejects.toMatchObject({
      code: 'github_response_invalid',
      message: 'github_response_invalid'
    });
  });

  it('deduplicates a shared head SHA request when no check identity is ambiguous', async () => {
    let checkRequests = 0;
    const sharedSha = sha(88);
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith('/issues')) return jsonResponse([]);
      if (url.pathname.endsWith('/pulls')) {
        return jsonResponse([
          pullRequest(8, {head: {ref: 'shared-8', sha: sharedSha}}),
          pullRequest(9, {head: {ref: 'shared-9', sha: sharedSha}})
        ]);
      }
      if (url.pathname.endsWith(`/commits/${sharedSha}/check-runs`)) {
        checkRequests += 1;
        return jsonResponse({total_count: 0, check_runs: []});
      }
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    await expect(readMsa(fetch)).resolves.toMatchObject({checks: []});
    expect(checkRequests).toBe(1);
  });

  it('rejects duplicate check IDs across pull requests', async () => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith('/issues')) return jsonResponse([]);
      if (url.pathname.endsWith('/pulls')) {
        return jsonResponse([pullRequest(8), pullRequest(9)]);
      }
      if (url.pathname.endsWith('/check-runs')) {
        return jsonResponse({
          total_count: 1,
          check_runs: [{
            id: 44,
            name: 'same-provider-check',
            status: 'completed',
            conclusion: 'success',
            details_url: null
          }]
        });
      }
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    await expect(readMsa(fetch)).rejects.toMatchObject({
      code: 'github_response_invalid',
      message: 'github_response_invalid'
    });
  });

  it.each([
    {
      name: 'issue label IDs',
      item: issue(1, {
        labels: [
          {id: 11, name: 'first', color: '111111'},
          {id: 11, name: 'duplicate', color: '222222'}
        ]
      }),
      pull: null
    },
    {
      name: 'issue assignee IDs',
      item: issue(1, {
        assignees: [
          {id: 21, login: 'first'},
          {id: 21, login: 'duplicate'}
        ]
      }),
      pull: null
    },
    {
      name: 'pull request label IDs',
      item: null,
      pull: pullRequest(1, {
        labels: [
          {id: 31, name: 'first', color: '111111'},
          {id: 31, name: 'duplicate', color: '222222'}
        ]
      })
    },
    {
      name: 'pull request assignee IDs',
      item: null,
      pull: pullRequest(1, {
        assignees: [
          {id: 41, login: 'first'},
          {id: 41, login: 'duplicate'}
        ]
      })
    }
  ])('rejects duplicate nested $name', async ({item, pull}) => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith('/issues')) {
        return jsonResponse(item === null ? [] : [item]);
      }
      if (url.pathname.endsWith('/pulls')) {
        return jsonResponse(pull === null ? [] : [pull]);
      }
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    await expect(readMsa(fetch)).rejects.toMatchObject({
      code: 'github_response_invalid',
      message: 'github_response_invalid'
    });
  });

  it.each([
    {
      name: 'missing merged_at',
      pull: pullRequest(8, {merged_at: undefined})
    },
    {
      name: 'non-GitHub URL',
      pull: pullRequest(8, {html_url: 'https://example.com/VF78/MSA/pull/8'})
    },
    {
      name: 'mismatched API URL number',
      pull: pullRequest(8, {
        url: 'https://api.github.com/repos/VF78/MSA/pulls/9'
      })
    },
    {
      name: 'non-positive ID',
      pull: pullRequest(8, {id: 0})
    },
    {
      name: 'empty head ref',
      pull: pullRequest(8, {head: {ref: '', sha: sha(8)}})
    },
    {
      name: 'non-40-hex head SHA',
      pull: pullRequest(8, {head: {ref: 'feature-8', sha: 'sha-8'}})
    }
  ])('rejects $name in a pull request response', async ({pull}) => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse(repositoryPayload());
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

  it.each([
    {
      name: 'non-GitHub URL',
      item: issue(1, {url: 'https://example.com/issues/1'})
    },
    {
      name: 'mismatched HTML URL number',
      item: issue(1, {html_url: 'https://github.com/VF78/MSA/issues/2'})
    },
    {
      name: 'non-positive number',
      item: issue(1, {number: 0})
    },
    {
      name: 'empty title',
      item: issue(1, {title: ''})
    }
  ])('rejects work-item $name', async ({item}) => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith('/issues')) {
        return jsonResponse([item]);
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
      name: 'unknown conclusion',
      check: {
        id: 44,
        name: 'test',
        status: 'completed',
        conclusion: 'unknown',
        details_url: null
      }
    },
    {
      name: 'non-HTTPS details URL',
      check: {
        id: 44,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        details_url: 'http://github.com/check/44'
      }
    },
    {
      name: 'details URL userinfo',
      check: {
        id: 44,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        details_url: 'https://user:password@github.com/check/44'
      }
    }
  ])('rejects check-run $name', async ({check}) => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith('/issues')) return jsonResponse([]);
      if (url.pathname.endsWith('/pulls')) return jsonResponse([pullRequest(8)]);
      if (url.pathname.endsWith('/check-runs')) {
        return jsonResponse({total_count: 1, check_runs: [check]});
      }
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    await expect(readMsa(fetch)).rejects.toMatchObject({
      code: 'github_response_invalid',
      message: 'github_response_invalid'
    });
  });

  it.each(trackerCheckStatuses)('accepts the %s check-run status', async (status) => {
    const fetch = routeFetch((url) => {
      if (url.pathname === '/repos/VF78/MSA') {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith('/issues')) return jsonResponse([]);
      if (url.pathname.endsWith('/pulls')) return jsonResponse([pullRequest(8)]);
      if (url.pathname.endsWith('/check-runs')) {
        return jsonResponse({
          total_count: 1,
          check_runs: [{
            id: 44,
            name: 'test',
            status,
            conclusion: 'success',
            details_url: null
          }]
        });
      }
      throw new Error(`Unexpected route ${url.pathname}`);
    });

    await expect(readMsa(fetch)).resolves.toMatchObject({
      checks: [expect.objectContaining({status})]
    });
  });

  it.each([
    {
      name: 'malformed payload',
      fetch: routeFetch((url) => url.pathname === '/repos/VF78/MSA'
        ? jsonResponse(repositoryPayload('VF78/MSA', {id: 'not-an-id'}))
        : jsonResponse([])),
      code: 'github_response_invalid'
    },
    {
      name: 'credential rejection',
      fetch: routeFetch(() => jsonResponse({message: 'caller-secret'}, 401)),
      code: 'github_credential_invalid'
    },
    {
      name: 'HTTP 429 rate limit',
      fetch: routeFetch(() => jsonResponse({message: 'caller-secret'}, 429)),
      code: 'github_rate_limited'
    },
    {
      name: 'exhausted primary rate limit',
      fetch: routeFetch(() => jsonResponse(
        {message: 'caller-secret'},
        403,
        {'x-ratelimit-remaining': '0'}
      )),
      code: 'github_rate_limited'
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
