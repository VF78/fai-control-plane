import {describe, expect, it, vi} from 'vitest';
import type {
  OpaqueSecretRef,
  SecretsProvider,
  TrackerProjectItemUpdateInput
} from '@fai-control-plane/domain';
import {
  createGitHubProjectStatusWriteAdapter,
  githubProjectsOAuthScope
} from './github-project-status-write';

type GitHubFetch = (
  input: string,
  init: Readonly<{
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal;
  }>
) => Promise<Response>;

const credentialRef: OpaqueSecretRef = {
  provider: 'file',
  reference: '/run/secrets/github-projects-oauth-token',
  scope: githubProjectsOAuthScope
};

const command = (overrides: Partial<TrackerProjectItemUpdateInput> = {}): TrackerProjectItemUpdateInput => ({
  expectedOptionExternalId: '1f121483',
  target: {
    repositoryExternalId: 'github:repository:1278325372',
    projectExternalId: 'PVT_kwHOBIUvJs4Bbefq',
    projectItemExternalId: 'PVTI_MSA_1',
    fieldExternalId: 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc',
    optionExternalId: 'f37309f6'
  },
  mutationId: 'b688754d-64b0-424b-a8bf-533acd9e8752',
  credentialRef,
  ...overrides
});

const jsonResponse = (payload: unknown): Response => new Response(JSON.stringify(payload), {
  headers: {'content-type': 'application/json'}
});

const projectItem = (optionId: string) => ({data: {node: {
  id: 'PVTI_MSA_1',
  project: {id: 'PVT_kwHOBIUvJs4Bbefq', owner: {databaseId: 75837222}},
  fieldValues: {nodes: [{
    optionId,
    field: {id: 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc'}
  }]}
}}});

describe('GitHub Project status write adapter', () => {
  it('denies a non-exact OAuth scope or a Project outside the hard allowlist before secret resolution', async () => {
    const resolve = vi.fn<SecretsProvider['resolve']>();
    const fetch = vi.fn<GitHubFetch>();
    const write = createGitHubProjectStatusWriteAdapter({secretsProvider: {resolve}, fetch})
      .updateProjectItem;

    await expect(write(command({credentialRef: {...credentialRef, scope: ['project', 'repo']}})))
      .resolves.toEqual({status: 'identity_denied'});
    await expect(write(command({target: {
      ...command().target, projectExternalId: 'PVT_not_allowlisted'
    }}))).resolves.toEqual({status: 'identity_denied'});

    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('declares one provider-native Project item update operation', () => {
    const adapter = createGitHubProjectStatusWriteAdapter({
      secretsProvider: {resolve: vi.fn<SecretsProvider['resolve']>()}
    });

    expect(adapter.provider).toBe('github');
    expect(adapter.updateProjectItem).toEqual(expect.any(Function));
  });

  it('writes an allowlisted Project status with the configured OAuth bearer and confirms it', async () => {
    const resolve = vi.fn<SecretsProvider['resolve']>(async () => ({value: 'oauth-access-token'}));
    const fetch = vi.fn<GitHubFetch>()
      .mockResolvedValueOnce(jsonResponse(projectItem('1f121483')))
      .mockResolvedValueOnce(jsonResponse({data: {updateProjectV2ItemFieldValue: {
        clientMutationId: command().mutationId, projectV2Item: {id: 'PVTI_MSA_1'}
      }}}))
      .mockResolvedValueOnce(jsonResponse(projectItem('f37309f6')));
    const result = await createGitHubProjectStatusWriteAdapter({secretsProvider: {resolve}, fetch})
      .updateProjectItem(command());

    expect(result).toEqual({status: 'confirmed', receipt: {
      verification: 'read_after_write',
      projectItemExternalId: 'PVTI_MSA_1',
      optionExternalId: 'f37309f6',
      clientMutationId: command().mutationId
    }});
    expect(resolve).toHaveBeenCalledWith(credentialRef, 'github_project_status_write_oauth_token');
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) {
      expect(init.headers.authorization).toBe('Bearer oauth-access-token');
    }
  });

  it('does not return a confirmed receipt when read-after-write observes another option', async () => {
    const resolve = vi.fn<SecretsProvider['resolve']>(async () => ({value: 'oauth-access-token'}));
    const fetch = vi.fn<GitHubFetch>()
      .mockResolvedValueOnce(jsonResponse(projectItem('1f121483')))
      .mockResolvedValueOnce(jsonResponse({data: {updateProjectV2ItemFieldValue: {
        clientMutationId: command().mutationId, projectV2Item: {id: 'PVTI_MSA_1'}
      }}}))
      .mockResolvedValueOnce(jsonResponse(projectItem('1f121483')));

    await expect(createGitHubProjectStatusWriteAdapter({secretsProvider: {resolve}, fetch})
      .updateProjectItem(command())).resolves.toEqual({status: 'stale'});
  });

  it('does not mutate when the exact Project item already has the target option', async () => {
    const fetch = vi.fn<GitHubFetch>()
      .mockResolvedValueOnce(jsonResponse(projectItem('f37309f6')));
    await expect(createGitHubProjectStatusWriteAdapter({
      secretsProvider: {resolve: async () => ({value: 'oauth-access-token'})},
      fetch
    }).updateProjectItem(command())).resolves.toMatchObject({
      status: 'confirmed',
      receipt: {verification: 'read_after_write', optionExternalId: 'f37309f6'}
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails the provider CAS without mutation when the observed option is stale', async () => {
    const fetch = vi.fn<GitHubFetch>()
      .mockResolvedValueOnce(jsonResponse(projectItem('b4f120e4')));
    await expect(createGitHubProjectStatusWriteAdapter({
      secretsProvider: {resolve: async () => ({value: 'oauth-access-token'})},
      fetch
    }).updateProjectItem(command())).resolves.toEqual({status: 'stale'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
