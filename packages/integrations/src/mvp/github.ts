import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import type {
  OpaqueSecretRef,
  RepositoryReadPort,
  SecretResolverPort,
  TrackerMutationPort,
  TrackerItemFact,
  TrackerReadPort,
  TrackerSnapshot
} from '@fai-control-plane/domain';

type Fetch = typeof globalThis.fetch;

export type GitHubBinding = Readonly<{
  id: string;
  owner: string;
  repository: string;
  projectId: string;
  projectNumber: number;
  projectUrl: string;
  credentialRef: OpaqueSecretRef;
}>;

const credentialPurpose = 'tracker_read';
const webhookPurpose = 'tracker_webhook_verify';
const mutationPurpose = 'tracker_mutate';
const bounded = (value: unknown, maximum = 2_048): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positiveInteger = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('github_response_invalid');
  return value as number;
};

const validBinding = (binding: GitHubBinding): boolean =>
  /^[A-Za-z0-9_.-]{1,100}$/.test(binding.owner) && /^[A-Za-z0-9_.-]{1,100}$/.test(binding.repository) &&
  Number.isSafeInteger(binding.projectNumber) && binding.projectNumber > 0 &&
  binding.projectUrl === `https://github.com/users/${binding.owner}/projects/${binding.projectNumber}`;

const apiHeaders = (token: string): Readonly<Record<string, string>> => ({
  accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
  'content-type': 'application/json', 'user-agent': 'fai-control-plane-mvp/0.1',
  'x-github-api-version': '2022-11-28'
});
const commandMarker = (key: string): string => `<!-- fai-command:${createHash('sha256').update(key).digest('hex')} -->`;

export type VerifiedGitHubEvent = Readonly<{
  deliveryId: string;
  eventType: string;
  payloadHash: string;
}>;

export const verifyGitHubWebhook = async (input: Readonly<{
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
  secretRef: OpaqueSecretRef;
  secrets: SecretResolverPort;
}>): Promise<VerifiedGitHubEvent | null> => {
  if (input.body.byteLength === 0 || input.body.byteLength > 1_048_576) return null;
  const signature = input.headers['x-hub-signature-256'];
  const deliveryId = input.headers['x-github-delivery'];
  const eventType = input.headers['x-github-event'];
  if (!/^sha256=[a-f0-9]{64}$/.test(signature ?? '') || !bounded(deliveryId, 128) || !bounded(eventType, 64)) return null;
  const secret = (await input.secrets.resolve(input.secretRef, webhookPurpose)).value;
  if (!bounded(secret, 4_096)) return null;
  const expected = `sha256=${createHmac('sha256', secret).update(input.body).digest('hex')}`;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature!))) return null;
  return {deliveryId, eventType, payloadHash: createHash('sha256').update(input.body).digest('hex')};
};

