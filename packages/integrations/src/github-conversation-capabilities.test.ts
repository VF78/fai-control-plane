import {describe, expect, it, vi} from 'vitest';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import {
  createGitHubConversationCapabilityAdapter,
  GitHubConversationCapabilityError,
  githubConversationCapabilityCredentialScope
} from './github-conversation-capabilities';

const binding = {
  owner: 'VF78', repository: 'ascon', repositoryId: 1279114011,
  projectNodeId: 'PVT_project', projectUrl: 'https://github.com/users/VF78/projects/4'
};
const credentialRef: OpaqueSecretRef = {
  provider: 'secret-store', reference: 'github-client-edge',
  scope: githubConversationCapabilityCredentialScope
};
const secrets: SecretsProvider = {resolve: vi.fn(async () => ({value: 'bounded-token'}))};
const origin = {
  visibility: 'client' as const, channelRef: 'channel:opaque', actorRef: 'actor:opaque',
  messageRef: 'message:opaque', observedAt: '2026-08-13T00:00:00.000Z'
};
const capability = <T>(action: T, idempotencyKey = 'idempotency-42') => ({
  projectRef: 'project:opaque', origin, action, correlationId: 'correlation-42', idempotencyKey
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: {'content-type': 'application/json'}
});

const github = () => {
  let issueBody: string | null = null;
  let inProject = false;
  let updatedAt = '2026-08-13T00:00:00Z';
  const comments: Record<string, unknown>[] = [];
  const calls = {issuesCreated: 0, projectAdds: 0, commentsCreated: 0};
  const issueRest = () => ({
    number: 42, id: 4242, node_id: 'I_issue',
    html_url: 'https://github.com/VF78/ascon/issues/42', updated_at: updatedAt,
    body: issueBody
  });
  const issueGraphql = () => ({
    number: 42, databaseId: 4242, id: 'I_issue',
    url: 'https://github.com/VF78/ascon/issues/42', updatedAt,
    projectItems: {nodes: inProject ? [{project: {id: binding.projectNodeId}}] : []}
  });
  const fetch = vi.fn(async (rawUrl: string, init: {method: string; body?: string}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/repos/VF78/ascon/issues' && init.method === 'GET') {
      return json(issueBody === null ? [] : [issueRest()]);
    }
    if (url.pathname === '/repos/VF78/ascon/issues' && init.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as {body: string};
      issueBody = body.body;
      calls.issuesCreated += 1;
      return json(issueRest(), 201);
    }
    if (url.pathname === '/repos/VF78/ascon/issues/42/comments' && init.method === 'GET') {
      return json(comments);
    }
    if (url.pathname === '/repos/VF78/ascon/issues/42/comments' && init.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as {body: string};
      updatedAt = '2026-08-13T00:01:00Z';
      const comment = {id: 77, body: body.body,
        html_url: 'https://github.com/VF78/ascon/issues/42#issuecomment-77', updated_at: updatedAt};
      comments.push(comment);
      calls.commentsCreated += 1;
      return json(comment, 201);
    }
    if (url.pathname === '/graphql') {
      const request = JSON.parse(init.body ?? '{}') as {query: string};
      if (request.query.includes('ClientProjectFacts')) return json({data: {node: {
        id: binding.projectNodeId, url: binding.projectUrl, updatedAt,
        closed: false, items: {totalCount: 1}
      }}});
      if (request.query.includes('AddConversationIssue')) {
        inProject = true;
        calls.projectAdds += 1;
        return json({data: {addProjectV2ItemById: {item: {
          id: 'PVTI_item', project: {id: binding.projectNodeId}
        }}}});
      }
      return json({data: {repository: {
        nameWithOwner: 'VF78/ascon', issue: issueGraphql()
      }}});
    }
    return json({message: 'unexpected'}, 404);
  });
  const adapter = createGitHubConversationCapabilityAdapter({binding, credentialRef, secrets, fetch});
  return {adapter, calls, fetch, setInProject: () => { inProject = true; }};
};

