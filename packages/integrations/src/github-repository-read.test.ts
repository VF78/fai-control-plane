import {generateKeyPairSync} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {
  createGitHubRepositoryReadAdapter,
  type GitHubFetch
} from './github-repository-read';

const sha = (id: number): string => id.toString(16).padStart(40, '0');
const appPrivateKey = generateKeyPairSync('rsa', {modulusLength: 2048})
  .privateKey.export({format: 'pem', type: 'pkcs8'}).toString();
const credentialRef: OpaqueSecretRef = {
  provider: 'test-secrets', reference: 'github/projects/read', scope: ['read:project']
};
const appPrivateKeyRef: OpaqueSecretRef = {
  provider: 'test-secrets', reference: 'github/app/private-key',
  scope: ['github:app:installation-token:mint']
};
const secretsProvider = (value = 'caller-secret'): SecretsProvider => ({
  resolve: async () => ({value})
});
const appSecretsProvider = (): SecretsProvider => ({
  resolve: async () => ({value: appPrivateKey})
});
const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {status, headers: {'content-type': 'application/json'}});

const repositoryPayload = (name: 'MSA' | 'ascon' = 'MSA') => ({
  id: name === 'MSA' ? 1278325372 : 1279114011,
  full_name: `VF78/${name}`,
  owner: {id: 75837222},
  default_branch: 'main'
});
const issuePayload = (id: number, repository: 'MSA' | 'ascon' = 'MSA') => ({
  id,
  number: id,
  url: `https://api.github.com/repos/VF78/${repository}/issues/${id}`,
  html_url: `https://github.com/VF78/${repository}/issues/${id}`,
  title: `Issue ${id}`,
  body: null,
  state: 'open',
  labels: [{id: id + 1_000, name: 'bug', color: 'd73a4a'}],
  assignees: [{id: id + 2_000, login: 'maintainer'}],
  milestone: null
});
const pullRequestPayload = (id: number) => ({
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
  labels: [], assignees: [], milestone: null
});
const issueConnection = (ids: readonly number[], repository: 'MSA' | 'ascon') => ({
  nodes: ids.map((databaseId) => ({databaseId, repository: {nameWithOwner: `VF78/${repository}`}})),
  pageInfo: {hasNextPage: false}
});
const projectItem = (input: Readonly<{
  id: string;
  issueId: number;
  repository?: 'MSA' | 'ascon';
  optionId?: string | null;
  targetDate?: string | null;
  parentId?: number | null;
  subIssueIds?: readonly number[];
  dependencyIds?: readonly number[];
}>) => {
  const repository = input.repository ?? 'MSA';
  const statusField = repository === 'MSA'
    ? 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc'
    : 'PVTSSF_lAHOBIUvJs4Bbi0QzhWSnmU';
  const fields: unknown[] = [{
    optionId: input.optionId === undefined
      ? repository === 'MSA' ? '1f121483' : 'f1d63022'
      : input.optionId,
    field: {id: statusField}
  }];
  if (repository === 'ascon') fields.push({
    date: input.targetDate ?? null,
    field: {id: 'PVTF_lAHOBIUvJs4Bbi0QzhWSnuc'}
  });
  return {
    id: input.id,
    content: {
      __typename: 'Issue',
      databaseId: input.issueId,
      number: input.issueId,
      repository: {nameWithOwner: `VF78/${repository}`},
      parent: input.parentId == null
        ? null
        : {databaseId: input.parentId, repository: {nameWithOwner: `VF78/${repository}`}},
      subIssues: issueConnection(input.subIssueIds ?? [], repository),
      blockedBy: issueConnection(input.dependencyIds ?? [], repository)
    },
    fieldValues: {nodes: fields, pageInfo: {hasNextPage: false}}
  };
};

const projectPayload = (input: Readonly<{
  projectId: string;
  repository: 'MSA' | 'ascon';
  items?: readonly unknown[];
  pullRequests?: readonly unknown[];
}>) => ({data: {
  node: {
    id: input.projectId,
    owner: {databaseId: 75837222},
    items: {nodes: input.items ?? [], pageInfo: {hasNextPage: false}}
  },
  repository: {
    nameWithOwner: `VF78/${input.repository}`,
    pullRequests: {nodes: input.pullRequests ?? [], pageInfo: {hasNextPage: false}}
  }
}});