const projectQuery = `query MvpProject($owner: String!, $number: Int!, $after: String) {
  user(login: $owner) { projectV2(number: $number) {
    id url updatedAt items(first: 100, after: $after) { nodes {
      id updatedAt
      statusValue: fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { optionId name }
      }
      ownerValue: fieldValueByName(name: "Owner") {
        ... on ProjectV2ItemFieldSingleSelectValue { optionId }
      }
      blockedValue: fieldValueByName(name: "Blocked") {
        ... on ProjectV2ItemFieldSingleSelectValue { optionId name }
      }
      targetDateValue: fieldValueByName(name: "Target date") {
        ... on ProjectV2ItemFieldDateValue { date }
      }
      content { ... on Issue {
        id databaseId number title url repository { nameWithOwner }
        assignees(first: 20) { nodes { id login name } }
        parent { databaseId repository { nameWithOwner } }
        subIssues(first: 100) { nodes { databaseId repository { nameWithOwner } } pageInfo { hasNextPage } }
        blockedBy(first: 100) { nodes { databaseId repository { nameWithOwner } } pageInfo { hasNextPage } }
      } }
    } pageInfo { endCursor hasNextPage } }
  } }
}`;
export const createGitHubTrackerReadAdapter = (input: Readonly<{
  binding: GitHubBinding;
  secrets: SecretResolverPort;
  fetch?: Fetch;
}>): TrackerReadPort => {
  if (!validBinding(input.binding)) throw new Error('github_binding_invalid');
  const request = input.fetch ?? globalThis.fetch;
  return {async readSnapshot(bindingId, cursor) {
    if (bindingId !== input.binding.id) throw new Error('github_binding_denied');
    void cursor; // Full bounded repair read; provider version, not pagination, deduplicates snapshots.
    const token = (await input.secrets.resolve(input.binding.credentialRef, credentialPurpose)).value;
    if (!bounded(token, 65_536)) throw new Error('github_credential_invalid');
    const itemNodes: unknown[] = [];
    let after: string | null = null;
    let projectVersion: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const response = await request('https://api.github.com/graphql', {
        method: 'POST', headers: apiHeaders(token),
        body: JSON.stringify({query: projectQuery, variables: {
          owner: input.binding.owner, number: input.binding.projectNumber, after
        }}), signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error('github_read_failed');
      const root = object(await response.json());
      const project = object(object(object(root?.data)?.user)?.projectV2);
      const itemsNode = object(project?.items);
      if (project?.url !== input.binding.projectUrl || !bounded(project.updatedAt, 64) || !Array.isArray(itemsNode?.nodes)) {
        throw new Error('github_response_invalid');
      }
      if (projectVersion !== null && projectVersion !== project.updatedAt) throw new Error('github_snapshot_changed');
      projectVersion = project.updatedAt;
      itemNodes.push(...itemsNode.nodes);
      const pageInfo = object(itemsNode.pageInfo);
      if (pageInfo?.hasNextPage !== true) break;
      if (!bounded(pageInfo.endCursor, 512) || page === 9) throw new Error('github_project_over_limit');
      after = pageInfo.endCursor;
    }
    if (projectVersion === null) throw new Error('github_response_invalid');
    const observedAt = new Date().toISOString();
    const linkedIssueIds = (value: unknown): readonly string[] => {
      const connection = object(value);
      if (!Array.isArray(connection?.nodes) || object(connection.pageInfo)?.hasNextPage === true) {
        throw new Error('github_response_invalid');
      }
      const ids = connection.nodes.map((node) => {
        const issue = object(node);
        if (issue === null || object(issue.repository)?.nameWithOwner !== `${input.binding.owner}/${input.binding.repository}`) {
          throw new Error('github_response_invalid');
        }
        return String(positiveInteger(issue.databaseId));
      });
      if (new Set(ids).size !== ids.length) throw new Error('github_response_invalid');
      return ids.sort((left, right) => Number(left) - Number(right));
    };
    const items: TrackerItemFact[] = itemNodes.map((entry) => {
      const item = object(entry);
      const content = object(item?.content);
      const status = object(item?.statusValue);
      const ownerValue = object(item?.ownerValue);
      const blockedValue = object(item?.blockedValue);
      const targetDateValue = object(item?.targetDateValue);
      const assignees = object(content?.assignees);
      const issueNumber = positiveInteger(content?.number);
      if (!bounded(item?.id, 512) || !bounded(item?.updatedAt, 64) || !bounded(content?.id, 512) ||
        !bounded(content?.title, 512) || !bounded(content?.url) || !Array.isArray(assignees?.nodes)) {
        throw new Error('github_response_invalid');
      }
      if (object(content.repository)?.nameWithOwner !== `${input.binding.owner}/${input.binding.repository}` ||
        content.url !== `https://github.com/${input.binding.owner}/${input.binding.repository}/issues/${issueNumber}`) {
        throw new Error('github_response_invalid');
      }
      const targetDate = targetDateValue === null || targetDateValue.date === null
        ? null
        : bounded(targetDateValue.date, 10) && /^\d{4}-\d{2}-\d{2}$/.test(targetDateValue.date)
          ? targetDateValue.date
          : (() => { throw new Error('github_response_invalid'); })();
      const blocked = blockedValue === null ? null : blockedValue.name === 'Yes' ? true
        : blockedValue.name === 'No' ? false : (() => { throw new Error('github_response_invalid'); })();
      const parent = content.parent === null ? null : object(content.parent);
      if (parent !== null && object(parent.repository)?.nameWithOwner !==
        `${input.binding.owner}/${input.binding.repository}`) throw new Error('github_response_invalid');
      return {
        itemId: item.id as string, projectId: input.binding.projectId,
        issueId: String(positiveInteger(content.databaseId)), title: content.title as string,
        url: content.url as string,
        version: `github:updated-at:${item.updatedAt as string}`,
        statusOptionId: bounded(status?.optionId, 512) ? status.optionId : null,
        statusOptionName: bounded(status?.name, 512) ? status.name : null,
        ownerOptionId: bounded(ownerValue?.optionId, 512) ? ownerValue.optionId : null,
        blocked,
        targetDate,
        parentIssueId: parent === null ? null : String(positiveInteger(parent.databaseId)),
        subIssueIds: linkedIssueIds(content.subIssues),
        dependencyIssueIds: linkedIssueIds(content.blockedBy),
        assigneeIds: assignees.nodes.map((actor) => {
          const id = object(actor)?.id;
          if (!bounded(id, 512)) throw new Error('github_response_invalid');
          return id;
        }), assignees: assignees.nodes.map((actor) => {
          const value = object(actor);
          if (!bounded(value?.id, 512) || !bounded(value?.login, 256) || (value?.name !== null && value?.name !== undefined && !bounded(value.name, 256))) {
            throw new Error('github_response_invalid');
          }
          return {id: value.id as string, login: value.login as string,
            name: value.name === null || value.name === undefined ? null : value.name as string};
        }), observedAt
      };
    });
    const snapshot: TrackerSnapshot = {
      bindingId, externalVersion: `github:updated-at:${projectVersion}`,
      cursor: `github:updated-at:${projectVersion}`,
      observedAt, sourceUrl: input.binding.projectUrl, items
    };
    return snapshot;
  }};
};

export const createGitHubRepositoryReadAdapter = (input: Readonly<{
  owner: string;
  repository: string;
  repositoryId: string;
  credentialRef: OpaqueSecretRef;
  secrets: SecretResolverPort;
  fetch?: Fetch;
}>): RepositoryReadPort => ({
  async readRepository({repositoryId}) {
    if (repositoryId !== input.repositoryId) throw new Error('github_repository_denied');
    const token = (await input.secrets.resolve(input.credentialRef, credentialPurpose)).value;
    if (!bounded(token, 65_536)) throw new Error('github_credential_invalid');
    const response = await (input.fetch ?? globalThis.fetch)(
      `https://api.github.com/repos/${input.owner}/${input.repository}`,
      {headers: apiHeaders(token), signal: AbortSignal.timeout(10_000)}
    );
    const value = response.ok ? object(await response.json()) : null;
    if (value?.html_url !== `https://github.com/${input.owner}/${input.repository}` ||
      !bounded(value.default_branch, 256)) throw new Error('github_repository_read_failed');
    return {repositoryId, url: value.html_url as string, defaultBranch: value.default_branch as string,
      observedAt: new Date().toISOString()};
  }
});

export const createGitHubTrackerMutationAdapter = (input: Readonly<{
  binding: GitHubBinding;
  credentialRef: OpaqueSecretRef;
  secrets: SecretResolverPort;
  fetch?: Fetch;
}>): TrackerMutationPort => {
  if (!validBinding(input.binding)) throw new Error('github_binding_invalid');
  const request = input.fetch ?? globalThis.fetch;
  const token = async (): Promise<string> => {
    const value = (await input.secrets.resolve(input.credentialRef, mutationPurpose)).value;
    if (!bounded(value, 65_536)) throw new Error('github_credential_invalid');
    return value;
  };
  const issueNumber = (referenceId: string): number => {
    const number = Number(referenceId);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('github_issue_reference_invalid');
    return number;
  };
  return {
    async createIssue(command) {
      if (command.projectId !== input.binding.projectId || !bounded(command.title, 160) || !bounded(command.statement, 4_000)) {
        throw new Error('github_mutation_denied');
      }
      const credential = await token();
      const marker = commandMarker(command.idempotencyKey);
      const search = await request(`https://api.github.com/search/issues?q=${encodeURIComponent(`${marker} repo:${input.binding.owner}/${input.binding.repository}`)}`,
        {headers: apiHeaders(credential), signal: AbortSignal.timeout(10_000)});
      const searchValue = search.ok ? object(await search.json()) : null;
      const found = Array.isArray(searchValue?.items) ? object(searchValue.items[0]) : null;
      let value = found;
      if (value === null) {
        const response = await request(`https://api.github.com/repos/${input.binding.owner}/${input.binding.repository}/issues`, {
          method: 'POST', headers: apiHeaders(credential),
          body: JSON.stringify({title: command.title, body: `${command.statement}\n\n${marker}`}), signal: AbortSignal.timeout(10_000)});
        value = response.ok ? object(await response.json()) : null;
      }
      const number = positiveInteger(value?.number);
      const url = `https://github.com/${input.binding.owner}/${input.binding.repository}/issues/${number}`;
      if (value?.html_url !== url || !bounded(value.updated_at, 64) || !bounded(value.node_id, 512)) {
        throw new Error('github_mutation_failed');
      }
      const project = await request('https://api.github.com/graphql', {method: 'POST', headers: apiHeaders(credential),
        body: JSON.stringify({query: `query($owner:String!,$number:Int!){user(login:$owner){projectV2(number:$number){id}}}`,
          variables: {owner: input.binding.owner, number: input.binding.projectNumber}}), signal: AbortSignal.timeout(10_000)});
      const projectValue = project.ok ? object(await project.json()) : null;
      const projectNodeId = object(object(object(projectValue?.data)?.user)?.projectV2)?.id;
      if (!bounded(projectNodeId, 512)) throw new Error('github_mutation_failed');
      const membership = await request('https://api.github.com/graphql', {method: 'POST', headers: apiHeaders(credential),
        body: JSON.stringify({query: `query($content:ID!){node(id:$content){... on Issue{projectItems(first:100){nodes{id project{id}} pageInfo{hasNextPage}}}}}`,
          variables: {content: value.node_id}}), signal: AbortSignal.timeout(10_000)});
      const membershipValue = membership.ok ? object(await membership.json()) : null;
      const projectItems = object(object(membershipValue?.data)?.node)?.projectItems;
      const connection = object(projectItems);
      if (!membership.ok || !Array.isArray(connection?.nodes) || object(connection.pageInfo)?.hasNextPage === true) {
        throw new Error('github_mutation_failed');
      }
      const alreadyAdded = connection.nodes.some((entry) => object(object(entry)?.project)?.id === projectNodeId);
      if (!alreadyAdded) {
        const add = await request('https://api.github.com/graphql', {method: 'POST', headers: apiHeaders(credential),
          body: JSON.stringify({query: `mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`,
            variables: {project: projectNodeId, content: value.node_id}}), signal: AbortSignal.timeout(10_000)});
        const addValue = add.ok ? object(await add.json()) : null;
        const errors = addValue?.errors;
        const returned = object(object(object(addValue?.data)?.addProjectV2ItemById)?.item)?.id;
        if (!add.ok || (Array.isArray(errors) && errors.length > 0) || !bounded(returned,512)) throw new Error('github_mutation_failed');
      }
      return {referenceId: String(number), url, version: `github:updated-at:${value.updated_at as string}`};
    },
    async addIssueContext(command) {
      if (!bounded(command.statement, 4_000)) throw new Error('github_mutation_denied');
      const number = issueNumber(command.referenceId); const credential = await token();
      const marker = commandMarker(command.idempotencyKey);
      const commentsResponse = await request(`https://api.github.com/repos/${input.binding.owner}/${input.binding.repository}/issues/${number}/comments?per_page=100`,
        {headers: apiHeaders(credential), signal: AbortSignal.timeout(10_000)});
      const comments = commentsResponse.ok ? await commentsResponse.json() as unknown : null;
      if (Array.isArray(comments) && comments.some((entry) => object(entry)?.body !== undefined &&
        String(object(entry)?.body).includes(marker))) return {referenceId: String(number),
        url: `https://github.com/${input.binding.owner}/${input.binding.repository}/issues/${number}`,
        version: command.expectedVersion};
      const issueUrl = `https://api.github.com/repos/${input.binding.owner}/${input.binding.repository}/issues/${number}`;
      const currentResponse = await request(issueUrl, {headers: apiHeaders(credential), signal: AbortSignal.timeout(10_000)});
      const current = currentResponse.ok ? object(await currentResponse.json()) : null;
      if (!bounded(current?.updated_at, 64) || `github:updated-at:${current.updated_at as string}` !== command.expectedVersion) {
        throw new Error('github_version_conflict');
      }
      const response = await request(`${issueUrl}/comments`, {method: 'POST',
        headers: apiHeaders(credential), body: JSON.stringify({body: `${command.statement}\n\n${marker}`}),
        signal: AbortSignal.timeout(10_000)});
      if (!response.ok) throw new Error('github_mutation_failed');
      return {referenceId: String(number),
        url: `https://github.com/${input.binding.owner}/${input.binding.repository}/issues/${number}`,
        version: command.expectedVersion};
    }
  };
};
