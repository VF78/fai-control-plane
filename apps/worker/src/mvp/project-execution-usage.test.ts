import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as db from '@fai-control-plane/db';
import * as application from '@fai-control-plane/application';
import * as integrations from '@fai-control-plane/integrations';
import * as projects from './project-runtime.ts';
import {captureProjectExecutionUsage,readProjectUsageSamples,linkedUsageItem} from './project-execution-usage.ts';
import {createWorker} from './runtime.ts';
const database={} as db.Database;
const scope={workspaceId:'workspace',projectId:'project',repositoryUrl:'https://github.com/VF78/fai-control-plane',
  runtime:{runtimeId:'fai-project',workspacePath:'/opt/data/work/fai-project',agentCredentialRef:{locator:'/unused/secrets/agent'}}};
const tasks=[{itemId:'telegram-task',url:`${scope.repositoryUrl}/issues/355`}];
const sample={cwd:'/opt/data/work/fai-project/items/355',usage:{sessionReference:'session',parentSessionReference:'parent',
  contexts:[{model:'gpt-6-astra',effort:'medium'}],latestContext:{model:'gpt-6-astra',effort:'medium'},
  totals:{input:100,cachedInput:80,output:20,reasoningOutput:5,total:120},
  completeness:'incomplete' as const,reasons:['session-coverage-unknown' as const]}};
const ports=()=>({tasks:vi.fn(async()=>tasks),record:vi.fn(async()=> 'recorded' as const),
  samples:async function*(){yield sample;}});
const directories:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await Promise.all(directories.splice(0).map(p=>rm(p,{recursive:true,force:true})));});

