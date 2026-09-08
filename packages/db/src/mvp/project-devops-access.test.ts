import {describe,expect,it,vi} from 'vitest';
import type {Database} from './runtime.ts';
import {saveProjectDevopsAccess} from './project-devops-access.ts';

describe('DevOps connection receipt',()=>{
  it('stores facts and audit with distinct UUID and text parameters in one transaction',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{id:'project'}]});const release=vi.fn();
    const database={connect:async()=>({query,release})} as unknown as Database;
    const value={host:'server.test',port:22,user:'deploy',ssh:'configured' as const,
      cloud:'none' as const,cloudStatus:'not_selected' as const,checkedAt:'2026-09-08T12:00:00Z'};
    await saveProjectDevopsAccess(database,{workspaceId:'workspace',projectId:'project',actorId:'actor',idempotencyKey:'request',value});
    const audit=query.mock.calls.find(([sql])=>sql.includes('insert into audit_events'))!;
    expect(audit[0]).toContain("values($1,$2,$3,'project.devops.configure',$7,$4,$5,$6)");
    expect(audit[1]).toEqual(['workspace','project','actor','request',
      JSON.stringify({ssh:'configured',cloud:'none',cloudStatus:'not_selected'}),value.checkedAt,'project']);
    expect(query.mock.calls.at(-1)?.[0]).toBe('commit');expect(release).toHaveBeenCalledOnce();
  });
});
