import {createHash, createSign} from 'node:crypto';
import type {
  AccessLevel,
  AccessObservationPort,
  OpaqueSecretRef,
  RepositoryObservationPort,
  SecretsProvider,
  TaskTrackerPort,
  TrackerAdapter,
  TrackerCheckConclusion,
  TrackerCheckStatus,
  TrackerCheckSnapshot,
  TrackerIdentity,
  TrackerLabel,
  TrackerMilestone,
  TrackerProjectItemSnapshot,
  TrackerPullRequestSnapshot,
  TrackerRepositorySnapshot,
} from '@fai-control-plane/domain';
import {
  containsHighConfidenceSecretContent,
  trackerCheckStatuses
} from '@fai-control-plane/domain';
import {
  githubCheckRunConclusions,
  githubRepositoryScopeDefinitions,
  type GitHubRepositoryScopeDefinition
} from './github-contract';

const pageSize = 100;
const maximumPages = 10;
const maximumProjectItemPages = 2;
const maximumSnapshotRequests = 37;
const maximumOpenPullRequestCheckFanout = 16;
const maximumIssueRequirementsBytes = 32 * 1_024;
const projectCredentialPurpose = 'github_project_snapshot_read_oauth_token';
const appPrivateKeyPurpose = 'github_app_installation_token_mint';
const githubProjectsOAuthScope = Object.freeze(['read:project']);
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
  | 'github_project_item_content_redacted'
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

const issueRequirements = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string') return fail('github_response_invalid');
  if (value.includes('\0')) return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return null;
  if (Buffer.byteLength(normalized, 'utf8') > maximumIssueRequirementsBytes) return null;
  if (containsHighConfidenceSecretContent(normalized)) return null;
  return normalized;
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

const byNumber = <T extends Readonly<{number: number}>>(
  values: readonly T[]
): readonly T[] => [...values].sort((left, right) =>
  left.number - right.number || stableVersion(left).localeCompare(stableVersion(right))
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

type RepositoryIssueSnapshot = Readonly<{
  issueExternalId: string;
  externalVersion: string;
  url: string;
  htmlUrl: string;
  number: number;
  title: string;
  requirements: string | null;
  state: 'open' | 'closed';
  labels: readonly TrackerLabel[];
  assignees: readonly TrackerIdentity[];
  milestone: TrackerMilestone | null;
}>;

const issue = (
  value: unknown,
  scope: GitHubRepositoryScopeDefinition
): RepositoryIssueSnapshot | null => {
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
    issueExternalId: stableId('issue', id),
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
    requirements: issueRequirements(source.body),
    state: state(source.state),
    labels,
    assignees,
    milestone: milestone(source.milestone)
  };
  return {...snapshot, externalVersion: stableVersion(snapshot)};
};

