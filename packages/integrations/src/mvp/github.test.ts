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
        ownerValue: {optionId: 'owner-hermes'},
        targetDateValue: {date: '2026-08-31'},
        content: {__typename: 'Issue', id: 'I_1', databaseId: 42, number: 42, title: 'Deliver feature',
          repository: {nameWithOwner: 'acme/repo'},
          url: 'https://github.com/acme/repo/issues/42', assignees: {nodes: [{id: 'U_1', login: 'octo', name: 'Octo Cat'}]},
          parent: {databaseId: 40, repository: {nameWithOwner: 'acme/repo'}},
          subIssues: {nodes: [{databaseId: 43, repository: {nameWithOwner: 'acme/repo'}}], pageInfo: {hasNextPage: false}},
          blockedBy: {nodes: [{databaseId: 41, repository: {nameWithOwner: 'acme/repo'}}], pageInfo: {hasNextPage: false}}}},
        {id: 'PVTI_other', updatedAt: '2026-08-13T00:00:00Z', content: {__typename: 'Issue',
          repository: {nameWithOwner: 'acme/other'}}},
        {id: 'PVTI_pr', updatedAt: '2026-08-13T00:00:00Z', content: {__typename: 'PullRequest'}}],
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
        statusOptionName: 'Ready', ownerOptionId: 'owner-hermes', assignees: [{id: 'U_1', login: 'octo', name: 'Octo Cat'}], blocked: false,
        targetDate: '2026-08-31', parentIssueId: '40',
        subIssueIds: ['43'], dependencyIssueIds: ['41']}]
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({authorization: 'Bearer token'});
    expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain('__typename');
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
    const fetch = vi.fn(async (url: string | URL | Request) => {
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

  it('reads assignable people from GitHub', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/assignees')) return new Response(JSON.stringify([{id: 7, login: 'octo', name: 'Octo Cat'}]));
      throw new Error(`unexpected request ${String(url)}`);
    });
    const adapter = createGitHubTrackerMutationAdapter({binding: {id: 'binding', owner: 'acme', repository: 'repo',
      projectId: 'project', projectNumber: 1, projectUrl: 'https://github.com/users/acme/projects/1', credentialRef: secretRef},
      credentialRef: secretRef, secrets: secrets('token'), fetch});
    await expect(adapter.listAssignableUsers()).resolves.toEqual([{id: '7', login: 'octo', name: 'Octo Cat'}]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('starts one exact blocked Backlog item for a human and reads every provider fact back', async () => {
    let stage = {optionId: 'backlog', name: 'Backlog'}; let blocked = {optionId: 'blocked-yes', name: 'Yes'};
    let owner: {optionId: string; name: string}|null = {optionId: 'owner-chatgpt', name: 'ChatGPT Work'};
    let assignees: readonly {id: string; login: string; name: null}[] = []; let updatedAt = '2026-08-24T00:00:00Z';
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body.includes('node(id:$id)')) return new Response(JSON.stringify({data: {node: {id: 'PVTI_1', updatedAt, project: {id: 'PVT_1'},
        statusValue: stage, ownerValue: owner, blockedValue: blocked,
        content: {id: 'I_42', databaseId: 9001, number: 42, url: 'https://github.com/acme/repo/issues/42', assignees: {nodes: assignees}}}}}));
      if (String(url).includes('/assignees')) return new Response(JSON.stringify([{id: 7, login: 'octo', name: null}]));
      if (body.includes('fields(first:100)')) return new Response(JSON.stringify({data: {user: {projectV2: {id: 'PVT_1', fields: {nodes: [
        {id: 'owner-field', name: 'Owner', options: [{id: 'owner-hermes', name: 'Hermes'}]},
        {id: 'status-field', name: 'Status', options: [{id: 'backlog', name: 'Backlog'}, {id: 'in-dev', name: 'In Dev'}]},
        {id: 'blocked-field', name: 'Blocked', options: [{id: 'blocked-yes', name: 'Yes'}, {id: 'blocked-no', name: 'No'}]}
      ], pageInfo: {hasNextPage: false}}}}}}));
      if (String(url).endsWith('/issues/42') && init?.method === 'PATCH') {
        assignees = [{id: '7', login: 'octo', name: null}]; updatedAt = '2026-08-24T00:01:00Z';
        return new Response(JSON.stringify({number: 42}));
      }
      if (body.includes('clearProjectV2ItemFieldValue')) { owner = null; return new Response(JSON.stringify({data: {clearProjectV2ItemFieldValue: {projectV2Item: {id: 'PVTI_1'}}}})); }
      if (body.includes('updateProjectV2ItemFieldValue')) {
        const variables = (JSON.parse(body) as {variables: {field: string}}).variables;
        if (variables.field === 'blocked-field') blocked = {optionId: 'blocked-no', name: 'No'};
        if (variables.field === 'status-field') stage = {optionId: 'in-dev', name: 'In Dev'};
        return new Response(JSON.stringify({data: {updateProjectV2ItemFieldValue: {projectV2Item: {id: 'PVTI_1'}}}}));
      }
      throw new Error(`unexpected request ${String(url)} ${body}`);
    });
    const adapter = createGitHubTrackerMutationAdapter({binding: {id: 'binding', owner: 'acme', repository: 'repo',
      projectId: 'project', projectNumber: 1, projectUrl: 'https://github.com/users/acme/projects/1', credentialRef: secretRef},
      credentialRef: secretRef, secrets: secrets('token'), fetch});
    await expect(adapter.startExecutor({itemId: 'PVTI_1', issueId: '9001', expectedVersion: 'github:updated-at:2026-08-24T00:00:00Z',
      expectedStage: 'Backlog', expectedBlocked: true, executor: {kind: 'human', candidate: {id: '7', login: 'octo'}}})).resolves.toBeUndefined();
    expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/issues/42') && init?.method === 'PATCH')).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/issues/9001'))).toBe(false);
  });

  it('changes one exact provider Project item stage and reads it back', async () => {
    let stage = {optionId: 'ready', name: 'Ready'}; let updatedAt = '2026-08-24T00:00:00Z';
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body.includes('node(id:$id)')) return new Response(JSON.stringify({data: {node: {
        id: 'PVTI_1', updatedAt, project: {id: 'PVT_1'}, statusValue: stage, ownerValue: null,
        blockedValue: {optionId: 'blocked-no', name: 'No'},
        content: {id: 'I_42', databaseId: 9001, number: 42,
          url: 'https://github.com/acme/repo/issues/42', assignees: {nodes: []}}
      }}}));
      if (body.includes('fields(first:100)')) return new Response(JSON.stringify({data: {user: {projectV2: {
        id: 'PVT_1', fields: {nodes: [
          {id: 'owner-field', name: 'Owner', options: []},
          {id: 'status-field', name: 'Status', options: [{id: 'ready', name: 'Ready'}, {id: 'qa', name: 'QA'}]},
          {id: 'blocked-field', name: 'Blocked', options: [{id: 'blocked-no', name: 'No'}]}
        ], pageInfo: {hasNextPage: false}}
      }}}}));
      if (body.includes('updateProjectV2ItemFieldValue')) {
        stage = {optionId: 'qa', name: 'QA'}; updatedAt = '2026-08-24T00:01:00Z';
        return new Response(JSON.stringify({data: {updateProjectV2ItemFieldValue: {projectV2Item: {id: 'PVTI_1'}}}}));
      }
      throw new Error(`unexpected request ${body}`);
    });
    const adapter = createGitHubTrackerMutationAdapter({binding: {id: 'binding', owner: 'acme', repository: 'repo',
      projectId: 'project', projectNumber: 1, projectUrl: 'https://github.com/users/acme/projects/1', credentialRef: secretRef},
      credentialRef: secretRef, secrets: secrets('token'), fetch});
    await expect(adapter.setProjectItemStage({projectId: 'project', itemId: 'PVTI_1', issueId: '9001',
      expectedVersion: 'github:updated-at:2026-08-24T00:00:00Z', stage: 'QA', idempotencyKey: 'command'}))
      .resolves.toEqual({referenceId: 'PVTI_1', url: 'https://github.com/users/acme/projects/1',
        version: 'github:updated-at:2026-08-24T00:01:00Z'});
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('updates one exact bound issue with optimistic item version and provider readback', async () => {
    let updatedAt = '2026-08-24T00:00:00Z'; let body = 'Before';
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const graphql = String(init?.body ?? '');
      if (graphql.includes('node(id:$id)')) return new Response(JSON.stringify({data: {node: {
        id: 'PVTI_1', updatedAt, project: {id: 'PVT_1'}, statusValue: {optionId: 'ready', name: 'Ready'}, ownerValue: null,
        blockedValue: {optionId: 'blocked-no', name: 'No'},
        content: {id: 'I_42', databaseId: 9001, number: 42,
          url: 'https://github.com/acme/repo/issues/42', assignees: {nodes: []}}
      }}}));
      if (String(url).endsWith('/issues/42') && init?.method === 'PATCH') {
        body = String(JSON.parse(String(init.body)).body); updatedAt = '2026-08-24T00:01:00Z';
        return new Response(JSON.stringify({number: 42}));
      }
      if (String(url).endsWith('/issues/42') && init?.method === undefined) return new Response(JSON.stringify({
        number: 42, html_url: 'https://github.com/acme/repo/issues/42', body, updated_at: updatedAt
      }));
      throw new Error(`unexpected request ${String(url)} ${graphql}`);
    });
    const adapter = createGitHubTrackerMutationAdapter({binding: {id: 'binding', owner: 'acme', repository: 'repo',
      projectId: 'project', projectNumber: 1, projectUrl: 'https://github.com/users/acme/projects/1', credentialRef: secretRef},
      credentialRef: secretRef, secrets: secrets('token'), fetch});
    await expect(adapter.updateIssue({projectId: 'project', itemId: 'PVTI_1', issueId: '9001',
      expectedVersion: 'github:updated-at:2026-08-24T00:00:00Z', operation: 'body', value: 'After',
      idempotencyKey: 'command'})).resolves.toEqual({referenceId: '42',
      url: 'https://github.com/acme/repo/issues/42', version: 'github:updated-at:2026-08-24T00:01:00Z'});
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
