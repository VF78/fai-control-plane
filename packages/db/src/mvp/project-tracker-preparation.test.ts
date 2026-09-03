import {describe,expect,it,vi} from 'vitest';
import {defaultProjectProcessPolicy} from '@fai-control-plane/domain';
import {parseProjectTrackerPreparationResult,projectTrackerPreparationAssignment,
  listProjectTrackerPreparationAttempts,recordProjectTrackerPreparationResult,recordProjectTrackerPreparationStart,
  type Database} from './index.ts';

describe('persisted project tracker preparation',()=>{
  it('accepts only the bounded terminal Hermes contract',()=>{
    expect(parseProjectTrackerPreparationResult(JSON.stringify({contract:'fai.project-tracker-preparation-result.v1',
      status:'approval_required',remainingDelta:['remove foreign item #1'],approvalText:'Удалить foreign item #1?'})))
      .toEqual({status:'approval_required',remainingDelta:['remove foreign item #1'],approvalText:'Удалить foreign item #1?'});
    expect(parseProjectTrackerPreparationResult(JSON.stringify({contract:'fai.project-tracker-preparation-result.v1',
      status:'completed',remainingDelta:['same','same']}))).toBeNull();
  });

  it('gives Hermes the exact confirmed process and keeps Control Plane read-only',()=>{
    const assignment=projectTrackerPreparationAssignment({repositoryUrl:'https://github.com/VF78/control',
      projectUrl:'https://github.com/users/VF78/projects/1',process:defaultProjectProcessPolicy,remainingDelta:['Owner: Hermes']});
    expect(JSON.parse(assignment.input)).toMatchObject({confirmedProcess:defaultProjectProcessPolicy,
      requiredFields:{Owner:['Hermes'],Blocked:['No','Yes']},remainingDelta:['Owner: Hermes']});
    expect(assignment.instructions).toContain('using gh directly');
    expect(assignment.instructions).toContain('Control Plane will only verify readback');
  });

  it('persists the project-scoped run reference and isolates the idempotency key',async()=>{
    const queries:{sql:string;parameters?:readonly unknown[]}[]=[];const query=vi.fn(async(sql:string,parameters?:readonly unknown[])=>{
      queries.push({sql,...(parameters===undefined?{}:{parameters})});if(sql.includes("command_type='project.tracker-prepare.start'"))return {rowCount:0,rows:[]};
      if(sql.includes('from project_memberships'))return {rowCount:1,rows:[{}]};return {rowCount:1,rows:[]};});
    const database={connect:vi.fn(async()=>({query,release:vi.fn()}))} as unknown as Database;
    const view=await recordProjectTrackerPreparationStart(database,{workspaceId:'workspace',
      projectId:'00000000-0000-4000-8000-000000000001',actorId:'actor',processVersion:'a'.repeat(64),
      remainingDelta:['Owner: Hermes'],idempotencyKey:'prepare:project-one',occurredAt:'2026-08-30T00:00:00.000Z'},
    async()=>'run_project_one');
    expect(view).toMatchObject({status:'configuring',runId:'run_project_one',remainingDelta:['Owner: Hermes']});
    expect(queries.some(({sql,parameters})=>sql.includes("'project.tracker-prepare.start'")&&
      parameters?.includes('run_project_one'))).toBe(true);
  });

  it('persists a UUID approval id while keeping the artifact sha as its exact target',async()=>{
    const queries:{sql:string;parameters?:readonly unknown[]}[]=[];const query=vi.fn(async(sql:string,parameters?:readonly unknown[])=>{
      queries.push({sql,...(parameters===undefined?{}:{parameters})});if(sql.includes('select 1 from command_receipts'))return {rowCount:0,rows:[]};return {rowCount:1,rows:[]};});
    const database={connect:vi.fn(async()=>({query,release:vi.fn()}))} as unknown as Database;
    const attempt={workspaceId:'workspace',projectId:'00000000-0000-4000-8000-000000000001',actorId:'actor',runId:'run_one',
      correlationId:'prepare:one',processVersion:'a'.repeat(64),remainingDelta:['remove foreign item']};
    const view=await recordProjectTrackerPreparationResult(database,attempt,JSON.stringify({
      contract:'fai.project-tracker-preparation-result.v1',status:'approval_required',remainingDelta:['remove foreign item'],
      approvalText:'Удалить foreign item?'}));
    expect(view.approval?.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(view.approval?.version).toMatch(/^[a-f0-9]{64}$/);
    expect(view.approval?.id).not.toBe(view.approval?.version);
    expect(view.runId).toBe('run_one');
    expect(queries.some(({parameters})=>parameters?.includes('project_tracker_preparation_approval_v1')&&
      parameters.includes(view.approval?.version))).toBe(true);
  });

  it('keeps a completed run observable while tracker readback is being verified',async()=>{
    const content=JSON.stringify({contract:'fai.project-tracker-preparation.v1',status:'verifying',runId:'run_one',
      processVersion:'a'.repeat(64),remainingDelta:[]});
    const database={query:vi.fn(async()=>({rows:[{projectId:'00000000-0000-4000-8000-000000000001',actorId:'actor',
      content,correlationId:'prepare:one'}]}))} as unknown as Database;
    await expect(listProjectTrackerPreparationAttempts(database,'workspace')).resolves.toEqual([{workspaceId:'workspace',
      projectId:'00000000-0000-4000-8000-000000000001',actorId:'actor',runId:'run_one',correlationId:'prepare:one',
      processVersion:'a'.repeat(64),remainingDelta:[]}]);
  });

  it('repairs an old configuring state whose result receipt already exists',async()=>{
    const current=JSON.stringify({contract:'fai.project-tracker-preparation.v1',status:'configuring',runId:'run_one',
      processVersion:'a'.repeat(64),remainingDelta:[]});const queries:string[]=[];
    const query=vi.fn(async(sql:string)=>{queries.push(sql);if(sql.includes('select 1 from command_receipts'))return {rowCount:1,rows:[{}]};
      if(sql.includes('select content_text as content'))return {rowCount:1,rows:[{content:current}]};return {rowCount:1,rows:[]};});
    const database={connect:vi.fn(async()=>({query,release:vi.fn()}))} as unknown as Database;
    const view=await recordProjectTrackerPreparationResult(database,{workspaceId:'workspace',
      projectId:'00000000-0000-4000-8000-000000000001',actorId:'actor',runId:'run_one',correlationId:'prepare:one',
      processVersion:'a'.repeat(64),remainingDelta:[]},JSON.stringify({contract:'fai.project-tracker-preparation-result.v1',
      status:'completed',remainingDelta:[]}));
    expect(view).toMatchObject({status:'verifying',runId:'run_one'});
    expect(queries.some((sql)=>sql.includes("'Project tracker preparation'"))).toBe(true);
    expect(queries).toContain('commit');
  });
});
