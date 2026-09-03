import {describe,expect,it,vi} from 'vitest';
import type {Database} from '@fai-control-plane/db';
import {projectOnboardingCommand,stageProjectDocuments,startBootstrap} from './project-onboarding-command.ts';

const database={} as Database;
describe('worker-owned project onboarding commands',()=>{
  it('uses the native Hermes JSON contract when replacing staged context files',async()=>{
    const request=vi.fn(async()=>new Response('{"ok":true}',{headers:{'content-type':'application/json'}}));
    await stageProjectDocuments({request},database,{actorId:'actor',projectId:'project',workDirectory:'/opt/data/work/project',
      documents:[]});
    expect(request).toHaveBeenNthCalledWith(1,'/api/files',{method:'DELETE',headers:{'content-type':'application/json'},
      body:JSON.stringify({path:'/opt/data/work/project/.fai-context/source',recursive:true})});
    expect(request).toHaveBeenNthCalledWith(2,'/api/files/mkdir',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({path:'/opt/data/work/project/.fai-context/source'})});
  });
  it('rejects unauthenticated context setup before reading project state',async()=>{
    const response=await projectOnboardingCommand(database,new Request('http://worker/project-agent-profile/project',{
      method:'POST',headers:{'content-type':'application/json'},body:'{}'}),'00000000-0000-4000-8000-000000000001','agent-profile');
    expect(response.status).toBe(401);await expect(response.json()).resolves.toEqual({error:'authentication_required'});
  });
  it('exposes no read endpoint for runtime mutations',async()=>{
    const response=await projectOnboardingCommand(database,new Request('http://worker/project-tracker-preparation/project'),
      '00000000-0000-4000-8000-000000000001','tracker-preparation');
    expect(response.status).toBe(405);
  });
  it('uses a fresh bounded session for each actual context synthesis attempt',async()=>{
    const fetchMock=vi.fn<(input:URL|string,init?:RequestInit)=>Promise<Response>>(async()=>new Response(JSON.stringify({run_id:'run_started',status:'started'}),{status:202,
      headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetchMock);
    const base={endpoint:'http://agent.test/v1/runs',token:'token',slug:'project',repositoryUrl:'https://example.test/repo',
      projectUrl:'https://example.test/tracker',workDirectory:'/work',fingerprint:'a'.repeat(64),architecturePresent:true,
      paths:['/work/source.md'],reason:'manual'} as const;
    try{
      await startBootstrap({...base,attemptReference:'correlation:first'});
      await startBootstrap({...base,attemptReference:'correlation:second'});
    }finally{vi.unstubAllGlobals();}
    const bodies=fetchMock.mock.calls.map((call)=>JSON.parse(String(call[1]?.body)) as {session_id:string;input:string});
    expect(bodies[0]?.session_id).not.toBe(bodies[1]?.session_id);
    expect(bodies.every(({session_id})=>/^project-context-project-[a-f0-9-]+$/.test(session_id))).toBe(true);
    expect(JSON.parse(bodies[0]!.input)).toMatchObject({tracker:'https://example.test/tracker'});
  });
});
