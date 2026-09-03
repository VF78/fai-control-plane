import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Database} from '@fai-control-plane/db';
import {resolveAndRegisterProject} from './project-onboarding.ts';

const original=process.env.GITHUB_PROJECTS_TOKEN_FILE;
afterEach(()=>{vi.restoreAllMocks();if(original===undefined)delete process.env.GITHUB_PROJECTS_TOKEN_FILE;
  else process.env.GITHUB_PROJECTS_TOKEN_FILE=original;});

describe('project registration',()=>{
  it('registers the exact repository and GitHub Project without reading repository documents',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fai-project-registration-'));const token=join(root,'tracker');
    await writeFile(token,'tracker-secret-value-long-enough');process.env.GITHUB_PROJECTS_TOKEN_FILE=token;
    const requests:string[]=[];vi.stubGlobal('fetch',vi.fn(async(value:string|URL|Request)=>{requests.push(String(value));
      return new Response(JSON.stringify({data:{user:{projectV2:{id:'PVT_1'}},
        repository:{id:'R_1',defaultBranchRef:{name:'main'}}}}));}));
    const query=vi.fn(async(sql:string)=>{if(sql.includes("m.role='project_owner'"))return {rowCount:1,rows:[{}]};
      if(sql.includes('from projects p join tracker_bindings'))return {rowCount:0,rows:[]};
      if(sql.includes("purpose='tracker_read'"))return {rowCount:1,rows:[{id:'tracker-secret'}]};
      return {rowCount:1,rows:[]};});const client={query,release:vi.fn()};
    const database={connect:vi.fn(async()=>client)} as unknown as Database;
    await expect(resolveAndRegisterProject(database,{workspaceId:'workspace',actorId:'actor',name:'Control',slug:'control',
      projectUrl:'https://github.com/users/VF78/projects/1',repositoryUrl:'https://github.com/VF78/control',
      idempotencyKey:'register:1'})).resolves.toMatchObject({created:true});
    expect(requests).toEqual(['https://api.github.com/graphql']);await rm(root,{recursive:true});
  });
});
