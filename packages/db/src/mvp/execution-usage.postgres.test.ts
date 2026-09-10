import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {listExecutionUsageTasks,recordExecutionUsage,readExecutionUsage,type ExecutionUsage} from './execution-usage.ts';

// Dedicated opt-in Unix socket only. Never reads DATABASE_URL, PGHOST or production credentials.
const enabled=process.env.FCP_USAGE_SMOKE_SOCKET==='/tmp/fai-355-pg-socket';
const config={host:'/tmp/fai-355-pg-socket',port:55435,user:'fai_usage_test',connectionTimeoutMillis:1000,max:4};
const name=`fai_usage_smoke_${process.pid}`;
let admin:pg.Pool|undefined;let database:pg.Pool|undefined;

describe.skipIf(!enabled)('isolated PostgreSQL usage SQL smoke',()=>{
  beforeAll(async()=>{
    admin=new pg.Pool({...config,database:'postgres'});
    await admin.query(`create database ${name}`);
    database=new pg.Pool({...config,database:name});
    // Current fresh 16-table schema from the repository, not a test schema fork.
    await database.query(await readFile(new URL('../../mvp-drizzle/0000_mvp.sql',import.meta.url),'utf8'));
    await database.query(await readFile(new URL('../../mvp-drizzle/0003_agent_attempt_lifecycle_index.sql',import.meta.url),'utf8'));
  });
  afterAll(async()=>{
    await database?.end();
    try{await admin?.query(`drop database if exists ${name}`);}finally{await admin?.end();}
  });
  it('executes real scope/dedup/update/parent SQL for Telegram tasks without submit receipts',async()=>{
    const db=database!;const workspaceId=randomUUID(),projectId=randomUUID(),otherProject=randomUUID(),actorId=randomUUID(),secret=randomUUID();
    const repositoryUrl='https://github.com/VF78/fai-control-plane';
    await db.query('insert into workspaces(id,slug,name) values($1,$2,$2)',[workspaceId,'usage-smoke']);
    await db.query("insert into actors(id,workspace_id,kind,display_name) values($1,$2,'human','Smoke owner')",[actorId,workspaceId]);
    for(const [id,slug] of [[projectId,'one'],[otherProject,'two']]){
      await db.query('insert into projects(id,workspace_id,slug,name,repository_url) values($1,$2,$3,$3,$4)',[id,workspaceId,slug,repositoryUrl]);
    }
    await db.query("insert into project_memberships(project_id,actor_id,role) values($1,$2,'project_owner')",[projectId,actorId]);
    await db.query("insert into secret_refs(id,workspace_id,purpose,locator) values($1,$2,'test-only','/test-only/not-resolved')",[secret,workspaceId]);
    for(const [id,item] of [[projectId,'telegram-task'],[otherProject,'other-task']]){
      const binding=randomUUID();
      await db.query(`insert into tracker_bindings(id,project_id,secret_ref_id,provider,external_project_id,project_url,repository_id,repository_url)
        values($1,$2,$3,'github','1','https://github.com/users/VF78/projects/1','repo',$4)`,[binding,id,secret,repositoryUrl]);
      await db.query(`insert into tracker_snapshots(binding_id,external_version,source_url,facts,observed_at)
        values($1,'v1',$2,$3,now())`,[binding,repositoryUrl,JSON.stringify({items:[{itemId:item,url:`${repositoryUrl}/issues/355`}]})]);
    }
    const scope={workspaceId,projectId};
    const value:ExecutionUsage={provider:'codex-cli',sessionReference:'session',parentSessionReference:null,itemId:'telegram-task',
      contexts:[{model:'gpt-6-astra',effort:'medium'}],totals:{input:100,cachedInput:80,output:20,reasoningOutput:5,total:120},
      completeness:'incomplete',reasons:[],aggregation:'unknown',provenance:'native-session-metadata'};
    expect((await db.query("select count(*)::int n from command_receipts where command_type='agent.submit'")).rows[0].n).toBe(0);
    expect(await listExecutionUsageTasks(db,{...scope,repositoryUrl})).toEqual([{itemId:'telegram-task',url:`${repositoryUrl}/issues/355`}]);
    expect(await recordExecutionUsage(db,scope,value)).toBe('recorded');
    expect(await recordExecutionUsage(db,scope,value)).toBe('duplicate');
    const grown={...value,totals:{input:200,cachedInput:160,output:40,reasoningOutput:10,total:240}};
    expect(await recordExecutionUsage(db,scope,grown)).toBe('recorded');
    await Promise.all([recordExecutionUsage(db,scope,value),recordExecutionUsage(db,scope,grown)]);
    expect((await readExecutionUsage(db,actorId,projectId)).sessions[0]?.totals).toEqual(grown.totals);
    expect(await recordExecutionUsage(db,scope,{...value,sessionReference:'child',parentSessionReference:'session'})).toBe('recorded');
    expect(await recordExecutionUsage(db,scope,{...value,sessionReference:'unattributed',itemId:null,
      totals:{input:null,cachedInput:null,output:null,reasoningOutput:null,total:null},completeness:'unknown'})).toBe('recorded');
    const result=await readExecutionUsage(db,actorId,projectId);
    expect(result.sessions).toHaveLength(3);expect(result.combinedTotal).toBe(240);
    expect(result.sessions.find(s=>s.sessionReference==='child')?.parentSessionReference).toBe('session');
    expect(await recordExecutionUsage(db,{workspaceId,projectId:otherProject},{...value,itemId:'other-task'})).toBe('recorded');
    expect((await readExecutionUsage(db,actorId,otherProject)).sessions).toEqual([]);
    expect(await recordExecutionUsage(db,scope,{...value,itemId:'other-task'})).toBe('denied');
    expect(await recordExecutionUsage(db,{...scope,workspaceId:randomUUID()},value)).toBe('denied');
    // Real lock contention must time out as optional/unavailable, not hang the worker.
    const blocker=await db.connect();await blocker.query('begin');
    await blocker.query('lock table audit_events in access exclusive mode');
    try{expect(await recordExecutionUsage(db,scope,grown)).toBe('unavailable');}
    finally{await blocker.query('rollback');blocker.release();}
    const count=await db.query("select count(*)::int n from information_schema.tables where table_schema='public'");
    expect(count.rows[0].n).toBe(16);
  });
});
