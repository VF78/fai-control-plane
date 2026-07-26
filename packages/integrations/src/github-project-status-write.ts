import {createSign} from 'node:crypto';
import type {
  SecretsProvider,
  TrackerAdapter,
  TrackerWorkItemTransitionInput,
  TrackerWorkItemTransitionResult
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

type InstallationIds = Readonly<{
  'VF78/MSA': string;
  'VF78/ascon': string;
}>;

type AdapterFailure = 'identity_denied' | 'retryable';

const githubApi = 'https://api.github.com';
const userAgent = 'fai-control-plane-status-writeback/0.1';
const secretPurpose = 'github_project_status_write_private_key';
const requestTimeoutMs = 10_000;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const optionFor = (
  input: TrackerWorkItemTransitionInput
): Readonly<{fullName: 'VF78/MSA' | 'VF78/ascon'; optionId: string}> | null => {
  const scope = githubRepositoryScopeDefinitions.find((candidate) =>
    `github:repository:${candidate.repositoryId}` === input.target.repositoryExternalId &&
    candidate.projectNodeId === input.target.projectExternalId &&
    candidate.projectStatusFieldNodeId === input.target.fieldExternalId
  );
  if (scope === undefined) return null;
  const option = Object.entries(scope.projectStatusOptionMap).find(
    ([, status]) => status === input.status
  );
  return option === undefined ? null : {fullName: scope.fullName, optionId: option[0]};
};

const appJwt = (appId: string, privateKey: string, now: Date): string => {
  const encoded = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const issuedAt = Math.floor(now.getTime() / 1_000) - 60;
  const unsigned = `${encoded({alg: 'RS256', typ: 'JWT'})}.${encoded({
    iat: issuedAt,
    exp: issuedAt + 540,
    iss: appId
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
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

const installationToken = async (
  fetch: GitHubFetch,
  appId: string,
  privateKey: string,
  installationId: string,
  now: () => Date
): Promise<Readonly<{status: 'ok'; token: string}> | Readonly<{status: AdapterFailure}>> => {
  let jwt: string;
  try {
    jwt = appJwt(appId, privateKey, now());
  } catch {
    return {status: 'identity_denied'};
  }
  const response = await fetchRequest(
    fetch,
    `${githubApi}/app/installations/${installationId}/access_tokens`,
    {method: 'POST', headers: headers(jwt), body: '{}'}
  );
  if (response.status !== 'ok') return response;
  const body = object(await response.response.json());
  return body === null || typeof body.token !== 'string' || body.token.length === 0
    ? {status: 'identity_denied'}
    : {status: 'ok', token: body.token};
};

const itemFieldQuery = `query ProjectStatusItem($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      id
      project { id }
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
  input: TrackerWorkItemTransitionInput
): Readonly<{status: 'observed'; optionId: string | null}> | Readonly<{status: 'identity_denied'}> => {
  const item = object(data.node);
  const project = item === null ? null : object(item.project);
  if (
    item === null || project === null || item.id !== input.target.projectItemExternalId ||
    project.id !== input.target.projectExternalId
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
  appId: string;
  installationIds: InstallationIds;
  secretsProvider: SecretsProvider;
  fetch?: GitHubFetch;
  now?: () => Date;
}>): Pick<TrackerAdapter, 'transitionWorkItem'> => {
  const fetch = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = input.now ?? (() => new Date());
  return {
    async transitionWorkItem(command): Promise<TrackerWorkItemTransitionResult> {
      const target = optionFor(command);
      const installationId = target === null ? undefined : input.installationIds[target.fullName];
      if (
        !/^[1-9][0-9]{0,19}$/.test(input.appId) || target === null ||
        installationId === undefined || !/^[1-9][0-9]{0,19}$/.test(installationId)
      ) {
        return {status: 'identity_denied'};
      }
      let privateKey: string;
      try {
        ({value: privateKey} = await input.secretsProvider.resolve(
          command.credentialRef,
          secretPurpose
        ));
      } catch {
        return {status: 'identity_denied'};
      }
      const token = await installationToken(fetch, input.appId, privateKey, installationId, now);
      if (token.status !== 'ok') return token;
      const before = await graphql(fetch, token.token, itemFieldQuery, {
        itemId: command.target.projectItemExternalId
      });
      if (before.status !== 'ok') return before;
      const observedBefore = observedOption(before.data, command);
      if (observedBefore.status === 'identity_denied') return observedBefore;
      if (observedBefore.optionId === target.optionId) {
        return {status: 'confirmed', receipt: {
          verification: 'read_after_write',
          projectItemExternalId: command.target.projectItemExternalId,
          optionExternalId: target.optionId,
          clientMutationId: command.mutationId
        }};
      }
      if (observedBefore.optionId !== command.expectedProviderOptionId) return {status: 'stale'};
      const updated = await graphql(fetch, token.token, updateStatusMutation, {
        projectId: command.target.projectExternalId,
        itemId: command.target.projectItemExternalId,
        fieldId: command.target.fieldExternalId,
        optionId: target.optionId,
        clientMutationId: command.mutationId
      });
      if (updated.status !== 'ok') return updated;
      const update = object(updated.data.updateProjectV2ItemFieldValue);
      const updatedItem = update === null ? null : object(update.projectV2Item);
      if (
        update === null || update.clientMutationId !== command.mutationId ||
        updatedItem === null || updatedItem.id !== command.target.projectItemExternalId
      ) return {status: 'identity_denied'};
      const after = await graphql(fetch, token.token, itemFieldQuery, {
        itemId: command.target.projectItemExternalId
      });
      if (after.status !== 'ok') return after;
      const observedAfter = observedOption(after.data, command);
      if (observedAfter.status === 'identity_denied') return observedAfter;
      return observedAfter.optionId === target.optionId
        ? {status: 'confirmed', receipt: {
          verification: 'read_after_write',
          projectItemExternalId: command.target.projectItemExternalId,
          optionExternalId: target.optionId,
          clientMutationId: command.mutationId
        }}
        : {status: 'stale'};
    }
  };
};