const routeFetch = (input: Readonly<{
  repository?: 'MSA' | 'ascon';
  issues?: readonly unknown[];
  projectItems?: readonly unknown[];
  pullRequests?: readonly unknown[];
  linkedPullRequests?: readonly unknown[];
  checkRuns?: readonly unknown[];
}> = {}): GitHubFetch => async (rawUrl, init) => {
  const repository = input.repository ?? 'MSA';
  const url = new URL(rawUrl);
  if (url.pathname === '/app/installations/149112973/access_tokens') return jsonResponse({
    token: 'installation-token', expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
  });
  if (url.pathname === '/graphql') {
    const body = JSON.parse(init.body ?? '{}') as {variables?: {repositoryOwner?: string}};
    return jsonResponse(projectPayload({
      projectId: repository === 'MSA' ? 'PVT_kwHOBIUvJs4Bbefq' : 'PVT_kwHOBIUvJs4Bbi0Q',
      repository,
      ...(body.variables?.repositoryOwner === undefined
        ? {items: input.projectItems ?? []}
        : {pullRequests: input.linkedPullRequests ?? []})
    }));
  }
  if (url.pathname === `/repos/VF78/${repository}`) return jsonResponse(repositoryPayload(repository));
  if (url.pathname.endsWith('/commits/main')) return jsonResponse({sha: sha(0)});
  if (url.pathname.endsWith('/issues')) return jsonResponse(input.issues ?? []);
  if (url.pathname.endsWith('/pulls')) return jsonResponse(input.pullRequests ?? []);
  if (url.pathname.includes('/check-runs')) return jsonResponse({check_runs: input.checkRuns ?? []});
  throw new Error(`Unexpected route ${url.pathname}`);
};

const adapter = (fetch: GitHubFetch, projectSecrets = secretsProvider()) =>
  createGitHubRepositoryReadAdapter({
    fetch,
    projectsSecretsProvider: projectSecrets,
    appSecretsProvider: appSecretsProvider(),
    appPrivateKeyRef
  });
const read = (repository: 'MSA' | 'ascon', fetch: GitHubFetch) =>
  adapter(fetch).readRepositorySnapshot!({
    repository: {owner: 'VF78', repository}, credentialRef
  });