const pullRequest = (
  value: unknown,
  scope: GitHubRepositoryScopeDefinition,
  linkedIssueExternalIds: readonly string[]
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
    linkedIssueExternalIds
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
              databaseId
              number
              repository { nameWithOwner }
              parent { databaseId repository { nameWithOwner } }
              subIssues(first: 100) {
                nodes { databaseId repository { nameWithOwner } }
                pageInfo { hasNextPage }
              }
              blockedBy(first: 100) {
                nodes { databaseId repository { nameWithOwner } }
                pageInfo { hasNextPage }
              }
            }
          }
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                optionId
                field { ... on ProjectV2SingleSelectField { id } }
              }
              ... on ProjectV2ItemFieldDateValue {
                date
                field { ... on ProjectV2Field { id } }
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
  $repositoryOwner: String!, $repositoryName: String!, $after: String
) {
  repository(owner: $repositoryOwner, name: $repositoryName) {
    nameWithOwner
    pullRequests(first: 100, states: [OPEN, CLOSED, MERGED], after: $after) {
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
  itemsByIssueNumber: ReadonlyMap<number, ProjectItemEvidence>;
  linkedIssueExternalIdsByPullRequestNumber: ReadonlyMap<number, readonly string[]>;
}>;

type ProjectItemEvidence = Readonly<{
  externalId: string;
  issueExternalId: string;
  projectExternalId: string;
  status: Readonly<{
    fieldExternalId: string;
    optionExternalId: string | null;
    optionName: string | null;
  }>;
  targetDate: string | null;
  parentIssueExternalId: string | null;
  subIssueExternalIds: readonly string[];
  dependencyExternalIds: readonly string[];
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
  itemsByIssueNumber: Map<number, ProjectItemEvidence>
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
    if (content === null) return fail('github_project_item_content_redacted');
    const entity = object(content);
    const typename = boundedString(entity.__typename, 64);
    if (typename !== 'Issue') return fail('github_response_invalid');
    const repository = object(entity.repository);
    if (boundedString(repository.nameWithOwner, 256) !== scope.fullName) continue;
    const number = positiveInteger(entity.number);
    const issueExternalId = stableId('issue', positiveInteger(entity.databaseId));
    const linkedIssues = (value: unknown): readonly string[] => {
      const connection = object(value);
      if (boolean(object(connection.pageInfo).hasNextPage)) {
        return fail('github_pagination_exceeded');
      }
      const identifiers = array(connection.nodes).flatMap((entry) => {
        const issue = object(entry);
        const issueRepository = object(issue.repository);
        return boundedString(issueRepository.nameWithOwner, 256) === scope.fullName
          ? [stableId('issue', positiveInteger(issue.databaseId))]
          : [];
      }).sort((left, right) => left.localeCompare(right));
      assertUnique(identifiers, (externalId) => externalId);
      return identifiers;
    };
    const parent = entity.parent === null ? null : object(entity.parent);
    const parentIssueExternalId = parent === null
      ? null
      : boundedString(object(parent.repository).nameWithOwner, 256) === scope.fullName
        ? stableId('issue', positiveInteger(parent.databaseId))
        : null;
    const subIssueExternalIds = linkedIssues(entity.subIssues);
    const dependencyExternalIds = linkedIssues(entity.blockedBy);
    const fieldValues = object(source.fieldValues);
    if (boolean(object(fieldValues.pageInfo).hasNextPage)) return fail('github_pagination_exceeded');
    let status: ProjectItemEvidence['status'] = {
      fieldExternalId: scope.projectStatusFieldNodeId,
      optionExternalId: null,
      optionName: null
    };
    let targetDate: string | null = null;
    let foundStatusField = false;
    let foundTargetDateField = false;
    for (const fieldValue of array(fieldValues.nodes)) {
      const value = object(fieldValue);
      if (value.field === undefined) continue;
      const field = object(value.field);
      const fieldExternalId = boundedString(field.id, 512);
      if (fieldExternalId === scope.projectStatusFieldNodeId && value.optionId !== undefined) {
        if (foundStatusField) return fail('github_response_invalid');
        foundStatusField = true;
        if (value.optionId === null) continue;
        const optionExternalId = boundedString(value.optionId, 512);
        const optionName = scope.projectStatusOptions[optionExternalId];
        if (optionName === undefined) return fail('github_response_invalid');
        status = {
          fieldExternalId: scope.projectStatusFieldNodeId,
          optionExternalId,
          optionName
        };
        continue;
      }
      if (
        scope.projectTargetDateFieldNodeId !== null &&
        fieldExternalId === scope.projectTargetDateFieldNodeId &&
        value.date !== undefined
      ) {
        if (foundTargetDateField) return fail('github_response_invalid');
        foundTargetDateField = true;
        if (value.date !== null) {
          const date = boundedString(value.date, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('github_response_invalid');
          targetDate = date;
        }
      }
    }
    if (itemsByIssueNumber.has(number)) return fail('github_response_invalid');
    itemsByIssueNumber.set(number, {
      externalId: boundedString(source.id, 512),
      issueExternalId,
      projectExternalId: scope.projectNodeId,
      status,
      targetDate,
      parentIssueExternalId,
      subIssueExternalIds,
      dependencyExternalIds
    });
  }
  if (!boolean(pageInfo.hasNextPage)) return null;
  return boundedString(pageInfo.endCursor, 512);
};

const pullRequestEvidence = (
  payload: JsonObject,
  scope: GitHubRepositoryScopeDefinition,
  linkedWorkItemExternalIdsByPullRequestNumber: Map<number, readonly string[]>
): string | null => {
  const repository = object(payload.repository);
  if (boundedString(repository.nameWithOwner, 256) !== scope.fullName) {
    return fail('github_response_invalid');
  }
  const pullRequests = object(repository.pullRequests);
  const pageInfo = object(pullRequests.pageInfo);
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
  if (!boolean(pageInfo.hasNextPage)) return null;
  return boundedString(pageInfo.endCursor, 512);
};

const readProjectEvidence = async (
  projectClient: ReturnType<typeof createClient>,
  repositoryClient: ReturnType<typeof createClient>,
  scope: GitHubRepositoryScopeDefinition
): Promise<ProjectEvidence> => {
  const itemsByIssueNumber = new Map<number, ProjectItemEvidence>();
  const linkedIssueExternalIdsByPullRequestNumber = new Map<number, readonly string[]>();
  const [repositoryOwner, repositoryName] = scope.fullName.split('/');
  if (repositoryOwner === undefined || repositoryName === undefined) {
    return fail('github_response_invalid');
  }
  let pullRequestAfter: string | null = null;
  for (let page = 0; page < maximumPages; page += 1) {
    pullRequestAfter = pullRequestEvidence(
      await repositoryClient.graphql(pullRequestEvidenceQuery, {
        repositoryOwner,
        repositoryName,
        after: pullRequestAfter
      }),
      scope,
      linkedIssueExternalIdsByPullRequestNumber
    );
    if (pullRequestAfter === null) break;
    if (page === maximumPages - 1) return fail('github_pagination_exceeded');
  }
  let after: string | null = null;
  for (let page = 0; page < maximumProjectItemPages; page += 1) {
    const payload = await projectClient.graphql(projectItemsQuery, {
      projectId: scope.projectNodeId, after
    });
    const nextCursor = projectEvidencePage(
      payload,
      scope,
      itemsByIssueNumber
    );
    if (nextCursor === null) {
      return {itemsByIssueNumber, linkedIssueExternalIdsByPullRequestNumber};
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
  now?: () => Date;
}>): TrackerAdapter & TaskTrackerPort & RepositoryObservationPort & AccessObservationPort => {
  const compatibilityAdapter: TrackerAdapter = ({
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
    const defaultBranch = boundedString(repositoryPayload.default_branch, 255);
    const defaultBranchCommit = object(await repositoryClient.get(
      `/repos/${fullName}/commits/${encodeURIComponent(defaultBranch)}`
    ));
    const defaultBranchHeadSha = headSha(defaultBranchCommit.sha);
    const repositoryModel = {
      ...repository,
      defaultBranch,
      headSha: defaultBranchHeadSha,
      externalVersion: stableVersion({
        ...repository,
        defaultBranch,
        headSha: defaultBranchHeadSha
      })
    };

    const issuePayloads = await repositoryClient.pages(
      `/repos/${fullName}/issues?state=all`,
      array
    );
    const rawIssues = byNumber(issuePayloads.map(
      (payload) => issue(payload, scope)
    ).filter(
      (item): item is RepositoryIssueSnapshot => item !== null
    ));
    assertUnique(rawIssues, ({issueExternalId}) => issueExternalId);
    assertUnique(rawIssues, ({number}) => number);
    const pullRequestPayloads = await repositoryClient.pages(
      `/repos/${fullName}/pulls?state=all`,
      array
    );
    const evidence = await readProjectEvidence(projectClient, repositoryClient, scope);
    const rawPullRequests = byNumber(pullRequestPayloads.map(
      (payload) => {
        const number = positiveInteger(object(payload).number);
        const linkedIssueExternalIds = evidence
          .linkedIssueExternalIdsByPullRequestNumber
          .get(number) ?? [];
        return pullRequest(payload, scope, linkedIssueExternalIds);
      }
    ));
    assertUnique(rawPullRequests, ({externalId}) => externalId);
    assertUnique(rawPullRequests, ({number}) => number);
    const issuesByNumber = new Map(rawIssues.map((item) => [item.number, item]));
    const projectItems = [...evidence.itemsByIssueNumber.entries()].map(([number, projectItem]) => {
      const repositoryIssue = issuesByNumber.get(number);
      if (repositoryIssue === undefined || repositoryIssue.issueExternalId !== projectItem.issueExternalId) {
        return fail('github_response_invalid');
      }
      const snapshot: Omit<TrackerProjectItemSnapshot, 'externalVersion'> = {
        ...repositoryIssue,
        ...projectItem
      };
      return {...snapshot, externalVersion: stableVersion(snapshot)};
    }).sort((left, right) => left.number - right.number || left.externalId.localeCompare(right.externalId));
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
      projectItems,
      pullRequests,
      checks: byStableId(checks)
    };
    return {
      ...snapshotContent,
      externalVersion: stableVersion(snapshotContent)
    };
  }
  });
  const pendingSnapshots = new Map<string, Promise<TrackerRepositorySnapshot>>();
  const snapshotReadKey = (
    input: Parameters<NonNullable<TrackerAdapter['readRepositorySnapshot']>>[0]
  ): string => JSON.stringify([
    input.repository.owner,
    input.repository.repository,
    input.credentialRef.provider,
    input.credentialRef.reference,
    input.credentialRef.scope
  ]);
  const readCompatibilitySnapshot = (
    input: Parameters<NonNullable<TrackerAdapter['readRepositorySnapshot']>>[0]
  ): Promise<TrackerRepositorySnapshot> => {
    const key = snapshotReadKey(input);
    const cached = pendingSnapshots.get(key);
    if (cached !== undefined) return cached;
    const pending = compatibilityAdapter.readRepositorySnapshot!(input);
    pendingSnapshots.set(key, pending);
    void pending.then(
      () => pendingSnapshots.delete(key),
      () => pendingSnapshots.delete(key)
    );
    return pending;
  };
  return {
    ...compatibilityAdapter,
    async observeAccess(input) {
      if (input.resourceType === 'tracker') return {
        state: 'unsupported',
        remediation: 'GitHub Project V2 membership observation is not supported; verify it in GitHub.'
      };
      if (input.resourceType !== 'repository') return {
        state: 'unsupported',
        remediation: `GitHub cannot observe ${input.resourceType} access.`
      };
      const accountId = input.externalSubject.match(/^github:user:([1-9][0-9]{0,15})$/)?.[1];
      if (accountId === undefined || !Number.isSafeInteger(Number(accountId))) return {
        state: 'unobserved',
        remediation: 'Bind an active GitHub identity as github:user:<numeric-id>.'
      };
      const fullName = `${input.repository.owner}/${input.repository.repository}`;
      const scope = githubRepositoryScopeDefinitions.find((candidate) => candidate.fullName === fullName);
      if (scope === undefined || input.repository.externalId !== stableId('repository', scope.repositoryId)) {
        return {
          state: 'unobserved',
          remediation: 'Configure an immutable GitHub repository binding for this project.'
        };
      }
      const request = createRequest(dependencies.fetch);
      let installationToken: string;
      try {
        installationToken = await mintInstallationToken(
          request,
          dependencies.appSecretsProvider,
          dependencies.appPrivateKeyRef
        );
      } catch (error) {
        return {
          state: 'unavailable',
          remediation: error instanceof GitHubRepositoryReadError && error.code === 'github_rate_limited'
            ? 'GitHub rate limit reached; retry after the provider window resets.'
            : 'GitHub repository access observation is unavailable; verify the App installation.'
        };
      }
      const read = async (path: string): Promise<Readonly<{status: number; payload?: unknown}>> => {
        let response: Response;
        try {
          response = await dependencies.fetch(`https://api.github.com${path}`, {
            method: 'GET', headers: requestHeaders(installationToken)
          });
        } catch {
          return {status: 503};
        }
        const remaining = response.headers.get('x-ratelimit-remaining');
        const retryAfter = response.headers.get('retry-after');
        if (response.status === 429 || (response.status === 403 && (remaining === '0' || retryAfter !== null))) {
          return {status: 429};
        }
        if (response.status !== 200) return {status: response.status};
        try {
          return {status: 200, payload: await response.json()};
        } catch {
          return {status: 502};
        }
      };
      const user = await read(`/user/${accountId}`);
      if (user.status === 404) return {
        state: 'unobserved',
        remediation: `GitHub user ID ${accountId} no longer resolves; update the external identity.`
      };
      if (user.status !== 200) return {
        state: 'unavailable',
        remediation: user.status === 429
          ? 'GitHub rate limit reached; retry after the provider window resets.'
          : 'GitHub user lookup is unavailable; verify App permissions and retry.'
      };
      let login: string;
      try {
        const payload = object(user.payload);
        if (positiveInteger(payload.id) !== Number(accountId)) return fail('github_response_invalid');
        login = boundedString(payload.login, 39);
      } catch {
        return {
          state: 'unavailable',
          remediation: 'GitHub returned an invalid user identity response; retry before changing bindings.'
        };
      }
      const permission = await read(
        `/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.repository)}` +
        `/collaborators/${encodeURIComponent(login)}/permission`
      );
      if (permission.status === 404) {
        const repository = await read(`/repositories/${scope.repositoryId}`);
        if (repository.status !== 200) return {
          state: 'unavailable',
          remediation: 'GitHub repository identity could not be revalidated after a missing collaborator response.'
        };
        try {
          const payload = object(repository.payload);
          if (
            positiveInteger(payload.id) !== scope.repositoryId ||
            boundedString(payload.full_name, 256) !== scope.fullName
          ) return fail('github_response_invalid');
        } catch {
          return {
            state: 'unavailable',
            remediation: 'GitHub repository revalidation returned a mismatched immutable identity.'
          };
        }
        return {
          state: 'confirmed', provider: 'github',
          externalResourceRef: input.repository.externalId,
          confirmedLevel: 'none',
          observedAt: (dependencies.now ?? (() => new Date()))().toISOString()
        };
      }
      if (permission.status !== 200) return {
        state: 'unavailable',
        remediation: permission.status === 429
          ? 'GitHub rate limit reached; retry after the provider window resets.'
          : 'GitHub collaborator permission is unavailable; verify repository administration access.'
      };
      let confirmedLevel: AccessLevel;
      try {
        const value = boundedString(object(permission.payload).permission, 32);
        const levels: Readonly<Record<string, AccessLevel>> = {
          none: 'none', read: 'read', triage: 'read',
          write: 'write', maintain: 'write', admin: 'admin'
        };
        const mapped = levels[value];
        if (mapped === undefined) return fail('github_response_invalid');
        confirmedLevel = mapped;
      } catch {
        return {
          state: 'unavailable',
          remediation: 'GitHub returned an unknown collaborator permission; update the adapter before confirming access.'
        };
      }
      return {
        state: 'confirmed', provider: 'github',
        externalResourceRef: input.repository.externalId,
        confirmedLevel,
        observedAt: (dependencies.now ?? (() => new Date()))().toISOString()
      };
    },
    async readWorkItems(input) {
      const snapshot = await readCompatibilitySnapshot(input);
      return {externalVersion: snapshot.externalVersion, projectItems: snapshot.projectItems};
    },
    async readRepositoryObservation(input) {
      const snapshot = await readCompatibilitySnapshot(input);
      return {
        repository: snapshot.repository,
        externalVersion: snapshot.externalVersion,
        pullRequests: snapshot.pullRequests,
        checks: snapshot.checks
      };
    }
  };
};
