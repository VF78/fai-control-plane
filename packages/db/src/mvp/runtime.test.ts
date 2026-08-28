import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {defaultAgentRoutingPolicy, projectContextSnapshotKind, projectContextSnapshotVersion,
  projectContextSourceKind, serializeProjectContextSnapshot, serializeProjectContextSource,
  trackerPollIntervalMs, trackerStaleAfterMs} from '@fai-control-plane/domain';
import {activateProjectContextSnapshot, addSourceArtifact, readActiveProjectContext, readAgentRoutingPolicy,
  createAgentAttemptStore,
  readProjectAgentSubmissionView, readProjectContextStatus,
  readProjectExecutionMode, readProjectProcessPolicy, refreshProjectContext, trackerSnapshotFreshness,
  executeAgentSubmissionTransaction, readProjectMembershipRole, type Database} from './runtime.ts';

describe('focused page projections', () => {
  it('reads one active membership role', async () => {
    const query = vi.fn().mockResolvedValue({rows:[{role:'project_owner'}]});
    await expect(readProjectMembershipRole({query} as unknown as Database,'actor','project'))
      .resolves.toBe('project_owner');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('active=true'), ['project','actor']);
  });

  it('reads only the latest submission for the selected task', async () => {
    const query = vi.fn().mockResolvedValue({rows:[{deliveryReference:'run-1',
      occurredAt:new Date('2026-08-26T10:00:00.000Z'),status:'completed'}]});
    await expect(readProjectAgentSubmissionView({query} as unknown as Database,'actor','project','item'))
      .resolves.toEqual({deliveryReference:'run-1',occurredAt:'2026-08-26T10:00:00.000Z',status:'completed'});
    expect(query).toHaveBeenCalledWith(expect.stringContaining('a.target_reference=$3'), ['actor','project','item']);
  });
});

describe('project-scoped active attempts', () => {
  it('filters by project before applying the bounded limit', async () => {
    const query = vi.fn(async () => ({rows: []}));
    const store = createAgentAttemptStore({query} as unknown as Database,
      '00000000-0000-4000-8000-000000000001');
    await store.listActive(20);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('($2::uuid is null or a.project_id=$2)'),
      [20, '00000000-0000-4000-8000-000000000001']);
  });
});

describe('tracker snapshot freshness', () => {
  const observedAt = new Date('2026-08-23T10:00:00.000Z');

  it('uses five-minute polls and three missed cycles as the stale boundary', () => {
    expect(trackerPollIntervalMs).toBe(300_000);
    expect(trackerStaleAfterMs).toBe(900_000);
    expect(trackerSnapshotFreshness(observedAt, new Date(observedAt.getTime() + trackerStaleAfterMs))).toBe('fresh');
    expect(trackerSnapshotFreshness(observedAt, new Date(observedAt.getTime() + trackerStaleAfterMs + 1))).toBe('stale');
  });

  it('reports unavailable before the first successful observation', () => {
    expect(trackerSnapshotFreshness(null, observedAt)).toBe('unavailable');
  });
});

