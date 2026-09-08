import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseDevopsInput,renderDevopsSshConfig,writeDevopsFiles} from './project-devops-files.ts';

const roots:string[]=[];
const owner={uid:process.getuid!(),gid:process.getgid!()};
const key='-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----';
const input={host:'example.test',user:'deploy',port:22,cloud:'none' as const,privateKey:key};
const {privateKey:_,...withoutKey}=input;
const root=async()=>{const value=await mkdtemp(join(tmpdir(),'fai-devops-'));roots.push(value);await mkdir(`${value}/data`);return value;};
afterEach(async()=>{for(const value of roots.splice(0))await rm(value,{recursive:true,force:true});});

describe('project DevOps files',()=>{
  it('accepts hostnames and IPv6, rejects SSH config injection',()=>{
    expect(parseDevopsInput(input)).toEqual(input);
    expect(parseDevopsInput({...input,host:'2001:db8::1'}).host).toBe('2001:db8::1');
    for(const host of ['-oProxyCommand=sh','example.test\nProxyCommand sh','a b'])
      expect(()=>parseDevopsInput({...input,host})).toThrow('project_devops_invalid');
    expect(()=>parseDevopsInput({...input,user:'root\nLocalCommand sh'})).toThrow();
    expect(()=>parseDevopsInput({...input,port:65536})).toThrow();
    expect(()=>parseDevopsInput({...input,privateKey:'not a key'})).toThrow('project_devops_key_invalid');
  });
  it('updates connection facts without overwriting an omitted persistent key',async()=>{
    const directory=await root();await writeDevopsFiles(directory,input,owner);
    await writeDevopsFiles(directory,{...withoutKey,host:'next.test'},owner);
    expect(await readFile(`${directory}/data/devops/id`,'utf8')).toBe(key+'\n');
    expect(await readFile(`${directory}/data/devops/ssh_config`,'utf8')).toBe(renderDevopsSshConfig({...input,host:'next.test'}));
    expect((await stat(`${directory}/data/devops/id`)).mode&0o777).toBe(0o600);
    expect((await stat(`${directory}/data/devops`)).mode&0o777).toBe(0o700);
  });
  it('requires credentials on first setup and validates all required files before replacement',async()=>{
    const directory=await root();
    await expect(writeDevopsFiles(directory,withoutKey,owner)).rejects.toThrow('project_devops_key_required');
    await writeDevopsFiles(directory,input,owner);
    await expect(writeDevopsFiles(directory,{...input,privateKey:key+'new',cloud:'yandex'},owner)).rejects.toThrow('project_devops_cloud_required');
    expect(await readFile(`${directory}/data/devops/id`,'utf8')).toBe(key+'\n');
  });
  it('keeps two projects separate and reuses optional cloud credentials',async()=>{
    const one=await root(),two=await root();
    await writeDevopsFiles(one,{...input,cloud:'yandex',cloudConfig:'token: fixture'},owner);
    await writeDevopsFiles(one,{...withoutKey,cloud:'yandex'},owner);
    await writeDevopsFiles(two,{...input,host:'other.test'},owner);
    expect(await readFile(`${one}/data/devops/yandex.yaml`,'utf8')).toBe('token: fixture\n');
    await expect(stat(`${two}/data/devops/yandex.yaml`)).rejects.toMatchObject({code:'ENOENT'});
  });
  it('does not follow a replacement directory symlink',async()=>{
    const one=await root(),two=await root();await symlink(`${two}/data`,`${one}/data/devops`);
    await expect(writeDevopsFiles(one,input,owner)).rejects.toThrow('project_runtime_host_layout_failed');
    await expect(stat(`${two}/data/id`)).rejects.toMatchObject({code:'ENOENT'});
  });
});
