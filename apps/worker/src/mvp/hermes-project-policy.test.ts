import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {defaultAgentRoutingPolicy,defaultProjectProcessPolicy} from '@fai-control-plane/domain';
import type {Database} from '@fai-control-plane/db';
import {persistProjectHermesPolicies,syncProjectHermesPolicies} from './hermes-project-policy.ts';
const versioned=<T>(policy:T)=>({policy,version:createHash('sha256').update(JSON.stringify(policy)).digest('hex')});
describe('persistent project policy materialization',()=>{
  it('installs exact fresh project settings, changes only custom routing bytes and isolates another project',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fai-policy-'));const owner={uid:process.getuid!(),gid:process.getgid!()};
    try{
      const runtime={runtimeId:'fresh-project',workspacePath:'/opt/data/work/fresh-project',
        agentCredentialRef:{locator:`${root}/secrets/agent`}};
      const processPolicy=versioned(defaultProjectProcessPolicy);const routing=versioned(defaultAgentRoutingPolicy);
      expect(await persistProjectHermesPolicies(runtime,processPolicy,routing,owner)).toBe(2);
      const directory=`${root}/data/work/fresh-project/.fai-context`;
      expect(JSON.parse(await readFile(`${directory}/process.json`,'utf8'))).toEqual(processPolicy);
      expect(JSON.parse(await readFile(`${directory}/routing.json`,'utf8'))).toEqual(routing);
      for(const path of [`${root}/data/work`,`${root}/data/work/fresh-project`,directory]){
        const details=await stat(path);expect(details.uid).toBe(owner.uid);expect(details.gid).toBe(owner.gid);
        expect(details.mode&0o777).toBe(0o700);
      }
      const unchanged=await stat(`${directory}/process.json`);
      expect(await persistProjectHermesPolicies(runtime,processPolicy,routing,owner)).toBe(0);
      const custom=versioned({...defaultAgentRoutingPolicy,routes:defaultAgentRoutingPolicy.routes.map(route=>
        route.taskClass==='ordinary_implementation'?{...route,model:'custom-model',effort:'high' as const}:route)});
      expect(await persistProjectHermesPolicies(runtime,processPolicy,custom,owner)).toBe(1);
      expect(JSON.parse(await readFile(`${directory}/routing.json`,'utf8'))).toEqual(custom);
      expect((await stat(`${directory}/process.json`)).mtimeMs).toBe(unchanged.mtimeMs);
      expect(await persistProjectHermesPolicies({...runtime,runtimeId:'second-project',workspacePath:'/opt/data/work/second-project'},
        processPolicy,routing,owner)).toBe(2);
      expect(JSON.parse(await readFile(`${directory}/routing.json`,'utf8'))).toEqual(custom);
      await expect(persistProjectHermesPolicies(runtime,processPolicy,{...custom,version:'0'.repeat(64)},owner))
        .rejects.toThrow('project_policy_version_invalid');
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('refreshes a custom settings change from stored configuration without a task or bootstrap',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fai-policy-sync-'));const owner={uid:process.getuid!(),gid:process.getgid!()};
    const runtime={runtimeId:'internal-project',workspacePath:'/opt/data/work/internal-project',
      agentCredentialRef:{locator:`${root}/secrets/agent`}};
    let routing=defaultAgentRoutingPolicy;
    const database={query:async(sql:string)=>{
      const policy=sql.includes('agent_routing_policy_v1')?routing:defaultProjectProcessPolicy;
      return {rows:[{id:'config',projectId:'project',sha256:versioned(policy).version,contentText:JSON.stringify(policy),
        provenance:'settings',createdAt:new Date('2026-09-06T00:00:00Z')}]};}} as unknown as Database;
    try{
      expect(await syncProjectHermesPolicies(database,'owner','project',runtime,owner)).toBe(2);
      routing={...routing,routes:routing.routes.map(route=>route.taskClass==='manager_project_ops'
        ?{...route,model:'custom-project-model'}:route)};
      expect(await syncProjectHermesPolicies(database,'owner','project',runtime,owner)).toBe(1);
      expect(await syncProjectHermesPolicies(database,'owner','project',runtime,owner)).toBe(0);
      expect(JSON.parse(await readFile(`${root}/data/work/internal-project/.fai-context/routing.json`,'utf8')))
        .toEqual(versioned(routing));
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
