import type {
  SecretsProvider,
  TrackerProjectItemUpdateInput,
  TrackerProjectItemUpdatePort,
  TrackerProjectItemUpdateResult
} from '@fai-control-plane/domain';
import {githubRepositoryScopeDefinitions} from './github-contract';

type GitHubFetch = (
  input: string,
  init: Readonly<{
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal;
  }>
) => Promise<Response>;

type AdapterFailure = 'identity_denied' | 'retryable';

const githubApi = 'https://api.github.com';
const userAgent = 'fai-control-plane-status-writeback/0.1';
const secretPurpose = 'github_project_status_write_oauth_token';
const requestTimeoutMs = 10_000;
const githubProjectsOwnerId = 75837222;
const allowedProjectNodeIds = new Set([
  'PVT_kwHOBIUvJs4Bbefq',
  'PVT_kwHOBIUvJs4Bbi0Q'
]);

export const githubProjectsOAuthScope = Object.freeze(['project']);

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const optionFor = (
  input: TrackerProjectItemUpdateInput
): string | null => {
  const scope = githubRepositoryScopeDefinitions.find((candidate) =>
    `github:repository:${candidate.repositoryId}` === input.target.repositoryExternalId &&
    candidate.projectNodeId === input.target.projectExternalId &&
    candidate.projectStatusFieldNodeId === input.target.fieldExternalId
  );
  if (scope === undefined) return null;
  return scope.projectStatusOptions[input.target.optionExternalId] === undefined
    ? null
    : input.target.optionExternalId;
};

const headers = (token: string): Readonly<Record<string, string>> => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'user-agent': userAgent,
  'x-github-api-version': '2022-11-28'
});

const failureFor = (status: number): AdapterFailure =>
  status === 401 || status === 403 || (status >= 400 && status < 500 && status !== 429)
    ? 'identity_denied'
    : 'retryable';

const fetchRequest = async (
  fetch: GitHubFetch,
  url: string,
  init: Omit<Parameters<GitHubFetch>[1], 'signal'>
): Promise<Readonly<{status: 'ok'; response: Response}> | Readonly<{status: AdapterFailure}>> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {...init, signal: controller.signal});
    return response.ok ? {status: 'ok', response} : {status: failureFor(response.status)};
  } catch {
    return {status: 'retryable'};
  } finally {
    clearTimeout(timeout);
  }
};

const itemFieldQuery = `query ProjectStatusItem($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      id
      project {
        id
        owner {
          ... on User { databaseId }
          ... on Organization { databaseId }
        }
      }
      fieldValues(first: 100) {
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue {
            optionId
            field { ... on ProjectV2SingleSelectField { id } }
          }
        }
      }
    }
  }
}`;

const updateStatusMutation = `mutation UpdateProjectV2ItemFieldValue(
  $projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!, $clientMutationId: String!
) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: {singleSelectOptionId: $optionId}, clientMutationId: $clientMutationId
  }) { clientMutationId projectV2Item { id } }
}`;

const graphql = async (
  fetch: GitHubFetch,
  token: string,
  query: string,
  variables: Record<string, string>
): Promise<Readonly<{status: 'ok'; data: Record<string, unknown>}> | Readonly<{status: AdapterFailure}>> => {
  const response = await fetchRequest(fetch, `${githubApi}/graphql`, {
    method: 'POST', headers: headers(token), body: JSON.stringify({query, variables})
  });
  if (response.status !== 'ok') return response;
  const body = object(await response.response.json());
  if (body === null || body.errors !== undefined || object(body.data) === null) {
    return {status: 'identity_denied'};
  }
  return {status: 'ok', data: body.data as Record<string, unknown>};
};

