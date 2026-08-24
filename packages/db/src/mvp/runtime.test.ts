import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {defaultAgentRoutingPolicy, projectContextSnapshotKind, projectContextSnapshotVersion,
  projectContextSourceKind, serializeProjectContextSnapshot, serializeProjectContextSource,
  trackerPollIntervalMs, trackerStaleAfterMs} from '@fai-control-plane/domain';
import {activateProjectContextSnapshot, addSourceArtifact, projectAgentDeliveryConfigured, readActiveProjectContext, readAgentRoutingPolicy,
  readProjectContextStatus,
  readProjectProcessPolicy, resolveReceiptBoundRoleRun, trackerSnapshotFreshness, type Database} from './runtime.ts';

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

describe('agent delivery readiness', () => {
  it('uses the authorized project DB projection without exposing the secret locator', async () => {
    const query = vi.fn().mockResolvedValue({rows: [{configured: true}]});
    await expect(projectAgentDeliveryConfigured({query} as unknown as Database, 'actor', 'project')).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("s.purpose='agent_delivery'"), ['actor', 'project']);
  });

  it('fails closed when no canonical reference is visible', async () => {
    const query = vi.fn().mockResolvedValue({rows: [{configured: false}]});
    await expect(projectAgentDeliveryConfigured({query} as unknown as Database, 'actor', 'project')).resolves.toBe(false);
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

  it('keys bootstrap refreshes by canonical source identity so updated documents activate', async () => {
    const source = await import('node:fs/promises').then(({readFile}) => readFile(new URL('./runtime.ts', import.meta.url), 'utf8'));
    expect(source).toContain("input.idempotencyKey.startsWith('bootstrap-context:')");
    expect(source).toContain("update(sourceIds.join('\\0'))");
    expect(source).toContain('boundedCapsule(source.content, 600)');
  });

  it('compares text audit references with artifact UUIDs explicitly', async () => {
    const source = await import('node:fs/promises').then(({readFile}) => readFile(new URL('./runtime.ts', import.meta.url), 'utf8'));
    expect(source.match(/active\.target_reference=s\.id::text/g)).toHaveLength(2);
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
    expect(source).toContain("insert into outbox_events(project_id,topic,idempotency_key,payload,available_at)");
    expect(source).toContain("values($1,'messenger-notification',$2,$3,$4)");
  });
});

describe('receipt-bound role-run projection', () => {
  it('derives the exact submit key and returns only one active operator receipt/audit match', async () => {
    const query = vi.fn().mockResolvedValue({rows: [{actorId: 'actor', projectId: 'project',
      requesterRole: 'operator', role: 'developer', itemId: 'PVTI_1', observedVersion: 'v1',
      occurredAt: new Date('2026-08-24T10:00:00.000Z')}]});
    const sessionId = `browser:${'a'.repeat(64)}`;
    await expect(resolveReceiptBoundRoleRun({query} as unknown as Database, sessionId, 'project'))
      .resolves.toMatchObject({sessionId, actorId: 'actor', role: 'developer', itemId: 'PVTI_1'});
    expect(query).toHaveBeenCalledWith(expect.stringContaining("r.command_type='agent.submit'"),
      [sessionId, 'project', `agent.submit:${'a'.repeat(64)}`]);
  });

  it('fails closed for malformed ids, duplicate matches, clients, or malformed receipt details', async () => {
    const query = vi.fn();
    await expect(resolveReceiptBoundRoleRun({query} as unknown as Database, 'browser:nope', 'project'))
      .resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
    for (const rows of [
      [{actorId: 'a'}, {actorId: 'b'}],
      [{actorId: 'a', projectId: 'project', requesterRole: 'client', role: 'developer', itemId: 'item',
        observedVersion: 'v1', occurredAt: new Date()}],
      [{actorId: 'a', projectId: 'project', requesterRole: 'operator', role: 'devops', itemId: 'item',
        observedVersion: 'v1', occurredAt: new Date()}]
    ]) {
      query.mockResolvedValueOnce({rows});
      await expect(resolveReceiptBoundRoleRun({query} as unknown as Database, `browser:${'a'.repeat(64)}`, 'project'))
        .resolves.toBeNull();
    }
  });
});
