import {describe,expect,it,vi} from 'vitest';
import type {Database} from './runtime.ts';
import {completeProjectContextBootstrap,listProjectContextBootstrapAttempts,
  promoteApprovedProjectArchitectures,type ProjectContextBootstrapAttempt} from './project-context-bootstrap.ts';

const attempt:ProjectContextBootstrapAttempt={workspaceId:'workspace',projectId:'project',actorId:'actor',
  profile:'project-control',endpointPath:'/v1/runs',deliveryReference:'run_context_1',
  documentFingerprint:'a'.repeat(64),architecturePresent:false,
  correlationId:'project-context:project:project-control:fingerprint'};

describe('project context bootstrap persistence',()=>{
  it('isolates a corrupt configuring artifact instead of crashing worker polling',async()=>{
    const database={query:vi.fn(async()=>({rows:[{workspaceId:'workspace',projectId:'project',actorId:'actor',
      content:'{',correlationId:'key'}]}))} as unknown as Database;
    await expect(listProjectContextBootstrapAttempts(database,'workspace')).resolves.toEqual([]);
  });

  it('accepts a bounded fenced result and persists the exact architecture gate with existing primitives',async()=>{
    const queries:{sql:string;parameters?:readonly unknown[]}[]=[];
    const query=vi.fn(async(sql:string,parameters?:readonly unknown[])=>{queries.push({sql,
      ...(parameters===undefined?{}:{parameters})});
      if(sql.includes('select 1 from command_receipts'))return {rowCount:0,rows:[]};
      return {rowCount:1,rows:[]};});
    const database={connect:vi.fn(async()=>({query,release:vi.fn()}))} as unknown as Database;
    const output='```json\n'+JSON.stringify({contract:'fai.project-context-result.v1',context:'Compact facts',
      architectureProposal:'Exact proposal',sources:{documents:true,repository:true,githubProject:true}})+'\n```';
    await expect(completeProjectContextBootstrap(database,attempt,output)).resolves.toMatchObject({
      status:'awaiting_architecture',documentFingerprint:attempt.documentFingerprint});
    expect(queries.some(({sql,parameters})=>sql.includes("'Compact project context'")&&
      parameters?.includes(`project_context_compact_v1:${attempt.documentFingerprint}`))).toBe(true);
    expect(queries.some(({sql})=>sql.includes("'project_architecture_proposal_v1'"))).toBe(true);
    expect(queries.some(({sql})=>sql.includes("'project.context-bootstrap.complete'"))).toBe(true);
    const notification=queries.find(({sql})=>sql.includes('insert into outbox_events'))?.parameters?.[2];
    expect(String(notification)).toContain('Требуется точное согласование архитектурного предложения');
    expect(String(notification)).not.toMatch(/[a-f0-9]{64}/);
  });

  it('rejects a context result when Hermes did not read every required authority',async()=>{
    const output=JSON.stringify({contract:'fai.project-context-result.v1',context:'Unverified facts',
      architectureProposal:'Proposal',sources:{documents:true,repository:false,githubProject:false}});
    await expect(completeProjectContextBootstrap({} as Database,attempt,output))
      .rejects.toThrow('project_context_result_invalid');
  });

  it('promotes an exact approved proposal once without rerunning document synthesis',async()=>{
    const proposalSha='b'.repeat(64);let receiptAttempts=0;
    const content=JSON.stringify({contract:'fai.project-agent-profile.v1',status:'awaiting_architecture',
      profile:'project-control',endpointPath:'/v1/runs',documentFingerprint:'a'.repeat(64),
      contextSha:'c'.repeat(64),proposalSha});
    const databaseQuery=vi.fn(async()=>({rows:[{projectId:'project',actorId:'actor',content}]}));
    const clientQuery=vi.fn(async(sql:string)=>{
      if(sql.includes("'project.architecture.approve'")){receiptAttempts+=1;
        return {rowCount:receiptAttempts===1?1:0,rows:receiptAttempts===1?[{id:'receipt'}]:[]};}
      return {rowCount:1,rows:[]};});
    const database={query:databaseQuery,connect:vi.fn(async()=>({query:clientQuery,release:vi.fn()}))} as unknown as Database;
    await expect(promoteApprovedProjectArchitectures(database,'workspace')).resolves.toBe(1);
    await expect(promoteApprovedProjectArchitectures(database,'workspace')).resolves.toBe(0);
    expect(clientQuery.mock.calls.filter(([sql])=>String(sql).includes("'project_agent_profile_v1'"))).toHaveLength(1);
  });
});
