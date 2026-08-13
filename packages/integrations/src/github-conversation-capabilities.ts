import {createHash} from 'node:crypto';
import type {
  ClientProjectFactsReadResult,
  ClientProjectFactsReadPort,
  ConversationCapabilityInput,
  ConversationExternalResult,
  IssueIntakePort,
  SourceContextPort
} from '@fai-control-plane/application';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';

type Fetch = (
  input: string,
  init: Readonly<{
    method: 'GET' | 'POST';
    headers: Readonly<Record<string, string>>;
    body?: string;
    signal?: AbortSignal;
  }>
) => Promise<Response>;

export type GitHubConversationCapabilityPort = ClientProjectFactsReadPort &
  IssueIntakePort & SourceContextPort;

export type GitHubConversationCapabilityErrorCode =
  | 'configuration_invalid'
  | 'credential_denied'
  | 'provider_rejected'
  | 'response_invalid'
  | 'reference_denied'
  | 'stale_reference'
  | 'transport_failed';

export class GitHubConversationCapabilityError extends Error {
  readonly name = 'GitHubConversationCapabilityError';
  constructor(readonly code: GitHubConversationCapabilityErrorCode) {
    super(code);
  }
}

export const githubConversationCapabilityCredentialScope = Object.freeze([
  'issues:write',
  'projects:write'
]);

const api = 'https://api.github.com';
const credentialPurpose = 'github_bounded_conversation_capabilities';
const timeoutMs = 10_000;
const fail = (code: GitHubConversationCapabilityErrorCode): never => {
  throw new GitHubConversationCapabilityError(code);
};
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('response_invalid');
  }
  return value as Record<string, unknown>;
};
const string = (value: unknown, maximum = 2_048): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    return fail('response_invalid');
  }
  return value;
};
const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return fail('response_invalid');
  return value as number;
};
const exactScope = (reference: OpaqueSecretRef): boolean =>
  reference.scope.length === githubConversationCapabilityCredentialScope.length &&
  reference.scope.every((part, index) => part === githubConversationCapabilityCredentialScope[index]);
const version = (updatedAt: unknown): string => `github:updated-at:${string(updatedAt, 64)}`;
const issueReference = (databaseId: unknown): string => `github:issue:${integer(databaseId)}`;
const commentReference = (databaseId: unknown): string => `github:comment:${integer(databaseId)}`;
const marker = (projectRef: string, idempotencyKey: string): string =>
  `<!-- fai-conversation:${createHash('sha256').update(projectRef).update('\0').update(idempotencyKey).digest('hex')} -->`;

const headers = (token: string): Readonly<Record<string, string>> => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'user-agent': 'fai-control-plane-conversation-capabilities/0.1',
  'x-github-api-version': '2022-11-28'
});

const request = async (
  fetch: Fetch,
  token: string,
  path: string,
  init: Readonly<{method: 'GET' | 'POST'; body?: unknown}>
): Promise<unknown> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${api}${path}`, {
      method: init.method,
      headers: headers(token),
      ...(init.body === undefined ? {} : {body: JSON.stringify(init.body)}),
      signal: controller.signal
    });
    if (!response.ok) {
      return fail(response.status === 401 || response.status === 403
        ? 'credential_denied'
        : 'provider_rejected');
    }
    try {
      return await response.json();
    } catch {
      return fail('response_invalid');
    }
  } catch (error) {
    if (error instanceof GitHubConversationCapabilityError) throw error;
    return fail('transport_failed');
  } finally {
    clearTimeout(timeout);
  }
};

type BoundIssue = Readonly<{
  number: number;
  databaseId: number;
  nodeId: string;
  url: string;
  updatedAt: string;
  inProject: boolean;
}>;

const parseIssue = (
  value: unknown,
  binding: Readonly<{owner: string; repository: string; projectNodeId: string}>
): BoundIssue => {
  const issue = object(value);
  const number = integer(issue.number);
  const url = string(issue.url ?? issue.html_url);
  if (url !== `https://github.com/${binding.owner}/${binding.repository}/issues/${number}`) {
    return fail('reference_denied');
  }
  const projectItems = issue.projectItems === undefined
    ? []
    : object(issue.projectItems).nodes;
  return {
    number,
    databaseId: integer(issue.databaseId ?? issue.id),
    nodeId: string(issue.nodeId ?? issue.node_id ?? issue.id, 512),
    url,
    updatedAt: string(issue.updatedAt ?? issue.updated_at, 64),
    inProject: Array.isArray(projectItems) && projectItems.some((entry) => {
      const item = object(entry);
      return object(item.project).id === binding.projectNodeId;
    })
  };
};

