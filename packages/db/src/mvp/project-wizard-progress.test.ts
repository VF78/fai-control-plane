import {describe,expect,it,vi} from 'vitest';
import {readProjectWizardProgress,recordProjectWizardDecision,type Database} from './index.ts';

describe('persisted project wizard progress',()=>{
  it('derives confirmations and skips only from canonical receipts',async()=>{const query=vi.fn(async()=>({rows:[
    {commandType:'project.wizard.process-confirm'},{commandType:'project.wizard.communications-skip'}]}));
    await expect(readProjectWizardProgress({query} as unknown as Database,'actor','project')).resolves.toEqual({
      processConfirmed:true,teamSkipped:false,communicationsSkipped:true});});
  it('records a project-owner decision in receipts and audit',async()=>{const statements:string[]=[];const query=vi.fn(async(sql:string)=>{
    statements.push(sql);if(sql.includes('from project_memberships'))return {rowCount:1,rows:[{}]};if(sql.includes('select distinct'))
      return {rows:[{commandType:'project.wizard.team-skip'}]};return {rowCount:1,rows:[]};});const database={connect:vi.fn(async()=>({query,
      release:vi.fn()})),query} as unknown as Database;await expect(recordProjectWizardDecision(database,{workspaceId:'workspace',projectId:'project',
        actorId:'actor',decision:'project.wizard.team-skip',idempotencyKey:'skip-team:one',occurredAt:'2026-08-30T00:00:00.000Z'}))
      .resolves.toMatchObject({teamSkipped:true});expect(statements.some((sql)=>sql.includes('insert into command_receipts'))).toBe(true);
    expect(statements.some((sql)=>sql.includes('$2::uuid::text'))).toBe(true);});
  it('activates the canonical process before confirming the wizard step',async()=>{const statements:string[]=[];const query=vi.fn(async(sql:string)=>{
    statements.push(sql);if(sql.includes('from project_memberships m join projects p'))return {rows:[{workspaceId:'workspace'}]};
    if(sql.includes("kind='project_process_policy_v1' and sha256"))return {rows:[{id:'policy-id'}]};
    if(sql.includes('from project_memberships'))return {rowCount:1,rows:[{}]};if(sql.includes('select distinct'))return {rows:[
      {commandType:'project.wizard.process-confirm'}]};return {rowCount:1,rows:[]};});const database={connect:vi.fn(async()=>({query,
      release:vi.fn()})),query} as unknown as Database;await expect(recordProjectWizardDecision(database,{workspaceId:'workspace',projectId:
        '00000000-0000-4000-8000-000000000001',actorId:'actor',decision:'project.wizard.process-confirm',
        idempotencyKey:'confirm-process:one',occurredAt:'2026-08-30T00:00:00.000Z'})).resolves.toMatchObject({processConfirmed:true});
    const activation=statements.findIndex((sql)=>sql.includes("'project.process.configure'"));
    expect(activation).toBeGreaterThan(-1);
    expect(statements.findIndex((sql,index)=>index>activation&&sql==='begin')).toBeGreaterThan(activation);});
});
