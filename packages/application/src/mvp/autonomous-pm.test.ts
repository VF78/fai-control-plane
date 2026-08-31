import {describe,expect,it} from 'vitest';
import {autonomousPmEnabled,autonomousPmKey,sameAutonomousActivation,verifyAutonomousPmSelection} from './autonomous-pm.ts';

const process={contract:'fai.project-process.v1' as const,stages:[{id:'dev',title:'In Dev',responsibility:'Agent',
  gate:'Automated',evidence:'PR',nextStageId:'qa',automation:{agentRole:'developer' as const,afterRoles:['qa' as const],
    maxStarts:2,reworkStageId:null}},{id:'qa',title:'QA',responsibility:'Agent',gate:'Automated',evidence:'Checks',
  nextStageId:null,automation:{agentRole:'qa' as const,afterRoles:['developer' as const],maxStarts:2,reworkStageId:'dev'}}]};
const item={itemId:'item',projectId:'project',issueId:'42',title:'Task',url:'https://example.test/issues/42',version:'v2',
  statusOptionId:'dev',statusOptionName:'In Dev',ownerOptionId:'hermes',blocked:false,targetDate:null,parentIssueId:null,
  subIssueIds:[],dependencyIssueIds:[],assigneeIds:[],assignees:[],observedAt:'2026-08-31T10:00:00.000Z'};
const snapshot={bindingId:'binding',externalVersion:'snapshot',cursor:null,observedAt:item.observedAt,
  sourceUrl:'https://example.test/project',items:[item]};
const result={contract:'fai.autonomous-pm-result.v1' as const,outcome:'selected' as const,reason:'ready',
  selection:{itemId:'item',issueUrl:item.url,observedVersion:'v2'}};

describe('autonomous PM selection verification',()=>{
  it('is disabled in manual mode and requires the authenticated mode actor',()=>{
    expect(autonomousPmEnabled({mode:'manual',actorId:'actor',changedAt:item.observedAt})).toBe(false);
    expect(autonomousPmEnabled({mode:'autonomous',actorId:null,changedAt:item.observedAt})).toBe(false);
    expect(autonomousPmEnabled({mode:'autonomous',actorId:'actor',changedAt:item.observedAt})).toBe(true);
    expect(sameAutonomousActivation({mode:'autonomous',actorId:'actor',changedAt:item.observedAt},
      {actorId:'actor',modeChangedAt:item.observedAt})).toBe(true);
    expect(sameAutonomousActivation({mode:'manual',actorId:'actor',changedAt:'2026-08-31T10:01:00.000Z'},
      {actorId:'actor',modeChangedAt:item.observedAt})).toBe(false);
    expect(sameAutonomousActivation({mode:'autonomous',actorId:'other',changedAt:item.observedAt},
      {actorId:'actor',modeChangedAt:item.observedAt})).toBe(false);
  });
  it('derives one deterministic reconciliation identity per mode and policy versions',()=>{
    const input={projectId:'project',modeChangedAt:item.observedAt,processVersion:'a'.repeat(64),
      routingVersion:'b'.repeat(64),snapshotVersion:`mode:${item.observedAt}`};
    expect(autonomousPmKey(input)).toBe(autonomousPmKey(input));
  });
  it('accepts only the exact selected eligible automated item',()=>{
    const input={result,snapshot,projectId:'project',bindingId:'binding',ownerOptionId:'hermes',
      doneStatusOptionId:'done',process};
    expect(verifyAutonomousPmSelection(input)).toEqual({itemId:'item',role:'developer'});
    for(const malicious of [{...result,selection:{...result.selection,itemId:'other'}},
      {...result,selection:{...result.selection,issueUrl:'https://evil.test/issues/1'}},
      {...result,selection:{...result.selection,observedVersion:'stale'}}])
      expect(verifyAutonomousPmSelection({...input,result:malicious})).toBeNull();
    expect(verifyAutonomousPmSelection({...input,snapshot:{...snapshot,items:[{...item,blocked:true}]}})).toBeNull();
    expect(verifyAutonomousPmSelection({...input,snapshot:{...snapshot,items:[{...item,ownerOptionId:'other'}]}})).toBeNull();
  });
});
