import {describe, expect, it} from 'vitest';
import {parseProjectProcessPolicy} from './project-process.ts';

describe('project process policy', () => {
  it('accepts a provider-neutral linked process', () => {
    expect(parseProjectProcessPolicy({contract:'fai.project-process.v1',stages:[
      {id:'ready',title:'Ready',responsibility:'Contributor',gate:'Explicit assignment',evidence:'Tracker fact',nextStageId:'done'},
      {id:'done',title:'Done',responsibility:'Owner',gate:'Acceptance',evidence:'Approval',nextStageId:null}
    ]})).not.toBeNull();
  });

  it('rejects duplicate and dangling stage identifiers', () => {
    const stage = {id:'ready',title:'Ready',responsibility:'Contributor',gate:'Gate',evidence:'Evidence',nextStageId:'missing'};
    expect(parseProjectProcessPolicy({contract:'fai.project-process.v1',stages:[stage]})).toBeNull();
    expect(parseProjectProcessPolicy({contract:'fai.project-process.v1',stages:[{...stage,nextStageId:null},{...stage,nextStageId:null}]})).toBeNull();
  });

  it('parses bounded per-stage agent continuation settings', () => {
    const policy = parseProjectProcessPolicy({contract:'fai.project-process.v1',stages:[
      {id:'qa',title:'Review',responsibility:'Agent',gate:'Automatic',evidence:'Checks',nextStageId:null,
        automation:{agentRole:'qa',afterRoles:['developer'],maxStarts:2}}
    ]});
    expect(policy?.stages[0]?.automation).toEqual({agentRole:'qa',afterRoles:['developer'],maxStarts:2,reworkStageId:null});
    expect(parseProjectProcessPolicy({contract:'fai.project-process.v1',stages:[
      {id:'qa',title:'Review',responsibility:'Agent',gate:'Automatic',evidence:'Checks',nextStageId:null,
        automation:{agentRole:'qa',afterRoles:['developer'],maxStarts:0}}
    ]})).toBeNull();
  });

  it('accepts a human-gated DevOps stage without making it an automatic chain step', () => {
    const policy = parseProjectProcessPolicy({contract:'fai.project-process.v1',stages:[
      {id:'acceptance',title:'Acceptance',responsibility:'Owner',gate:'Production approval',evidence:'QA',nextStageId:'done',
        automation:{agentRole:'devops',afterRoles:['qa'],maxStarts:1,reworkStageId:null}},
      {id:'done',title:'Done',responsibility:'Owner',gate:'Done',evidence:'Production',nextStageId:null}
    ]});
    expect(policy?.stages[0]?.automation?.agentRole).toBe('devops');
  });

});
