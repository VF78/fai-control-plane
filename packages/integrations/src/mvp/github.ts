import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import type {
  OpaqueSecretRef,
  RepositoryReadPort,
  SecretResolverPort,
  TrackerExecutorAssignmentPort,
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
      content { __typename ... on Issue {
        id databaseId number title body url repository { nameWithOwner }
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
    const items: TrackerItemFact[] = itemNodes.flatMap((entry) => {
      const item = object(entry);
      const content = object(item?.content);
      if (!bounded(item?.id, 512) || !bounded(item?.updatedAt, 64) ||
        content === null || !bounded(content.__typename, 64)) throw new Error('github_response_invalid');
      if (content.__typename !== 'Issue') return [];
      const contentRepository = object(content.repository)?.nameWithOwner;
      if (!bounded(contentRepository, 201)) throw new Error('github_response_invalid');
      if (contentRepository !== `${input.binding.owner}/${input.binding.repository}`) return [];
      const status = object(item?.statusValue);
      const ownerValue = object(item?.ownerValue);
      const blockedValue = object(item?.blockedValue);
      const targetDateValue = object(item?.targetDateValue);
      const assignees = object(content?.assignees);
      const issueNumber = positiveInteger(content?.number);
      if (!bounded(content?.id, 512) ||
        !bounded(content?.title, 512) || !bounded(content?.url) || !Array.isArray(assignees?.nodes)) {
        throw new Error('github_response_invalid');
      }
      if (content.url !== `https://github.com/${input.binding.owner}/${input.binding.repository}/issues/${issueNumber}`) {
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
      return [{
        itemId: item.id as string, projectId: input.binding.projectId,
        issueId: String(positiveInteger(content.databaseId)), title: content.title as string,
        statement: content.body === null || content.body === undefined ? null :
          typeof content.body === 'string' && content.body.length <= 20_000 && !content.body.includes('\0')
            ? content.body : (() => { throw new Error('github_response_invalid'); })(),
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
      }];
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
    const defaultBranch = value.default_branch as string;
    const refResponse = await (input.fetch ?? globalThis.fetch)(
      `https://api.github.com/repos/${input.owner}/${input.repository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      {headers: apiHeaders(token), signal: AbortSignal.timeout(10_000)}
    );
    const ref = refResponse.ok ? object(await refResponse.json()) : null;
    const target = object(ref?.object);
    if (typeof target?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(target.sha)) {
      throw new Error('github_repository_read_failed');
    }
    return {repositoryId, url: value.html_url as string, defaultBranch, defaultBranchSha: target.sha,
      observedAt: new Date().toISOString()};
  }
});

export const createGitHubTrackerMutationAdapter = (input: Readonly<{
  binding: GitHubBinding;
  credentialRef: OpaqueSecretRef;
  secrets: SecretResolverPort;
  fetch?: Fetch;
}>): TrackerMutationPort & TrackerExecutorAssignmentPort => {
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
  const graph = async (credential: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await request('https://api.github.com/graphql', {method: 'POST', headers: apiHeaders(credential),
      body: JSON.stringify({query, variables}), signal: AbortSignal.timeout(10_000)});
    const value = response.ok ? object(await response.json()) : null;
    if (value === null || (Array.isArray(value.errors) && value.errors.length > 0)) throw new Error('github_mutation_failed');
    return value;
  };
  const projectFields = async (credential: string) => {
    const root = await graph(credential, `query($owner:String!,$number:Int!){user(login:$owner){projectV2(number:$number){id fields(first:100){nodes{
      ... on ProjectV2SingleSelectField{id name options{id name}}
    } pageInfo{hasNextPage}}}}}`, {owner: input.binding.owner, number: input.binding.projectNumber});
    const project = object(object(object(root.data)?.user)?.projectV2);
    const fields = object(project?.fields); const nodes = fields?.nodes;
    if (fields === null || !bounded(project?.id, 512) || !Array.isArray(nodes) || object(fields.pageInfo)?.hasNextPage === true) {
      throw new Error('github_mutation_failed');
    }
    const single = (name: string): Readonly<{id: string; options: readonly Readonly<{id: string; name: string}>[]}> => {
      const field = nodes.map(object).find((value) => value?.name === name);
      if (field === undefined || field === null || !bounded(field.id, 512) || !Array.isArray(field.options)) throw new Error('github_mutation_failed');
      const options = field.options.map(object).map((option) => {
        if (option === null || !bounded(option.id, 512) || !bounded(option.name, 512)) throw new Error('github_mutation_failed');
        return {id: option.id, name: option.name};
      });
      return {id: field.id, options};
    };
    return {projectId: project.id, owner: single('Owner'), status: single('Status'), blocked: single('Blocked')};
  };
  const currentItem = async (credential: string, itemId: string, issueId: string, expectedVersion: string | null) => {
    const root = await graph(credential, `query($id:ID!){node(id:$id){... on ProjectV2Item{id updatedAt project{id}
      statusValue:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{optionId name}}
      ownerValue:fieldValueByName(name:"Owner"){... on ProjectV2ItemFieldSingleSelectValue{optionId name}}
      blockedValue:fieldValueByName(name:"Blocked"){... on ProjectV2ItemFieldSingleSelectValue{optionId name}}
      content{... on Issue{id databaseId number url assignees(first:20){nodes{id login name}}}}
    }}}`, {id: itemId});
    const item = object(object(root.data)?.node); const content = object(item?.content);
    const databaseId = content?.databaseId; const issueNumber = content?.number;
    if (item?.id !== itemId || !bounded(item?.updatedAt, 64) || !bounded(object(item?.project)?.id, 512) ||
      !bounded(content?.id, 512) || !Number.isSafeInteger(databaseId) || String(databaseId) !== issueId ||
      !Number.isSafeInteger(issueNumber) || (issueNumber as number) <= 0 ||
      content?.url !== `https://github.com/${input.binding.owner}/${input.binding.repository}/issues/${issueNumber as number}` ||
      !Array.isArray(object(content?.assignees)?.nodes)) throw new Error('github_response_invalid');
    const version = `github:updated-at:${item.updatedAt as string}`;
    if (expectedVersion !== null && version !== expectedVersion) throw new Error('github_version_conflict');
    const assigneeNodes = object(content.assignees)?.nodes;
    if (!Array.isArray(assigneeNodes)) throw new Error('github_response_invalid');
    const assignees = assigneeNodes.map(object).map((user) => {
      if (user === null || !bounded(user.id, 512) || !bounded(user.login, 256) ||
        (user.name !== null && user.name !== undefined && !bounded(user.name, 256))) throw new Error('github_response_invalid');
      return {id: user.id, login: user.login, name: user.name === null || user.name === undefined ? null : user.name};
    });
    const value = (field: 'statusValue'|'ownerValue'|'blockedValue') => object(item[field]);
    const blocked = value('blockedValue');
    if (blocked === null || !['Yes','No'].includes(String(blocked.name)) || !bounded(blocked.optionId, 512)) {
      throw new Error('github_response_invalid');
    }
    return {projectId: object(item.project)!.id as string, issueNumber: issueNumber as number, version,
      status: value('statusValue'), owner: value('ownerValue'), blocked: blocked.name === 'Yes', assignees};
  };
  const setIssueAssignees = async (credential: string, issueNumber: number, assignees: readonly string[]) => {
    const response = await request(`https://api.github.com/repos/${input.binding.owner}/${input.binding.repository}/issues/${issueNumber}`, {
      method: 'PATCH', headers: apiHeaders(credential), body: JSON.stringify({assignees}), signal: AbortSignal.timeout(10_000)});
    if (!response.ok) throw new Error('github_mutation_failed');
  };
  const setSingleSelect = async (credential: string, projectId: string, itemId: string, fieldId: string, optionId: string) => {
    await graph(credential, `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`,
      {project: projectId, item: itemId, field: fieldId, option: optionId});
  };
  const clearField = async (credential: string, projectId: string, itemId: string, fieldId: string) => {
    await graph(credential, `mutation($project:ID!,$item:ID!,$field:ID!){clearProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field}){projectV2Item{id}}}`,
      {project: projectId, item: itemId, field: fieldId});
  };
  const candidates = async (credential: string) => {
    const users: {id: string; login: string; name: string | null}[] = [];
    let page = 1;
    for (; page <= 10; page += 1) {
      const response = await request(`https://api.github.com/repos/${input.binding.owner}/${input.binding.repository}/assignees?per_page=100&page=${page}`,
        {headers: apiHeaders(credential), signal: AbortSignal.timeout(10_000)});
      const value = response.ok ? await response.json() as unknown : null;
      if (!Array.isArray(value)) throw new Error('github_read_failed');
      for (const entry of value) {
        const user = object(entry);
        const id = user === null ? null : String(user.id ?? '');
        if (user === null || !bounded(id, 512) || !bounded(user.login, 256) ||
          (user.name !== null && user.name !== undefined && !bounded(user.name, 256))) throw new Error('github_response_invalid');
        users.push({id, login: user.login, name: user.name === null || user.name === undefined ? null : user.name});
      }
      if (value.length < 100) break;
    }
    if (page > 10 && users.length >= 1_000) throw new Error('github_project_over_limit');
    return users;
  };
  return {
    async createIssue(command) {
      if (command.projectId !== input.binding.projectId || !bounded(command.title, 160) || !bounded(command.statement, 4_000) ||
        (command.initialStage!==undefined&&!bounded(command.initialStage,200))) {
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
      const existingItem=connection.nodes.map(object).find((entry)=>object(entry?.project)?.id===projectNodeId)??null;
      const alreadyAdded = existingItem!==null;let projectItemId=existingItem?.id;
      if (!alreadyAdded) {
        const add = await request('https://api.github.com/graphql', {method: 'POST', headers: apiHeaders(credential),
          body: JSON.stringify({query: `mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`,
            variables: {project: projectNodeId, content: value.node_id}}), signal: AbortSignal.timeout(10_000)});
        const addValue = add.ok ? object(await add.json()) : null;
        const errors = addValue?.errors;
        const returned = object(object(object(addValue?.data)?.addProjectV2ItemById)?.item)?.id;
        if (!add.ok || (Array.isArray(errors) && errors.length > 0) || !bounded(returned,512)) throw new Error('github_mutation_failed');
        projectItemId=returned;
      }
      if(command.initialStage!==undefined){if(!bounded(projectItemId,512))throw new Error('github_mutation_failed');
        const fields=await projectFields(credential);const stage=fields.status.options.find((option)=>option.name===command.initialStage);
        const no=fields.blocked.options.find((option)=>option.name==='No');if(stage===undefined||no===undefined)
          throw new Error('github_status_unavailable');
        await setSingleSelect(credential,fields.projectId,projectItemId,fields.status.id,stage.id);
        await setSingleSelect(credential,fields.projectId,projectItemId,fields.blocked.id,no.id);
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
    },
    async updateIssue(command) {
      const validValue = command.operation === 'state'
        ? ['open', 'closed'].includes(command.value)
        : bounded(command.value, command.operation === 'title' ? 160 : 4_000);
      if (command.projectId !== input.binding.projectId ||
        !['title', 'body', 'state'].includes(command.operation) || !validValue) {
        throw new Error('github_mutation_denied');
      }
      const credential = await token();
      const current = await currentItem(credential, command.itemId, command.issueId, command.expectedVersion);
      const issueUrl = `https://api.github.com/repos/${input.binding.owner}/${input.binding.repository}/issues/${current.issueNumber}`;
      const response = await request(issueUrl, {method: 'PATCH', headers: apiHeaders(credential),
        body: JSON.stringify({[command.operation]: command.value}), signal: AbortSignal.timeout(10_000)});
      if (!response.ok) throw new Error('github_mutation_failed');
      const readback = await request(issueUrl, {headers: apiHeaders(credential), signal: AbortSignal.timeout(10_000)});
      const issue = readback.ok ? object(await readback.json()) : null;
      const expectedUrl = `https://github.com/${input.binding.owner}/${input.binding.repository}/issues/${current.issueNumber}`;
      if (issue?.html_url !== expectedUrl || issue.number !== current.issueNumber ||
        issue[command.operation] !== command.value || !bounded(issue.updated_at, 64)) {
        throw new Error('github_mutation_failed');
      }
      const verified = await currentItem(credential, command.itemId, command.issueId, null);
      return {referenceId: String(current.issueNumber), url: expectedUrl, version: verified.version};
    },
    async setProjectItemStage(command) {
      if (command.projectId !== input.binding.projectId ||
        !bounded(command.stage, 200)) {
        throw new Error('github_mutation_denied');
      }
      const credential = await token();
      const current = await currentItem(credential, command.itemId, command.issueId, command.expectedVersion);
      const fields = await projectFields(credential);
      if (current.projectId !== fields.projectId) throw new Error('github_response_invalid');
      const stage = fields.status.options.find((option) => option.name === command.stage);
      if (stage === undefined) throw new Error('github_status_unavailable');
      if (current.status?.optionId !== stage.id) {
        await setSingleSelect(credential, fields.projectId, command.itemId, fields.status.id, stage.id);
      }
      const verified = current.status?.optionId === stage.id ? current :
        await currentItem(credential, command.itemId, command.issueId, null);
      if (verified.status?.optionId !== stage.id || verified.status?.name !== command.stage) {
        throw new Error('github_mutation_failed');
      }
      return {referenceId: command.itemId,
        url: `https://github.com/users/${input.binding.owner}/projects/${input.binding.projectNumber}`,
        version: verified.version};
    },
    async listAssignableUsers() {
      return candidates(await token());
    },
    async startExecutor(command) {
      if (!bounded(command.expectedStage, 200) || !bounded(command.targetStage, 200)) {
        throw new Error('github_mutation_denied');
      }
      const executor = command.executor;
      const credential = await token();
      const current = await currentItem(credential, command.itemId, command.issueId, command.expectedVersion);
      if (current.status?.name !== command.expectedStage || current.blocked !== command.expectedBlocked) {
        throw new Error('github_version_conflict');
      }
      const fields = await projectFields(credential);
      if (current.projectId !== fields.projectId) throw new Error('github_response_invalid');
      const no = fields.blocked.options.find((option) => option.name === 'No');
      const stage = fields.status.options.find((option) => option.name === command.targetStage);
      if (no === undefined || stage === undefined) throw new Error('github_status_unavailable');
      if (executor.kind === 'agent' &&
        !fields.owner.options.some((option) => option.id === executor.ownerOptionId)) {
        throw new Error('github_owner_unavailable');
      }
      if (executor.kind === 'human') {
        const available = await candidates(credential);
        if (!available.some((candidate) => candidate.id === executor.candidate.id &&
          candidate.login === executor.candidate.login)) throw new Error('github_assignee_unavailable');
      }
      let mutated = false;
      try {
        if (executor.kind === 'human') {
          await setIssueAssignees(credential, current.issueNumber, [executor.candidate.login]); mutated = true;
          if (current.owner !== null) await clearField(credential, fields.projectId, command.itemId, fields.owner.id);
        } else {
          if (current.assignees.length > 0) { await setIssueAssignees(credential, current.issueNumber, []); mutated = true; }
          if (current.owner?.optionId !== executor.ownerOptionId) {
            await setSingleSelect(credential, fields.projectId, command.itemId, fields.owner.id, executor.ownerOptionId);
            mutated = true;
          }
        }
        if (current.blocked) { await setSingleSelect(credential, fields.projectId, command.itemId, fields.blocked.id, no.id); mutated = true; }
        if (current.status?.name !== command.targetStage) {
          await setSingleSelect(credential, fields.projectId, command.itemId, fields.status.id, stage.id); mutated = true;
        }
      } catch (error) {
        if (mutated) throw new Error('github_assignment_partial');
        throw error;
      }
      const verified = await currentItem(credential, command.itemId, command.issueId, null);
      const exactExecutor = executor.kind === 'human'
        ? verified.owner === null && verified.assignees.length === 1 && verified.assignees[0]?.login === executor.candidate.login
        : verified.owner?.optionId === executor.ownerOptionId && verified.assignees.length === 0;
      if (verified.blocked || verified.status?.name !== command.targetStage || !exactExecutor) throw new Error('github_assignment_partial');
    }
  };
};
