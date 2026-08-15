import {createHmac} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {createGitHubRepositoryReadAdapter, createGitHubTrackerMutationAdapter, createGitHubTrackerReadAdapter, verifyGitHubWebhook} from './github.ts';

const secretRef = {id: 'secret', purpose: 'tracker', locator: '/run/secrets/provider'};
const secrets = (value: string) => ({resolve: vi.fn(async () => ({value}))});

describe('MVP GitHub adapter', () => {
  it('verifies a delivery against the raw body', async () => {
    const body = new TextEncoder().encode('{"action":"edited"}');
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(body).digest('hex')}`;
    await expect(verifyGitHubWebhook({
      headers: {'x-hub-signature-256': signature, 'x-github-delivery': 'delivery', 'x-github-event': 'projects_v2_item'},
      body, secretRef, secrets: secrets('webhook-secret')
    })).resolves.toMatchObject({deliveryId: 'delivery', eventType: 'projects_v2_item'});
  });

  it('rejects an altered webhook body', async () => {
    const body = new TextEncoder().encode('{}');
    await expect(verifyGitHubWebhook({
      headers: {'x-hub-signature-256': `sha256=${'a'.repeat(64)}`, 'x-github-delivery': 'delivery', 'x-github-event': 'ping'},
      body, secretRef, secrets: secrets('webhook-secret')
    })).resolves.toBeNull();
  });

  it('maps provider-native Project facts into a neutral snapshot', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({data: {user: {projectV2: {
      id: 'PVT_1', url: 'https://github.com/users/acme/projects/1', updatedAt: '2026-08-13T00:00:00Z',
      items: {nodes: [{id: 'PVTI_1', updatedAt: '2026-08-13T00:00:00Z',
        statusValue: {optionId: 'status', name: 'Ready'}, blockedValue: {optionId: 'not-blocked', name: 'No'},
        targetDateValue: {date: '2026-08-31'},
        content: {id: 'I_1', databaseId: 42, number: 42, title: 'Deliver feature',
          repository: {nameWithOwner: 'acme/repo'},
          url: 'https://github.com/acme/repo/issues/42', assignees: {nodes: [{id: 'U_1'}]},
          parent: {databaseId: 40, repository: {nameWithOwner: 'acme/repo'}},
          subIssues: {nodes: [{databaseId: 43, repository: {nameWithOwner: 'acme/repo'}}], pageInfo: {hasNextPage: false}},
          blockedBy: {nodes: [{databaseId: 41, repository: {nameWithOwner: 'acme/repo'}}], pageInfo: {hasNextPage: false}}}}],
        pageInfo: {endCursor: 'cursor', hasNextPage: false}}
    }}}}), {status: 200}));
    const adapter = createGitHubTrackerReadAdapter({
      binding: {id: 'binding', owner: 'acme', repository: 'repo', projectId: 'project', projectNumber: 1,
        projectUrl: 'https://github.com/users/acme/projects/1', credentialRef: secretRef},
      secrets: secrets('token'), fetch
    });
    await expect(adapter.readSnapshot('binding', null)).resolves.toMatchObject({
      bindingId: 'binding', externalVersion: 'github:updated-at:2026-08-13T00:00:00Z',
      cursor: 'github:updated-at:2026-08-13T00:00:00Z',
      items: [{itemId: 'PVTI_1', projectId: 'project', issueId: '42', title: 'Deliver feature',
        statusOptionName: 'Ready', blocked: false, targetDate: '2026-08-31', parentIssueId: '40',
        subIssueIds: ['43'], dependencyIssueIds: ['41']}]
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({authorization: 'Bearer token'});
  });

  it('repeats a full repair read instead of treating a page cursor as sync state', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({data: {user: {projectV2: {
      id: 'PVT_1', url: 'https://github.com/users/acme/projects/1', updatedAt: '2026-08-13T00:00:00Z',
      items: {nodes: [], pageInfo: {endCursor: 'page-cursor', hasNextPage: false}}
    }}}}), {status: 200}));
    const adapter = createGitHubTrackerReadAdapter({binding: {id: 'binding', owner: 'acme', repository: 'repo',
      projectId: 'project', projectNumber: 1, projectUrl: 'https://github.com/users/acme/projects/1', credentialRef: secretRef},
      secrets: secrets('token'), fetch});
    await expect(adapter.readSnapshot('binding', 'previous-provider-marker')).resolves.toMatchObject({
      cursor: 'github:updated-at:2026-08-13T00:00:00Z'
    });
  });

  it('keeps repository observation provider-neutral and bound to the configured repository', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      html_url: 'https://github.com/acme/repo', default_branch: 'main'
    })));
    const adapter = createGitHubRepositoryReadAdapter({owner: 'acme', repository: 'repo', repositoryId: 'R_1',
      credentialRef: secretRef, secrets: secrets('token'), fetch});
    await expect(adapter.readRepository({repositoryId: 'R_1'})).resolves.toMatchObject({
      repositoryId: 'R_1', url: 'https://github.com/acme/repo', defaultBranch: 'main'
    });
    await expect(adapter.readRepository({repositoryId: 'R_2'})).rejects.toThrow('github_repository_denied');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reads every Project page into one version-consistent snapshot', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const after = (JSON.parse(String(init?.body)) as {variables: {after: string | null}}).variables.after;
      return new Response(JSON.stringify({data: {user: {projectV2: {
        id: 'PVT_1', url: 'https://github.com/users/acme/projects/1', updatedAt: '2026-08-13T00:00:00Z',
        items: {nodes: [], pageInfo: after === null
          ? {endCursor: 'next-page', hasNextPage: true}
          : {endCursor: 'complete', hasNextPage: false}}
      }}}}), {status: 200});
    });
    const adapter = createGitHubTrackerReadAdapter({binding: {id: 'binding', owner: 'acme', repository: 'repo',
      projectId: 'project', projectNumber: 1, projectUrl: 'https://github.com/users/acme/projects/1', credentialRef: secretRef},
      secrets: secrets('token'), fetch});
    await expect(adapter.readSnapshot('binding', null)).resolves.toMatchObject({
      externalVersion: 'github:updated-at:2026-08-13T00:00:00Z', items: []
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({variables: {after: 'next-page'}});
  });

  it('recovers an issue-create replay and repairs missing Project membership', async () => {
    const fetched: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      fetched.push(String(url));
      if (String(url).includes('search/issues')) return new Response(JSON.stringify({items: [{number: 42,
        node_id: 'I_42', html_url: 'https://github.com/acme/repo/issues/42', updated_at: '2026-08-13T00:00:00Z'}]}));
      if (fetched.length === 2) return new Response(JSON.stringify({data: {user: {projectV2: {id: 'PVT_1'}}}}));
      if (String(init?.body).includes('projectItems')) return new Response(JSON.stringify({data: {node: {
        projectItems: {nodes: [], pageInfo: {hasNextPage: false}}
      }}}));
      return new Response(JSON.stringify({data: {addProjectV2ItemById: {item: {id: 'PVTI_1'}}}}));
    });
    const adapter = createGitHubTrackerMutationAdapter({binding: {id: 'binding', owner: 'acme', repository: 'repo',
      projectId: 'project', projectNumber: 1, projectUrl: 'https://github.com/users/acme/projects/1', credentialRef: secretRef},
      credentialRef: secretRef, secrets: secrets('token'), fetch});
    await expect(adapter.createIssue({projectId: 'project', title: 'Defect', statement: 'Details', idempotencyKey: 'command'}))
      .resolves.toEqual({referenceId: '42', url: 'https://github.com/acme/repo/issues/42',
        version: 'github:updated-at:2026-08-13T00:00:00Z'});
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetched[0]).toContain('search/issues');
    expect(String(fetch.mock.calls[3]?.[1]?.body)).toContain('addProjectV2ItemById');
  });

  it('treats a marker-found issue already in the Project as a completed replay', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('search/issues')) return new Response(JSON.stringify({items: [{number: 42,
        node_id: 'I_42', html_url: 'https://github.com/acme/repo/issues/42', updated_at: '2026-08-13T00:00:00Z'}]}));
      if (String(init?.body).includes('projectV2(number')) {
        return new Response(JSON.stringify({data: {user: {projectV2: {id: 'PVT_1'}}}}));
      }
      return new Response(JSON.stringify({data: {node: {projectItems: {
        nodes: [{id: 'PVTI_1', project: {id: 'PVT_1'}}], pageInfo: {hasNextPage: false}
      }}}}));
    });
    const adapter = createGitHubTrackerMutationAdapter({binding: {id: 'binding', owner: 'acme', repository: 'repo',
      projectId: 'project', projectNumber: 1, projectUrl: 'https://github.com/users/acme/projects/1', credentialRef: secretRef},
      credentialRef: secretRef, secrets: secrets('token'), fetch});
    await expect(adapter.createIssue({projectId: 'project', title: 'Defect', statement: 'Details', idempotencyKey: 'command'}))
      .resolves.toMatchObject({referenceId: '42'});
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
