import {createHash, createSign} from 'node:crypto';
import type {
  OpaqueSecretRef,
  SecretsProvider,
  TrackerAdapter,
  TrackerCheckConclusion,
  TrackerCheckStatus,
  TrackerCheckSnapshot,
  TrackerIdentity,
  TrackerLabel,
  TrackerMilestone,
  TrackerProjectStatusObservation,
  TrackerPullRequestSnapshot,
  TrackerRepositorySnapshot,
  TrackerWorkItemSnapshot
} from '@fai-control-plane/domain';
import {trackerCheckStatuses} from '@fai-control-plane/domain';
import {
  githubCheckRunConclusions,
  githubRepositoryScopeDefinitions,
  type GitHubRepositoryScopeDefinition
} from './github-contract';

const pageSize = 100;
const maximumPages = 10;
const maximumProjectItemPages = 2;
const maximumSnapshotRequests = 36;
const maximumOpenPullRequestCheckFanout = 16;
const projectCredentialPurpose = 'github_project_snapshot_read_oauth_token';
const appPrivateKeyPurpose = 'github_app_installation_token_mint';
const githubProjectsOAuthScope = Object.freeze(['project']);
const githubAppId = 4_397_394;
const githubInstallationId = 149_112_973;
const githubProjectsOwnerId = 75_837_222;
const shaPattern = /^[0-9a-f]{40}$/i;
const colorPattern = /^[0-9a-f]{6}$/i;

export type GitHubFetch = (
  input: string,
  init: Readonly<{
    method: 'GET' | 'POST';
    headers: Readonly<Record<string, string>>;
    body?: string;
  }>
) => Promise<Response>;

export type GitHubRepositoryReadErrorCode =
  | 'github_repository_not_allowed'
  | 'github_credential_invalid'
  | 'github_transport_failed'
  | 'github_provider_rejected'
  | 'github_rate_limited'
  | 'github_request_budget_exceeded'
  | 'github_response_invalid'
  | 'github_pagination_exceeded';

export class GitHubRepositoryReadError extends Error {
  readonly name = 'GitHubRepositoryReadError';

  constructor(readonly code: GitHubRepositoryReadErrorCode) {
    super(code);
  }
}

type JsonObject = Readonly<Record<string, unknown>>;

const fail = (code: GitHubRepositoryReadErrorCode): never => {
  throw new GitHubRepositoryReadError(code);
};

const object = (value: unknown): JsonObject => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('github_response_invalid');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail('github_response_invalid');
  }
  return value as JsonObject;
};

const array = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) return fail('github_response_invalid');
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return fail('github_response_invalid');
  }
  return value;
};

const boundedString = (value: unknown, maximumLength: number): string => {
  if (typeof value !== 'string' || value.trim().length === 0 ||
    value.length > maximumLength) {
    return fail('github_response_invalid');
  }
  return value;
};

const nullableBoundedString = (
  value: unknown,
  maximumLength: number
): string | null => {
  if (value === null) return null;
  return boundedString(value, maximumLength);
};

const parseHttpsUrl = (value: unknown): Readonly<{serialized: string; parsed: URL}> => {
  const serialized = boundedString(value, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(serialized);
  } catch {
    return fail('github_response_invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' ||
    parsed.password !== '') {
    return fail('github_response_invalid');
  }
  return {serialized, parsed};
};

const entityUrl = (
  value: unknown,
  expectedHost: string,
  expectedPath: string
): string => {
  const {serialized, parsed} = parseHttpsUrl(value);
  if (parsed.origin !== `https://${expectedHost}` ||
    parsed.pathname !== expectedPath ||
    parsed.search !== '' || parsed.hash !== '') {
    return fail('github_response_invalid');
  }
  return serialized;
};

const optionalDetailsUrl = (value: unknown): string | null => {
  if (value === null) return null;
  return parseHttpsUrl(value).serialized;
};

const positiveInteger = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return fail('github_response_invalid');
  }
  return value as number;
};

const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') return fail('github_response_invalid');
  return value;
};

const state = (value: unknown): 'open' | 'closed' => {
  if (value !== 'open' && value !== 'closed') {
    return fail('github_response_invalid');
  }
  return value;
};

const checkStatus = (
  value: unknown
): TrackerCheckStatus => {
  if (typeof value !== 'string' ||
    !trackerCheckStatuses.includes(value as TrackerCheckStatus)) {
    return fail('github_response_invalid');
  }
  return value as TrackerCheckStatus;
};

