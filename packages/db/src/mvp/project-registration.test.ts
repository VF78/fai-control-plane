import {describe,expect,it,vi} from 'vitest';
import type {Database} from './runtime.ts';
import {projectAgentProfileTemplateVersion,readProjectAgentProfile,registerProject,resolveProjectRuntimeByRepository} from './project-registration.ts';

const input={workspaceId:'workspace',actorId:'actor',name:'Control',slug:'fai-control-plane',
  repositoryUrl:'https://github.com/VF78/fai-control-plane',repositoryId:'R_1',
  projectUrl:'https://github.com/users/VF78/projects/1',externalProjectId:'PVT_1',
  contextSources:[{contract:'fai.project-context-source.v1' as const,key:'repo:agents',content:'instructions'}],
  trackerCapabilities:{provider:'github' as const,agentOwnerOptionId:'owner-hermes-1',doneStatusOptionId:'status-done-1',
    defaultBranch:'main'},
  idempotencyKey:'register:1'};

describe('project registration',()=>{
  it('creates owner, binding, policies, context and audit in one transaction without a secret value',async()=>{
    const queries:string[]=[];
    const query=vi.fn(async(sql:string)=>{queries.push(sql.replace(/\s+/g,' ').trim());
      if(sql.includes("m.role='project_owner'"))return {rowCount:1,rows:[{}]};
      if(sql.includes('from projects p join tracker_bindings'))return {rowCount:0,rows:[]};
      if(sql.includes("purpose='tracker_read'"))return {rowCount:1,rows:[{id:'secret-ref'}]};
      return {rowCount:1,rows:[]};});
    const client={query,release:vi.fn()}; const database={connect:vi.fn(async()=>client)} as unknown as Database;
    await expect(registerProject(database,input)).resolves.toMatchObject({slug:input.slug,created:true});
    expect(queries.some((sql)=>sql.startsWith('insert into tracker_bindings'))).toBe(true);
    expect(queries.filter((sql)=>sql.startsWith('insert into project_source_artifacts'))).toHaveLength(4);
    expect(queries.some((sql)=>sql.includes("'project.register',$2::uuid::text"))).toBe(true);
    expect(queries.at(-1)).toBe('commit');
    expect(JSON.stringify(query.mock.calls)).not.toContain('github_pat_');
  });

  it('resumes an existing binding when only display whitespace or URL spelling differs',async()=>{
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes("m.role='project_owner'"))return {rowCount:1,rows:[{}]};
      if(sql.includes('from projects p join tracker_bindings'))return {rowCount:1,rows:[{
        id:'project',name:'Control ',repositoryUrl:'https://github.com/VF78/fai-control-plane/',
        projectUrl:'https://github.com/users/VF78/projects/1/',repositoryId:'R_1',externalProjectId:'PVT_1'}]};
      return {rowCount:1,rows:[]};
    });
    const client={query,release:vi.fn()};const database={connect:vi.fn(async()=>client)} as unknown as Database;
    await expect(registerProject(database,input)).resolves.toEqual({projectId:'project',slug:input.slug,created:false});
    expect(query.mock.calls.some(([sql])=>String(sql).startsWith('insert into projects'))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe('commit');
  });

  it('fails closed when the readiness artifact is malformed',async()=>{
    const database={query:vi.fn(async()=>({rows:[{sha256:'v',content:'{}'}]}))} as unknown as Database;
    await expect(readProjectAgentProfile(database,'actor','project')).resolves.toEqual({status:'not_configured',
      profile:null,endpointPath:null,version:null,documentFingerprint:null});
  });

  it('requires context to be rebuilt when the stored profile uses an older template',async()=>{
    const fingerprint='a'.repeat(64);
    const database={query:vi.fn(async()=>({
      rows:[{sha256:'stored-version',content:JSON.stringify({contract:'fai.project-agent-profile.v1',status:'ready',
        profile:'project-agent',endpointPath:'/v1/runs',templateVersion:'v2026.8.28-dedicated-runtime-v1',
        documentFingerprint:fingerprint})}],
    }))} as unknown as Database;
    expect(projectAgentProfileTemplateVersion).not.toBe('v2026.8.28-dedicated-runtime-v1');
    await expect(readProjectAgentProfile(database,'actor','project')).resolves.toEqual({status:'not_configured',
      profile:'project-agent',endpointPath:null,version:'stored-version',documentFingerprint:fingerprint});
  });

  it('resolves two repositories to distinct canonical project runtimes',async()=>{
    const runtimeRow=(projectId:string,repository:string,projectNumber:number)=>({workspaceId:'workspace',projectId,
      ownerActorId:`owner-${projectId}`,bindingId:`binding-${projectId}`,provider:'github',
      projectUrl:`https://github.com/users/VF78/projects/${projectNumber}`,repositoryId:`repo-${projectId}`,
      repositoryUrl:`https://github.com/VF78/${repository}`,cursor:null,trackerSecretId:`secret-${projectId}`,
      trackerSecretPurpose:'tracker_read',trackerSecretLocator:`/run/${projectId}`,
      trackerCapabilitiesContent:JSON.stringify({contract:'fai.project-tracker-capabilities.v1',provider:'github',
        agentOwnerOptionId:`hermes-${projectId}`,doneStatusOptionId:`done-${projectId}`,defaultBranch:'main'}),
      agentProfileContent:null});
    const query=vi.fn(async(_sql:string,parameters?:readonly unknown[])=>({rows:parameters?.[1]===
      'https://github.com/VF78/control'?[runtimeRow('a','control',1)]:[runtimeRow('b','ascon',4)]}));
    const database={query} as unknown as Database;
    await expect(resolveProjectRuntimeByRepository(database,'workspace','https://github.com/VF78/control'))
      .resolves.toMatchObject({projectId:'a',bindingId:'binding-a',repositoryUrl:'https://github.com/VF78/control'});
    await expect(resolveProjectRuntimeByRepository(database,'workspace','https://github.com/VF78/ascon'))
      .resolves.toMatchObject({projectId:'b',bindingId:'binding-b',repositoryUrl:'https://github.com/VF78/ascon'});
    expect(query.mock.calls.map((call)=>call[1]?.[1])).toEqual([
      'https://github.com/VF78/control','https://github.com/VF78/ascon']);
    expect(query.mock.calls[0]![0]).not.toContain('project_agent_profile_v1');
  });
});