describe('bounded GitHub conversation capabilities', () => {
  it('returns bounded transient facts separately from source evidence', async () => {
    const {adapter} = github();
    await expect(adapter.readClientProjectFacts(capability({
      type: 'client_project_facts.read' as const
    }))).resolves.toEqual({
      evidence: {kind: 'source', referenceId: binding.projectNodeId, url: binding.projectUrl,
        version: 'github:updated-at:2026-08-13T00:00:00Z'},
      facts: {projectUrl: binding.projectUrl,
        projectVersion: 'github:updated-at:2026-08-13T00:00:00Z', closed: false, itemCount: 1}
    });
    expect(() => createGitHubConversationCapabilityAdapter({
      binding,
      credentialRef: {...credentialRef, scope: ['repo', 'project']},
      secrets,
      fetch: vi.fn()
    })).toThrowError(GitHubConversationCapabilityError);
  });

  it('deduplicates sequential issue replay and project-binds it', async () => {
    const {adapter, calls} = github();
    const input = capability({
      type: 'issue_intake.create' as const, title: 'Observed defect', statement: 'Bounded report',
      source: {referenceId: 'message:opaque', url: 'https://chat.example.test/messages/42'}
    });
    const first = await adapter.createIssueIntake(input);
    const replay = await adapter.createIssueIntake(input);
    expect(first).toEqual(replay);
    expect(first).toEqual({kind: 'issue', referenceId: 'github:issue:4242',
      url: 'https://github.com/VF78/ascon/issues/42',
      version: 'github:updated-at:2026-08-13T00:00:00Z'});
    expect(calls).toMatchObject({issuesCreated: 1, projectAdds: 1});
    const concurrent = github();
    const concurrentInput = capability({
      type: 'issue_intake.create' as const, title: 'Concurrent defect', statement: 'Bounded report',
      source: {referenceId: 'message:opaque', url: 'https://chat.example.test/messages/42'}
    });
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      concurrent.adapter.createIssueIntake(concurrentInput),
      concurrent.adapter.createIssueIntake(concurrentInput)
    ]);
    expect(concurrentSecond).toEqual(concurrentFirst);
    expect(concurrent.calls).toMatchObject({issuesCreated: 1, projectAdds: 1});
  });

  // GitHub issue creation has no atomic idempotency key: two concurrent first
  // deliveries can race between the marker scan and create. Avoiding that race
  // requires a durable lock/registry, deliberately outside this schema-free slice.

  it('returns stable clarification evidence for an exact replay', async () => {
    const {adapter, calls, setInProject} = github();
    setInProject();
    const input = capability({
      type: 'issue_intake.clarify' as const,
      issueReference: {referenceId: 'github:issue:4242',
        url: 'https://github.com/VF78/ascon/issues/42',
        expectedVersion: 'github:updated-at:2026-08-13T00:00:00Z'},
      clarification: 'Reproduced twice',
      source: {referenceId: 'message:opaque', url: 'https://chat.example.test/messages/42'}
    });
    const first = await adapter.clarifyIssueIntake(input);
    await expect(adapter.clarifyIssueIntake(input)).resolves.toEqual(first);
    expect(first).toMatchObject({kind: 'issue',
      version: 'github:updated-at:2026-08-13T00:01:00Z'});
    expect(calls.commentsCreated).toBe(1);
    const sourceContext = github();
    sourceContext.setInProject();
    const reference = {referenceId: 'github:issue:4242',
      url: 'https://github.com/VF78/ascon/issues/42',
      expectedVersion: 'github:updated-at:2026-08-13T00:00:00Z'};
    const sourceInput = capability({
      type: 'source_context.add' as const, targetReference: reference,
      statement: 'Diagnostic detail',
      source: {referenceId: 'message:opaque', url: 'https://chat.example.test/messages/42'}
    });
    const firstSource = await sourceContext.adapter.addSourceContext(sourceInput);
    expect(firstSource).toMatchObject({kind: 'source', referenceId: 'github:comment:77'});
    await expect(sourceContext.adapter.addSourceContext(sourceInput)).resolves.toEqual(firstSource);
    expect(sourceContext.calls.commentsCreated).toBe(1);
    await expect(sourceContext.adapter.clarifyIssueIntake(capability({
      type: 'issue_intake.clarify' as const, issueReference: reference,
      clarification: 'Late clarification',
      source: {referenceId: 'message:opaque', url: 'https://chat.example.test/messages/43'}
    }, 'idempotency-43'))).rejects.toMatchObject({code: 'stale_reference'});
  });
});