const stableId = (kind: string, id: number): string => `github:${kind}:${id}`;

const headSha = (value: unknown): string => {
  const candidate = boundedString(value, 40);
  if (!shaPattern.test(candidate)) return fail('github_response_invalid');
  return candidate.toLowerCase();
};

const checkConclusion = (value: unknown): TrackerCheckConclusion | null => {
  if (value === null) return null;
  if (typeof value !== 'string' ||
    !githubCheckRunConclusions.includes(value as TrackerCheckConclusion)) {
    return fail('github_response_invalid');
  }
  return value as TrackerCheckConclusion;
};

const stableVersion = (value: unknown): string => {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    if (input !== null && typeof input === 'object') {
      const record = input as Readonly<Record<string, unknown>>;
      return `{${Object.keys(record).sort().map(
        (key) => `${JSON.stringify(key)}:${canonical(record[key])}`
      ).join(',')}}`;
    }
    return JSON.stringify(input);
  };
  return `github:sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
};

const byStableId = <T extends Readonly<{externalId: string}>>(
  values: readonly T[]
): readonly T[] => [...values].sort((left, right) => {
  const identityOrder = left.externalId.localeCompare(right.externalId);
  return identityOrder === 0
    ? stableVersion(left).localeCompare(stableVersion(right))
    : identityOrder;
});

const byNumber = <T extends Readonly<{number: number; externalId: string}>>(
  values: readonly T[]
): readonly T[] => [...values].sort((left, right) =>
  left.number - right.number || left.externalId.localeCompare(right.externalId)
);

const assertUnique = <T>(
  values: readonly T[],
  key: (value: T) => string | number
): void => {
  const seen = new Set<string | number>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) return fail('github_response_invalid');
    seen.add(identity);
  }
};

const identity = (value: unknown): TrackerIdentity => {
  const source = object(value);
  return {
    externalId: stableId('user', positiveInteger(source.id)),
    login: boundedString(source.login, 100)
  };
};

const label = (value: unknown): TrackerLabel => {
  const source = object(value);
  const color = boundedString(source.color, 6);
  if (!colorPattern.test(color)) return fail('github_response_invalid');
  return {
    externalId: stableId('label', positiveInteger(source.id)),
    name: boundedString(source.name, 256),
    color: color.toLowerCase()
  };
};

const milestone = (value: unknown): TrackerMilestone | null => {
  if (value === null) return null;
  const source = object(value);
  return {
    externalId: stableId('milestone', positiveInteger(source.id)),
    number: positiveInteger(source.number),
    title: boundedString(source.title, 1_024),
    state: state(source.state)
  };
};

const workItem = (
  value: unknown,
  scope: GitHubRepositoryScopeDefinition
): TrackerWorkItemSnapshot | null => {
  const source = object(value);
  if (source.pull_request !== undefined) return null;
  const id = positiveInteger(source.id);
  const number = positiveInteger(source.number);
  const providerLabels = array(source.labels).map(label);
  const providerAssignees = array(source.assignees).map(identity);
  assertUnique(providerLabels, ({externalId}) => externalId);
  assertUnique(providerAssignees, ({externalId}) => externalId);
  const labels = byStableId(providerLabels);
  const assignees = byStableId(providerAssignees);
  const snapshot = {
    externalId: stableId('issue', id),
    url: entityUrl(
      source.url,
      'api.github.com',
      `/repos/${scope.fullName}/issues/${number}`
    ),
    htmlUrl: entityUrl(
      source.html_url,
      'github.com',
      `/${scope.fullName}/issues/${number}`
    ),
    number,
    title: boundedString(source.title, 1_024),
    state: state(source.state),
    labels,
    assignees,
    milestone: milestone(source.milestone),
    projectStatus: null
  };
  return {...snapshot, externalVersion: stableVersion(snapshot)};
};

const pullRequest = (
  value: unknown,
  scope: GitHubRepositoryScopeDefinition,
  linkedWorkItemExternalIds: readonly string[]
): TrackerPullRequestSnapshot => {
  const source = object(value);
  const head = object(source.head);
  const base = object(source.base);
  const id = positiveInteger(source.id);
  const number = positiveInteger(source.number);
  const mergedAt = nullableBoundedString(source.merged_at, 64);
  const providerLabels = array(source.labels).map(label);
  const providerAssignees = array(source.assignees).map(identity);
  assertUnique(providerLabels, ({externalId}) => externalId);
  assertUnique(providerAssignees, ({externalId}) => externalId);
  const labels = byStableId(providerLabels);
  const assignees = byStableId(providerAssignees);
  const snapshot = {
    externalId: stableId('pull-request', id),
    url: entityUrl(
      source.url,
      'api.github.com',
      `/repos/${scope.fullName}/pulls/${number}`
    ),
    htmlUrl: entityUrl(
      source.html_url,
      'github.com',
      `/${scope.fullName}/pull/${number}`
    ),
    number,
    title: boundedString(source.title, 1_024),
    state: state(source.state),
    draft: boolean(source.draft),
    merged: mergedAt !== null,
    headRef: boundedString(head.ref, 512),
    headSha: headSha(head.sha),
    baseRef: boundedString(base.ref, 512),
    labels,
    assignees,
    milestone: milestone(source.milestone),
    linkedWorkItemExternalIds
  };
  return {...snapshot, externalVersion: stableVersion(snapshot)};
};

const check = (
  value: unknown,
  pullRequestExternalId: string
): TrackerCheckSnapshot => {
  const source = object(value);
  const snapshot = {
    externalId: stableId('check-run', positiveInteger(source.id)),
    pullRequestExternalId,
    name: boundedString(source.name, 512),
    status: checkStatus(source.status),
    conclusion: checkConclusion(source.conclusion),
    detailsUrl: optionalDetailsUrl(source.details_url)
  };
  return {...snapshot, externalVersion: stableVersion(snapshot)};
};

const requestHeaders = (credential: string): Readonly<Record<string, string>> => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${credential}`,
  'user-agent': 'fai-control-plane-repository-reader/0.1',
  'x-github-api-version': '2022-11-28'
});

