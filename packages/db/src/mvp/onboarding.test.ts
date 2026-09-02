import {describe, expect, it, vi} from 'vitest';
import type {Database} from './runtime.ts';
import {addExistingProjectMember,listWorkspaceHumanActors,onboardProjectMember} from './onboarding.ts';

const hash = (character: string): string => character.repeat(64);
const database = (existing: readonly Readonly<{
  actorId: string; workspaceId: string; kind: string; enabled: boolean;
}>[] = []) => {
  const queries: string[] = [];
  const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
    queries.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.startsWith('select 1 from projects')) return {rowCount: 1, rows: [{ok: 1}]};
    if (sql.includes('from actor_external_identities')) return {rowCount: existing.length, rows: existing};
    if (sql.includes('returning actor_id')) return {rowCount: 1, rows: [{actorId: parameters?.[0]}]};
    return {rowCount: 1, rows: []};
  });
  const client = {query, release: vi.fn()};
  return {value: {connect: vi.fn(async () => client)} as unknown as Database, queries, query};
};

describe('project member onboarding', () => {
  it('lists only the workspace human directory through one bounded projection', async () => {
    const query=vi.fn<(sql:string,parameters?:readonly unknown[])=>Promise<{rows:{actorId:string;displayName:string}[]}>>(async()=>
      ({rows:[{actorId:'actor',displayName:'Vladimir'}]}));
    await expect(listWorkspaceHumanActors({query} as unknown as Database,'workspace')).resolves.toEqual([
      {actorId:'actor',displayName:'Vladimir'}]);
    expect(String(query.mock.calls[0]?.[0])).toContain("workspace_id=$1 and kind='human' and enabled=true");
  });

  it('adds one existing workspace employee to a project without copying the actor', async () => {
    const query=vi.fn<(sql:string,parameters?:readonly unknown[])=>Promise<{rowCount:number;rows:{id:string}[]}>>(async()=>
      ({rowCount:1,rows:[{id:'membership'}]}));
    await expect(addExistingProjectMember({query} as unknown as Database,{workspaceId:'workspace',projectId:'project',
      actorId:'actor',role:'contributor'})).resolves.toBeUndefined();
    expect(String(query.mock.calls[0]?.[0])).toContain('join actors a on a.workspace_id=p.workspace_id');
    expect(String(query.mock.calls[0]?.[0])).not.toContain('insert into actors');
  });

  it('allows a client with Bitrix identity only and creates CP access without a messenger call', async () => {
    const db = database();
    await expect(onboardProjectMember(db.value, {workspaceId: 'workspace', projectId: 'project', displayName: 'Client',
      role: 'client', identities: [{provider: 'bitrix24', subjectHash: hash('a')}]})).resolves.toMatchObject({created: true});
    expect(db.queries.some((sql) => sql.includes('insert into project_memberships'))).toBe(true);
    expect(db.queries.every((sql) => !/send|room|chat/i.test(sql))).toBe(true);
  });

  it('requires GitHub identity for an internal role before opening a transaction', async () => {
    const db = database();
    await expect(onboardProjectMember(db.value, {workspaceId: 'workspace', projectId: 'project', displayName: 'Team',
      role: 'operator', identities: [{provider: 'telegram', subjectHash: hash('b')}]}))
      .rejects.toThrow('onboarding_invalid');
    expect(db.value.connect).not.toHaveBeenCalled();
  });

  it('reuses one enabled workspace actor, adds identities and reactivates membership atomically', async () => {
    const db = database([{actorId: 'actor', workspaceId: 'workspace', kind: 'human', enabled: true}]);
    await expect(onboardProjectMember(db.value, {workspaceId: 'workspace', projectId: 'project', displayName: 'Known',
      role: 'contributor', identities: [{provider: 'github', subjectHash: hash('c')},
        {provider: 'telegram', subjectHash: hash('d')}]})).resolves.toEqual({actorId: 'actor', created: false});
    expect(db.queries.some((sql) => sql.includes('do update set role=excluded.role,active=true'))).toBe(true);
    expect(db.queries.some((sql) => sql.startsWith('insert into actors'))).toBe(false);
  });

  it('rejects supplied identities already bound to different actors', async () => {
    const db = database([
      {actorId: 'one', workspaceId: 'workspace', kind: 'human', enabled: true},
      {actorId: 'two', workspaceId: 'workspace', kind: 'human', enabled: true}
    ]);
    await expect(onboardProjectMember(db.value, {workspaceId: 'workspace', projectId: 'project', displayName: 'Conflict',
      role: 'client', identities: [{provider: 'github', subjectHash: hash('e')},
        {provider: 'bitrix24', subjectHash: hash('f')}]})).rejects.toThrow('onboarding_identity_conflict');
    expect(db.queries.at(-1)).toBe('rollback');
  });
});
