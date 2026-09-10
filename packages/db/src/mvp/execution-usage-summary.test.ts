import {describe,it,expect} from 'vitest';
import {summarizeExecutionUsage,type ExecutionUsage} from './execution-usage.ts';

const sample=(sessionReference:string,total:number|null,itemId:string|null='task',parentSessionReference:string|null=null):ExecutionUsage=>({provider:'executor',sessionReference,parentSessionReference,itemId,contexts:[],totals:{input:null,output:null,cachedInput:null,reasoningOutput:null,total},completeness:'incomplete',reasons:[],aggregation:'unknown',provenance:'native-session-metadata'});
describe('observed token lower bounds',()=>{
  it('counts latest cumulative observations once and adds Dev, QA and failed/rework sessions',()=>{
    expect(summarizeExecutionUsage([sample('dev',100),sample('dev',150),sample('qa',70),sample('failed',30),sample('rework',50)])).toEqual({combinedTotal:300,taskTotals:{task:300}});
  });
  it('does not add overlapping parent, children or siblings with an absent parent',()=>{
    expect(summarizeExecutionUsage([sample('parent',100),sample('child',80,'task','parent'),sample('child2',150,'task','parent')])).toEqual({combinedTotal:150,taskTotals:{task:150}});
    expect(summarizeExecutionUsage([sample('child',80,'task','absent'),sample('child2',150,'task','absent')]).combinedTotal).toBe(150);
  });
  it('keeps unassigned and ambiguously attributed family usage only in the project total',()=>{
    expect(summarizeExecutionUsage([sample('dev',100),sample('overhead',25,null),sample('p',90,'a'),sample('c',70,'b','p')])).toEqual({combinedTotal:215,taskTotals:{task:100}});
  });
  it('distinguishes zero, unknown and overflow without deriving totals from cached subsets',()=>{
    expect(summarizeExecutionUsage([]).combinedTotal).toBeNull();
    expect(summarizeExecutionUsage([sample('unknown',null)]).combinedTotal).toBeNull();
    expect(summarizeExecutionUsage([sample('zero',0)])).toEqual({combinedTotal:0,taskTotals:{task:0}});
    expect(summarizeExecutionUsage([sample('a',Number.MAX_SAFE_INTEGER),sample('b',1)])).toEqual({combinedTotal:null,taskTotals:{task:null}});
  });
  it('separates providers, handles cycles, and excludes identity conflicts',()=>{
    expect(summarizeExecutionUsage([sample('a',10),{...sample('a',20),provider:'other'}]).combinedTotal).toBe(30);
    expect(summarizeExecutionUsage([sample('a',10,'task','b'),sample('b',20,'task','a')]).combinedTotal).toBe(20);
    expect(summarizeExecutionUsage([sample('a',10),sample('a',20,'other')]).combinedTotal).toBeNull();
  });
  it('bounds unknown parent overlap at provider level and avoids speculative task attribution',()=>{
    expect(summarizeExecutionUsage([sample('a',10),{...sample('b',20),reasons:['parent-identity-unknown']}])).toEqual({combinedTotal:20,taskTotals:{task:10}});
  });
});