describe('versioned agent routing projection', () => {
  it('reads the latest valid immutable source artifact with provenance', async () => {
    const contentText = JSON.stringify(defaultAgentRoutingPolicy);
    const query = vi.fn().mockResolvedValue({rows: [{id: 'version-id', projectId: 'project',
      sha256: createHash('sha256').update(contentText).digest('hex'), provenance: 'control-plane:command',
      createdAt: new Date('2026-08-24T10:00:00.000Z'), contentText}]});
    await expect(readAgentRoutingPolicy({query} as unknown as Database, 'owner', 'project')).resolves.toMatchObject({
      id: 'version-id', provenance: 'control-plane:command', policy: defaultAgentRoutingPolicy
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("s.kind='agent_routing_policy_v1'"), ['owner', 'project']);
  });
});

describe('versioned project process projection', () => {
  it('reads the exact immutable artifact selected by the latest canonical command', async () => {
    const policy = {contract:'fai.project-process.v1' as const,stages:[{id:'ready',title:'Ready',
      responsibility:'Contributor',gate:'Assignment',evidence:'Tracker fact',nextStageId:null}]};
    const contentText = JSON.stringify(policy);
    const query = vi.fn().mockResolvedValue({rows:[{id:'process',projectId:'project',
      sha256:createHash('sha256').update(contentText).digest('hex'),provenance:'control-plane:process',
      createdAt:new Date('2026-08-24T10:00:00.000Z'),contentText}]});
    await expect(readProjectProcessPolicy({query} as unknown as Database,'actor','project')).resolves.toMatchObject({policy});
    expect(query.mock.calls[0]?.[0]).toContain("action='project.process.configure'");
    expect(query.mock.calls[0]?.[0]).toContain("s.kind='project_process_policy_v1'");
  });
});

describe('project execution mode projection', () => {
  it('defaults to manual and reads only the latest project-scoped command', async () => {
    const empty = vi.fn().mockResolvedValue({rows:[]});
    await expect(readProjectExecutionMode({query:empty} as unknown as Database,'actor','project'))
      .resolves.toEqual({mode:'manual',actorId:null,changedAt:null});
    const query = vi.fn().mockResolvedValue({rows:[{actorId:'actor',mode:'autonomous',
      changedAt:new Date('2026-08-26T10:00:00.000Z')}]});
    await expect(readProjectExecutionMode({query} as unknown as Database,'actor','project'))
      .resolves.toEqual({mode:'autonomous',actorId:'actor',changedAt:'2026-08-26T10:00:00.000Z'});
    expect(query.mock.calls[0]?.[0]).toContain("action='project.execution.mode'");
  });
});

describe('active project context projection', () => {
  const sourceId='00000000-0000-4000-8000-000000000001'; const sourceKey='requirements';
  const sourceText=serializeProjectContextSource({contract:'fai.project-context-source.v1',key:sourceKey,content:'Approved source'});
  const sourceVersion=projectContextSnapshotVersion(sourceText);
  const content = serializeProjectContextSnapshot({contract:'fai.project-context.v1',content:'Approved context',
    sources:[{id:sourceId,key:sourceKey,kind:projectContextSourceKind,version:sourceVersion,provenance:'operator'}]});
  const artifact = {id:'context',sha256:projectContextSnapshotVersion(content),kind:projectContextSnapshotKind,
    provenance:'control-plane:context',content,createdAt:new Date('2026-08-24T10:00:00.000Z')};
  const artifactView = {...artifact,createdAt:'2026-08-24T10:00:00.000Z'};
  const sourceRow = (change: Partial<{id:string;name:string;sha256:string;provenance:string;contentText:string}> = {}) => ({
    id:sourceId,name:sourceKey,kind:projectContextSourceKind,sha256:sourceVersion,provenance:'operator',contentText:sourceText,...change});

  it('returns only the activated snapshot whose exact manifest is still present', async () => {
    const query = vi.fn().mockResolvedValueOnce({rows:[artifact]}).mockResolvedValueOnce({rows:[sourceRow()]});
    await expect(readActiveProjectContext({query} as unknown as Database,'actor','project')).resolves.toEqual(artifactView);
    expect(query.mock.calls[0]?.[0]).toContain("action='project.context.activate'");
  });

  it('fails closed when a newer canonical artifact exists for the same logical source key', async () => {
    const newerText=serializeProjectContextSource({contract:'fai.project-context-source.v1',key:sourceKey,content:'New source'});
    const query = vi.fn().mockResolvedValueOnce({rows:[artifact]}).mockResolvedValueOnce({rows:[sourceRow({
      id:'00000000-0000-4000-8000-000000000002',contentText:newerText,sha256:projectContextSnapshotVersion(newerText)})]});
    await expect(readActiveProjectContext({query} as unknown as Database,'actor','project')).resolves.toBeNull();
  });

  it('preserves the last active version for a truthful stale UI state', async () => {
    const newerText=serializeProjectContextSource({contract:'fai.project-context-source.v1',key:sourceKey,content:'New source'});
    const query = vi.fn().mockResolvedValueOnce({rows:[artifact]}).mockResolvedValueOnce({rows:[sourceRow({
      id:'00000000-0000-4000-8000-000000000002',contentText:newerText,sha256:projectContextSnapshotVersion(newerText)})]});
    await expect(readProjectContextStatus({query} as unknown as Database,'actor','project')).resolves.toMatchObject({
      status:'stale',snapshot:artifactView,sources:[{key:sourceKey}]
    });
  });

  it('ignores unrelated or noncanonical artifacts when resolving current source versions', async () => {
    const query = vi.fn().mockResolvedValueOnce({rows:[artifact]}).mockResolvedValueOnce({rows:[sourceRow()]});
    await expect(readActiveProjectContext({query} as unknown as Database,'actor','project')).resolves.toEqual(artifactView);
    expect(query.mock.calls[1]?.[1]).toEqual(['project',projectContextSourceKind,[sourceKey]]);
  });

  it('keeps an exact duplicate canonical source idempotent by kind and content hash', async () => {
    const query=vi.fn().mockResolvedValue({rowCount:1,rows:[{id:sourceId}]});
    const database={query} as unknown as Database;
    const input={projectId:'project',actorId:'actor',kind:projectContextSourceKind,name:sourceKey,mediaType:'application/json',
      sha256:sourceVersion,contentText:sourceText,sourceUrl:null,provenance:'operator'};
    await expect(addSourceArtifact(database,input)).resolves.toBe(sourceId);
    await expect(addSourceArtifact(database,input)).resolves.toBe(sourceId);
    expect(query.mock.calls[0]?.[0]).toContain('on conflict(project_id,kind,sha256)');
  });

  it('builds and activates through an owner/operator-only receipt and audit transaction', async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("m.role in ('project_owner','operator')")) return {rows:[{workspaceId:'workspace'}]};
      if (statement.includes("command_type='project.context.activate'")) return {rows:[]};
      if (statement.includes('id=any($2::uuid[]) and kind=$3')) return {rows:[sourceRow()]};
      if (statement.includes('where project_id=$1 and kind=$2 and sha256=$3')) return {rows:[]};
      return {rows:[]};
    });
    const release = vi.fn(); const connect = vi.fn(async () => ({query,release}));
    await expect(activateProjectContextSnapshot({connect} as unknown as Database,{workspaceId:'workspace',projectId:'project',
      actorId:'operator',sourceIds:[sourceId],content:'Approved context',idempotencyKey:'context:one',
      occurredAt:'2026-08-24T10:00:00.000Z'})).resolves.toMatchObject({status:'completed',
        version:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(query.mock.calls.some(([statement]) => String(statement).includes("values($1,$2,$3,'project.context.activate'"))).toBe(true);
    expect(query.mock.calls.some(([statement]) => String(statement).includes("values($1,$2,$3,'project.context.activate',$4,$5,$6,$7)"))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps the runtime context capsule bounded instead of resending full source documents', async () => {
    const source = await import('node:fs/promises').then(({readFile}) => readFile(new URL('./runtime.ts', import.meta.url), 'utf8'));
    expect(source).toContain('boundedCapsule(source.content, 600)');
  });

  it('requires project instructions, passport and process policy', async () => {
    const source = (id: string, name: string, content: string, provenance = 'repo-file:test') => {
      const contentText = serializeProjectContextSource({contract:'fai.project-context-source.v1',key:name,content});
      return {id,name,kind:projectContextSourceKind,contentText,provenance,
        sha256:projectContextSnapshotVersion(contentText)};
    };
    const rows = [
      source('00000000-0000-4000-8000-000000000001','repo:agents','ASCON instructions'),
      source('00000000-0000-4000-8000-000000000002','repo:passport','ASCON passport'),
      source('00000000-0000-4000-8000-000000000003','composition:project-process-policy','ASCON process','composition-file')
    ];
    const query = vi.fn().mockResolvedValue({rows});
    const transactionQuery = vi.fn(async (statement: string) => {
      if (statement.includes("m.role in ('project_owner','operator')")) return {rows:[{workspaceId:'workspace'}]};
      if (statement.includes("command_type='project.context.activate'")) return {rows:[]};
      if (statement.includes('id=any($2::uuid[]) and kind=$3')) return {rows};
      return {rows:[]};
    });
    const database = {query, connect: vi.fn(async () => ({query:transactionQuery,release:vi.fn()}))} as unknown as Database;
    await expect(refreshProjectContext(database,{workspaceId:'workspace',projectId:'project',actorId:'actor',
      idempotencyKey:'refresh:one',occurredAt:'2026-08-27T00:00:00.000Z'})).resolves.toMatchObject({status:'completed'});
    expect(query.mock.calls[0]?.[1]).toEqual(['project',projectContextSourceKind,
      ['repo:agents','repo:passport','composition:project-process-policy']]);
  });

  it('does not revive an older repository source after a newer removal tombstone', async () => {
    const oldText = serializeProjectContextSource({contract:'fai.project-context-source.v1',key:'repo:agents',
      content:'obsolete instructions'});
    const query = vi.fn().mockResolvedValue({rows:[
      {id:'00000000-0000-4000-8000-000000000002',name:'repo:agents',contentText:oldText,
        provenance:'repo-file-removed:AGENTS.md@deadbeef'},
      {id:'00000000-0000-4000-8000-000000000001',name:'repo:agents',contentText:oldText,
        provenance:'repo-file:AGENTS.md@old'}
    ]});
    const database = {query,connect:vi.fn()} as unknown as Database;
    await expect(refreshProjectContext(database,{workspaceId:'workspace',projectId:'project',actorId:'actor',
      idempotencyKey:'refresh:removed',occurredAt:'2026-08-27T00:00:00.000Z'}))
      .rejects.toThrow('project_context_not_configured');
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('compares text audit references with artifact UUIDs explicitly', async () => {
    const source = await import('node:fs/promises').then(({readFile}) => readFile(new URL('./runtime.ts', import.meta.url), 'utf8'));
    expect(source.match(/active\.target_reference=s\.id::text/g)).toHaveLength(3);
    expect(source).not.toContain('active.target_reference=s.id\n');
  });
});

describe('agent submission evidence projection', () => {
  it('keeps task and delivery references in the same bounded DB projection', async () => {
    const source = await import('node:fs/promises').then(({readFile}) => readFile(new URL('./runtime.ts', import.meta.url), 'utf8'));
    expect(source).toContain("a.action='agent.submit'");
    expect(source).toContain("r.command_type='agent.submit'");
    expect(source).toContain('a.target_reference as "targetReference"');
    expect(source).toContain('r.result_reference as "deliveryReference"');
    expect(source).toContain('r.occurred_at=a.occurred_at');
    expect(source).toContain("coalesce(terminal.details->>'status','started') as status");
    expect(source).toContain("t.action in ('agent.attempt.completed','agent.attempt.failed')");
    expect(source).toContain('agent-attempt:${input.projectId}:${input.itemId}');
    expect(source).toContain("failureCode: 'operator_confirmed_unobservable'");
    expect(source).toContain("insert into outbox_events(project_id,topic,idempotency_key,payload,available_at)");
    expect(source).toContain("values($1,'messenger-notification',$2,$3,$4)");
  });
});

describe('agent attempt retry guard', () => {
  const input = {workspaceId: 'workspace', projectId: 'project', actorId: 'actor', idempotencyKey: 'new-key',
    correlationId: 'new-correlation', role: 'developer', itemId: 'item', issueId: '42',
    observedVersion: 'v1', sourceCount: 1,
    processPolicyVersion: 'b'.repeat(64), processStageId: 'in-dev', processStageTitle: 'In Dev',
    successTargetTitle: 'QA', reworkTargetTitle: null,
    routingPolicy: {contract: 'fai.agent-routing.v1', routes: []} as never, executorCatalog: {},
    expectedOwnerOptionId: 'owner-hermes',
    retryOf: null as string|null, confirmUnobservableFailure: false,
    notification: {projectId: 'project', contour: 'trusted-main' as const, channelReference: 'internal',
      text: 'accepted', idempotencyKey: 'notice'}};
  const database = (latest: {deliveryReference: string; status: string; correlationId: string; actorId: string}|undefined) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('select result_reference as "deliveryReference" from command_receipts')) return {rows: []};
      if (sql.includes('coalesce(terminal.details')) return {rows: latest === undefined ? [] : [latest]};
      return {rows: [], rowCount: 1};
    });
    return {database: {connect: async () => ({query, release: vi.fn()})} as unknown as Database, query};
  };

  it('blocks a second execution while the exact item has a started attempt', async () => {
    const value = database({deliveryReference: 'run_active', status: 'started', correlationId: 'prior', actorId: 'actor'});
    const submit = vi.fn(async () => ({deliveryReference: 'run_new'}));
    await expect(executeAgentSubmissionTransaction(value.database, input, submit)).rejects.toThrow('agent_attempt_active');
    expect(submit).not.toHaveBeenCalled();
  });

  it('allows only the latest exact failed run and rejects a stale double retry', async () => {
    const failed = database({deliveryReference: 'run_failed', status: 'failed', correlationId: 'prior', actorId: 'actor'});
    await expect(executeAgentSubmissionTransaction(failed.database,
      {...input, retryOf: 'run_failed'}, async () => ({deliveryReference: 'run_new'}))).resolves.toMatchObject({deliveryReference: 'run_new'});
    const afterRetry = database({deliveryReference: 'run_new', status: 'started', correlationId: 'new', actorId: 'actor'});
    await expect(executeAgentSubmissionTransaction(afterRetry.database,
      {...input, idempotencyKey: 'another-key', retryOf: 'run_failed'}, async () => ({deliveryReference: 'run_duplicate'})))
      .rejects.toThrow('agent_retry_denied');
  });

  it('requires the explicit recovery flag before closing an unobservable started attempt', async () => {
    const prior = {deliveryReference: 'run_expired', status: 'started', correlationId: 'prior', actorId: 'actor'};
    const denied = database(prior);
    await expect(executeAgentSubmissionTransaction(denied.database,
      {...input, retryOf: 'run_expired'}, async () => ({deliveryReference: 'run_new'})))
      .rejects.toThrow('agent_retry_denied');
    const confirmed = database(prior);
    await expect(executeAgentSubmissionTransaction(confirmed.database,
      {...input, retryOf: 'run_expired', confirmUnobservableFailure: true}, async () => ({deliveryReference: 'run_new'})))
      .resolves.toMatchObject({deliveryReference: 'run_new'});
    expect(confirmed.query.mock.calls.some(([sql]) => String(sql).includes("'agent.attempt.failed'"))).toBe(true);
  });
});
