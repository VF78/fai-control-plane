import {createHash,randomUUID} from 'node:crypto';
import type {Database} from './runtime.ts';

const kind='project_devops_access_v1';
export type ProjectDevopsAccess=Readonly<{
  host:string;port:number;user:string;
  ssh:'configured'|'error';cloud:'none'|'yandex';
  cloudStatus:'not_selected'|'configured'|'error';checkedAt:string;
}>;

export const readProjectDevopsAccess=async(database:Database,actorId:string,projectId:string):Promise<ProjectDevopsAccess|null>=>{
  const result=await database.query<{content:string}>(`select s.content_text as content
    from project_source_artifacts s join project_memberships m on m.project_id=s.project_id
    where s.project_id=$1 and m.actor_id=$2 and m.active=true and s.kind=$3
    order by s.created_at desc,s.id desc limit 1`,[projectId,actorId,kind]);
  return result.rows[0]===undefined?null:JSON.parse(result.rows[0].content) as ProjectDevopsAccess;
};

/** Connection facts only. Key/config contents stay in this project's existing runtime data directory. */
export const saveProjectDevopsAccess=async(database:Database,input:Readonly<{
  workspaceId:string;projectId:string;actorId:string;idempotencyKey:string;value:ProjectDevopsAccess;
}>):Promise<void>=>{
  const client=await database.connect();try{await client.query('begin');
    const allowed=await client.query(`select p.id from projects p join project_memberships m on m.project_id=p.id
      where p.id=$1 and p.workspace_id=$2 and m.actor_id=$3 and m.role='project_owner' and m.active=true`,
    [input.projectId,input.workspaceId,input.actorId]);
    if(allowed.rows.length!==1)throw new Error('project_runtime_denied');
    const content=JSON.stringify(input.value);const sha=createHash('sha256').update(content).digest('hex');
    await client.query(`insert into project_source_artifacts
      (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,provenance)
      values($1,$2,$3,$4,'DevOps connections','application/json',$5,$6,'operator:project-devops')
      on conflict(project_id,kind,sha256) do nothing`,[randomUUID(),input.projectId,input.actorId,kind,sha,content]);
    await client.query(`insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
      values($1,$2,$3,'project.devops.configure',$4,$5) on conflict(idempotency_key) do nothing`,
    [input.projectId,input.actorId,input.idempotencyKey,sha,input.value.checkedAt]);
    await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
      values($1,$2,$3,'project.devops.configure',$2,$4,$5,$6)`,[input.workspaceId,input.projectId,input.actorId,
      input.idempotencyKey,JSON.stringify({ssh:input.value.ssh,cloud:input.value.cloud,cloudStatus:input.value.cloudStatus}),input.value.checkedAt]);
    await client.query('commit');
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
};
