import {afterEach,describe,expect,it} from 'vitest';
import {chmod,mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureProjectRuntimeDirectory,projectGithubCredential} from './project-runtime-setup.ts';

const previous={github:process.env.GITHUB_PROJECTS_TOKEN_FILE,root:process.env.FCP_PROJECT_RUNTIME_HOST_DIR};
afterEach(()=>{
  for(const [name,value] of [['GITHUB_PROJECTS_TOKEN_FILE',previous.github],
    ['FCP_PROJECT_RUNTIME_HOST_DIR',previous.root]] as const){if(value===undefined)delete process.env[name];else process.env[name]=value;}
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

describe('project runtime host layout',()=>{
  const workspaceId='00000000-0000-4000-8000-000000000100';
  const projectId='00000000-0000-4000-8000-000000000001';
  const owner={uid:process.getuid?.()??0,gid:process.getgid?.()??0};

  it('repairs the parent before creating nested project directories',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fai-project-layout-'));const workspace=join(root,workspaceId);
    await mkdir(workspace,{mode:0o700});await chmod(workspace,0o500);process.env.FCP_PROJECT_RUNTIME_HOST_DIR=root;
    try{
      const directory=await ensureProjectRuntimeDirectory(workspaceId,projectId,owner);
      const stats=await Promise.all(['','secrets','data','codex-home'].map((name)=>stat(join(directory,name))));
      expect(stats.every((value)=>value.isDirectory()&&(value.mode&0o777)===0o700&&
        value.uid===owner.uid&&value.gid===owner.gid)).toBe(true);
      const workspaceStat=await stat(workspace);expect(workspaceStat.mode&0o777).toBe(0o700);
      expect({uid:workspaceStat.uid,gid:workspaceStat.gid}).toEqual(owner);
    }finally{await chmod(workspace,0o700);await rm(root,{recursive:true});}
  });

  it('is idempotent and preserves existing project files',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fai-project-layout-'));process.env.FCP_PROJECT_RUNTIME_HOST_DIR=root;
    try{
      const directory=await ensureProjectRuntimeDirectory(workspaceId,projectId,owner);
      await writeFile(join(directory,'codex-home','auth.json'),'persisted');
      await ensureProjectRuntimeDirectory(workspaceId,projectId,owner);
      await expect(readFile(join(directory,'codex-home','auth.json'),'utf8')).resolves.toBe('persisted');
    }finally{await rm(root,{recursive:true});}
  });
});
