import {describe,expect,it,vi} from 'vitest';
import type {Database} from './runtime.ts';
import {deleteProjectRecords,readProjectDeletionTarget} from './project-deletion.ts';

describe('project deletion',()=>{
  it('requires the active project owner and deletes only project-scoped records',async()=>{
    const target={workspaceId:'workspace',projectId:'project',slug:'control'};const statements:string[]=[];
    const query=vi.fn<(sql:string,parameters?:unknown[])=>Promise<{rowCount:number;rows:Record<string,unknown>[]}>>(async(sql:string)=>{statements.push(sql.replace(/\s+/g,' ').trim());
      return sql.includes('for update')?{rowCount:1,rows:[{}]}:{rowCount:1,rows:[]};});
    const client={query,release:vi.fn()};const database={query:vi.fn(async()=>({rows:[target]})),
      connect:vi.fn(async()=>client)} as unknown as Database;
    await expect(readProjectDeletionTarget(database,'actor','project')).resolves.toEqual(target);
    await deleteProjectRecords(database,{...target,actorId:'actor'});
    expect(statements.some((sql)=>sql.startsWith('delete from tracker_snapshots'))).toBe(true);
    expect(statements).toContain('update audit_events set project_id=null where project_id=$1');
    expect(statements).toContain('delete from projects where id=$1 and workspace_id=$2');
    expect(query.mock.calls.find(([sql])=>String(sql).startsWith('delete from secret_refs'))?.[1]?.[1])
      .toBe('project-hermes:project:%');
    expect(statements.at(-1)).toBe('commit');
  });
});
