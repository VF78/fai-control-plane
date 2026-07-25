import {createHash} from 'node:crypto';
import type {
  TrackerAdapter,
  TrackerCheckSnapshot,
  TrackerIdentity,
  TrackerLabel,
  TrackerMilestone,
  TrackerPullRequestSnapshot,
  TrackerRepositorySnapshot,
  TrackerWorkItemSnapshot
} from '@fai-control-plane/domain';

const allowedRepositories = new Set(['VF78/MSA', 'VF78/ascon']);
const pageSize = 100;
const maximumPages = 10;

export type GitHubFetch = (
  input: string,
  init: Readonly<{method: 'GET'; headers: Readonly<Record<string, string>>}>
) => Promise<Response>;

export type GitHubRepositoryReadErrorCode =
  | 'github_repository_not_allowed'
  | 'github_credential_invalid'
  | 'github_transport_failed'
  | 'github_provider_rejected'
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
  return value as JsonObject;
};

const array = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) return fail('github_response_invalid');
  return value;
};

const string = (value: unknown): string => {
  if (typeof value !== 'string') return fail('github_response_invalid');
  return value;
};

const nullableString = (value: unknown): string | null => {
  if (value === null) return null;
  return string(value);
};

const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
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
): TrackerCheckSnapshot['status'] => {
  if (!['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(
    value as string
  )) {
    return fail('github_response_invalid');
  }
  return value as TrackerCheckSnapshot['status'];
};

const stableId = (kind: string, id: number): string => `github:${kind}:${id}`;

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

const identity = (value: unknown): TrackerIdentity => {
  const source = object(value);
  return {
    externalId: stableId('user', integer(source.id)),
    login: string(source.login)
  };
};

const label = (value: unknown): TrackerLabel => {
  const source = object(value);
  return {
    externalId: stableId('label', integer(source.id)),
    name: string(source.name),
    color: string(source.color)
  };
};

const milestone = (value: unknown): TrackerMilestone | null => {
  if (value === null) return null;
  const source = object(value);
  return {
    externalId: stableId('milestone', integer(source.id)),
    number: integer(source.number),
    title: string(source.title),
    state: state(source.state)
  };
};

const workItem = (value: unknown): TrackerWorkItemSnapshot | null => {
  const source = object(value);
  if (source.pull_request !== undefined) return null;
  const snapshot = {
    externalId: stableId('issue', integer(source.id)),
    number: integer(source.number),
    title: string(source.title),
    state: state(source.state),
    labels: array(source.labels).map(label),
    assignees: array(source.assignees).map(identity),
    milestone: milestone(source.milestone)
  };
  return {...snapshot, externalVersion: stableVersion(snapshot)};
};

const pullRequest = (value: unknown): TrackerPullRequestSnapshot => {
  const source = object(value);
  const head = object(source.head);
  const base = object(source.base);
  const snapshot = {
    externalId: stableId('pull-request', integer(source.id)),
    number: integer(source.number),
    title: string(source.title),
    state: state(source.state),
    draft: boolean(source.draft),
    merged: source.merged_at !== null,
    headRef: string(head.ref),
    headSha: string(head.sha),
    baseRef: string(base.ref),
    labels: array(source.labels).map(label),
    assignees: array(source.assignees).map(identity),
    milestone: milestone(source.milestone)
  };
  return {...snapshot, externalVersion: stableVersion(snapshot)};
};

const check = (
  value: unknown,
  pullRequestExternalId: string
): TrackerCheckSnapshot => {
  const source = object(value);
  const snapshot = {
    externalId: stableId('check-run', integer(source.id)),
    pullRequestExternalId,
    name: string(source.name),
    status: checkStatus(source.status),
    conclusion: nullableString(source.conclusion),
    detailsUrl: nullableString(source.details_url)
  };
  return {...snapshot, externalVersion: stableVersion(snapshot)};
};

const requestHeaders = (credential: string): Readonly<Record<string, string>> => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${credential}`,
  'x-github-api-version': '2022-11-28'
});

const createClient = (fetch: GitHubFetch, credential: string) => {
  const get = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method: 'GET',
        headers: requestHeaders(credential)
      });
    } catch {
      return fail('github_transport_failed');
    }
    if (!response || typeof response.status !== 'number' ||
      typeof response.json !== 'function') {
      return fail('github_response_invalid');
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
      collected.push(...values);
      if (values.length < pageSize) return collected;
    }
    return fail('github_pagination_exceeded');
  };
  return {get, pages};
};

export const createGitHubRepositoryReadAdapter = (
  fetch: GitHubFetch
): TrackerAdapter => ({
  provider: 'github',
  capabilities: {
    readWorkItems: true,
    writeWorkItems: false,
    readPullRequests: true,
    readChecks: true
  },
  async readRepositorySnapshot(input): Promise<TrackerRepositorySnapshot> {
    const fullName = `${input.repository.owner}/${input.repository.repository}`;
    if (!allowedRepositories.has(fullName)) {
      return fail('github_repository_not_allowed');
    }
    if (typeof input.credential !== 'string' || input.credential.length === 0) {
      return fail('github_credential_invalid');
    }

    const client = createClient(fetch, input.credential);
    const repositoryPayload = object(await client.get(`/repos/${fullName}`));
    if (string(repositoryPayload.full_name) !== fullName) {
      return fail('github_response_invalid');
    }
    const repository = {
      externalId: stableId('repository', integer(repositoryPayload.id)),
      owner: input.repository.owner,
      name: input.repository.repository
    };
    const repositoryModel = {
      ...repository,
      externalVersion: stableVersion(repository)
    };

    const issuePayloads = await client.pages(
      `/repos/${fullName}/issues?state=all`,
      array
    );
    const workItems = issuePayloads.map(workItem).filter(
      (item): item is TrackerWorkItemSnapshot => item !== null
    );
    const pullRequestPayloads = await client.pages(
      `/repos/${fullName}/pulls?state=all`,
      array
    );
    const pullRequests = pullRequestPayloads.map(pullRequest);
    const checks: TrackerCheckSnapshot[] = [];
    for (const pullRequestModel of pullRequests) {
      const checkPayloads = await client.pages(
        `/repos/${fullName}/commits/${encodeURIComponent(pullRequestModel.headSha)}/check-runs`,
        (payload) => array(object(payload).check_runs)
      );
      checks.push(...checkPayloads.map(
        (payload) => check(payload, pullRequestModel.externalId)
      ));
    }

    const snapshotContent = {
      repository: repositoryModel,
      workItems,
      pullRequests,
      checks
    };
    return {
      ...snapshotContent,
      externalVersion: stableVersion(snapshotContent)
    };
  }
});