const projectItemsQuery = `query ProjectStatus($projectId: ID!, $after: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      id
      owner {
        ... on User { databaseId }
        ... on Organization { databaseId }
      }
      items(first: 100, after: $after) {
        nodes {
          id
          content {
            __typename
            ... on Issue {
              number
              repository { nameWithOwner }
            }
          }
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                optionId
                field { ... on ProjectV2SingleSelectField { id } }
              }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const pullRequestEvidenceQuery = `query PullRequestEvidence(
  $repositoryOwner: String!, $repositoryName: String!
) {
  repository(owner: $repositoryOwner, name: $repositoryName) {
    nameWithOwner
    pullRequests(first: 100, states: [OPEN, CLOSED, MERGED]) {
      nodes {
        number
        closingIssuesReferences(first: 2) {
          nodes {
            databaseId
            repository { nameWithOwner }
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

type ProjectEvidence = Readonly<{
  statusByIssueNumber: ReadonlyMap<number, TrackerProjectStatusObservation>;
  linkedWorkItemExternalIdsByPullRequestNumber: ReadonlyMap<number, readonly string[]>;
}>;

const createRequest = (fetch: GitHubFetch) => {
  let requestCount = 0;
  return async (
    input: string,
    init: Readonly<{method: 'GET' | 'POST'; headers: Readonly<Record<string, string>>; body?: string}>
  ): Promise<unknown> => {
    if (requestCount >= maximumSnapshotRequests) {
      return fail('github_request_budget_exceeded');
    }
    requestCount += 1;
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch {
      return fail('github_transport_failed');
    }
    if (!response || typeof response.status !== 'number' ||
      typeof response.json !== 'function') {
      return fail('github_response_invalid');
    }
    if (response.status === 401) return fail('github_credential_invalid');
    let rateLimitRemaining: string | null;
    let retryAfter: string | null;
    try {
      rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      retryAfter = response.headers.get('retry-after');
    } catch {
      return fail('github_response_invalid');
    }
    if (response.status === 429 ||
      (response.status === 403 &&
        (rateLimitRemaining === '0' || retryAfter !== null))) {
      return fail('github_rate_limited');
    }
    if (response.status < 200 || response.status >= 300) {
      return fail('github_provider_rejected');
    }
    try {
      return await response.json();
    } catch {
      return fail('github_response_invalid');
    }
  };
};

const createClient = (
  request: ReturnType<typeof createRequest>,
  credential: string
) => {
  const get = async (path: string): Promise<unknown> => request(
    `https://api.github.com${path}`,
    {method: 'GET', headers: requestHeaders(credential)}
  );
  const graphql = async (
    query: string,
    variables: Readonly<Record<string, string | null>>
  ): Promise<JsonObject> => {
    const payload = object(await request('https://api.github.com/graphql', {
      method: 'POST',
      headers: {...requestHeaders(credential), 'content-type': 'application/json'},
      body: JSON.stringify({query, variables})
    }));
    if (payload.errors !== undefined) return fail('github_provider_rejected');
    return object(payload.data);
  };

  const pages = async (
    path: string,
    select: (payload: unknown) => readonly unknown[]
  ): Promise<readonly unknown[]> => {
    const collected: unknown[] = [];
    for (let page = 1; page <= maximumPages; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const values = select(await get(
        `${path}${separator}per_page=${pageSize}&page=${page}`
      ));
      if (values.length > pageSize) return fail('github_response_invalid');
      collected.push(...values);
      if (values.length < pageSize) return collected;
    }
    return fail('github_pagination_exceeded');
  };
  return {get, graphql, pages};
};

const base64Url = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64url');

const mintInstallationToken = async (
  request: ReturnType<typeof createRequest>,
  secretsProvider: SecretsProvider,
  privateKeyRef: OpaqueSecretRef
): Promise<string> => {
  let privateKey: string;
  try {
    ({value: privateKey} = await secretsProvider.resolve(
      privateKeyRef,
      appPrivateKeyPurpose
    ));
  } catch {
    return fail('github_credential_invalid');
  }
  if (privateKey.length === 0 || privateKey.length > 65_536 || privateKey.includes('\0')) {
    return fail('github_credential_invalid');
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const signingInput = `${base64Url(JSON.stringify({alg: 'RS256', typ: 'JWT'}))}.${base64Url(
    JSON.stringify({iat: nowSeconds - 60, exp: nowSeconds + 540, iss: githubAppId})
  )}`;
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey, 'base64url');
  } catch {
    return fail('github_credential_invalid');
  }
  const payload = object(await request(
    `https://api.github.com/app/installations/${githubInstallationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        ...requestHeaders(`${signingInput}.${signature}`),
        'content-type': 'application/json'
      },
      body: JSON.stringify({repositories: ['MSA', 'ascon']})
    }
  ));
  const token = boundedString(payload.token, 65_536);
  const expiresAt = Date.parse(boundedString(payload.expires_at, 64));
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 65 * 60_000) {
    return fail('github_response_invalid');
  }
  return token;
};

const projectEvidencePage = (
  payload: JsonObject,
  scope: GitHubRepositoryScopeDefinition,
  statusByIssueNumber: Map<number, TrackerProjectStatusObservation>
): string | null => {
  const project = object(payload.node);
  if (boundedString(project.id, 512) !== scope.projectNodeId) {
    return fail('github_response_invalid');
  }
  const owner = object(project.owner);
  if (positiveInteger(owner.databaseId) !== githubProjectsOwnerId ||
    githubProjectsOwnerId !== scope.ownerId) {
    return fail('github_response_invalid');
  }
  const items = object(project.items);
  const pageInfo = object(items.pageInfo);
  for (const item of array(items.nodes)) {
    const source = object(item);
    const content = source.content;
    if (content === null) continue;
    const entity = object(content);
    const typename = boundedString(entity.__typename, 64);
    if (typename !== 'Issue') return fail('github_response_invalid');
    const repository = object(entity.repository);
    if (boundedString(repository.nameWithOwner, 256) !== scope.fullName) continue;
    const number = positiveInteger(entity.number);
    const fieldValues = object(source.fieldValues);
    if (boolean(object(fieldValues.pageInfo).hasNextPage)) return fail('github_pagination_exceeded');
    let status: TrackerProjectStatusObservation = {
      projectExternalId: scope.projectNodeId,
      projectItemExternalId: boundedString(source.id, 512),
      fieldExternalId: scope.projectStatusFieldNodeId,
      optionExternalId: null,
      status: null
    };
    let foundStatusField = false;
    for (const fieldValue of array(fieldValues.nodes)) {
      const value = object(fieldValue);
      if (value.field === undefined || value.optionId === undefined) continue;
      const field = object(value.field);
      if (boundedString(field.id, 512) !== scope.projectStatusFieldNodeId) continue;
      if (foundStatusField) return fail('github_response_invalid');
      foundStatusField = true;
      if (value.optionId !== null) {
        const optionExternalId = boundedString(value.optionId, 512);
        status = {
          projectExternalId: scope.projectNodeId,
          projectItemExternalId: boundedString(source.id, 512),
          fieldExternalId: scope.projectStatusFieldNodeId,
          optionExternalId,
          status: scope.projectStatusOptionMap[optionExternalId] ?? null
        };
      }
    }
    if (statusByIssueNumber.has(number)) return fail('github_response_invalid');
    statusByIssueNumber.set(number, status);
  }
  if (!boolean(pageInfo.hasNextPage)) return null;
  return boundedString(pageInfo.endCursor, 512);
};

const pullRequestEvidence = (
  payload: JsonObject,
  scope: GitHubRepositoryScopeDefinition,
  linkedWorkItemExternalIdsByPullRequestNumber: Map<number, readonly string[]>
): void => {
  const repository = object(payload.repository);
  if (boundedString(repository.nameWithOwner, 256) !== scope.fullName) {
    return fail('github_response_invalid');
  }
  const pullRequests = object(repository.pullRequests);
  if (boolean(object(pullRequests.pageInfo).hasNextPage)) {
    return fail('github_pagination_exceeded');
  }
  for (const value of array(pullRequests.nodes)) {
    const pullRequest = object(value);
    const number = positiveInteger(pullRequest.number);
    const closingIssuesReferences = object(pullRequest.closingIssuesReferences);
    if (boolean(object(closingIssuesReferences.pageInfo).hasNextPage)) {
      return fail('github_pagination_exceeded');
    }
    const linkedWorkItemExternalIds: string[] = [];
    for (const reference of array(closingIssuesReferences.nodes)) {
      const issue = object(reference);
      const issueRepository = object(issue.repository);
      if (boundedString(issueRepository.nameWithOwner, 256) !== scope.fullName) continue;
      linkedWorkItemExternalIds.push(stableId('issue', positiveInteger(issue.databaseId)));
    }
    assertUnique(linkedWorkItemExternalIds, (externalId) => externalId);
    linkedWorkItemExternalIds.sort((left, right) => left.localeCompare(right));
    const previous = linkedWorkItemExternalIdsByPullRequestNumber.get(number);
    if (previous !== undefined && (
      previous.length !== linkedWorkItemExternalIds.length ||
      previous.some((externalId, index) => externalId !== linkedWorkItemExternalIds[index])
    )) return fail('github_response_invalid');
    linkedWorkItemExternalIdsByPullRequestNumber.set(number, linkedWorkItemExternalIds);
  }
};

const readProjectEvidence = async (
  projectClient: ReturnType<typeof createClient>,
  repositoryClient: ReturnType<typeof createClient>,
  scope: GitHubRepositoryScopeDefinition
): Promise<ProjectEvidence> => {
  const statusByIssueNumber = new Map<number, TrackerProjectStatusObservation>();
  const linkedWorkItemExternalIdsByPullRequestNumber = new Map<number, readonly string[]>();
  const [repositoryOwner, repositoryName] = scope.fullName.split('/');
  if (repositoryOwner === undefined || repositoryName === undefined) {
    return fail('github_response_invalid');
  }
  pullRequestEvidence(
    await repositoryClient.graphql(pullRequestEvidenceQuery, {
      repositoryOwner,
      repositoryName
    }),
    scope,
    linkedWorkItemExternalIdsByPullRequestNumber
  );
  let after: string | null = null;
  for (let page = 0; page < maximumProjectItemPages; page += 1) {
    const payload = await projectClient.graphql(projectItemsQuery, {
      projectId: scope.projectNodeId, after
    });
    const nextCursor = projectEvidencePage(
      payload,
      scope,
      statusByIssueNumber
    );
    if (nextCursor === null) {
      return {statusByIssueNumber, linkedWorkItemExternalIdsByPullRequestNumber};
    }
    after = nextCursor;
  }
  return fail('github_pagination_exceeded');
};

export const createGitHubRepositoryReadAdapter = (dependencies: Readonly<{
  fetch: GitHubFetch;
  appSecretsProvider: SecretsProvider;
  appPrivateKeyRef: OpaqueSecretRef;
  projectsSecretsProvider: SecretsProvider;
}>): TrackerAdapter => ({
  provider: 'github',
  capabilities: {
    readWorkItems: true,
    writeWorkItems: false,
    readPullRequests: true,
    readChecks: true
  },
  async readRepositorySnapshot(input): Promise<TrackerRepositorySnapshot> {
    const fullName = `${input.repository.owner}/${input.repository.repository}`;
    const scope = githubRepositoryScopeDefinitions.find(
      (candidate) => candidate.fullName === fullName
    );
    if (scope === undefined) {
      return fail('github_repository_not_allowed');
    }
    if (
      input.credentialRef.scope.length !== githubProjectsOAuthScope.length ||
      input.credentialRef.scope.some(
        (part, index) => part !== githubProjectsOAuthScope[index]
      )
    ) {
      return fail('github_credential_invalid');
    }
    const request = createRequest(dependencies.fetch);
    const installationToken = await mintInstallationToken(
      request,
      dependencies.appSecretsProvider,
      dependencies.appPrivateKeyRef
    );
    let projectCredential: string;
    try {
      const resolved = await dependencies.projectsSecretsProvider.resolve(
        input.credentialRef,
        projectCredentialPurpose
      );
      projectCredential = resolved.value;
    } catch {
      return fail('github_credential_invalid');
    }
    if (typeof projectCredential !== 'string' || projectCredential.length === 0 ||
      projectCredential.length > 65_536 || projectCredential.includes('\0')) {
      return fail('github_credential_invalid');
    }

    const repositoryClient = createClient(request, installationToken);
    const projectClient = createClient(request, projectCredential);
    const repositoryPayload = object(await repositoryClient.get(`/repos/${fullName}`));
    const repositoryOwner = object(repositoryPayload.owner);
    if (positiveInteger(repositoryPayload.id) !== scope.repositoryId ||
      boundedString(repositoryPayload.full_name, 256) !== scope.fullName ||
      positiveInteger(repositoryOwner.id) !== scope.ownerId) {
      return fail('github_response_invalid');
    }
    const repository = {
      externalId: stableId('repository', scope.repositoryId),
      owner: input.repository.owner,
      name: input.repository.repository
    };
    const repositoryModel = {
      ...repository,
      externalVersion: stableVersion(repository)
    };

    const issuePayloads = await repositoryClient.pages(
      `/repos/${fullName}/issues?state=all`,
      array
    );
    const rawWorkItems = byNumber(issuePayloads.map(
      (payload) => workItem(payload, scope)
    ).filter(
      (item): item is TrackerWorkItemSnapshot => item !== null
    ));
    assertUnique(rawWorkItems, ({externalId}) => externalId);
    assertUnique(rawWorkItems, ({number}) => number);
    const pullRequestPayloads = await repositoryClient.pages(
      `/repos/${fullName}/pulls?state=all`,
      array
    );
    const evidence = await readProjectEvidence(projectClient, repositoryClient, scope);
    const rawPullRequests = byNumber(pullRequestPayloads.map(
      (payload) => {
        const number = positiveInteger(object(payload).number);
        const linkedWorkItemExternalIds = evidence
          .linkedWorkItemExternalIdsByPullRequestNumber
          .get(number) ?? [];
        return pullRequest(payload, scope, linkedWorkItemExternalIds);
      }
    ));
    assertUnique(rawPullRequests, ({externalId}) => externalId);
    assertUnique(rawPullRequests, ({number}) => number);
    const workItems = rawWorkItems.map((item) => {
      const projectStatus = evidence.statusByIssueNumber.get(item.number) ?? null;
      const snapshot = {...item, projectStatus};
      return {...snapshot, externalVersion: stableVersion(snapshot)};
    });
    const pullRequests = rawPullRequests;
    const checks: TrackerCheckSnapshot[] = [];
    const openPullRequests = pullRequests.filter(({state}) => state === 'open');
    if (openPullRequests.length > maximumOpenPullRequestCheckFanout) {
      return fail('github_request_budget_exceeded');
    }
    const checksByHeadSha = new Map<string, readonly unknown[]>();
    // Check runs are current execution state, so fanout is capped to open PRs.
    for (const pullRequestModel of openPullRequests) {
      let checkPayloads = checksByHeadSha.get(pullRequestModel.headSha);
      if (checkPayloads === undefined) {
        checkPayloads = await repositoryClient.pages(
          `/repos/${fullName}/commits/${pullRequestModel.headSha}/check-runs`,
          (payload) => array(object(payload).check_runs)
        );
        checksByHeadSha.set(pullRequestModel.headSha, checkPayloads);
      }
      checks.push(...checkPayloads.map(
        (payload) => check(payload, pullRequestModel.externalId)
      ));
    }
    assertUnique(checks, ({externalId}) => externalId);

    const snapshotContent = {
      repository: repositoryModel,
      workItems,
      pullRequests,
      checks: byStableId(checks)
    };
    return {
      ...snapshotContent,
      externalVersion: stableVersion(snapshotContent)
    };
  }
});
