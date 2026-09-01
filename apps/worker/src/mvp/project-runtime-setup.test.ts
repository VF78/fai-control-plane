import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectGithubCredential} from './project-runtime-setup.ts';

const previous=process.env.GITHUB_PROJECTS_TOKEN_FILE;
afterEach(()=>{
  if(previous===undefined)delete process.env.GITHUB_PROJECTS_TOKEN_FILE;
  else process.env.GITHUB_PROJECTS_TOKEN_FILE=previous;
});

describe('project runtime GitHub credential',()=>{
  it('reads the existing host-owned credential through its configured secret path',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'fai-project-credential-'));
    const path=join(directory,'github-projects-token');
    await writeFile(path,`${'x'.repeat(40)}\n`);process.env.GITHUB_PROJECTS_TOKEN_FILE=path;
    await expect(projectGithubCredential()).resolves.toBe('x'.repeat(40));
    await rm(directory,{recursive:true});
  });

  it('fails closed when the configured secret path is unavailable',async()=>{
    delete process.env.GITHUB_PROJECTS_TOKEN_FILE;
    await expect(projectGithubCredential()).rejects.toThrow('project_runtime_unavailable');
  });
});