const observedOption = (
  data: Record<string, unknown>,
  input: TrackerProjectItemUpdateInput
): Readonly<{status: 'observed'; optionId: string | null}> | Readonly<{status: 'identity_denied'}> => {
  const item = object(data.node);
  const project = item === null ? null : object(item.project);
  const owner = project === null ? null : object(project.owner);
  if (
    item === null || project === null || item.id !== input.target.projectItemExternalId ||
    project.id !== input.target.projectExternalId ||
    !allowedProjectNodeIds.has(project.id as string) ||
    owner === null || owner.databaseId !== githubProjectsOwnerId
  ) return {status: 'identity_denied'};
  const fieldValues = object(item.fieldValues);
  const nodes = fieldValues === null || !Array.isArray(fieldValues.nodes)
    ? null
    : fieldValues.nodes;
  if (nodes === null) return {status: 'identity_denied'};
  let optionId: string | null | undefined;
  for (const node of nodes) {
    const value = object(node);
    if (value === null) continue;
    const field = object(value.field);
    if (field === null || field.id !== input.target.fieldExternalId) continue;
    if (optionId !== undefined) return {status: 'identity_denied'};
    optionId = value.optionId === null ? null : typeof value.optionId === 'string'
      ? value.optionId
      : undefined;
  }
  return optionId === undefined ? {status: 'identity_denied'} : {status: 'observed', optionId};
};

export const createGitHubProjectStatusWriteAdapter = (input: Readonly<{
  secretsProvider: SecretsProvider;
  fetch?: GitHubFetch;
}>): TrackerProjectItemUpdatePort => {
  const fetch = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return {
    provider: 'github',
    async updateProjectItem(command): Promise<TrackerProjectItemUpdateResult> {
      const target = optionFor(command);
      if (
        target === null || !allowedProjectNodeIds.has(command.target.projectExternalId) ||
        command.credentialRef.scope.length !== githubProjectsOAuthScope.length ||
        command.credentialRef.scope.some((scope, index) => scope !== githubProjectsOAuthScope[index])
      ) {
        return {status: 'identity_denied'};
      }
      let token: string;
      try {
        ({value: token} = await input.secretsProvider.resolve(
          command.credentialRef,
          secretPurpose
        ));
      } catch {
        return {status: 'identity_denied'};
      }
      if (token.length === 0 || token.length > 65_536 || token.includes('\0')) {
        return {status: 'identity_denied'};
      }
      const before = await graphql(fetch, token, itemFieldQuery, {
        itemId: command.target.projectItemExternalId
      });
      if (before.status !== 'ok') return before;
      const observedBefore = observedOption(before.data, command);
      if (observedBefore.status === 'identity_denied') return observedBefore;
      if (observedBefore.optionId === target) {
        return {status: 'confirmed', receipt: {
          verification: 'read_after_write',
          projectItemExternalId: command.target.projectItemExternalId,
          optionExternalId: target,
          clientMutationId: command.mutationId
        }};
      }
      if (observedBefore.optionId !== command.expectedOptionExternalId) return {status: 'stale'};
      const updated = await graphql(fetch, token, updateStatusMutation, {
        projectId: command.target.projectExternalId,
        itemId: command.target.projectItemExternalId,
        fieldId: command.target.fieldExternalId,
        optionId: target,
        clientMutationId: command.mutationId
      });
      if (updated.status !== 'ok') return updated;
      const update = object(updated.data.updateProjectV2ItemFieldValue);
      const updatedItem = update === null ? null : object(update.projectV2Item);
      if (
        update === null || update.clientMutationId !== command.mutationId ||
        updatedItem === null || updatedItem.id !== command.target.projectItemExternalId
      ) return {status: 'identity_denied'};
      const after = await graphql(fetch, token, itemFieldQuery, {
        itemId: command.target.projectItemExternalId
      });
      if (after.status !== 'ok') return after;
      const observedAfter = observedOption(after.data, command);
      if (observedAfter.status === 'identity_denied') return observedAfter;
      return observedAfter.optionId === target
        ? {status: 'confirmed', receipt: {
          verification: 'read_after_write',
          projectItemExternalId: command.target.projectItemExternalId,
          optionExternalId: target,
          clientMutationId: command.mutationId
        }}
        : {status: 'stale'};
    }
  };
};