describe('existing worker usage integration',()=>{
  it('attributes a Telegram-origin session from exact native cwd and tracker facts without agent.submit',async()=>{
    const p=ports();await captureProjectExecutionUsage(database,scope,p);
    expect(p.record).toHaveBeenCalledWith(database,scope,expect.objectContaining({itemId:'telegram-task',
      sessionReference:'session',parentSessionReference:'parent',totals:sample.usage.totals,aggregation:'unknown'}));
    expect(JSON.stringify(p.record.mock.calls)).not.toContain('agent.submit');
  });
  it('does not guess task identity from a similar cwd, another repository, or ambiguous tracker facts',async()=>{
    expect(linkedUsageItem(`${sample.cwd}/subdir`,scope,tasks)).toBeNull();
    expect(linkedUsageItem(sample.cwd,scope,[{itemId:'other',url:'https://github.com/VF78/other/issues/355'}])).toBeNull();
    expect(linkedUsageItem(sample.cwd,scope,[...tasks,{...tasks[0]!,itemId:'ambiguous'}])).toBeNull();
    const p={...ports(),tasks:vi.fn(async()=>[])};await captureProjectExecutionUsage(database,scope,p);
    expect(p.record).toHaveBeenCalledWith(database,scope,expect.objectContaining({itemId:null,reasons:expect.arrayContaining(['task-unattributed'])}));
  });
  it('falls back to unattributed when tracker linkage is unavailable or becomes stale before write',async()=>{
    const p={...ports(),tasks:vi.fn(async()=>{throw new Error('unavailable');})};
    await expect(captureProjectExecutionUsage(database,scope,p)).resolves.toBeUndefined();
    expect(p.record).toHaveBeenCalledWith(database,scope,expect.objectContaining({itemId:null}));
    const record=vi.fn< typeof db.recordExecutionUsage >().mockResolvedValueOnce('denied').mockResolvedValueOnce('recorded');
    await captureProjectExecutionUsage(database,scope,{...ports(),record});
    expect(record).toHaveBeenNthCalledWith(2,database,scope,expect.objectContaining({itemId:null}));
  });
  it('contains native read and SQL errors without changing normal processing',async()=>{
    const p={...ports(),samples:async function*(){throw new Error('read failed');yield sample;}};
    await expect(captureProjectExecutionUsage(database,scope,p)).resolves.toBeUndefined();expect(p.record).not.toHaveBeenCalled();
    const record=vi.fn(async()=>{throw new Error('SQL failed');});
    await expect(captureProjectExecutionUsage(database,scope,{...ports(),record})).resolves.toBeUndefined();
  });
  it('reads actual fixture files through the accepted parser and retains only metadata',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fai-usage-fixture-'));directories.push(root);
    const sessions=join(root,'codex-home/sessions/2026/09/08');await mkdir(sessions,{recursive:true});
    const line=(type:string,payload:unknown)=>JSON.stringify({type,payload});const marker='UNRETAINED_FIXTURE_CONTENT';
    await writeFile(join(sessions,'rollout-2026-09-08-session.jsonl'),[
      line('session_meta',{id:'session',cwd:sample.cwd,source:{subagent:{thread_spawn:{parent_thread_id:'parent'}}},instructions:marker}),
      line('turn_context',{model:'gpt-6-astra',effort:'medium',prompt:marker}),
      line('response_item',{output:marker}),line('event_msg',{type:'token_count',info:{total_token_usage:{
        input_tokens:100,cached_input_tokens:80,output_tokens:20,reasoning_output_tokens:5,total_tokens:120}}})
    ].join('\n')+'\n');
    await writeFile(join(sessions,'rollout-broken.jsonl'),'{broken');
    await symlink(join(sessions,'rollout-2026-09-08-session.jsonl'),join(sessions,'rollout-link.jsonl'));
    const record=vi.fn(async()=> 'recorded' as const);
    const local={...scope,runtime:{...scope.runtime,agentCredentialRef:{locator:join(root,'secrets/agent')}}};
    await captureProjectExecutionUsage(database,local,{tasks:async()=>tasks,record,samples:readProjectUsageSamples});
    expect(record).toHaveBeenCalledOnce();expect(JSON.stringify(record.mock.calls)).not.toContain(marker);
    expect(record).toHaveBeenCalledWith(database,local,expect.objectContaining({itemId:'telegram-task',totals:sample.usage.totals}));
  });
  it('runs capture from the existing observation tick even with no local attempts and isolates its failure',async()=>{
    vi.stubEnv('FCP_WORKSPACE_ID','workspace');
    for(const name of ['listProjectRuntimeProvisioningRequests','listProjectHermesRuntimeBindings','listProjectContextBootstrapAttempts',
      'listRejectedProjectTrackerPreparations','listApprovedProjectTrackerPreparations','listProjectTrackerPreparationAttempts',
      'listActiveAutonomousPmAttempts'] as const)vi.spyOn(db,name).mockResolvedValue([]);
    vi.spyOn(db,'promoteApprovedProjectArchitectures').mockResolvedValue(undefined as never);
    vi.spyOn(projects,'listWorkerProjectBindings').mockResolvedValue([{...scope,provider:'github',bindingId:'binding',repositoryId:'repo',
      projectUrl:'https://github.com/users/VF78/projects/1',runtime:{...scope.runtime,artifactVersion:'v'}} as never]);
    vi.spyOn(integrations,'createHermesDeliveryAdapter').mockReturnValue({} as never);
    vi.spyOn(integrations,'createGitHubTrackerReadAdapter').mockReturnValue({} as never);
    vi.spyOn(integrations,'createGitHubRepositoryReadAdapter').mockReturnValue({} as never);
    const ordinary=vi.spyOn(application,'reconcileActiveAgentAttempts').mockResolvedValue([]);
    const capture=vi.fn(async()=>{throw new Error('optional usage unavailable');});
    await expect(createWorker(database,capture).observe()).resolves.toBeUndefined();
    expect(ordinary).toHaveBeenCalledOnce();expect(capture).toHaveBeenCalledOnce();
    expect(ordinary.mock.invocationCallOrder[0]).toBeLessThan(capture.mock.invocationCallOrder[0]!);
    expect(capture).toHaveBeenCalledWith(database,{...scope,runtime:{...scope.runtime,artifactVersion:'v'}});
  });
});