describe('GitHub provider-native project reader', () => {
  it('exposes read-only repository capabilities and no local transition operation', () => {
    const github = adapter(vi.fn<GitHubFetch>());
    expect(github.provider).toBe('github');
    expect(github.capabilities).toEqual({
      readWorkItems: true,
      writeWorkItems: false,
      readPullRequests: true,
      readChecks: true
    });
    expect(github.readRepositorySnapshot).toEqual(expect.any(Function));
    expect(github.transitionWorkItem).toBeUndefined();
  });

  it('shares one in-flight snapshot between the task and repository read ports', async () => {
    const fetch = vi.fn<GitHubFetch>(routeFetch());
    const github = adapter(fetch);
    await expect(Promise.all([
      github.readWorkItems({repository: {owner: 'VF78', repository: 'MSA'}, credentialRef}),
      github.readRepositoryObservation({repository: {owner: 'VF78', repository: 'MSA'}, credentialRef})
    ])).resolves.toHaveLength(2);
    expect(fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/repos/VF78/MSA'))
      .toHaveLength(1);
  });

  it('rejects a repository outside the exact immutable scope before transport', async () => {
    const fetch = vi.fn<GitHubFetch>();
    await expect(adapter(fetch).readRepositorySnapshot!({
      repository: {owner: 'VF78', repository: 'other'}, credentialRef
    })).rejects.toMatchObject({code: 'github_repository_not_allowed'});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the exact read:project credential scope', async () => {
    const fetch = vi.fn<GitHubFetch>();
    await expect(adapter(fetch).readRepositorySnapshot!({
      repository: {owner: 'VF78', repository: 'MSA'},
      credentialRef: {...credentialRef, scope: ['project']}
    })).rejects.toMatchObject({code: 'github_credential_invalid'});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses ProjectV2 item identity and reads native status, hierarchy and dependencies', async () => {
    const value = await read('MSA', routeFetch({
      issues: [issuePayload(1), issuePayload(2)],
      projectItems: [projectItem({
        id: 'PVTI_MSA_1', issueId: 1, parentId: 2, subIssueIds: [3], dependencyIds: [4]
      })]
    }));
    expect(value.projectItems).toEqual([expect.objectContaining({
      externalId: 'PVTI_MSA_1',
      issueExternalId: 'github:issue:1',
      projectExternalId: 'PVT_kwHOBIUvJs4Bbefq',
      status: {
        fieldExternalId: 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc',
        optionExternalId: '1f121483', optionName: 'Ready'
      },
      parentIssueExternalId: 'github:issue:2',
      subIssueExternalIds: ['github:issue:3'],
      dependencyExternalIds: ['github:issue:4']
    })]);
    expect(JSON.stringify(value)).not.toContain('Issue 2');
  });

  it('reads the ASCON Target date from the configured Project field', async () => {
    const value = await read('ascon', routeFetch({
      repository: 'ascon',
      issues: [issuePayload(7, 'ascon')],
      projectItems: [projectItem({
        id: 'PVTI_ASCON_7', issueId: 7, repository: 'ascon', targetDate: '2026-09-01'
      })]
    }));
    expect(value.projectItems[0]).toMatchObject({targetDate: '2026-09-01'});
  });

  it('fails closed for an unknown Project status option', async () => {
    await expect(read('MSA', routeFetch({
      issues: [issuePayload(1)],
      projectItems: [projectItem({id: 'PVTI_MSA_1', issueId: 1, optionId: 'unknown'})]
    }))).rejects.toMatchObject({code: 'github_response_invalid'});
  });

  it('fails closed when Project item content is redacted', async () => {
    await expect(read('MSA', routeFetch({
      issues: [issuePayload(1)],
      projectItems: [{id: 'PVTI_MSA_1', content: null, fieldValues: {
        nodes: [], pageInfo: {hasNextPage: false}
      }}]
    }))).rejects.toMatchObject({code: 'github_project_item_content_redacted'});
  });

  it('keeps credential-shaped issue content out of the provider snapshot', async () => {
    const marker = `ghp_${'x'.repeat(24)}`;
    const value = await read('MSA', routeFetch({
      issues: [{...issuePayload(1), body: `Use token: ${marker}`}],
      projectItems: [projectItem({id: 'PVTI_MSA_1', issueId: 1})]
    }));
    expect(value.projectItems[0]?.requirements).toBeNull();
    expect(JSON.stringify(value)).not.toContain(marker);
  });

  it('rejects a seventeenth open-PR check fanout before making check requests', async () => {
    const fetch = vi.fn<GitHubFetch>(routeFetch({
      pullRequests: Array.from({length: 17}, (_, index) => pullRequestPayload(index + 1))
    }));
    await expect(read('MSA', fetch)).rejects.toMatchObject({
      code: 'github_request_budget_exceeded'
    });
    expect(fetch.mock.calls.some(([url]) => new URL(url).pathname.includes('/check-runs'))).toBe(false);
  });

  it('deduplicates a shared head SHA request', async () => {
    const sharedSha = sha(88);
    const fetch = vi.fn<GitHubFetch>(routeFetch({
      pullRequests: [
        {...pullRequestPayload(8), head: {ref: 'shared-8', sha: sharedSha}},
        {...pullRequestPayload(9), head: {ref: 'shared-9', sha: sharedSha}}
      ]
    }));
    await expect(read('MSA', fetch)).resolves.toMatchObject({checks: []});
    expect(fetch.mock.calls.filter(([url]) => new URL(url).pathname.includes('/check-runs')))
      .toHaveLength(1);
  });

  it('rejects duplicate provider check identities across pull requests', async () => {
    await expect(read('MSA', routeFetch({
      pullRequests: [pullRequestPayload(8), pullRequestPayload(9)],
      checkRuns: [{id: 44, name: 'same', status: 'completed', conclusion: 'success', details_url: null}]
    }))).rejects.toMatchObject({code: 'github_response_invalid'});
  });

  it('redacts secret resolution failures', async () => {
    const projectSecrets: SecretsProvider = {resolve: async () => {
      throw new Error('vault failure with caller-secret');
    }};
    let failure: unknown;
    try {
      await adapter(routeFetch(), projectSecrets).readRepositorySnapshot!({
        repository: {owner: 'VF78', repository: 'MSA'}, credentialRef
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({code: 'github_credential_invalid'});
    expect(String(failure)).not.toContain('caller-secret');
    expect(JSON.stringify(failure)).not.toContain('caller-secret');
  });

  it('keeps PR and check evidence linked by provider issue identity', async () => {
    const value = await read('MSA', routeFetch({
      issues: [issuePayload(7)],
      projectItems: [projectItem({id: 'PVTI_MSA_7', issueId: 7})],
      pullRequests: [pullRequestPayload(8)],
      linkedPullRequests: [{
        number: 8,
        closingIssuesReferences: {
          nodes: [{databaseId: 7, repository: {nameWithOwner: 'VF78/MSA'}}],
          pageInfo: {hasNextPage: false}
        }
      }],
      checkRuns: [{
        id: 44, name: 'test', status: 'completed', conclusion: 'success', details_url: null
      }]
    }));
    expect(value.pullRequests[0]).toMatchObject({
      externalId: 'github:pull-request:8', linkedIssueExternalIds: ['github:issue:7']
    });
    expect(value.checks[0]).toMatchObject({
      externalId: 'github:check-run:44', pullRequestExternalId: 'github:pull-request:8'
    });
  });

  it('is deterministic when provider collection order changes', async () => {
    const first = await read('MSA', routeFetch({
      issues: [issuePayload(2), issuePayload(1)],
      projectItems: [
        projectItem({id: 'PVTI_MSA_2', issueId: 2}),
        projectItem({id: 'PVTI_MSA_1', issueId: 1})
      ]
    }));
    const second = await read('MSA', routeFetch({
      issues: [issuePayload(1), issuePayload(2)],
      projectItems: [
        projectItem({id: 'PVTI_MSA_1', issueId: 1}),
        projectItem({id: 'PVTI_MSA_2', issueId: 2})
      ]
    }));
    expect(second).toEqual(first);
    expect(first.projectItems.map(({externalId}) => externalId))
      .toEqual(['PVTI_MSA_1', 'PVTI_MSA_2']);
  });
});
