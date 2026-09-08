import {describe,expect,it,vi} from 'vitest';
import {normalizeExecutionUsage,readExecutionUsage,recordExecutionUsage,type ExecutionUsage} from './execution-usage.ts';
import type {Database} from './runtime.ts';

const workspaceA='00000000-0000-4000-8000-000000000001';
const workspaceB='00000000-0000-4000-8000-000000000002';
const projectA='00000000-0000-4000-8000-000000000003';
const projectB='00000000-0000-4000-8000-000000000004';
const scope={workspaceId:workspaceA,projectId:projectA};
const other={workspaceId:workspaceB,projectId:projectB};
const sample=(overrides:Partial<ExecutionUsage>={}):ExecutionUsage=>({provider:'native-cli',sessionReference:'session',
  parentSessionReference:null,itemId:'task-a',contexts:[{model:'model-a',effort:'medium'}],
  totals:{input:100,cachedInput:80,output:20,reasoningOutput:5,total:120},
  completeness:'incomplete',reasons:[],aggregation:'unknown',provenance:'native-session-metadata',...overrides});
const higher=()=>sample({totals:{input:200,cachedInput:160,output:40,reasoningOutput:10,total:240}});
const missing=()=>sample({totals:{input:null,cachedInput:null,output:null,reasoningOutput:null,total:null},completeness:'unknown'});

type Audit={workspaceId:string;projectId:string;reference:string;details:{revision:number;usage:ExecutionUsage};observedAt:Date};
/** Transactional DB double: commit/rollback, receipt uniqueness and advisory-lock serialization.
 * SQL scope predicates are asserted separately. This is not a live PostgreSQL integration test.
 */
const fixture=()=>{
  const audits:Audit[]=[]; const receipts=new Map<string,string>();
  const locks=new Map<string,Promise<void>>();
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const projects=new Map([[projectA,workspaceA],[projectB,workspaceB]]);
  const tracked=new Map([[projectA,new Set(['task-a','task-other'])],[projectB,new Set(['task-b'])]]);
  const memberships=new Map([['actor-a',new Set([projectA])],['actor-b',new Set([projectB])]]);
  let failAt=''; let forceReceiptConflict=false;
  const release=vi.fn();
  const database={
    connect:async()=>{
      if(failAt==='connect')throw new Error('DO_NOT_RETAIN_DATABASE_ERROR');
      let unlock:(()=>void)|undefined;
      let pendingAudits:Audit[]=[];let pendingReceipts:Array<[string,string]>=[];
      return {release,query:async(sql:string,values:unknown[]=[])=>{
        calls.push({sql,values});
        if(failAt && sql.startsWith(failAt))throw new Error('DO_NOT_RETAIN_DATABASE_ERROR');
        if(sql.includes('pg_advisory_xact_lock')){
          const key=String(values[0]); const previous=locks.get(key)??Promise.resolve();
          let resolve!:()=>void;const current=new Promise<void>(done=>{resolve=done;});
          locks.set(key,previous.then(()=>current)); await previous;unlock=resolve;
        }else if(sql.startsWith('select 1 from projects')){
          const [project,workspace,item]=values as [string,string,string|null];
          const allowed=projects.get(project)===workspace && (item===null || tracked.get(project)?.has(item));
          return {rows:allowed?[{allowed:1}]:[],rowCount:allowed?1:0};
        }else if(sql.startsWith('select details')){
          const [project,workspace,reference]=values;
          const previous=audits.filter(a=>a.projectId===project&&a.workspaceId===workspace&&a.reference===reference)
            .sort((a,b)=>b.details.revision-a.details.revision)[0];
          return {rows:previous?[{details:previous.details}]:[],rowCount:previous?1:0};
        }else if(sql.startsWith('insert into command_receipts')){
          const [project,key]=values as [string,string];
          if(forceReceiptConflict||receipts.has(key))return {rows:[],rowCount:0};
          pendingReceipts.push([key,project]);return {rows:[],rowCount:1};
        }else if(sql.startsWith('insert into audit_events')){
          const [workspace,project,reference,,details,date]=values as string[];
          pendingAudits.push({workspaceId:workspace!,projectId:project!,reference:reference!,
            details:JSON.parse(details!),observedAt:new Date(date!)});
        }else if(sql==='commit'){
          audits.push(...pendingAudits);for(const [key,project] of pendingReceipts)receipts.set(key,project);
          pendingAudits=[];pendingReceipts=[];unlock?.();unlock=undefined;
        }else if(sql==='rollback'){
          pendingAudits=[];pendingReceipts=[];unlock?.();unlock=undefined;
        }
        return {rows:[],rowCount:0};
      }};
    },
    query:async(sql:string,values:unknown[])=>{
      calls.push({sql,values});if(failAt==='read')throw new Error('DO_NOT_RETAIN_DATABASE_ERROR');
      const [actor,project]=values as [string,string];
      if(!memberships.get(actor)?.has(project))return {rows:[]};
      const latest=new Map<string,Audit>();
      for(const audit of audits.filter(a=>a.projectId===project)){
        if((latest.get(audit.reference)?.details.revision??0)<audit.details.revision)latest.set(audit.reference,audit);
      }
      return {rows:[...latest.values()].map(a=>({usage:a.details.usage,observedAt:a.observedAt}))};
    }
  } as unknown as Database;
  return {database,audits,receipts,calls,release,memberships,
    fail:(value:string)=>{failAt=value;},conflict:()=>{forceReceiptConflict=true;}};
};

