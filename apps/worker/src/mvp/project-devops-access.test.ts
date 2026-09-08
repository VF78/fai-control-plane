import {describe,expect,it} from 'vitest';
import {probeDevopsAccess} from './project-devops-access.ts';
import {projectRuntimeOwnership,type DockerRequest} from './docker-project-runtime.ts';

const runtime={runtimeId:'fai-example-12345678',projectId:'project-one',workspaceId:'workspace-one'};
const response=(status:number,body:unknown)=>({status,body:Buffer.from(JSON.stringify(body))});
function engine(options:{foreign?:boolean;exit?:number}={}){
  const commands:unknown[]=[];const paths:string[]=[];
  const docker:DockerRequest=async(method,path,body)=>{paths.push(path);
    if(path.startsWith('/containers/')&&method==='GET')return response(200,{
      Name:`/${runtime.runtimeId}-gateway`,State:{Running:true},Config:{Labels:projectRuntimeOwnership({
        ...runtime,projectId:options.foreign?'other':runtime.projectId,artifact:runtime},'gateway')}});
    if(path.endsWith('/exec')){commands.push(body);return response(201,{Id:`probe-${commands.length}`});}
    if(path.endsWith('/start'))return response(200,{});
    return response(200,{ExitCode:options.exit??0});
  };return {docker,commands,paths};
}
describe('DevOps connection probes',()=>{
  it('runs only fixed read-only checks in the selected project container without collecting secret output',async()=>{
    const fake=engine();expect(await probeDevopsAccess(runtime,'yandex',fake.docker)).toEqual({ssh:'configured',cloudStatus:'configured'});
    expect(fake.commands).toEqual([
      {User:'10000:10000',AttachStdout:false,AttachStderr:false,Env:['HOME=/opt/data/home'],Cmd:['timeout','12','ssh','-F','/opt/data/devops/ssh_config','project','true']},
      {User:'10000:10000',AttachStdout:false,AttachStderr:false,Env:['HOME=/opt/data/home'],Cmd:['timeout','12','yc','--config','/opt/data/devops/yandex.yaml','iam','create-token']},
    ]);
    expect(fake.paths.every(path=>path.startsWith(`/containers/${runtime.runtimeId}-gateway/`)||path.startsWith('/exec/probe-'))).toBe(true);
  });
  it('does not claim success for a failed SSH check and does not call an unselected cloud',async()=>{
    const fake=engine({exit:124});expect(await probeDevopsAccess(runtime,'none',fake.docker)).toEqual({ssh:'error',cloudStatus:'not_selected'});
    expect(fake.commands).toHaveLength(1);
  });
  it('does not execute in a differently owned container',async()=>{
    const fake=engine({foreign:true});await expect(probeDevopsAccess(runtime,'none',fake.docker)).rejects.toThrow();
    expect(fake.commands).toHaveLength(0);
  });
});