const issueQuery = `query ConversationIssue($owner: String!, $repository: String!, $number: Int!) {
  repository(owner: $owner, name: $repository) {
    nameWithOwner
    issue(number: $number) {
      number databaseId id: id url updatedAt
      projectItems(first: 20) { nodes { project { id } } }
    }
  }
}`;
const addProjectItemMutation = `mutation AddConversationIssue($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: {projectId: $project, contentId: $content}) {
    item { id project { id } }
  }
}`;
const projectFactsQuery = `query ClientProjectFacts($project: ID!) {
  node(id: $project) { ... on ProjectV2 { id url updatedAt closed items(first: 1) { totalCount } } }
}`;

export const createGitHubConversationCapabilityAdapter = (input: Readonly<{
  binding: Readonly<{
    owner: string;
    repository: string;
    repositoryId: number;
    projectNodeId: string;
    projectUrl: string;
  }>;
  credentialRef: OpaqueSecretRef;
  secrets: SecretsProvider;
  fetch?: Fetch;
}>): GitHubConversationCapabilityPort => {
  const {binding} = input;
  const issueCreations = new Map<string, Promise<ConversationExternalResult>>();
  let projectUrl: URL | null = null;
  try {
    projectUrl = new URL(binding.projectUrl);
  } catch {
    // Rejected by the configuration guard below.
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(binding.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(binding.repository) ||
    !Number.isSafeInteger(binding.repositoryId) || binding.repositoryId <= 0 ||
    !/^PVT_[A-Za-z0-9_-]{1,500}$/.test(binding.projectNodeId) ||
    projectUrl?.origin !== 'https://github.com' || projectUrl.username !== '' ||
    projectUrl.password !== '' || projectUrl.search !== '' || projectUrl.hash !== '' ||
    !projectUrl.pathname.startsWith(`/users/${binding.owner}/projects/`) ||
    !/^[1-9][0-9]*$/.test(projectUrl.pathname.slice(`/users/${binding.owner}/projects/`.length)) ||
    !exactScope(input.credentialRef)) return fail('configuration_invalid');
  const fetch = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const token = async (): Promise<string> => {
    let value: string;
    try {
      ({value} = await input.secrets.resolve(input.credentialRef, credentialPurpose));
    } catch {
      return fail('credential_denied');
    }
    if (value.length === 0 || value.length > 65_536 || value.includes('\0')) return fail('credential_denied');
    return value;
  };
  const graphql = async (credential: string, query: string, variables: Record<string, unknown>) => {
    const payload = object(await request(fetch, credential, '/graphql', {
      method: 'POST', body: {query, variables}
    }));
    if (payload.errors !== undefined) return fail('provider_rejected');
    return object(payload.data);
  };
  const readIssue = async (credential: string, number: number): Promise<BoundIssue> => {
    const data = await graphql(credential, issueQuery, {
      owner: binding.owner, repository: binding.repository, number
    });
    const repository = object(data.repository);
    if (repository.nameWithOwner !== `${binding.owner}/${binding.repository}`) return fail('reference_denied');
    return parseIssue(repository.issue, binding);
  };
  const issueNumberFrom = (url: string): number => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail('reference_denied');
    }
    const prefix = `/${binding.owner}/${binding.repository}/issues/`;
    const number = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : '';
    return parsed.origin === 'https://github.com' && parsed.search === '' && parsed.hash === '' &&
      /^[1-9][0-9]*$/.test(number)
      ? Number(number)
      : fail('reference_denied');
  };
  const boundIssue = async (
    credential: string,
    reference: ConversationCapabilityInput<'issue_intake.clarify'>['action']['issueReference'],
    enforceVersion = true
  ): Promise<BoundIssue> => {
    const issue = await readIssue(credential, issueNumberFrom(reference.url));
    if (issueReference(issue.databaseId) !== reference.referenceId) return fail('reference_denied');
    if (!issue.inProject) return fail('reference_denied');
    if (enforceVersion && version(issue.updatedAt) !== reference.expectedVersion) {
      return fail('stale_reference');
    }
    return issue;
  };
  const ensureProjectItem = async (credential: string, issue: BoundIssue): Promise<void> => {
    if (issue.inProject) return;
    const data = await graphql(credential, addProjectItemMutation, {
      project: binding.projectNodeId, content: issue.nodeId
    });
    const added = object(data.addProjectV2ItemById);
    const item = object(added.item);
    if (object(item.project).id !== binding.projectNodeId) return fail('response_invalid');
  };
  const findIssueByMarker = async (credential: string, value: string): Promise<BoundIssue | null> => {
    let match: BoundIssue | null = null;
    for (let page = 1; page <= 10; page += 1) {
      const payload = await request(fetch, credential,
        `/repos/${binding.owner}/${binding.repository}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
        {method: 'GET'});
      if (!Array.isArray(payload) || payload.length > 100) return fail('response_invalid');
      for (const entry of payload) {
        const issue = object(entry);
        if (issue.pull_request !== undefined || typeof issue.body !== 'string' || !issue.body.includes(value)) {
          continue;
        }
        if (match !== null) return fail('response_invalid');
        match = parseIssue(issue, binding);
      }
      if (payload.length < 100) return match;
    }
    return fail('response_invalid');
  };
  const findCommentByMarker = async (
    credential: string,
    issue: BoundIssue,
    value: string
  ): Promise<Record<string, unknown> | null> => {
    let match: Record<string, unknown> | null = null;
    for (let page = 1; page <= 10; page += 1) {
      const comments = await request(fetch, credential,
        `/repos/${binding.owner}/${binding.repository}/issues/${issue.number}/comments?per_page=100&page=${page}`,
        {method: 'GET'});
      if (!Array.isArray(comments) || comments.length > 100) return fail('response_invalid');
      for (const entry of comments) {
        const comment = object(entry);
        if (comment.body !== value && !String(comment.body).endsWith(`\n\n${value}`)) continue;
        if (match !== null) return fail('response_invalid');
        match = comment;
      }
      if (comments.length < 100) return match;
    }
    return fail('response_invalid');
  };
  const addComment = async (
    credential: string,
    issue: BoundIssue,
    body: string,
    value: string
  ): Promise<Record<string, unknown>> => {
    return object(await request(fetch, credential,
      `/repos/${binding.owner}/${binding.repository}/issues/${issue.number}/comments`,
      {method: 'POST', body: {body: `${body}\n\n${value}`}}));
  };

  return {
    async readClientProjectFacts(): Promise<ClientProjectFactsReadResult> {
      const credential = await token();
      const data = await graphql(credential, projectFactsQuery, {project: binding.projectNodeId});
      const project = object(data.node);
      if (project.id !== binding.projectNodeId || project.url !== binding.projectUrl ||
        typeof project.closed !== 'boolean' || !Number.isSafeInteger(object(project.items).totalCount)) {
        return fail('response_invalid');
      }
      const projectVersion = version(project.updatedAt);
      const itemCount = object(project.items).totalCount as number;
      return {
        evidence: {kind: 'source', referenceId: binding.projectNodeId, url: binding.projectUrl,
          version: projectVersion},
        facts: {projectUrl: binding.projectUrl, projectVersion,
          closed: project.closed as boolean, itemCount}
      };
    },
    async createIssueIntake(capability): Promise<ConversationExternalResult> {
      const pending = issueCreations.get(capability.idempotencyKey);
      if (pending !== undefined) return pending;
      const creation = (async (): Promise<ConversationExternalResult> => {
        const credential = await token();
        const value = marker(capability.projectRef, capability.idempotencyKey);
        let issue = await findIssueByMarker(credential, value);
        if (issue === null) {
          const created = await request(fetch, credential,
            `/repos/${binding.owner}/${binding.repository}/issues`, {method: 'POST', body: {
              title: capability.action.title,
              body: `${capability.action.statement}\n\nSource: ${capability.action.source.url}\n\n${value}`
            }});
          issue = parseIssue(created, binding);
        }
        issue = await readIssue(credential, issue.number);
        await ensureProjectItem(credential, issue);
        return {kind: 'issue', referenceId: issueReference(issue.databaseId), url: issue.url,
          version: version(issue.updatedAt)};
      })();
      issueCreations.set(capability.idempotencyKey, creation);
      try {
        return await creation;
      } finally {
        if (issueCreations.get(capability.idempotencyKey) === creation) {
          issueCreations.delete(capability.idempotencyKey);
        }
      }
    },
    async clarifyIssueIntake(capability): Promise<ConversationExternalResult> {
      const credential = await token();
      const value = marker(capability.projectRef, capability.idempotencyKey);
      const issue = await boundIssue(credential, capability.action.issueReference, false);
      const existing = await findCommentByMarker(credential, issue, value);
      if (existing !== null) {
        return {kind: 'issue', referenceId: issueReference(issue.databaseId), url: issue.url,
          version: version(existing.updated_at)};
      }
      if (version(issue.updatedAt) !== capability.action.issueReference.expectedVersion) {
        return fail('stale_reference');
      }
      const comment = await addComment(credential, issue,
        `${capability.action.clarification}\n\nSource: ${capability.action.source.url}`, value);
      return {kind: 'issue', referenceId: issueReference(issue.databaseId), url: issue.url,
        version: version(comment.updated_at)};
    },
    async addSourceContext(capability): Promise<ConversationExternalResult> {
      const credential = await token();
      const value = marker(capability.projectRef, capability.idempotencyKey);
      const issue = await boundIssue(credential, capability.action.targetReference, false);
      const existing = await findCommentByMarker(credential, issue, value);
      if (existing !== null) {
        return {kind: 'source', referenceId: commentReference(existing.id),
          url: string(existing.html_url), version: version(existing.updated_at)};
      }
      if (version(issue.updatedAt) !== capability.action.targetReference.expectedVersion) {
        return fail('stale_reference');
      }
      const comment = await addComment(credential, issue,
        `${capability.action.statement}\n\nSource: ${capability.action.source.url}`, value);
      return {kind: 'source', referenceId: commentReference(comment.id),
        url: string(comment.html_url), version: version(comment.updated_at)};
    }
  };
};