describe('existing-storage execution usage observations',()=>{
  it('records one receipt/audit revision; duplicate replay is deterministic even with reordered metadata',async()=>{
    const f=fixture();const value=sample({contexts:[{model:'b',effort:'high'},{model:'a',effort:'medium'}],
      reasons:['usage-partial','context-partial']});
    expect(await recordExecutionUsage(f.database,scope,value)).toBe('recorded');
    expect(await recordExecutionUsage(f.database,scope,{...value,contexts:[...value.contexts].reverse(),
      reasons:[...value.reasons].reverse()})).toBe('duplicate');
    expect(f.audits).toHaveLength(1);expect(f.receipts.size).toBe(1);
    expect(f.audits[0]?.details.revision).toBe(1);expect(f.release).toHaveBeenCalledTimes(2);
  });
  it('replaces cumulative totals in the latest query rather than summing revisions or subset counters',async()=>{
    const f=fixture();await recordExecutionUsage(f.database,scope,sample());
    expect(await recordExecutionUsage(f.database,scope,higher())).toBe('recorded');
    expect(await recordExecutionUsage(f.database,scope,higher())).toBe('duplicate');
    const result=await readExecutionUsage(f.database,'actor-a',projectA);
    expect(result.sessions).toHaveLength(1);expect(result.sessions[0]?.totals).toEqual(higher().totals);
    expect(result.combinedTotal).toBeNull();expect(result.aggregation).toBe('unknown');
    expect(f.audits.map(a=>a.details.revision)).toEqual([1,2]);
  });
  it('preserves the higher sample on stale replay, records incompleteness once, and allows recovery',async()=>{
    const f=fixture();await recordExecutionUsage(f.database,scope,higher());
    expect(await recordExecutionUsage(f.database,scope,sample())).toBe('recorded');
    expect(await recordExecutionUsage(f.database,scope,sample())).toBe('duplicate');
    let result=await readExecutionUsage(f.database,'actor-a',projectA);
    expect(result.sessions[0]?.totals).toEqual(higher().totals);
    expect(result.sessions[0]?.reasons).toContain('usage-decreased');
    const grown=sample({totals:{input:300,cachedInput:240,output:60,reasoningOutput:15,total:360}});
    await recordExecutionUsage(f.database,scope,grown);result=await readExecutionUsage(f.database,'actor-a',projectA);
    expect(result.sessions[0]?.totals.total).toBe(360);
  });
  it('does not synthesize component maxima when one counter decreases and total increases',async()=>{
    const f=fixture();await recordExecutionUsage(f.database,scope,sample());
    await recordExecutionUsage(f.database,scope,sample({totals:{...higher().totals,cachedInput:70}}));
    expect((await readExecutionUsage(f.database,'actor-a',projectA)).sessions[0]?.totals).toEqual(sample().totals);
  });
  it('retains explicit unknown/missing and partial fields without inventing zeros',async()=>{
    const f=fixture();await recordExecutionUsage(f.database,scope,missing());
    let result=await readExecutionUsage(f.database,'actor-a',projectA);
    expect(result.sessions[0]?.completeness).toBe('unknown');expect(result.sessions[0]?.totals.total).toBeNull();
    expect(await recordExecutionUsage(f.database,scope,missing())).toBe('duplicate');
    await recordExecutionUsage(f.database,scope,sample({totals:{...missing().totals,input:100}}));
    result=await readExecutionUsage(f.database,'actor-a',projectA);
    expect(result.sessions[0]?.totals).toEqual({...missing().totals,input:100});
    expect(result.sessions[0]?.completeness).toBe('incomplete');
    await recordExecutionUsage(f.database,scope,higher());await recordExecutionUsage(f.database,scope,missing());
    expect((await readExecutionUsage(f.database,'actor-a',projectA)).sessions[0]?.totals).toEqual(higher().totals);
  });
  it('distinguishes observed zero from absent counters',async()=>{
    const f=fixture();await recordExecutionUsage(f.database,scope,sample({totals:{input:0,cachedInput:0,output:0,reasoningOutput:0,total:0}}));
    const result=await readExecutionUsage(f.database,'actor-a',projectA);
    expect(result.sessions[0]?.totals.total).toBe(0);expect(result.sessions[0]?.completeness).toBe('incomplete');
    expect((await readExecutionUsage(f.database,'actor-b',projectB)).completeness).toBe('unknown');
  });
  it('preserves/enriches optional task/parent identity and refuses contradictory known identity',async()=>{
    const f=fixture();await recordExecutionUsage(f.database,scope,sample({itemId:null}));
    await recordExecutionUsage(f.database,scope,sample({parentSessionReference:'parent'}));
    await recordExecutionUsage(f.database,scope,{...higher(),parentSessionReference:null,itemId:null});
    expect((await readExecutionUsage(f.database,'actor-a',projectA)).sessions[0]).toMatchObject({itemId:'task-a',parentSessionReference:'parent'});
    expect(await recordExecutionUsage(f.database,scope,sample({parentSessionReference:'another'}))).toBe('conflict');
    expect(await recordExecutionUsage(f.database,scope,sample({itemId:'task-other'}))).toBe('conflict');
    expect(f.audits).toHaveLength(3);
  });
  it('retains parent and child samples separately without claiming whether parent totals include children',async()=>{
    const f=fixture();await recordExecutionUsage(f.database,scope,higher());
    await recordExecutionUsage(f.database,scope,sample({sessionReference:'child',parentSessionReference:'session'}));
    const result=await readExecutionUsage(f.database,'actor-a',projectA);
    expect(result.sessions).toHaveLength(2);expect(result.combinedTotal).toBeNull();
    expect(result.sessions.every(s=>s.aggregation==='unknown'&&s.reasons.includes('child-inclusion-unknown'))).toBe(true);
  });
  it('separates identical provider/session IDs by project and checks workspace, task and membership scope',async()=>{
    const f=fixture();await recordExecutionUsage(f.database,scope,sample());
    await recordExecutionUsage(f.database,other,{...higher(),itemId:'task-b'});
    expect(f.receipts.size).toBe(2);
    expect((await readExecutionUsage(f.database,'actor-a',projectA)).sessions[0]?.totals.total).toBe(120);
    expect((await readExecutionUsage(f.database,'actor-b',projectB)).sessions[0]?.totals.total).toBe(240);
    expect((await readExecutionUsage(f.database,'actor-a',projectB)).sessions).toEqual([]);
    expect(await recordExecutionUsage(f.database,{...scope,workspaceId:workspaceB},sample())).toBe('denied');
    expect(await recordExecutionUsage(f.database,scope,sample({itemId:'task-b'}))).toBe('denied');
    f.memberships.delete('actor-a');expect((await readExecutionUsage(f.database,'actor-a',projectA)).sessions).toEqual([]);
    const authorization=f.calls.find(c=>c.sql.startsWith('select 1 from projects'))!.sql;
    expect(authorization).toContain('p.id=$1 and p.workspace_id=$2');
    expect(authorization).toContain('b.project_id=p.id');expect(authorization).toContain("fact->>'itemId'=$3");
    expect(authorization).not.toContain('agent.submit');
    const prior=f.calls.find(c=>c.sql.startsWith('select details'))!.sql;
    expect(prior).toContain('project_id=$1 and workspace_id=$2');expect(prior).toContain('target_reference=$3');
    const read=f.calls.find(c=>c.sql.startsWith('select distinct'))!.sql;
    for(const predicate of ['a.project_id=$2','m.project_id=a.project_id','m.actor_id=$1','m.active=true','actor.enabled=true',
      'actor.workspace_id=p.workspace_id',"m.role in ('project_owner','operator','contributor')"] )expect(read).toContain(predicate);
  });
  it('uses collision-safe tuple keys for provider/session identities',async()=>{
    const f=fixture();await recordExecutionUsage(f.database,scope,sample({provider:'a:b',sessionReference:'c'}));
    await recordExecutionUsage(f.database,scope,sample({provider:'a',sessionReference:'b:c'}));
    expect(new Set(f.audits.map(a=>a.reference)).size).toBe(2);expect(f.receipts.size).toBe(2);
  });
  it('serializes concurrent observations and keeps one latest monotonic session sample',async()=>{
    const f=fixture();await Promise.all([recordExecutionUsage(f.database,scope,higher()),recordExecutionUsage(f.database,scope,sample()),
      recordExecutionUsage(f.database,scope,higher())]);
    const result=await readExecutionUsage(f.database,'actor-a',projectA);
    expect(result.sessions).toHaveLength(1);expect(result.sessions[0]?.totals.total).toBe(240);
    expect(f.audits.map(a=>a.details.revision)).toEqual([1,2]);
    const lockCalls=f.calls.filter(c=>c.sql.includes('pg_advisory_xact_lock'));
    expect(lockCalls).toHaveLength(3);expect(new Set(lockCalls.map(c=>c.values[0])).size).toBe(1);
  });
  it('strips every non-allowlisted payload field and rejects free-form diagnostics',async()=>{
    const f=fixture();const marker='DO_NOT_RETAIN_RAW_PAYLOAD';
    const value={...sample(),prompt:marker,rawJsonl:marker,toolOutput:marker,credentials:marker,
      contexts:[{model:'model-a',effort:'medium',instructions:marker}],totals:{...sample().totals,raw:marker}};
    expect(await recordExecutionUsage(f.database,scope,value)).toBe('recorded');
    expect(JSON.stringify(f.calls)).not.toContain(marker);expect(JSON.stringify(f.audits)).not.toContain(marker);
    expect(await recordExecutionUsage(f.database,scope,{...sample(),reasons:[marker]})).toBe('invalid');
    expect(await recordExecutionUsage(f.database,scope,{...sample(),sessionReference:'multiline\ncontents'})).toBe('invalid');
    // Reads reconstruct the allowlist too, rather than spreading historical JSON.
    Object.assign(f.audits[0]!.details.usage,{raw:marker});
    expect(JSON.stringify(await readExecutionUsage(f.database,'actor-a',projectA))).not.toContain(marker);
  });
  it.each([null,{},sample({totals:{...sample().totals,input:-1}}),sample({totals:{...sample().totals,cachedInput:101}}),
    sample({totals:{...sample().totals,reasoningOutput:21}}),sample({totals:{...sample().totals,total:999}}),
    {...sample(),sessionReference:null}])('rejects malformed metadata before persistence: %j',async value=>{
    const f=fixture();expect(await recordExecutionUsage(f.database,scope,value)).toBe('invalid');expect(f.calls).toEqual([]);
  });
  it('normalizes omitted token fields as unknown and canonicalizes context changes',()=>{
    const value=normalizeExecutionUsage({...sample(),totals:{input:100},contexts:[{model:'b',effort:'high'},
      {model:'a',effort:'medium'},{model:'b',effort:'high'}]});
    expect(value?.totals).toEqual({...missing().totals,input:100});expect(value?.contexts).toHaveLength(2);
    expect(value?.reasons).toContain('usage-partial');
  });
  it.each(['connect','insert into audit_events'])('contains %s failure and rolls back incomplete persistence',async failure=>{
    const f=fixture();f.fail(failure);expect(await recordExecutionUsage(f.database,scope,sample())).toBe('unavailable');
    expect(f.audits).toEqual([]);expect(f.receipts.size).toBe(0);
    if(failure!=='connect'){expect(f.calls.at(-1)?.sql).toBe('rollback');expect(f.release).toHaveBeenCalledOnce();}
    f.fail('');expect(await recordExecutionUsage(f.database,scope,sample())).toBe('recorded');
  });
  it('does not append audit when the receipt dedup gate reports a conflict',async()=>{
    const f=fixture();f.conflict();expect(await recordExecutionUsage(f.database,scope,sample())).toBe('duplicate');
    expect(f.audits).toEqual([]);expect(f.calls.at(-1)?.sql).toBe('rollback');
  });
  it('reports read outages/corrupt retained metadata as unavailable/partial without leaking raw errors',async()=>{
    const f=fixture();f.fail('read');
    expect(await readExecutionUsage(f.database,'actor-a',projectA)).toMatchObject({sessions:[],combinedTotal:null,
      completeness:'unknown',availability:'unavailable'});
    f.fail('');await recordExecutionUsage(f.database,scope,sample());
    f.audits[0]!.details.usage={...sample(),reasons:['DO_NOT_RETAIN_RAW_PAYLOAD']};
    expect(await readExecutionUsage(f.database,'actor-a',projectA)).toMatchObject({sessions:[],availability:'partial',completeness:'unknown'});
    expect(await recordExecutionUsage(f.database,scope,higher())).toBe('unavailable');
  });
});
