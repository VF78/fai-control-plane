import {describe,expect,it} from 'vitest';
import {parseNativeUsage} from './native-execution-usage.ts';

const event = (type:string,payload:unknown) => JSON.stringify({timestamp:'2026-09-08T13:00:00Z',type,payload});
const context = (model='gpt-6-astra',effort='medium') => event('turn_context',{model,effort});
const usage = (input=100,cached=80,output=20,reasoning=5) => event('event_msg',{
  type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,
    output_tokens:output,reasoning_output_tokens:reasoning,total_tokens:input+output}}});
const session = (id='session-1',parent?:string) => event('session_meta',{id,
  ...(parent === undefined ? {} : {source:{subagent:{thread_spawn:{parent_thread_id:parent}}}})});
const fixture = [session(),context(),usage()];
const expected = {input:100,cachedInput:80,output:20,reasoningOutput:5,total:120};

describe('standalone native execution usage metadata',()=>{
  it('keeps one cumulative sample on repeat ingestion and repeated native events',async()=>{
    const first = await parseNativeUsage(fixture);
    expect(await parseNativeUsage(fixture)).toEqual(first);
    expect(await parseNativeUsage([...fixture,...fixture])).toEqual(first);
    expect(first.totals).toEqual(expected);
    expect(first.completeness).toBe('incomplete');
    expect(first.reasons).toEqual(['session-coverage-unknown']);
  });
  it('replaces increasing cumulative samples; cached/reasoning counters remain subsets',async()=>{
    const result = await parseNativeUsage([...fixture,usage(200,160,40,10)]);
    expect(result.totals).toEqual({input:200,cachedInput:160,output:40,reasoningOutput:10,total:240});
    expect(result.totals.total).not.toBe(360);
    expect(result.totals.total).not.toBe(410);
  });
  it('retains model changes without allocating a cumulative sample to any model',async()=>{
    const result = await parseNativeUsage([...fixture,context('gpt-5.6-terra','high'),usage(200,160,40,10),context()]);
    expect(result.contexts).toEqual([{model:'gpt-6-astra',effort:'medium'},{model:'gpt-5.6-terra',effort:'high'}]);
    expect(result.latestContext).toEqual({model:'gpt-6-astra',effort:'medium'});
    expect(result.totals.total).toBe(240);
  });
  it('preserves optional parent identity without aggregating parent and child samples',async()=>{
    const parent = await parseNativeUsage([session('parent'),context(),usage(500,100,50,10)]);
    const child = await parseNativeUsage([session('child','parent'),context(),usage()]);
    expect(parent.sessionReference).toBe('parent');
    expect(child).toMatchObject({sessionReference:'child',parentSessionReference:'parent',totals:expected});
    expect(parent.totals.total).toBe(550);
    expect(await parseNativeUsage([context(),usage()])).toMatchObject({sessionReference:null,parentSessionReference:null,totals:expected});
  });
  it('marks conflicting concatenated session identity unknown instead of merging counters',async()=>{
    const result = await parseNativeUsage([...fixture,session('other'),usage(200,160,40,10)]);
    expect(result).toMatchObject({sessionReference:null,parentSessionReference:null,completeness:'unknown'});
    expect(Object.values(result.totals)).toEqual([null,null,null,null,null]);
    expect(result.reasons).toContain('identity-conflict');
  });
  it.each([{lines:[]},{lines:[context()]},{lines:[event('event_msg',{type:'token_count',info:null})]}])('reports missing usage as unknown: %j',async ({lines})=>{
    const result = await parseNativeUsage(lines);
    expect(result.completeness).toBe('unknown');
    expect(Object.values(result.totals).every(v=>v===null)).toBe(true);
    expect(result.reasons).toContain('usage-missing');
  });
  it('keeps partial known fields, leaving absent fields null rather than zero',async()=>{
    const result = await parseNativeUsage([context(),event('event_msg',{type:'token_count',
      info:{total_token_usage:{input_tokens:100}}})]);
    expect(result.totals).toEqual({input:100,cachedInput:null,output:null,reasoningOutput:null,total:null});
    expect(result.reasons).toContain('usage-partial');
    expect(result.completeness).toBe('incomplete');
  });
  it('does not splice partial samples or replace a valid sample with a partial tail',async()=>{
    const partial = event('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:200}}});
    const result = await parseNativeUsage([...fixture,partial]);
    expect(result.totals).toEqual(expected);
    expect(result.reasons).toContain('usage-partial');
    const recovered = await parseNativeUsage([context(),partial,usage(300,200,50,10)]);
    expect(recovered.totals.total).toBe(350);
  });
  it('rejects decreasing cumulative counters even if the total increases',async()=>{
    const result = await parseNativeUsage([...fixture,usage(200,70,40,10),usage(50,40,10,2)]);
    expect(result.totals).toEqual(expected);
    expect(result.reasons).toContain('usage-decreased');
    expect((await parseNativeUsage([...fixture,usage(50,40,10,2),usage(200,160,40,10)])).totals.total).toBe(240);
  });
  it.each([
    {input_tokens:-1}, {input_tokens:'100'}, {input_tokens:1.5}, {input_tokens:Number.MAX_SAFE_INTEGER+1},
    {input_tokens:100,cached_input_tokens:101}, {output_tokens:20,reasoning_output_tokens:21},
    {input_tokens:100,output_tokens:20,total_tokens:999}
  ])('rejects invalid numeric/subset/total metadata: %j',async bad=>{
    const result = await parseNativeUsage([...fixture,event('event_msg',{type:'token_count',info:{total_token_usage:bad}})]);
    expect(result.totals).toEqual(expected);
    expect(result.reasons).toContain('usage-invalid');
  });
  it('marks malformed and truncated events without throwing or losing the valid sample',async()=>{
    const result = await parseNativeUsage([...fixture,'{broken',
      '{"type":"event_msg","payload":{"type":"token_count","info":',
      '{"type":"turn_context","payload":']);
    expect(result.totals).toEqual(expected);
    expect(result.reasons).toEqual(expect.arrayContaining(['malformed-envelope','malformed-event']));
  });
  it('never retains prompt, tool, credential, account/quota or arbitrary payload fields',async()=>{
    const marker = 'DO_NOT_RETAIN_FIXTURE_CONTENT';
    const result = await parseNativeUsage([
      event('session_meta',{id:'session-1',cwd:marker,instructions:marker,credentials:marker}),
      event('turn_context',{model:'gpt-6-astra',effort:'medium',developer_instructions:marker,prompt:marker}),
      event('response_item',{type:'function_call_output',output:marker}),
      event('event_msg',{type:'agent_message',message:marker}),
      event('event_msg',{type:'token_count',message:marker,rate_limits:{secret:marker},info:{
        total_token_usage:{input_tokens:100,cached_input_tokens:80,output_tokens:20,reasoning_output_tokens:5,total_tokens:120,secret:marker},
        last_token_usage:{input_tokens:999999},arbitrary:marker}})
    ]);
    expect(result.totals).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(Object.keys(result).sort()).toEqual(['completeness','contexts','latestContext','parentSessionReference','reasons','sessionReference','totals']);
  });
  it('reports unavailable sources and retains the last known metadata',async()=>{
    async function* interrupted(){yield* fixture;throw new Error('DO_NOT_RETAIN_FIXTURE_CONTENT');}
    const result = await parseNativeUsage(interrupted());
    expect(result.totals).toEqual(expected);
    expect(result.reasons).toContain('source-unavailable');
    expect(JSON.stringify(result)).not.toContain('DO_NOT_RETAIN');
  });
  it('accepts observed zero counters while keeping absent counters unknown',async()=>{
    expect((await parseNativeUsage([context(),usage(0,0,0,0)])).totals.total).toBe(0);
    expect((await parseNativeUsage([])).totals.total).toBeNull();
  });
  it('bounds context retention and reports missing context/parent metadata',async()=>{
    const result = await parseNativeUsage([session(),...Array.from({length:35},(_,i)=>context(`model-${i}`)),usage()]);
    expect(result.contexts).toHaveLength(32);
    expect(result.reasons).toContain('contexts-truncated');
    expect(result.latestContext?.model).toBe('model-34');
    expect((await parseNativeUsage([usage()])).reasons).toContain('context-missing');
    expect((await parseNativeUsage([event('session_meta',{id:'child',source:{subagent:{}}})])).reasons).toContain('parent-identity-unknown');
    expect((await parseNativeUsage([event('turn_context',{model:'model'})])).reasons).toContain('context-partial');
  });
});
